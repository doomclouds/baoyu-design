import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignSystemSync } from '../source/server/design-system-sync.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE } from '../source/scripts/worker-core.mjs';
import { adaptSkillMarkdown } from '../adapt-skills.mjs';

async function write(root, relative, value) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const execute = promisify(execFile);

async function fixture(t, kind = 'slides', options = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ds-sync-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await write(source, 'project/design-system.json', { v: 3, layout: 'files', title: 'Nimbus source', namespace: 'nimbus' });
  await write(source, 'project/theme.css', ':root { --accent: #0077cc; }\n');
  await write(source, 'project/README.md', 'Brand guide\n');
  await write(source, 'project/new-only.txt', 'Do not mirror new source files.\n');
  const store = createLibraryStore({ root: path.join(temporary, 'Library') });
  const record = await store.create({ kind, title: 'System sync verification' });
  const indexFile = `project/${kind === 'slides' ? 'deck' : 'canvas'}.json`;
  const index = await json(path.join(record.path, indexFile));
  index.designSystems = [{ namespace: 'nimbus', title: 'Nimbus', artifact: source, copiedAt: '2026-01-01T00:00:00Z', retained: 'keep' }];
  index.unrelated = { retained: true };
  await write(record.path, indexFile, index);
  await write(record.path, 'project/ds/nimbus/theme.css', ':root { --accent: #880000; }\n');
  await write(record.path, 'project/ds/nimbus/README.md', 'Brand guide\n');
  await write(record.path, 'project/ds/nimbus/removed.txt', 'Keep this installed-only file.\n');
  await write(record.path, 'comments.json', { local: 'Keep comments.' });
  const sync = createDesignSystemSync({ store, cwd: temporary, ...options });
  return { temporary, source, store, record: await store.get(record.id), indexFile, sync };
}

