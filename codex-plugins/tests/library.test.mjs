import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLibraryStore, BUNDLE_FORMAT } from '../source/library/index.mjs';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-library-test-'));
  const root = path.join(temporary, 'Library');
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), path.resolve(temporary));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root, ...options });
  await store.initialize(); return { store, root, temporary };
}
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const code = expected => error => { assert.equal(error.code, expected, error.stack); return true; };

test('default location is fixed under the user profile and independent of CODEX_HOME', () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(os.tmpdir(), 'unrelated-codex-home');
  try { assert.equal(createLibraryStore().root, path.join(os.homedir(), '.codex', 'CodexDesignLibrary')); }
  finally { previous === undefined ? delete process.env.CODEX_HOME : process.env.CODEX_HOME = previous; }
});

test('four blank native formats pass the actual artifact CLI checker', async t => {
  const { store } = await fixture(t);
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const record = await store.create({ kind, title: '空白设计 ' + kind });
    assert.equal(record.contentStatus, 'ok');
    assert.ok(record.path.endsWith(path.join(kind, record.id)));
    const cli = path.join(repository, 'skills', 'claude-' + kind, 'scripts', 'artifact.mjs');
    const result = await run(process.execPath, [cli, 'check', record.path], { windowsHide: true, timeout: 15_000 });
    assert.equal(JSON.parse(result.stdout).problems, 0, result.stdout);
  }
});

test('persistent identity survives rename and favorites; copy gets a new identity with content only', async t => {
  const { store } = await fixture(t);
  const original = await store.create({ kind: 'design', title: '原标题' });
  await fs.writeFile(path.join(original.path, 'comments.json'), JSON.stringify({ secret: 'LOCAL_COMMENT_SECRET' }));
  await fs.writeFile(path.join(original.path, '.artifact-server.json'), JSON.stringify({ secret: 'RUNTIME_SECRET' }));
  await fs.writeFile(path.join(original.path, '.codex-design-worker-jobs.json'), JSON.stringify({ secret: 'WORKER_SECRET' }));
  await store.bindChat(original.id, { threadId: 'real-host-chat-a', projectId: 'real-project-a' });
  const renamed = await store.rename(original.id, '新标题 <真实文本>');
  assert.equal(renamed.id, original.id); assert.equal(renamed.path, original.path);
  assert.equal((await json(path.join(original.path, 'project/canvas.json'))).title, renamed.title);
  await store.setFavorite(original.id, true);
  assert.equal((await store.list({ query: '新标题', favoritesOnly: true })).length, 1);
  const copy = await store.duplicate(original.id, { title: '副本' });
  assert.notEqual(copy.id, original.id); assert.equal(copy.sourceArtifactId, original.id); assert.equal(copy.favorite, false);
  assert.equal(await store.getBinding(copy.id), null);
  for (const name of ['comments.json', '.artifact-server.json', '.codex-design-worker-jobs.json']) await assert.rejects(fs.access(path.join(copy.path, name)), { code: 'ENOENT' });
  assert.equal((await json(path.join(copy.path, 'project/canvas.json'))).title, '副本');
});

