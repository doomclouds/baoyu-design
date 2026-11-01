import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLibraryStore, nativeTrashActivity } from '../source/library/index.mjs';
import { createEditRequestStore } from '../source/library/edit-requests.mjs';

const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const inside = (root, target) => { const relative = path.relative(path.resolve(root), path.resolve(target)); assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)); };

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-library-purge-'));
  const root = path.join(temporary, 'Library');
  t.after(async () => { inside(os.tmpdir(), temporary); await fs.rm(temporary, { recursive: true, force: true }); });
  const store = createLibraryStore({ root, ...options });
  const create = title => store.create({ kind: 'slides', title });
  const trashed = async title => { const artifact = await create(title); return { artifact, trash: await store.trash(artifact.id) }; };
  return { temporary, root, store, create, trashed };
}

async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
async function nativeState(item, { jobs = [], registry = {} } = {}) {
  await writeJson(path.join(item.trash.path, '.codex-design-worker.json'), { version: 1, root: item.artifact.path, nativeThreadId: CHILD, status: 'paused', ...registry });
  await writeJson(path.join(item.trash.path, '.codex-design-worker-jobs.json'), { version: 1, jobs: Object.fromEntries(jobs.map((job, i) => [String(i), job])), order: jobs.map((_job, i) => String(i)) });
}

test('purge permanently removes only selected trash artwork, snapshots, requests and local relationships', async t => {
  const f = await fixture(t), artifact = await f.create('Delete me'), other = await f.create('Keep me');
  const requests = createEditRequestStore({ store: f.store });
  const prepare = async item => {
    await writeJson(path.join(item.path, 'comments.json'), { version: 1, threads: [{ id: 'comment', status: 'open', location: { file: 'project/slides/cover.html' }, messages: [{ from: 'user', text: 'A local request', at: '2026-11-01T00:00:00Z' }] }] });
    return requests.prepare({ artifactId: item.id, commentId: 'comment' });
  };
  const removedRequest = await prepare(artifact), keptRequest = await prepare(other);
  await f.store.snapshot(artifact.id); await f.store.snapshot(other.id);
  await f.store.bindChat(artifact.id, { threadId: 'real-native-history-id' }); await f.store.bindChat(other.id, { threadId: 'keep-native-history-id' });
  await writeJson(path.join(f.root, '_state/legacy-imports.json'), { version: 1, sources: { 'slides/old-delete': artifact.id, 'slides/old-keep': other.id } });
  const chatHistory = path.join(f.temporary, 'native-chat-history.json'); await writeJson(chatHistory, { id: 'real-native-history-id', messages: ['Keep external history'] });
  await f.store.trash(artifact.id);
  const result = await f.store.purge([artifact.id, artifact.id.toUpperCase()]); assert.deepEqual(result, { deleted: [artifact.id], failed: [] });
  for (const relative of [`_trash/${artifact.id}`, `_state/snapshots/${artifact.id}`, `_state/edit-requests/${removedRequest.id}.json`, `_state/purge-progress/${artifact.id}.json`]) assert.equal(await exists(path.join(f.root, relative)), false, relative);
  assert.equal((await json(path.join(f.root, '_state/catalog.json'))).artifacts[artifact.id], undefined);
  assert.equal((await json(path.join(f.root, '_state/bindings.json'))).artifacts[artifact.id], undefined);
  assert.equal((await json(path.join(f.root, '_state/legacy-imports.json'))).sources['slides/old-delete'], undefined);
  assert.equal((await json(chatHistory)).messages[0], 'Keep external history');
  assert.ok(await exists(other.path)); assert.ok(await exists(path.join(f.root, `_state/snapshots/${other.id}`))); assert.ok(await exists(path.join(f.root, `_state/edit-requests/${keptRequest.id}.json`)));
  assert.equal((await f.store.getBinding(other.id)).threadId, 'keep-native-history-id'); assert.equal((await f.store.list()).length, 1);
});

test('every batch item is checked before destruction; active, restored and unknown ids preserve the trash selection', async t => {
  const f = await fixture(t), first = await f.trashed('Trash selection'), active = await f.create('Active selection');
  for (const id of [active.id, randomUUID()]) {
    await assert.rejects(f.store.purge([first.artifact.id, id]), error => ['NOT_IN_TRASH', 'NOT_FOUND'].includes(error.code));
    assert.ok(await exists(first.trash.path)); assert.equal(await exists(path.join(f.root, '_state/purge-progress')), false);
  }
  const restored = await f.trashed('Restored selection'); await f.store.restore(restored.artifact.id);
  await assert.rejects(f.store.purge([first.artifact.id, restored.artifact.id]), { code: 'NOT_IN_TRASH' }); assert.ok(await exists(first.trash.path));
});