for (const kind of ['slides', 'design']) test(`${kind}: a persisted confirmation copies only reviewed existing differences and retains a usable recovery point`, async t => {
  const { temporary, source, store, record, indexFile, sync } = await fixture(t, kind);
  const beforeIndex = await fs.readFile(path.join(record.path, indexFile));
  const beforeTheme = await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css'));
  const prepared = await sync.prepare(record, 'nimbus');
  assert.deepEqual(prepared.changed, ['theme.css']);
  assert.deepEqual(prepared.removed, ['removed.txt']);
  assert.equal(prepared.source, source);
  assert.equal(prepared.title, 'Nimbus');
  assert.equal(prepared.state, 'behind');
  assert.deepEqual(await fs.readFile(path.join(record.path, indexFile)), beforeIndex, 'prepare never changes artwork content');
  assert.equal((await store.listSnapshots(record.id)).length, 0);
  // A second instance represents a CLI confirmation of an MCP-prepared token.
  const applied = await createDesignSystemSync({ store, cwd: temporary }).apply(record, prepared.confirmationToken);
  assert.deepEqual({ ...applied, snapshotId: Boolean(applied.snapshotId) }, { copied: 1, state: 'current', changed: 0, removed: 1, canSync: true, snapshotId: true });
  assert.equal(await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css'), 'utf8'), await fs.readFile(path.join(source, 'project/theme.css'), 'utf8'));
  assert.equal(await fs.readFile(path.join(record.path, 'project/ds/nimbus/removed.txt'), 'utf8'), 'Keep this installed-only file.\n');
  await assert.rejects(fs.stat(path.join(record.path, 'project/ds/nimbus/new-only.txt')), { code: 'ENOENT' });
  const index = await json(path.join(record.path, indexFile));
  assert.equal(index.designSystems[0].retained, 'keep');
  assert.notEqual(index.designSystems[0].copiedAt, '2026-01-01T00:00:00Z');
  assert.deepEqual(index.unrelated, { retained: true });
  await assert.rejects(sync.apply(record, prepared.confirmationToken), { code: 'DS_SYNC_INVALID_TOKEN' });
  await store.restoreSnapshot(record.id, applied.snapshotId);
  assert.deepEqual(await fs.readFile(path.join(record.path, indexFile)), beforeIndex);
  assert.deepEqual(await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css')), beforeTheme);
  assert.deepEqual(await json(path.join(record.path, 'comments.json')), { local: 'Keep comments.' });
});

test('status reads current differences during active work without a worker lock, receipt, snapshot or content write', async t => {
  const { store, record, indexFile, sync } = await fixture(t);
  await write(record.path, WORKER_JOBS_FILE, { version: 1, jobs: { job: { id: 'job', status: 'active' } }, order: ['job'] });
  await write(record.path, WORKER_FILE, { version: 1, status: 'active', activeJobId: 'job' });
  await write(record.path, `${WORKER_LOCK_FILE}/owner.json`, { pid: process.pid, token: 'live-owner', at: Date.now() });
  const before = await Promise.all([indexFile, 'project/ds/nimbus/theme.css', WORKER_FILE, WORKER_JOBS_FILE, `${WORKER_LOCK_FILE}/owner.json`].map(relative => fs.readFile(path.join(record.path, relative))));
  const stateFiles = (await fs.readdir(path.join(store.root, '_state'))).sort();
  assert.deepEqual(await sync.status(record, 'nimbus'), { state: 'behind', changed: 1, removed: 1, canSync: true });
  assert.deepEqual(await Promise.all([indexFile, 'project/ds/nimbus/theme.css', WORKER_FILE, WORKER_JOBS_FILE, `${WORKER_LOCK_FILE}/owner.json`].map(relative => fs.readFile(path.join(record.path, relative)))), before);
  assert.deepEqual((await fs.readdir(path.join(store.root, '_state'))).sort(), stateFiles);
  assert.equal((await store.listSnapshots(record.id)).length, 0);
  await assert.rejects(fs.stat(path.join(store.root, '_state/design-system-sync')), { code: 'ENOENT' });
});

test('status reports absent and remote sources as unknown but preserves real validation and safety errors', async t => {
  const { source, record, indexFile, sync } = await fixture(t);
  const index = await json(path.join(record.path, indexFile));
  for (const [artifact, reason] of [['', 'none'], ['https://example.org/source', 'remote'], ['missing-source-folder', 'not-found']]) {
    index.designSystems[0].artifact = artifact;
    await write(record.path, indexFile, index);
    assert.deepEqual(await sync.status(record, 'nimbus'), { state: 'unknown', changed: 0, removed: 0, reason });
  }
  index.designSystems[0].artifact = '\u0000invalid';
  await write(record.path, indexFile, index);
  await assert.rejects(sync.status(record, 'nimbus'), { code: 'DS_SYNC_SOURCE_UNAVAILABLE' });
  index.designSystems[0].artifact = source;
  await write(record.path, indexFile, index);
  await assert.rejects(sync.status(record, 'uninstalled'), { code: 'DS_SYNC_INVALID_NAMESPACE' });
  await fs.symlink(path.join(source, 'project/README.md'), path.join(source, 'project/linked.css'));
  await write(record.path, 'project/ds/nimbus/linked.css', 'installed content');
  await assert.rejects(sync.status(record, 'nimbus'), { code: 'SYMLINK_REFUSED' });
});

test('a confirmation is tied to its artwork, expires, and cannot be replaced with an arbitrary source input', async t => {
  let clock = 1000;
  const { store, record, sync } = await fixture(t, 'slides', { now: () => clock, ttlMs: 100 });
  const prepared = await sync.prepare(record, 'nimbus');
  const other = await store.create({ kind: 'slides', title: 'Other artwork' });
  await assert.rejects(sync.apply(other, prepared.confirmationToken), { code: 'DS_SYNC_INVALID_TOKEN' });
  await assert.rejects(sync.prepare(record, { namespace: 'nimbus', source: '/arbitrary/source' }), { code: 'DS_SYNC_INVALID_NAMESPACE' });
  await assert.rejects(sync.apply(record, '../not-a-token'), { code: 'DS_SYNC_INVALID_TOKEN' });
  clock += 101;
  await assert.rejects(sync.apply(record, prepared.confirmationToken), { code: 'DS_SYNC_CONFIRMATION_EXPIRED' });
  assert.equal((await store.listSnapshots(record.id)).length, 0);
});

test('a relative recorded source and its confirmation survive a separate CLI process with a different cwd', async t => {
  const { temporary, store, record, indexFile, sync } = await fixture(t);
  const index = await json(path.join(record.path, indexFile));
  index.designSystems[0].artifact = 'source';
  await write(record.path, indexFile, index);
  const prepared = await sync.prepare(record, 'nimbus');
  const script = `import {createLibraryStore} from ${JSON.stringify(new URL('../source/library/index.mjs', import.meta.url).href)};
import {createDesignSystemSync} from ${JSON.stringify(new URL('../source/server/design-system-sync.mjs', import.meta.url).href)};
const [root,id,token]=process.argv.slice(1);const store=createLibraryStore({root});await store.initialize();
console.log(JSON.stringify(await createDesignSystemSync({store}).apply(await store.get(id),token)));`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script, store.root, record.id, prepared.confirmationToken], { cwd: path.dirname(temporary), windowsHide: true });
  assert.equal(JSON.parse(result.stdout).copied, 1);
  assert.equal((await store.listSnapshots(record.id)).length, 1);
});

