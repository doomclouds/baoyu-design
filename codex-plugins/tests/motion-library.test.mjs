import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixtures.mjs';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignService, openLocalEditor } from '../source/server/service.mjs';
import { stopLocalEditor } from '../source/server/editor-lifecycle.mjs';
import { portableBundle } from '../source/ui/library-transfer.mjs';
import { dispatchEditRequest } from '../source/scripts/edit-request-dispatch.mjs';
import { completeNativeJob, getWorkerStatus, nextNativeJob, registerNativeWorker } from '../source/scripts/worker-client.mjs';
import { readJson } from '../source/scripts/bridge-core.mjs';
import { WORKER_JOBS_FILE } from '../source/scripts/worker-core.mjs';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = response => JSON.parse(Buffer.from(response.body, 'base64').toString('utf8'));
const parentEnv = { CODEX_THREAD_ID: '11111111-2222-4333-8444-555555555555' };
const childEnv = { CODEX_THREAD_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'codex-motion-library-'));
  const cleanup = [];
  t.after(async () => {
    try { for (const close of cleanup.toReversed()) await close(); }
    finally {
      const relative = path.relative(temporaryRoot, temporary);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
  const store = createLibraryStore({ root: path.join(temporary, 'Library') });
  await store.initialize();
  return { store, temporary, cleanup };
}

test('Motion blank creation and rename remain valid real films with persistent library identity', async t => {
  const { store } = await fixture(t);
  const artwork = await store.create({ kind: 'motion', title: '茶馆开业' });
  const cli = path.join(repository, 'skills/claude-motion/scripts/artifact.mjs');
  const checked = await run(process.execPath, [cli, 'check', artwork.path], { timeout: 15_000, windowsHide: true });
  assert.equal(JSON.parse(checked.stdout).problems, 0, checked.stdout);
  const renamed = await store.rename(artwork.id, '茶馆开业 · 第二版');
  assert.equal(renamed.id, artwork.id);
  assert.equal(renamed.path, artwork.path);
  assert.equal((await json(path.join(artwork.path, 'db/film/meta.json'))).title, renamed.title);
  await store.setFavorite(artwork.id, true);
  assert.deepEqual((await store.list({ kind: 'motion', query: '第二版', favoritesOnly: true })).map(item => item.id), [artwork.id]);
  const reopened = createLibraryStore({ root: store.root });
  assert.equal((await reopened.get(artwork.id)).title, renamed.title);
  assert.equal((await reopened.get(artwork.id)).contentStatus, 'ok');
});

test('Motion transfer, copy, recovery and trash preserve film modules and binary assets while keeping local execution state private', async t => {
  const { store, temporary } = await fixture(t);
  const source = await createFixture('motion', temporary);
  const artwork = await store.importArtifact({ sourcePath: source.root });
  const scene = path.join(artwork.path, source.contentFile);
  const original = await fs.readFile(scene, 'utf8');
  const binary = await fs.readFile(path.join(artwork.path, '_blobs', source.blobId));
  const privateComment = '{"version":1,"threads":[],"local":"COMMENT_STAYS_LOCAL"}\n';
  await fs.writeFile(path.join(artwork.path, 'comments.json'), privateComment);
  await fs.writeFile(path.join(artwork.path, '.artifact-server.json'), '{"private":"RUNTIME_STAYS_LOCAL"}');
  await fs.mkdir(path.join(artwork.path, 'src'), { recursive: true });
  await fs.writeFile(path.join(artwork.path, 'src/working-copy.js'), 'WORKING_COPY_STAYS_LOCAL');
  const bundle = await store.exportArtifact(artwork.id);
  assert.equal(bundle.kind, 'motion');
  assert.ok(bundle.files.some(file => file.path === source.contentFile));
  assert.ok(bundle.files.some(file => file.path === `_blobs/${source.blobId}`));
  assert.ok(bundle.files.some(file => file.path === 'db/assets/fixture.png.json'));
  assert.doesNotMatch(JSON.stringify(bundle), /COMMENT_STAYS_LOCAL|RUNTIME_STAYS_LOCAL|WORKING_COPY_STAYS_LOCAL/);
  const transferred = await store.importArtifact({ bundle: portableBundle(JSON.stringify(bundle)) });
  assert.notEqual(transferred.id, artwork.id);
  assert.equal(await fs.readFile(path.join(transferred.path, source.contentFile), 'utf8'), original);
  assert.deepEqual(await fs.readFile(path.join(transferred.path, '_blobs', source.blobId)), binary);
  await assert.rejects(fs.access(path.join(transferred.path, 'comments.json')), { code: 'ENOENT' });
  const copy = await store.duplicate(artwork.id, { title: 'A separate film' });
  assert.notEqual(copy.id, artwork.id);
  assert.equal((await json(path.join(copy.path, 'db/film/meta.json'))).title, 'A separate film');
  const snapshot = await store.snapshot(artwork.id, { label: 'Before scene edit' });
  await fs.writeFile(scene, original.replace('Codex Design verification', 'Changed scene'));
  await store.restoreSnapshot(artwork.id, snapshot.id);
  assert.equal(await fs.readFile(scene, 'utf8'), original);
  assert.equal(await fs.readFile(path.join(artwork.path, 'comments.json'), 'utf8'), privateComment);
  await store.openTab(artwork.id);
  const trashed = await store.trash(artwork.id);
  assert.ok(trashed.deletedAt);
  assert.equal((await store.list({ kind: 'motion' })).some(item => item.id === artwork.id), false);
  assert.equal((await store.getViewState()).tabs.some(tab => tab.id === artwork.id), false);
  const restored = await store.restore(artwork.id);
  assert.equal(restored.id, artwork.id);
  assert.equal(restored.path, artwork.path);
  assert.equal(await fs.readFile(scene, 'utf8'), original);
  assert.deepEqual(await fs.readFile(path.join(restored.path, '_blobs', source.blobId)), binary);
  const malformed = structuredClone(bundle);
  malformed.files = malformed.files.filter(file => file.path !== 'db/film/script.json');
  const count = (await store.list()).length;
  await assert.rejects(store.importArtifact({ bundle: malformed }), { code: 'MISSING_CONTENT' });
  assert.equal((await store.list()).length, count, 'An incomplete film must not create a replacement library item.');
});

test('Motion native document, editor save and immutable comment dispatch use the native workflow without an upstream waiter or hook', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const source = await createFixture('motion', f.temporary);
  const artwork = await f.store.importArtifact({ sourcePath: source.root });
  const nativeEnv = { ...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '' };
  const service = createDesignService({ store: f.store, pluginRoot,
    editorOpen: (record, options) => openLocalEditor(record, { ...options, env: nativeEnv }) });
  f.cleanup.push(() => stopLocalEditor(artwork, { pluginRoot, env: nativeEnv }));
  const opened = await service.invoke('editor.open', { id: artwork.id });
  const other = await f.store.create({ kind: 'motion', title: 'An isolated second film' });
  f.cleanup.push(() => stopLocalEditor(other, { pluginRoot, env: nativeEnv }));
  const second = await service.invoke('editor.open', { id: other.id });
  assert.notEqual(new URL(opened.url).port, new URL(second.url).port, 'Each native artwork has its own service.');
  assert.notEqual(readJson(path.join(artwork.path, '.artifact-server.json')).pid, readJson(path.join(other.path, '.artifact-server.json')).pid);
  const reused = await service.invoke('editor.open', { id: artwork.id });
  assert.equal(reused.url, opened.url);
  const request = async (route, method = 'GET', data) => {
    const response = await service.invoke('editor.request', { id: artwork.id, request: { path: route, method,
      ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: encode(data) }) } });
    assert.ok(response.status >= 200 && response.status < 300, `${route}: ${JSON.stringify(decode(response))}`);
    return response;
  };
  const doc = await service.invoke('editor.document', { id: artwork.id, channel: 'motion_native_regression_channel', canDraftComments: true });
  assert.equal(doc.transport, 'mcp');
  assert.match(doc.html, /__CODEX_DESIGN_EDITOR_TRANSPORT__/);
  assert.doesNotMatch(doc.html, /<iframe\b[^>]*src=["']https?:\/\/(?:localhost|127\.0\.0\.1)/i);
  assert.doesNotMatch(doc.html, /<script\b[^>]*src=["'](?:\.\/)?artifact-type\/app\.js/i);
  const scene = await json(path.join(artwork.path, source.contentFile));
  const edited = { ...scene, text: scene.text.replace('Codex Design verification', 'Saved in native Motion') };
  await request('_api/write', 'POST', { op: 'set', path: 'modules/scene-intro.js', base: scene, data: edited });
  assert.equal((await json(path.join(artwork.path, source.contentFile))).text, edited.text);
  const reference = await service.readReferenceFile(artwork.id, source.contentFile);
  assert.equal(JSON.parse(reference.text).text, edited.text);
  const created = await request('__comments', 'POST', { ...source.comment, text: '把开头标题改得更清楚。', send: true });
  const thread = decode(created).thread;
  assert.ok(created.nativeDraft?.requestId);
  assert.equal(created.nativeDraft.uri, `codex-design://edit-requests/${created.nativeDraft.requestId}`);
  assert.equal((await getWorkerStatus(artwork.path)).jobs.length, 0, 'Preparing a native draft cannot queue or start an agent.');
  assert.equal(readJson(path.join(artwork.path, WORKER_JOBS_FILE)), null);
  const comments = decode(await request('__comments'));
  assert.equal(comments.agent.hook, false);
  assert.equal(comments.agent.listening, false);
  assert.equal(comments.threads[0].messages[0].text, '把开头标题改得更清楚。');
  await service.invoke('request.draftAdded', { requestId: created.nativeDraft.requestId });
  const accepted = await service.operateEditRequests('accept', [created.nativeDraft.requestId]);
  assert.equal(accepted.errors.length, 0);
  assert.equal(accepted.requests[0].artifact.kind, 'motion');
  assert.deepEqual(accepted.requests[0].event.data.location, { file: 'db/film/script.json', anchor: source.comment.anchor,
    coordinateSpace: 'authored', time: 0.5, timeEnd: 1.5 });
  assert.match(accepted.requests[0].skillFile, /skills[/\\]codex-motion[/\\]SKILL\.md$/);
  // Test identities exercise real native persistence and reply commands, not platform agent creation.
  const skillDir = path.join(pluginRoot, 'skills/codex-motion');
  const queued = await dispatchEditRequest(skillDir, artwork.path, created.nativeDraft.requestId, { env: parentEnv, store: f.store });
  assert.equal((await dispatchEditRequest(skillDir, artwork.path, created.nativeDraft.requestId, { env: parentEnv, store: f.store })).duplicate, true);
  await registerNativeWorker(artwork.path, { env: childEnv, name: 'motion-regression-worker' });
  const claimed = await nextNativeJob(artwork.path, { env: childEnv, timeoutSeconds: 0 });
  assert.equal(claimed.job.id, queued.jobId);
  const done = await completeNativeJob(artwork.path, claimed.job.id, '已修改开头并检查影片。', { env: { ...process.env, ...childEnv } });
  assert.equal(done.completed, true, JSON.stringify(done));
  const completed = decode(await request('__comments'));
  const result = completed.threads.find(item => item.id === thread.id);
  assert.equal(result.messages.at(-1).text, '已修改开头并检查影片。');
  assert.equal(result.messages.at(-1).author.kind, 'agent');
  assert.equal(result.agent.nativeRequest.status, 'completed');
  assert.equal((await getWorkerStatus(artwork.path)).counts.completed, 1);
  assert.equal((await getWorkerStatus(other.path)).jobs.length, 0, 'Another open film never inherits this artwork request.');
  await service.invoke('library.trash', { id: artwork.id });
  assert.equal((await f.store.list({ kind: 'motion' })).some(item => item.id === artwork.id), false);
  await service.invoke('library.restore', { id: artwork.id });
  assert.equal((await json(path.join(artwork.path, source.contentFile))).text, edited.text);
  assert.equal((await json(path.join(artwork.path, 'comments.json'))).threads[0].messages.at(-1).text, '已修改开头并检查影片。');
  assert.equal((await service.invoke('editor.open', { id: artwork.id })).kind, 'motion');
});