test('ids reject parent paths, malformed UUIDs and invalid batch sizes before touching files', async t => {
  const f = await fixture(t), item = await f.trashed('Scope');
  for (const ids of [[], null, item.artifact.id, Array(201).fill(item.artifact.id)]) await assert.rejects(f.store.purge(ids), { code: 'INVALID_ARGUMENTS' });
  for (const id of ['..', '../_trash', '_trash/' + item.artifact.id, item.artifact.id + '/..', 'C:/Users']) await assert.rejects(f.store.purge([item.artifact.id, id]), { code: 'INVALID_ID' });
  assert.ok(await exists(item.trash.path));
  await assert.rejects(f.store._purgeTree('_trash'), { code: 'INVALID_PATH' }); await assert.rejects(f.store._purgeTree('_state/snapshots'), { code: 'INVALID_PATH' });
});

test('active jobs, live listeners and unknown native ownership fail closed without batch deletion', async t => {
  for (const native of [
    { jobs: [{ status: 'active' }] },
    { registry: { listener: { pid: process.pid, expiresAt: Date.now() + 60_000 } } },
    { registry: { root: path.join(os.tmpdir(), 'different-artwork') } },
    { registry: { url: 'http://127.0.0.1:1', token: 'legacy' } },
    { jobs: [{ status: 'mystery-status' }] },
  ]) {
    const f = await fixture(t), safe = await f.trashed('Safe'), owned = await f.trashed('Owned'); await nativeState(owned, native);
    await assert.rejects(f.store.purge([safe.artifact.id, owned.artifact.id]), { code: 'ARTIFACT_BUSY' });
    assert.ok(await exists(safe.trash.path)); assert.ok(await exists(owned.trash.path));
    assert.equal(await exists(path.join(f.root, '_state/purge-progress')), false);
  }
});

test('native trash inspection accepts the exact former root and pending jobs, while preserving custom busy guards', async t => {
  let busy = false;
  const f = await fixture(t, { isBusy: async () => busy ? { busy: true, reason: 'External ownership' } : false });
  const item = await f.trashed('Pending native request'); await nativeState(item, { jobs: [{ status: 'pending' }] });
  assert.equal(await nativeTrashActivity(item.trash), false);
  busy = true; await assert.rejects(f.store.purge([item.artifact.id]), { code: 'ARTIFACT_BUSY' }); assert.ok(await exists(item.trash.path));
  busy = false; assert.deepEqual(await f.store.purge([item.artifact.id]), { deleted: [item.artifact.id], failed: [] });
});

test('malformed native journals are unknown ownership and preserve all selected artifacts', async t => {
  const f = await fixture(t), item = await f.trashed('Unknown journal');
  await fs.writeFile(path.join(item.trash.path, '.codex-design-worker-jobs.json'), '{broken json');
  assert.equal((await nativeTrashActivity(item.trash)).busy, true);
  await assert.rejects(f.store.purge([item.artifact.id]), { code: 'ARTIFACT_BUSY' }); assert.ok(await exists(item.trash.path));
});

test('symlinks inside artwork and snapshot trees cannot escape the exact delete scope', async t => {
  for (const targetKind of ['artwork', 'snapshot']) {
    const f = await fixture(t), item = await f.trashed('Linked scope');
    const outside = path.join(f.temporary, 'outside'); await fs.mkdir(outside); const sentinel = path.join(outside, 'keep.txt'); await fs.writeFile(sentinel, 'Do not delete');
    const parent = targetKind === 'artwork' ? item.trash.path : path.join(f.root, `_state/snapshots/${item.artifact.id}`); await fs.mkdir(parent, { recursive: true });
    const link = path.join(parent, 'external');
    try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('This environment cannot create the test link.'); continue; } throw error; }
    try { await assert.rejects(f.store.purge([item.artifact.id]), { code: 'SYMLINK_REFUSED' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'Do not delete'); assert.ok(await exists(item.trash.path)); }
    finally { await fs.unlink(link); }
  }
});