test('source bytes, installed bytes, source metadata and artwork index changes invalidate the reviewed diff', async t => {
  for (const change of ['source', 'destination', 'source-index', 'index', 'removed']) {
    const { source, store, record, indexFile, sync } = await fixture(t);
    const prepared = await sync.prepare(record, 'nimbus');
    if (change === 'source') await write(source, 'project/theme.css', 'source changed after review');
    if (change === 'destination') await write(record.path, 'project/ds/nimbus/theme.css', 'user edited after review');
    if (change === 'source-index') await write(source, 'project/design-system.json', { title: 'Changed source metadata' });
    if (change === 'index') { const index = await json(path.join(record.path, indexFile)); index.unrelated.later = true; await write(record.path, indexFile, index); }
    if (change === 'removed') await write(source, 'project/removed.txt', 'source file returned after review');
    const before = await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css'));
    await assert.rejects(sync.apply(record, prepared.confirmationToken), { code: 'DS_SYNC_STALE' });
    assert.deepEqual(await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css')), before);
    assert.equal((await store.listSnapshots(record.id)).length, 0);
  }
});

test('active or pending native work blocks both review and apply without consuming the confirmed diff', async t => {
  const { store, record, sync } = await fixture(t);
  const prepared = await sync.prepare(record, 'nimbus');
  for (const status of ['active', 'pending']) {
    await write(record.path, WORKER_JOBS_FILE, { version: 1, jobs: { job: { id: 'job', status } }, order: ['job'] });
    await assert.rejects(sync.prepare(record, 'nimbus'), { code: 'ARTIFACT_BUSY' });
    await assert.rejects(sync.apply(record, prepared.confirmationToken), { code: 'ARTIFACT_BUSY' });
  }
  await write(record.path, WORKER_JOBS_FILE, { version: 1, jobs: {}, order: [] });
  await write(record.path, WORKER_FILE, { version: 1, status: 'active', activeJobId: 'claimed' });
  await assert.rejects(sync.apply(record, prepared.confirmationToken), { code: 'ARTIFACT_BUSY' });
  await fs.rm(path.join(record.path, WORKER_FILE));
  assert.equal((await sync.apply(record, prepared.confirmationToken)).copied, 1);
  assert.equal((await store.listSnapshots(record.id)).length, 1);
});

test('snapshot failure and a source change during snapshot leave the installed copy unchanged', async t => {
  const { source, store, record, sync } = await fixture(t);
  const prepared = await sync.prepare(record, 'nimbus');
  const before = await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css'));
  const original = store.snapshot.bind(store);
  store.snapshot = async () => { throw new Error('snapshot storage unavailable'); };
  await assert.rejects(sync.apply(record, prepared.confirmationToken), /snapshot storage unavailable/);
  assert.deepEqual(await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css')), before);
  store.snapshot = original;
  const newer = await sync.prepare(record, 'nimbus');
  store.snapshot = async (...args) => { const result = await original(...args); await write(source, 'project/theme.css', 'changed during checkpoint'); return result; };
  await assert.rejects(sync.apply(record, newer.confirmationToken), error => error.code === 'DS_SYNC_STALE' && Boolean(error.snapshotId));
  assert.deepEqual(await fs.readFile(path.join(record.path, 'project/ds/nimbus/theme.css')), before);
});

test('local source paths come only from the installed record and symlinked source content is refused', async t => {
  const { source, record, indexFile, sync } = await fixture(t);
  await fs.symlink(path.join(source, 'project/README.md'), path.join(source, 'project/linked.css'));
  await write(record.path, 'project/ds/nimbus/linked.css', 'installed content');
  await assert.rejects(sync.prepare(record, 'nimbus'), { code: 'SYMLINK_REFUSED' });
  await fs.rm(path.join(source, 'project/linked.css'));
  await fs.rm(path.join(record.path, 'project/ds/nimbus/linked.css'));
  const index = await json(path.join(record.path, indexFile));
  index.designSystems[0].artifact = 'https://example.org/system';
  await write(record.path, indexFile, index);
  await assert.rejects(sync.prepare(record, 'nimbus'), { code: 'DS_SYNC_SOURCE_UNAVAILABLE' });
});

test('an unchanged copy with source-only additions or removals does not create a snapshot or rewrite copiedAt', async t => {
  const { source, store, record, indexFile, sync } = await fixture(t);
  await write(record.path, 'project/ds/nimbus/theme.css', await fs.readFile(path.join(source, 'project/theme.css'), 'utf8'));
  const indexBefore = await fs.readFile(path.join(record.path, indexFile));
  const prepared = await sync.prepare(record, 'nimbus');
  assert.deepEqual(prepared.changed, []);
  assert.deepEqual(prepared.removed, ['removed.txt']);
  const result = await sync.apply(record, prepared.confirmationToken);
  assert.equal(result.copied, 0);
  assert.equal(result.removed, 1);
  assert.equal(result.snapshotId, null);
  assert.deepEqual(await fs.readFile(path.join(record.path, indexFile)), indexBefore);
  assert.equal((await store.listSnapshots(record.id)).length, 0);
});

test('real Slides and Canvas skill instructions require the persistent review and confirm commands', async () => {
  for (const name of ['slides', 'design']) {
    const original = await fs.readFile(new URL(`../../skills/claude-${name}/SKILL.md`, import.meta.url), 'utf8');
    const adapted = adaptSkillMarkdown(original, `codex-${name}`, 'SKILL.md');
    assert.match(adapted, /ds-sync <root> \[namespace\] --check/);
    assert.match(adapted, /ds-sync <root> --confirm <confirmationToken>/);
    assert.match(adapted, /source\/copy\/index hashes/);
    assert.match(adapted, /saving a recovery point/);
    assert.doesNotMatch(adapted, /\[--check\]|ds-sync <root> <folder>` copies what changed/);
  }
});
