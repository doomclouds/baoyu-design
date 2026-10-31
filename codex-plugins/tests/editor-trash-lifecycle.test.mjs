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
  await rm(root, { recursive: true, force: true });
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
  let current;
  try {
    const record = await store.create({ kind: 'design-system', title: 'Portable editor lifecycle' });
    const service = createDesignService({ store, pluginRoot,
      editorOpen: (record, options) => openLocalEditor(record, { ...options, env: { ...process.env, CODEX_THREAD_ID: '' } }),
    });
    const first = await service.invoke('editor.open', { id: record.id });
    current = record;
    const firstState = readJson(path.join(record.path, '.artifact-server.json'));
    assert.equal((await fetch(first.url, { signal: AbortSignal.timeout(5000) })).status, 200);
    assert.equal(alive(firstState.pid), true);
    atomicJson(path.join(record.path, WORKER_FILE), { version: 1, root: record.path, nativeThreadId: '11111111-2222-4333-8444-555555555555', status: 'waiting' });
    atomicJson(path.join(record.path, WORKER_JOBS_FILE), queued('pending'));
    const trashed = await service.invoke('library.trash', { id: record.id });
    current = trashed;
    assert.equal(trashed.deleted, true);
    assert.equal(alive(firstState.pid), false);
    assert.equal(readJson(path.join(trashed.path, '.artifact-server.json')), null);
    assert.equal(readJson(path.join(trashed.path, BINDING_FILE)), null);
    assert.equal(readJson(path.join(trashed.path, WORKER_FILE)).status, 'paused');
    assert.equal(readJson(path.join(trashed.path, WORKER_JOBS_FILE)).jobs.job.status, 'pending');
    const restored = await service.invoke('library.restore', { id: record.id });
    current = restored;
    assert.equal(restored.deleted, false);
    const second = await service.invoke('editor.open', { id: record.id });
    const secondState = readJson(path.join(restored.path, '.artifact-server.json'));
    assert.equal((await fetch(second.url, { signal: AbortSignal.timeout(5000) })).status, 200);
    assert.notEqual(secondState.pid, firstState.pid);
    assert.equal(readJson(path.join(restored.path, WORKER_FILE)).status, 'paused', 'reopening does not resume pending native work');
    assert.equal((await getWorkerStatus(restored.path)).counts.active, 0);
    assert.equal((await getWorkerStatus(restored.path)).counts.pending, 1);
  } finally {
    if (current) await stopLocalEditor(current, { pluginRoot }).catch(() => {});
    await removeTemporary(temporary);
  }
});