test('native bundle import/export excludes machine relationships and comments, including hostile extra entries', async t => {
  const { store } = await fixture(t);
  const original = await store.create({ kind: 'dashboard', title: '我的看板' });
  await fs.mkdir(path.join(original.path, '_blobs'), { recursive: true });
  await fs.writeFile(path.join(original.path, '_blobs', 'sample.bin'), Buffer.from([0, 255, 17]));
  await fs.writeFile(path.join(original.path, 'comments.json'), 'LOCAL_COMMENT_SECRET');
  await fs.mkdir(path.join(original.path, 'db/data/users/local'), { recursive: true });
  await fs.writeFile(path.join(original.path, 'db/data/users/local/runs.json'), '{"private":"DIAGNOSTIC_SECRET"}');
  await store.bindChat(original.id, { threadId: 'PRIVATE_CHAT_ID' });
  const bundle = await store.exportArtifact(original.id);
  assert.equal(bundle.format, BUNDLE_FORMAT);
  const text = JSON.stringify(bundle);
  for (const secret of ['LOCAL_COMMENT_SECRET', 'DIAGNOSTIC_SECRET', 'PRIVATE_CHAT_ID', original.id]) assert.ok(!text.includes(secret));
  const inject = (relative, secret) => ({ path: relative, encoding: 'base64', data: Buffer.from(secret).toString('base64') });
  const extra = { ...bundle, files: [...bundle.files, inject('comments.json', 'FORGED_COMMENT'), inject('_state/bindings.json', 'FORGED_CHAT'), inject('project/_state/bindings.json', 'NESTED_FORGED_CHAT'), inject('.codex-design-worker-jobs.json', 'FORGED_TASK')] };
  const imported = await store.importArtifact({ bundle: JSON.stringify(extra), title: '已导入' });
  assert.notEqual(imported.id, original.id); assert.equal(imported.contentStatus, 'ok'); assert.equal(await store.getBinding(imported.id), null);
  for (const relative of ['comments.json', '_state/bindings.json', 'project/_state/bindings.json', '.codex-design-worker-jobs.json']) await assert.rejects(fs.access(path.join(imported.path, relative)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(imported.path, '_blobs/sample.bin')), Buffer.from([0, 255, 17]));
});

test('snapshots restore artwork while current comments, chat binding and view state survive', async t => {
  const { store } = await fixture(t);
  const artifact = await store.create({ kind: 'slides', title: 'Before' });
  const slide = path.join(artifact.path, 'project/slides/cover.html');
  await fs.writeFile(slide, '<section id="cover" style="background:#ffffff"><h1>Before snapshot</h1></section>');
  const snapshot = await store.snapshot(artifact.id, { label: '第一版' });
  assert.equal((await store.listSnapshots(artifact.id))[0].id, snapshot.id);
  await fs.writeFile(slide, '<section id="cover" style="background:#ffffff"><h1>After snapshot</h1></section>');
  await fs.writeFile(path.join(artifact.path, 'comments.json'), 'CURRENT_DISCUSSION');
  await store.bindChat(artifact.id, { threadId: 'current-real-chat' }); await store.openTab(artifact.id);
  await store.rename(artifact.id, 'After');
  const restored = await store.restoreSnapshot(artifact.id, snapshot.id);
  assert.equal(restored.id, artifact.id); assert.equal(restored.title, 'Before');
  assert.match(await fs.readFile(slide, 'utf8'), /Before snapshot/);
  assert.equal(await fs.readFile(path.join(artifact.path, 'comments.json'), 'utf8'), 'CURRENT_DISCUSSION');
  assert.equal((await store.getBinding(artifact.id)).threadId, 'current-real-chat');
  assert.equal((await store.getViewState()).activeTabId, artifact.id);
});

test('one persistent editing chat per artifact; conflicting bind requires explicit unlink', async t => {
  const { store } = await fixture(t);
  const artifact = await store.create({ kind: 'design-system', title: '系统' });
  const first = await store.bindChat(artifact.id, { threadId: 'chat-a', projectId: 'project-a' });
  assert.equal((await store.bindChat(artifact.id, { threadId: 'chat-a' })).boundAt, first.boundAt);
  await assert.rejects(store.bindChat(artifact.id, { threadId: 'chat-b' }), code('BINDING_CONFLICT'));
  assert.equal((await store.getBinding(artifact.id)).threadId, 'chat-a');
  await store.unbindChat(artifact.id); assert.equal((await store.bindChat(artifact.id, { threadId: 'chat-b' })).threadId, 'chat-b');
});