test('a symlink replacing the trash parent is refused and leaves external data intact', async t => {
  const f = await fixture(t), item = await f.trashed('Parent scope');
  const trash = path.join(f.root, '_trash'), backup = path.join(f.temporary, 'original-trash'), outside = path.join(f.temporary, 'outside');
  inside(f.temporary, trash); inside(f.temporary, backup); await fs.rename(trash, backup); await fs.mkdir(outside);
  const sentinel = path.join(outside, 'keep.txt'); await fs.writeFile(sentinel, 'Preserved');
  try {
    try { await fs.symlink(outside, trash, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('This environment cannot create the test link.'); return; } throw error; }
    await assert.rejects(f.store.purge([item.artifact.id]), { code: 'SYMLINK_REFUSED' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'Preserved');
  } finally { if (await exists(trash)) await fs.unlink(trash); await fs.rename(backup, trash); }
});

test('batch deletion failure reports real partial progress and a durable receipt supports retry', async t => {
  const isBusy = record => record.deleted ? nativeTrashActivity(record) : false;
  const f = await fixture(t, { isBusy }), first = await f.create('First partial'), second = await f.create('Second success'); await f.store.snapshot(first.id);
  const a = await f.store.trash(first.id), b = await f.store.trash(second.id);
  const snapshots = path.join(f.root, `_state/snapshots/${first.id}`), originalRm = fs.rm;
  fs.rm = async (target, options) => { if (path.resolve(target) === path.resolve(snapshots)) throw Object.assign(new Error('Snapshot directory is locked'), { code: 'EPERM' }); return originalRm(target, options); };
  let result;
  try { result = await f.store.purge([first.id, second.id]); }
  finally { fs.rm = originalRm; }
  assert.deepEqual(result.deleted, [second.id]); assert.equal(result.failed.length, 1); assert.equal(result.failed[0].id, first.id); assert.equal(result.failed[0].error.code, 'EPERM'); assert.deepEqual(result.failed[0].removed, ['artwork']);
  assert.equal(await exists(a.path), false); assert.equal(await exists(b.path), false); assert.ok(await exists(snapshots));
  assert.equal((await json(path.join(f.root, '_state/catalog.json'))).artifacts[first.id].location, 'trash'); assert.ok(await exists(path.join(f.root, `_state/purge-progress/${first.id}.json`)));
  const restarted = createLibraryStore({ root: f.root, isBusy });
  assert.deepEqual(await restarted.purge([first.id]), { deleted: [first.id], failed: [] });
  assert.equal(await exists(snapshots), false); assert.equal(await exists(path.join(f.root, `_state/purge-progress/${first.id}.json`)), false);
});

test('a restored artifact cannot be purged using an earlier failed deletion receipt', async t => {
  const f = await fixture(t), item = await f.trashed('Restore after failure'), originalRm = fs.rm;
  fs.rm = async (target, options) => { if (path.resolve(target) === path.resolve(item.trash.path)) throw Object.assign(new Error('Locked'), { code: 'EBUSY' }); return originalRm(target, options); };
  try { assert.equal((await f.store.purge([item.artifact.id])).failed.length, 1); }
  finally { fs.rm = originalRm; }
  await f.store.restore(item.artifact.id);
  await assert.rejects(f.store.purge([item.artifact.id]), { code: 'NOT_IN_TRASH' }); assert.ok(await exists(item.artifact.path));
});

test('replacing the library root with an alias is refused before permanent deletion', async t => {
  const f = await fixture(t), item = await f.trashed('Root identity');
  const original = path.join(f.temporary, 'OriginalLibrary'), outside = path.join(f.temporary, 'OutsideLibrary');
  inside(f.temporary, original); inside(f.temporary, f.root); await fs.rename(f.root, original); await fs.mkdir(outside);
  const sentinel = path.join(outside, 'keep.txt'); await fs.writeFile(sentinel, 'Preserved root');
  try {
    try { await fs.symlink(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('This environment cannot create the test link.'); return; } throw error; }
    await assert.rejects(f.store.purge([item.artifact.id]), { code: 'ROOT_CHANGED' }); assert.equal(await fs.readFile(sentinel, 'utf8'), 'Preserved root');
  } finally { if (await exists(f.root)) await fs.unlink(f.root); await fs.rename(original, f.root); }
});

test('interrupted recursive deletion can resume when its manifest was already removed', async t => {
  const f = await fixture(t), item = await f.trashed('Partial directory'); const originalRm = fs.rm;
  fs.rm = async (target, options) => {
    if (path.resolve(target) === path.resolve(item.trash.path)) { await fs.unlink(path.join(item.trash.path, 'artifact.json')); throw Object.assign(new Error('Partial recursive deletion'), { code: 'EBUSY' }); }
    return originalRm(target, options);
  };
  let result;
  try { result = await f.store.purge([item.artifact.id]); }
  finally { fs.rm = originalRm; }
  assert.equal(result.deleted.length, 0); assert.equal(result.failed[0].error.code, 'EBUSY'); assert.ok(await exists(item.trash.path));
  assert.deepEqual(await f.store.purge([item.artifact.id]), { deleted: [item.artifact.id], failed: [] }); assert.equal(await exists(item.trash.path), false);
});

test('mismatched recovery point or request identities abort the entire preflight', async t => {
  const f = await fixture(t), item = await f.create('Metadata scope'); const snapshot = await f.store.snapshot(item.id); const trash = await f.store.trash(item.id);
  const file = path.join(f.root, `_state/snapshots/${item.id}/${snapshot.id}.json`), saved = await json(file); saved.artifactId = randomUUID(); await writeJson(file, saved);
  await assert.rejects(f.store.purge([item.id]), { code: 'INVALID_STATE' }); assert.ok(await exists(trash.path));
  saved.artifactId = item.id; await writeJson(file, saved);
  const requestId = randomUUID(); await writeJson(path.join(f.root, `_state/edit-requests/${requestId}.json`), { version: 1, id: requestId, artifactId: '../escape' });
  await assert.rejects(f.store.purge([item.id]), { code: 'INVALID_STATE' }); assert.ok(await exists(trash.path));
});
