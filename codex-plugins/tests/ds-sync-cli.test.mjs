import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibraryStore } from '../source/library/index.mjs';
import { createFixture } from './fixtures.mjs';

const execute = promisify(execFile);
const sourceModule = fileURLToPath(new URL('../source/scripts/artifact-command.mjs', import.meta.url));
const skill = fileURLToPath(new URL('../codex-design/skills/codex-slides/', import.meta.url));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'codex-ds-sync-cli-'));
  t.after(async () => {
    const relative = path.relative(parent, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root: path.join(directory, 'Library') });
  const record = await store.create({ kind: 'slides', title: 'A real CLI synchronization target' });
  const system = await createFixture('design-system', directory);
  const copy = path.join(record.path, 'project/ds/qa');
  await fs.cp(path.join(system.root, 'project'), copy, { recursive: true });
  const deckFile = path.join(record.path, 'project/deck.json');
  const deck = await readJson(deckFile);
  deck.designSystems = [{ namespace: 'qa', title: 'QA design system', artifact: system.root, version: null, copiedAt: '2026-11-01T00:00:00.000Z' }];
  await fs.writeFile(deckFile, JSON.stringify(deck));
  const runner = path.join(directory, 'run-current-wrapper.mjs');
  await fs.writeFile(runner, `import {runArtifactCommand} from ${JSON.stringify(pathToFileURL(sourceModule).href)};\nawait runArtifactCommand(process.argv[2],process.argv.slice(3));\n`);
  const run = async (...args) => {
    let result;
    try { result = { ...await execute(process.execPath, [runner, skill, 'ds-sync', record.path, ...args], {
      env: { ...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '' }, timeout: 15_000, windowsHide: true,
    }), status: 0 }; }
    catch (error) { if (typeof error.code !== 'number') throw error; result = { status: error.code, stdout: error.stdout, stderr: error.stderr }; }
    return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : null,
      error: result.stderr.trim() ? JSON.parse(result.stderr) : null };
  };
  const sourceReadme = path.join(system.root, 'project/README.md'), targetReadme = path.join(copy, 'README.md');
  return { directory, store, record, sourceReadme, targetReadme, run };
}

test('ds-sync confirmation survives distinct CLI processes, snapshots the replaced copy and cannot be replayed', async t => {
  const f = await fixture(t), original = await fs.readFile(f.targetReadme, 'utf8');
  const updated = '# Updated system source\n\nReviewed source content.\n';
  await fs.writeFile(f.sourceReadme, updated);
  const review = await f.run('qa', '--check');
  assert.equal(review.status, 1);
  const planned = review.value.systems[0];
  assert.deepEqual(planned.changed, ['README.md']);
  assert.equal(planned.state, 'behind');
  assert.match(planned.confirmationToken, /^[0-9a-f-]{36}$/i);
  assert.equal(await fs.readFile(f.targetReadme, 'utf8'), original, 'The review process never overwrites the installed copy.');
  const applied = await f.run('--confirm', planned.confirmationToken);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.value.copied, 1);
  assert.equal(applied.value.state, 'current');
  assert.ok(applied.value.snapshotId);
  assert.equal(await fs.readFile(f.targetReadme, 'utf8'), updated);
  assert.equal((await f.store.listSnapshots(f.record.id)).length, 1);
  const replay = await f.run('--confirm', planned.confirmationToken);
  assert.equal(replay.status, 2);
  assert.equal(replay.error.error, 'DS_SYNC_INVALID_TOKEN');
  assert.equal(await fs.readFile(f.targetReadme, 'utf8'), updated);
  assert.equal((await f.run('qa', '--check')).status, 0);
});

test('ds-sync requires a reviewed token and refuses source changes between separate review and apply processes', async t => {
  const f = await fixture(t), original = await fs.readFile(f.targetReadme, 'utf8');
  const unconfirmed = await f.run('qa');
  assert.equal(unconfirmed.status, 2);
  assert.equal(unconfirmed.error.error, 'SYSTEM_SYNC_CONFIRMATION_REQUIRED');
  await fs.writeFile(f.sourceReadme, 'Reviewed source revision A');
  const reviewed = await f.run('qa', '--check');
  assert.equal(reviewed.status, 1);
  await fs.writeFile(f.sourceReadme, 'Unreviewed source revision B');
  const stale = await f.run('--confirm', reviewed.value.systems[0].confirmationToken);
  assert.equal(stale.status, 2);
  assert.equal(stale.error.error, 'DS_SYNC_STALE');
  assert.equal(await fs.readFile(f.targetReadme, 'utf8'), original);
  assert.equal((await f.store.listSnapshots(f.record.id)).length, 0);
  const used = await f.run('--confirm', reviewed.value.systems[0].confirmationToken);
  assert.equal(used.error.error, 'DS_SYNC_INVALID_TOKEN');
});