test('fixed library tab, unique artifact tabs, order and active tab restore after a new store instance', async t => {
  const { store, root } = await fixture(t);
  const a = await store.create({ kind: 'design', title: 'A' }), b = await store.create({ kind: 'slides', title: 'B' });
  await store.openTab(a.id); await store.openTab(b.id); await store.openTab(a.id);
  const view = await store.reorderTabs([b.id, a.id]);
  assert.deepEqual(view.tabs.map(tab => tab.id), ['library', b.id, a.id]); assert.equal(view.activeTabId, a.id);
  await store.closeTab('library'); assert.equal((await store.getViewState()).tabs[0].id, 'library');
  const reopened = createLibraryStore({ root }); await reopened.initialize();
  assert.deepEqual(await reopened.getViewState(), await store.getViewState());
  await reopened.trash(a.id); assert.ok(!(await reopened.getViewState()).tabs.some(tab => tab.id === a.id));
  await reopened.restore(a.id); assert.equal((await reopened.openTab(a.id)).tabs.filter(tab => tab.id === a.id).length, 1);
});

test('active tasks block deletion and destructive restore without stopping agents', async t => {
  let busy = false, calls = 0;
  const { store } = await fixture(t, { isBusy: async record => { calls++; assert.ok(record.path); return busy; } });
  const artifact = await store.create({ kind: 'design', title: 'Busy' }); const snapshot = await store.snapshot(artifact.id); busy = true;
  await assert.rejects(store.trash(artifact.id), code('ARTIFACT_BUSY'));
  await assert.rejects(store.restoreSnapshot(artifact.id, snapshot.id), code('ARTIFACT_BUSY'));
  assert.equal((await store.get(artifact.id)).contentStatus, 'ok'); assert.ok(calls >= 3);
  busy = false; await store.trash(artifact.id); assert.equal((await store.list()).length, 0);
  assert.equal((await store.list({ includeDeleted: true }))[0].deleted, true);
  assert.equal((await store.restore(artifact.id)).id, artifact.id);
});

test('missing native files remain visible as missing and never recreate blank artwork', async t => {
  const { store } = await fixture(t); const artifact = await store.create({ kind: 'design', title: 'Missing' });
  await fs.unlink(path.join(artifact.path, 'project/canvas.json'));
  assert.equal((await store.get(artifact.id)).contentStatus, 'missing');
  assert.equal((await store.list())[0].contentStatus, 'missing');
  await assert.rejects(fs.access(path.join(artifact.path, 'project/canvas.json')), { code: 'ENOENT' });
  await assert.rejects(store.exportArtifact(artifact.id), code('MISSING_CONTENT'));
});

test('content reads and bundles reject traversal, private control routes and resource exhaustion', async t => {
  const { store } = await fixture(t); const artifact = await store.create({ kind: 'design', title: 'Safe' });
  await assert.rejects(store.readFile(artifact.id, 'project/../../_state/bindings.json'), code('INVALID_PATH'));
  await assert.rejects(store.readFile(artifact.id, 'project\\..\\comments.json'), code('INVALID_PATH'));
  await assert.rejects(store.readFile(artifact.id, 'comments.json'), code('CONTENT_ONLY'));
  await assert.rejects(store.readFile(artifact.id, '_state/bindings.json'), code('CONTENT_ONLY'));
  const bundle = await store.exportArtifact(artifact.id);
  await assert.rejects(store.importArtifact({ bundle: { ...bundle, files: [...bundle.files, { path: 'project/../../outside.txt', encoding: 'base64', data: 'eA==' }] } }), code('INVALID_PATH'));
  const tiny = createLibraryStore({ root: path.join((await fixture(t)).temporary, 'Tiny'), limits: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 2048, maxBundleBytes: 4096 } });
  await tiny.initialize();
  await assert.rejects(tiny.importArtifact({ bundle: { ...bundle, files: [...bundle.files, { path: 'project/big.bin', encoding: 'base64', data: 'a'.repeat(8192) }] } }), code('INVALID_BUNDLE'));
});

