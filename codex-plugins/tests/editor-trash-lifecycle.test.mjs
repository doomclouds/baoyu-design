import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignService, openLocalEditor } from '../source/server/service.mjs';
import { stopLocalEditor } from '../source/server/editor-lifecycle.mjs';
import { stopWorker, getWorkerStatus } from '../source/scripts/worker-client.mjs';
import { readJson, alive, BINDING_FILE, atomicJson } from '../source/scripts/bridge-core.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE } from '../source/scripts/worker-core.mjs';

const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
async function removeTemporary(root) {
  const relative = path.relative(os.tmpdir(), path.resolve(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  // A terminated Windows child can retain its working-directory handle briefly.
  // Retry only Node's documented transient removal errors; retain final failures.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const queued = status => ({ version: 1, order: ['job'], jobs: { job: { id: 'job', status, event: { kind: 'comment', data: { id: 'comment' } } } } });

test('idle-only worker pause rejects active ownership before changing any registry or job', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-trash-worker-'));
  try {
    const registry = { version: 1, root, nativeThreadId: '11111111-2222-4333-8444-555555555555', status: 'working', activeJobId: 'job' };
    atomicJson(path.join(root, WORKER_FILE), registry);
    atomicJson(path.join(root, WORKER_JOBS_FILE), queued('active'));
    const beforeRegistry = await readFile(path.join(root, WORKER_FILE), 'utf8');
    const beforeJobs = await readFile(path.join(root, WORKER_JOBS_FILE), 'utf8');
    await assert.rejects(stopWorker(root, { onlyWhenIdle: true }), { code: 'ARTIFACT_BUSY' });
    assert.equal(await readFile(path.join(root, WORKER_FILE), 'utf8'), beforeRegistry);
    assert.equal(await readFile(path.join(root, WORKER_JOBS_FILE), 'utf8'), beforeJobs);
    atomicJson(path.join(root, WORKER_JOBS_FILE), queued('pending'));
    const pending = await stopWorker(root, { onlyWhenIdle: true });
    assert.equal(pending.interruptRequired, false);
    assert.equal(readJson(path.join(root, WORKER_FILE)).status, 'paused');
    assert.equal((await getWorkerStatus(root)).counts.pending, 1);
  } finally { await removeTemporary(root); }
});

test('trashing an active native job never invokes editor shutdown or moves artwork', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-trash-active-'));
  try {
    const store = createLibraryStore({ root });
    const record = await store.create({ kind: 'design', title: 'Preserve active work' });
    atomicJson(path.join(record.path, WORKER_JOBS_FILE), queued('active'));
    let stops = 0;
    const service = createDesignService({ store, pluginRoot, editorStop: async () => { stops++; } });
    await assert.rejects(service.invoke('library.trash', { id: record.id }), { code: 'ARTIFACT_BUSY' });
    assert.equal(stops, 0);
    assert.equal((await store.get(record.id)).deleted, false);
    assert.equal((await getWorkerStatus(record.path)).counts.active, 1);
    assert.deepEqual(await readdir(path.join(root, '_trash')), []);
  } finally { await removeTemporary(root); }
});

test('real editor opens, safely stops before trash, restores and opens a fresh instance', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-trash-live-editor-'));
  const store = createLibraryStore({ root: path.join(temporary, 'library') });
  let current, primary;
  const cleanup = [], timeline = [];
  let stage;
  const mark = value => { stage = value; timeline.push({ stage, at: new Date().toISOString() }); };
  const describe = error => ({ name: error.name, code: error.code, message: error.message, stack: error.stack });
  const evidence = async () => {
    if (!current) return { current: null };
    if (typeof current.path !== 'string') return { invalidCurrent: current };
    const relative = path.relative(temporary, path.resolve(current.path));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { refusedOutsideFixture: current.path };
    const files = {};
    for (const name of ['.artifact-server.json', '.artifact-server.log', BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE]) {
      try { files[name] = await readFile(path.join(current.path, name), 'utf8'); }
      catch (error) { files[name] = error.code === 'ENOENT' ? null : { readError: describe(error) }; }
    }
    return { current, files };
  };
  try {
    mark('create');
    const record = await store.create({ kind: 'design-system', title: 'Portable editor lifecycle' });
    const service = createDesignService({ store, pluginRoot,
      editorOpen: (record, options) => openLocalEditor(record, { ...options, env: { ...process.env, CODEX_THREAD_ID: '' } }),
    });
    current = record;
    mark('open.first');
    const first = await service.invoke('editor.open', { id: record.id });
    mark('assert.first-session');
    const firstState = readJson(path.join(record.path, '.artifact-server.json'));
    assert.equal((await fetch(first.url, { signal: AbortSignal.timeout(5000) })).status, 200);
    assert.equal(alive(firstState.pid), true);
    mark('prepare.pending-worker');
    atomicJson(path.join(record.path, WORKER_FILE), { version: 1, root: record.path, nativeThreadId: '11111111-2222-4333-8444-555555555555', status: 'waiting' });
    atomicJson(path.join(record.path, WORKER_JOBS_FILE), queued('pending'));
    mark('trash');
    const trashed = await service.invoke('library.trash', { id: record.id });
    current = trashed;
    mark('assert.trashed');
    assert.equal(trashed.deleted, true);
    assert.equal(alive(firstState.pid), false);
    assert.equal(readJson(path.join(trashed.path, '.artifact-server.json')), null);
    assert.equal(readJson(path.join(trashed.path, BINDING_FILE)), null);
    assert.equal(readJson(path.join(trashed.path, WORKER_FILE)).status, 'paused');
    assert.equal(readJson(path.join(trashed.path, WORKER_JOBS_FILE)).jobs.job.status, 'pending');
    mark('restore');
    const restored = await service.invoke('library.restore', { id: record.id });
    current = restored;
    mark('assert.restored');
    assert.equal(restored.deleted, false);
    mark('open.second');
    const second = await service.invoke('editor.open', { id: record.id });
    mark('assert.second-session');
    const secondState = readJson(path.join(restored.path, '.artifact-server.json'));
    assert.equal((await fetch(second.url, { signal: AbortSignal.timeout(5000) })).status, 200);
    assert.notEqual(secondState.pid, firstState.pid);
    assert.equal(readJson(path.join(restored.path, WORKER_FILE)).status, 'paused', 'reopening does not resume pending native work');
    assert.equal((await getWorkerStatus(restored.path)).counts.active, 0);
    assert.equal((await getWorkerStatus(restored.path)).counts.pending, 1);
  } catch (error) {
    primary = { stage, error };
  }
  const beforeCleanup = await evidence().catch(error => ({ captureError: describe(error) }));
  if (current) {
    mark('cleanup.stop-editor');
    try { await stopLocalEditor(current, { pluginRoot }); }
    catch (error) { cleanup.push({ stage, error }); }
  }
  const afterStop = await evidence().catch(error => ({ captureError: describe(error) }));
  if (!primary && cleanup.length === 0) {
    mark('cleanup.remove-temporary');
    try { await removeTemporary(temporary); }
    catch (error) { cleanup.push({ stage, error }); }
  }
  if (primary || cleanup.length) {
    const diagnostic = { temporary, timeline, primary: primary && { stage: primary.stage, error: describe(primary.error) },
      cleanup: cleanup.map(item => ({ stage: item.stage, error: describe(item.error) })), beforeCleanup, afterStop };
    const file = path.join(temporary, 'lifecycle-failure.json');
    try { await writeFile(file, JSON.stringify(diagnostic, null, 2) + '\n'); }
    catch (error) { cleanup.push({ stage: 'diagnostic.write', error }); }
    console.error('Editor lifecycle failure evidence: ' + file + '\n' + JSON.stringify(diagnostic));
    throw new AggregateError([...(primary ? [primary.error] : []), ...cleanup.map(item => item.error)],
      'Editor lifecycle failed; original and cleanup errors retained at ' + temporary, { cause: primary?.error });
  }
});
