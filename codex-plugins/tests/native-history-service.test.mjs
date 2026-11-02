import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createLibraryStore} from '../source/library/index.mjs';
import {createDesignService} from '../source/server/service.mjs';
import {installNativeEditorTransport} from '../source/scripts/editor-native-transport.js';
import {WORKER_FILE, WORKER_JOBS_FILE} from '../source/scripts/worker-core.mjs';
import {createFixture} from './fixtures.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const channel = 'native_history_fixture_channel';
const json = (response, value, status = 200) => response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify(value));
const request = (path, method = 'GET', body) => ({path, method, ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: Buffer.from(JSON.stringify(body)).toString('base64')})});

async function fixture(t, kind = 'design') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-history-service-'));
  const store = createLibraryStore({root: path.join(temporary, 'Library')});
  await store.initialize();
  const record = await store.create({kind, title: 'History broker fixture'});
  const authored = await createFixture(kind, temporary);
  for (const directory of kind === 'dashboard' ? ['db', '_blobs'] : ['project']) await fs.cp(path.join(authored.root, directory), path.join(record.path, directory), {recursive: true});
  const pluginRoot = path.join(temporary, 'package');
  const chrome = path.join(pluginRoot, 'skills', `codex-${kind}`, 'scripts/editor');
  await fs.mkdir(path.join(chrome, 'assets'), {recursive: true});
  await fs.mkdir(path.join(pluginRoot, 'scripts'), {recursive: true});
  await fs.writeFile(path.join(chrome, 'index.html'), '<!doctype html><html><head><script src="/__share/boot.js"></script><script type="module" src="/__share/ui.js"></script><link rel="stylesheet" href="./assets/editor.css"><script src="./assets/editor.js"></script></head><body><p>Packaged chrome fixture</p></body></html>');
  await fs.writeFile(path.join(chrome, 'assets/editor.js'), 'globalThis.__historyFixtureChrome=true;');
  await fs.writeFile(path.join(chrome, 'assets/editor.css'), 'body{margin:0;font-family:Arial,sans-serif}');
  await fs.writeFile(path.join(pluginRoot, 'scripts/browser-annotations.js'), '// fixture annotation bootstrap');
  await fs.copyFile(path.join(repository, 'skills', `claude-${kind}`, 'scripts/editor/share-ui.js'), path.join(chrome, 'share-ui.js'));
  const basePath = kind === 'dashboard' ? '/dashboard/stable-fixture/' : '/design/secret-fixture-grant/';
  const calls = [];
  const server = http.createServer(async (incoming, response) => {
    const parsed = new URL(incoming.url, 'http://localhost');
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    calls.push({path: parsed.pathname, query: parsed.searchParams, method: incoming.method, headers: incoming.headers, body: bytes});
    if (!parsed.pathname.startsWith(basePath)) return json(response, {code: 'outside'}, 404);
    const route = parsed.pathname.slice(basePath.length);
    if (route === '__history') return json(response, {rows: [1, 3].map(n => ({n, preview: kind === 'dashboard' ? `${basePath}?at=${n}` : `${basePath}v/${n}/`}))});
    if (route === '__codex/boot.js') {
      response.writeHead(200, {'content-type': 'text/javascript'}).end(`window.__baoyuShare={role:"owner",user:{id:"fixture"}};window.__baoyuHistory=${JSON.stringify({base: basePath, canRestore: true, me: 'fixture', ...(parsed.searchParams.has('at') ? {preview: {n: Number(parsed.searchParams.get('at')), current_url: basePath}} : {})})};`);
      return;
    }
    if (/^__history\/(?:\d+\/restore|notice\/[a-f0-9]+\/recover)$/.test(route) && incoming.method !== 'POST') return json(response, {code: 'method_not_allowed'}, 405);
    if (/^__history\/(?:\d+\/restore|notice\/[a-f0-9]+\/recover)$/.test(route) && incoming.method === 'POST') {
      await fs.writeFile(path.join(record.path, 'project/Main.dc.html'), 'Restored selected fragment');
      return json(response, {version: 4, changed: ['project/Main.dc.html']});
    }
    if (route === '__ds/nimbus/') {
      response.writeHead(200, {'content-type': 'text/html', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff'}).end('<html><body>Read-only reference</body></html>');
      return;
    }
    if (route === '_api/doc') return json(response, {exists: true, data: {text: 'Historical dashboard', capturedVersion: Number(parsed.searchParams.get('at'))}});
    if (route === '_api/events') {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(`event: snapshot\ndata: ${JSON.stringify({capturedVersion: Number(parsed.searchParams.get('at'))})}\n\n`);
      return;
    }
    return json(response, {saved: incoming.method !== 'GET' && incoming.method !== 'HEAD'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = createDesignService({store, pluginRoot, editorOpen: async current => ({url: origin + basePath, kind, artifactId: current.id})});
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, {recursive: true, force: true});
  });
  return {temporary, store, record, service, calls, origin, basePath};
}

for (const route of ['__history/3/restore', '__history/notice/abc123/recover']) test(`partial history action ${route} creates a content checkpoint before forwarding and preserves unrelated edits`, async t => {
  const f = await fixture(t), content = path.join(f.record.path, 'project/Main.dc.html');
  const original = await fs.readFile(content);
  const other = path.join(f.record.path, 'project/Unrelated.dc.html');
  await fs.writeFile(other, 'Unrelated latest content');
  const result = await f.service.invoke('editor.request', {id: f.record.id, request: request(route, 'POST', {paths: ['project/Main.dc.html']})});
  assert.equal(result.status, 200);
  assert.equal(await fs.readFile(content, 'utf8'), 'Restored selected fragment');
  assert.equal(await fs.readFile(other, 'utf8'), 'Unrelated latest content');
  const checkpoints = await f.store.listSnapshots(f.record.id);
  assert.equal(checkpoints.length, 1); assert.equal(checkpoints[0].label, 'Before partial restore');
  const saved = JSON.parse(await fs.readFile(path.join(f.store.root, '_state/snapshots', f.record.id, checkpoints[0].id + '.json'), 'utf8'));
  assert.deepEqual(Buffer.from(saved.bundle.files.find(file => file.path === 'project/Main.dc.html').data, 'base64'), original);
  assert.equal(saved.bundle.files.some(file => /comments|worker|history|server|binding/i.test(file.path)), false);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('unsupported History methods do not create checkpoints before the upstream method refusal', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const result = await f.service.invoke('editor.request', {id: f.record.id, request: request('__history/3/restore', method)});
    assert.equal(result.status, 405);
  }
  assert.equal((await f.store.listSnapshots(f.record.id)).length, 0);
});

for (const state of ['active', 'pending', 'orphan-active', 'orphan-pending', 'registry-active']) test(`history restore refuses ${state} ownership without a checkpoint or upstream write`, async t => {
  const f = await fixture(t);
  const job = {id: 'job', status: state.includes('pending') ? 'pending' : 'active', event: {kind: 'comment', data: {id: 'fixture'}}};
  await fs.writeFile(path.join(f.record.path, WORKER_JOBS_FILE), JSON.stringify({version: 1, jobs: state === 'registry-active' ? {} : {job}, order: state.startsWith('orphan') || state === 'registry-active' ? [] : ['job']}));
  if (state === 'registry-active') await fs.writeFile(path.join(f.record.path, WORKER_FILE), JSON.stringify({version: 1, root: f.record.path, nativeThreadId: randomUUID(), status: 'active', activeJobId: 'unknown'}));
  await assert.rejects(f.service.invoke('editor.request', {id: f.record.id, request: request('__history/3/restore', 'POST', {})}), {code: 'ARTIFACT_BUSY'});
  assert.equal((await f.store.listSnapshots(f.record.id)).length, 0);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

for (const kind of ['design', 'dashboard']) test(`a historical ${kind} document requires an existing positive version and uses scoped boot plus packaged History only`, async t => {
  const f = await fixture(t, kind);
  for (const version of [0, -1, 1.5, '3', 1000000000]) await assert.rejects(f.service.invoke('editor.previewDocument', {id: f.record.id, channel, version}), {code: 'INVALID_EDITOR_PREVIEW'});
  await assert.rejects(f.service.invoke('editor.previewDocument', {id: f.record.id, channel, version: 2}), {code: 'EDITOR_PREVIEW_UNAVAILABLE'});
  const result = await f.service.invoke('editor.previewDocument', {id: f.record.id, channel, version: 3});
  assert.equal(result.transport, 'mcp');
  assert.equal(result.virtualBase, `https://codex-design.invalid/artifacts/${f.record.id}/v/3/`);
  assert.match(result.html, /"readOnly":true/); assert.match(result.html, /"canDraftComments":false/);
  assert.ok(result.html.includes(`"kind":"${kind}"`));
  assert.match(result.html, /codex-design:native-history-v1/);
  assert.equal(result.html.includes(f.origin), false, 'real loopback address must not become the editor base');
  assert.equal(/<script\b[^>]*\bsrc=/i.test(result.html), false);
  assert.equal(result.html.includes('var C=window.__baoyuShare??{},M=C.role==="owner";ce(M);ge(M);'), false, 'the raw Share/Presence bootstrap must not be started');
  assert.equal(f.calls.filter(call => call.path.endsWith('/__codex/boot.js')).at(-1).query.get('at'), '3');
  assert.equal(f.calls.some(call => /\/__share(?:\/|$)/.test(call.path)), false);
});

test('native requests retain validated client identity and passive reference response policies', async t => {
  const f = await fixture(t);
  const saved = await f.service.invoke('editor.request', {id: f.record.id, request: {path: '__deck/publish', method: 'POST', headers: {'content-type': 'application/json', 'x-deck-client': 'fixture_client_123'}, body: Buffer.from('{"files":{}}').toString('base64')}});
  assert.equal(saved.status, 200);
  assert.equal(f.calls.at(-1).headers['x-deck-client'], 'fixture_client_123');
  assert.equal(f.calls.at(-1).headers.origin, f.origin);
  for (const headers of [{authorization: 'must-not-forward'}, {cookie: 'must-not-forward'}, {'x-deck-client': 'invalid/id'}]) {
    const before = f.calls.length;
    await assert.rejects(f.service.invoke('editor.request', {id: f.record.id, request: {path: '__history', headers}}), {code: 'INVALID_EDITOR_REQUEST'});
    assert.equal(f.calls.length, before);
  }
  for (const forbidden of ['__share', '__share/archive', '%5f%5fshare/archive']) await assert.rejects(f.service.invoke('editor.request', {id: f.record.id, request: request(forbidden)}), {code: 'EDITOR_NETWORK_SHARING_UNAVAILABLE'});
  const reference = await f.service.invoke('editor.request', {id: f.record.id, request: request('__ds/nimbus/')});
  assert.match(reference.headers['content-security-policy'], /sandbox/);
  assert.equal(reference.headers['referrer-policy'], 'no-referrer');
  assert.equal(reference.headers['x-content-type-options'], 'nosniff');
});

test('Dashboard historical read and SSE requests use the captured at query while preserving their artwork base', async t => {
  const f = await fixture(t, 'dashboard');
  const read = await f.service.invoke('editor.request', {id: f.record.id, request: request('v/3/_api/doc?path=files%2Findex.html')});
  assert.equal(read.status, 200);
  assert.equal(JSON.parse(Buffer.from(read.body, 'base64')).data.capturedVersion, 3);
  assert.equal(f.calls.at(-1).path, f.basePath + '_api/doc');
  assert.equal(f.calls.at(-1).query.get('at'), '3');
  const overriding = await f.service.invoke('editor.request', {id: f.record.id, request: request('v/3/_api/doc?path=files%2Findex.html&at=999')});
  assert.equal(JSON.parse(Buffer.from(overriding.body, 'base64')).data.capturedVersion, 3);
  assert.equal(f.calls.at(-1).query.get('at'), '3');
  const opened = await f.service.invoke('editor.events.open', {id: f.record.id, path: 'v/3/_api/events?at=999'});
  try {
    const events = await f.service.invoke('editor.events.poll', {id: f.record.id, subscriptionId: opened.subscriptionId, cursor: 0});
    assert.equal(JSON.parse(events.events[0].data).capturedVersion, 3);
    assert.equal(f.calls.at(-1).path, f.basePath + '_api/events');
    assert.equal(f.calls.at(-1).query.get('at'), '3');
  } finally { await f.service.invoke('editor.events.close', {id: f.record.id, subscriptionId: opened.subscriptionId}); }
  const before = f.calls.length;
  await assert.rejects(f.service.invoke('editor.request', {id: f.record.id, request: request('v/3/_api/write', 'POST', {})}), error => ['EDITOR_PREVIEW_READ_ONLY', 'INVALID_EDITOR_PREVIEW', 'INVALID_EDITOR_REQUEST'].includes(error.code));
  assert.equal(f.calls.length, before);
});

test('the historical frontend cannot enable restoration, draft comments or issue writes', async () => {
  const callbacks = new Map(), sent = [];
  const id = randomUUID(), rootBaseUrl = `https://codex-design.invalid/artifacts/${id}/`;
  const parent = {postMessage: message => sent.push(message)};
  const target = {parent, fetch: async () => assert.fail('historical reads must use the scoped bridge'), addEventListener: (name, callback) => callbacks.set(name, callback), btoa, atob};
  installNativeEditorTransport({artifactId: id, baseUrl: rootBaseUrl + 'v/3/', rootBaseUrl, requestPrefix: 'v/3/', readOnly: true, canDraftComments: true, channel}, target);
  target.__baoyuHistory = {base: '/private/upstream/base/', canRestore: true, preview: {n: 3, current_url: '/private/upstream/base/'}};
  assert.equal(target.__baoyuHistory.canRestore, false);
  assert.equal(target.__baoyuHistory.base, new URL(rootBaseUrl + 'v/3/').pathname);
  assert.equal(target.__baoyuHistory.preview.current_url, rootBaseUrl);
  assert.equal(target.__CODEX_DESIGN_EDITOR_TRANSPORT__.canDraftComments, false);
  const count = sent.length;
  await assert.rejects(target.fetch('__deck/publish', {method: 'POST', body: '{}'}), {code: 'EDITOR_PREVIEW_READ_ONLY'});
  assert.equal(sent.length, count);
});

for (const kind of ['design', 'dashboard']) test(`the ${kind} frontend projects History addresses and capabilities into its virtual artwork scope`, async () => {
  const callbacks = new Map(), sent = [];
  const id = randomUUID(), base = `https://codex-design.invalid/artifacts/${id}/`;
  const serverPath = kind === 'dashboard' ? '/dashboard/stable-fixture/' : '/design/secret-fixture-grant/';
  const preview = kind === 'dashboard' ? `${serverPath}?at=3` : `${serverPath}v/3/`;
  const parent = {postMessage(message) {
    sent.push(message);
    if (message.type !== 'codex-design:editor-request') return;
    queueMicrotask(() => callbacks.get('message')({source: parent, data: {type: 'codex-design:editor-response', channel, requestId: message.requestId,
      result: {status: 200, headers: {'content-type': 'application/json'}, body: Buffer.from(JSON.stringify({rows: [{n: 3, preview}]})).toString('base64')}}}));
  }};
  const target = {parent, fetch: async () => assert.fail('native reads must use the scoped bridge'), addEventListener: (name, callback) => callbacks.set(name, callback), btoa, atob};
  installNativeEditorTransport({artifactId: id, kind, baseUrl: base, rootBaseUrl: base, serverPath, channel}, target);
  target.__baoyuHistory = {base: serverPath, canRestore: true, preview: {n: 3, current_url: serverPath}};
  assert.equal(target.__baoyuHistory.base, new URL(base).pathname);
  assert.equal(target.__baoyuHistory.preview.current_url, base);
  const response = await target.fetch('__history');
  assert.equal(response.url, base + '__history');
  assert.equal((await response.json()).rows[0].preview, base + 'v/3/');
});