test('symlinks cannot expose external files through content routes, export or explicit native import', async t => {
  const { store, temporary } = await fixture(t); const artifact = await store.create({ kind: 'design', title: 'Boundary' });
  const outside = path.join(temporary, 'Outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'DO_NOT_EXPORT');
  const link = path.join(artifact.path, 'project/leak');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.readFile(artifact.id, 'project/leak/secret.txt'), code('SYMLINK_REFUSED'));
  await assert.rejects(store.exportArtifact(artifact.id), code('SYMLINK_REFUSED'));
  await assert.rejects(store.importArtifact({ sourcePath: artifact.path, kind: 'design' }), code('SYMLINK_REFUSED'));
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'DO_NOT_EXPORT');
});

test('legacy registration scans only kind folders, imports content once, and reports broken roots', async t => {
  const { store, root, temporary } = await fixture(t); const prototype = await store.create({ kind: 'design', title: 'Legacy' });
  const legacy = path.join(root, 'design', 'old-name'); await fs.mkdir(legacy); await fs.cp(path.join(prototype.path, 'project'), path.join(legacy, 'project'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'comments.json'), 'PRESERVE_LOCAL_HISTORY');
  await fs.mkdir(path.join(root, 'slides', 'broken'));
  await fs.mkdir(path.join(temporary, 'outside-old-design')); // Never scanned.
  const first = await store.scanLegacy();
  const imported = first.find(item => item.status === 'imported'); assert.ok(imported); assert.equal(first.find(item => item.path.endsWith('broken')).status, 'missing');
  assert.equal(await fs.readFile(path.join(legacy, 'comments.json'), 'utf8'), 'PRESERVE_LOCAL_HISTORY');
  const fresh = await store.get(imported.artifactId); await assert.rejects(fs.access(path.join(fresh.path, 'comments.json')), { code: 'ENOENT' });
  const second = await store.scanLegacy(); assert.equal(second.filter(item => item.status === 'imported').length, 0); assert.equal((await store.list()).length, 2);
  await fs.unlink(path.join(fresh.path, 'project/canvas.json'));
  const missing = await store.scanLegacy();
  assert.equal(missing.find(item => item.path === legacy).status, 'missing');
  assert.equal((await store.list()).length, 2, 'a missing registration must not create a replacement blank artifact');
});

test('missing uploaded material is reported rather than silently imported as a complete artifact', async t => {
  const { store } = await fixture(t); const item = await store.create({ kind: 'slides', title: 'Broken material' });
  await fs.writeFile(path.join(item.path, 'project/slides/cover.html'), '<section id="cover"><img src="/_blob/0123456789abcdef0123456789abcdef"></section>');
  assert.equal((await store.get(item.id)).contentStatus, 'missing');
  await assert.rejects(store.exportArtifact(item.id), code('MISSING_CONTENT'));
  await assert.rejects(store.importArtifact({ sourcePath: item.path, kind: 'slides' }), code('MISSING_CONTENT'));
});

test('independent store instances serialize catalog updates and rebuild identity from manifests', async t => {
  const { store, root } = await fixture(t);
  const other = createLibraryStore({ root }); await other.initialize();
  const created = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? other : store).create({ kind: 'design', title: '并发作品 ' + index })));
  assert.equal(new Set(created.map(item => item.id)).size, 8); assert.equal((await store.list()).length, 8);
  await fs.unlink(path.join(root, '_state/catalog.json'));
  const recovered = createLibraryStore({ root }); await recovered.initialize();
  assert.deepEqual(new Set((await recovered.list()).map(item => item.id)), new Set(created.map(item => item.id)));
});

test('restore collision preserves both the recycle item and an independently occupied destination', async t => {
  const { store } = await fixture(t); const item = await store.create({ kind: 'design', title: 'Recycle' });
  await store.trash(item.id); await fs.mkdir(item.path); await fs.writeFile(path.join(item.path, 'keep.txt'), 'PRESERVE');
  await assert.rejects(store.restore(item.id), code('ID_CONFLICT'));
  assert.equal(await fs.readFile(path.join(item.path, 'keep.txt'), 'utf8'), 'PRESERVE');
  assert.equal((await store.get(item.id, { includeDeleted: true })).deleted, true);
});
