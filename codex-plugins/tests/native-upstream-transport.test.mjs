import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { createEditorTransport, editorRequestUrl, validateEditorRequest } from '../source/server/editor-transport.mjs';

const root = 'https://codex-design.invalid/artifacts/11111111-1111-4111-8111-111111111111/';
const serverPath = '/design/authenticated-grant/';
const encoded = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');

function fixture(options = {}, handler = () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: encoded({ ok: true }) }), { configure, previewInstaller } = {}) {
  const listeners = new Map(), requests = [], external = [];
  const configuration = { baseUrl: root, rootBaseUrl: root, serverPath, artifactId: '11111111-1111-4111-8111-111111111111',
    channel: 'native-upstream-test-channel', language: 'en', ...options };
  const emit = (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const answer = (message, value, source = parent, channel = configuration.channel) => emit('message', {
    source, data: { type: 'codex-design:editor-response', channel, requestId: message.requestId, ...value },
  });
  const parent = { postMessage(message) {
    requests.push(message);
    if (message.type !== 'codex-design:editor-request') return;
    const result = handler(message, answer);
    if (result !== undefined) queueMicrotask(() => answer(message, result?.error ? result : { result }));
  } };
  const target = { parent, btoa, atob, Event,
    fetch: async (...args) => { external.push(args); return new Response('external'); },
    addEventListener(type, listener) { const group = listeners.get(type) ?? []; group.push(listener); listeners.set(type, group); },
    dispatchEvent(event) { emit(event.type, event); return !event.defaultPrevented; },
  };
  configure?.(target, parent);
  // The real bootstrap is serialized by editor.document, so it may not depend
  // on module closures. No browser, model or artifact files are involved here.
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(' + JSON.stringify(configuration) + ',target,previewInstaller);', {
    target, previewInstaller, URL, Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, Blob, DOMException, Event, EventTarget, MessageEvent,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  return { target, parent, requests, external, emit, answer, configuration,
    calls: () => requests.filter(message => message.type === 'codex-design:editor-request'),
    dispose: () => emit('unload', {}),
  };
}

test('head bootstrap waits for body before installing preview UI and cancels deferred setup on unload', () => {
  let installed = 0, released = 0, styled;
  const dom = new Map();
  const f = fixture({}, undefined, {
    configure(target, parent) {
      for (const property of ['document', 'codexDesignBridge']) Object.defineProperty(parent, property, { get() { throw new DOMException('Opaque parent', 'SecurityError'); } });
      target.document = { body: null, addEventListener: (name, fn) => dom.set(name, fn), removeEventListener: name => dom.delete(name) };
    },
    previewInstaller() { installed++; return { updateHostContext: value => { styled = value; }, dispose: () => { released++; } }; },
  });
  assert.equal(installed, 0);
  assert.ok(dom.has('DOMContentLoaded'));
  f.emit('message', { source: f.parent, data: { type: 'codex-design:host-context-changed', channel: f.configuration.channel, context: { theme: 'dark', styles: { variables: { '--font-sans': 'QA Sans' } } } } });
  f.target.document.body = {};
  dom.get('DOMContentLoaded')();
  assert.equal(installed, 1);
  assert.equal(styled.theme, 'dark');
  dom.get('DOMContentLoaded')();
  assert.equal(installed, 1);
  f.dispose();
  assert.equal(released, 1);
  assert.equal(dom.has('DOMContentLoaded'), false);

  let late, lateInstall = 0;
  const second = fixture({}, undefined, {
    configure(target, parent) {
      for (const property of ['document', 'codexDesignBridge']) Object.defineProperty(parent, property, { get() { throw new DOMException('Opaque parent', 'SecurityError'); } });
      target.document = { body: null, addEventListener: (_name, fn) => { late = fn; }, removeEventListener() {} };
    },
    previewInstaller() { lateInstall++; return {}; },
  });
  second.dispose(); second.target.document.body = {}; late();
  assert.equal(lateInstall, 0);
});

test('serialized History boot metadata receives virtual paths without changing unrelated labels', t => {
  const f = fixture(); t.after(f.dispose);
  f.target.__baoyuHistory = { base: serverPath, canRestore: true, title: '中文作品',
    preview: { n: 12, current_url: 'http://127.0.0.1:4710/design/authenticated-grant/', by: 'agent' } };
  assert.equal(f.target.__baoyuHistory.base, new URL(root).pathname);
  assert.equal(f.target.__baoyuHistory.canRestore, true);
  assert.equal(f.target.__baoyuHistory.title, '中文作品');
  assert.equal(f.target.__baoyuHistory.preview.current_url, root);
  assert.equal(f.target.__baoyuHistory.preview.n, 12);
  assert.equal(f.target.__baoyuHistory.preview.by, 'agent');
  for (const invalid of [null, [], {}, { base: 12 }]) assert.throws(() => { f.target.__baoyuHistory = invalid; }, { name: 'TypeError' });
});

test('the read-only version bootstrap prefixes known content endpoints and removes write/draft capabilities', async t => {
  const f = fixture({ baseUrl: root + 'v/12/', requestPrefix: 'v/12/', readOnly: true, canDraftComments: true }); t.after(f.dispose);
  f.target.__baoyuHistory = { base: serverPath, canRestore: true, preview: { current_url: 'unsafe-current' } };
  assert.equal(f.target.__CODEX_DESIGN_EDITOR_TRANSPORT__.readOnly, true);
  assert.equal(f.target.__CODEX_DESIGN_EDITOR_TRANSPORT__.canDraftComments, false);
  assert.equal(f.target.__baoyuHistory.canRestore, false);
  assert.equal(f.target.__baoyuHistory.base, new URL(root + 'v/12/').pathname);
  assert.equal(f.target.__baoyuHistory.preview.current_url, root);
  for (const [url, expected] of [
    ['_files.json', 'v/12/_files.json'],
    [root + 'v/12/project/canvas.json', 'v/12/project/canvas.json'],
    ['/_api/session', 'v/12/_api/session'],
    ['/_blob/0123456789abcdef0123456789abcdef', 'v/12/_blob/0123456789abcdef0123456789abcdef'],
    ['__history?limit=8', 'v/12/__history?limit=8'],
  ]) {
    await f.target.fetch(url);
    assert.equal(f.calls().at(-1).payload.request.path, expected);
  }
  const before = f.calls().length;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(f.target.fetch('/_api/write', { method, body: '{}' }), { code: 'EDITOR_PREVIEW_READ_ONLY' });
    await assert.rejects(f.target.fetch('https://fonts.googleapis.com/unrelated', { method, body: '{}' }), { code: 'EDITOR_PREVIEW_READ_ONLY' });
  }
  assert.equal(f.calls().length, before, 'a refused write sends no parent RPC');
  assert.deepEqual(f.external, []);
});

test('a History restore flushes current drafts before becoming a pending write', { timeout: 2000 }, async t => {
  const f = fixture(); t.after(f.dispose);
  let finish;
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = () => new Promise(resolve => { finish = resolve; });
  const restored = f.target.fetch('__history/1/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['project/a.dc.html'] }) });
  await setImmediate();
  assert.equal(f.calls().length, 0);
  finish(true);
  assert.equal((await restored).status, 200);
  assert.equal(f.calls().length, 1);
  assert.equal(f.calls()[0].payload.request.path, '__history/1/restore');
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => false;
  await assert.rejects(f.target.fetch('__history/notice/notice-1/recover', { method: 'POST', body: '{}' }), /unsaved changes/);
  assert.equal(f.calls().length, 1, 'a refused save never sends the recovery');
});

test('the read-only canonical preview close callback has only its fixed parent channel and is removed on unload', () => {
  const f = fixture({ baseUrl: root + 'v/12/', requestPrefix: 'v/12/', readOnly: true });
  f.target.__CODEX_DESIGN_PREVIEW_CLOSE__();
  const closed = f.requests.filter(message => message.type === 'codex-design:preview-close');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].channel, f.configuration.channel);
  assert.equal(f.calls().length, 0);
  f.dispose();
  assert.equal(f.target.__CODEX_DESIGN_PREVIEW_CLOSE__, undefined);
});

test('invalid version prefixes cannot create a writable or escaping preview transport', () => {
  for (const requestPrefix of ['v/0/', 'v/-1/', 'v/1', '/v/1/', 'v/1000000000/', 'v/1/../', '__history/']) {
    assert.throws(() => fixture({ readOnly: true, requestPrefix }), { name: 'TypeError' });
  }
  assert.throws(() => fixture({ requestPrefix: 'v/1/' }), { name: 'TypeError' });
});

test('History rows normalize only validated current-artwork version URLs', async t => {
  const rows = [
    { n: 1, preview: serverPath + 'v/1/' }, { n: 8, preview: 'v/8/' },
    { n: 0, preview: serverPath + 'v/0/' }, { n: 9, preview: '/another-artwork/v/9/' },
    { n: 4, preview: 'https://example.test/v/4/' }, { n: 5, preview: { opaque: true } },
  ];
  const f = fixture({}, () => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: encoded({ rows, canRestore: true }) })); t.after(f.dispose);
  const result = await (await f.target.fetch('__history')).json();
  assert.equal(result.rows[0].preview, root + 'v/1/');
  assert.equal(result.rows[1].preview, root + 'v/8/');
  for (let index = 2; index < rows.length; index++) assert.deepEqual(result.rows[index].preview, rows[index].preview);
  assert.equal(result.canRestore, true);
  assert.deepEqual(f.external, []);
});

test('History protocol errors preserve original HTTP bytes and parent failure codes', async t => {
  const malformed = fixture({}, () => ({ status: 502, headers: { 'content-type': 'application/json' }, body: encoded('not json') })); t.after(malformed.dispose);
  const response = await malformed.target.fetch('__history');
  assert.equal(response.status, 502); assert.equal(await response.text(), 'not json');
  const refused = fixture({}, () => ({ error: { code: 'ARTIFACT_BUSY', message: 'Another native job owns this artwork.' } })); t.after(refused.dispose);
  await assert.rejects(refused.target.fetch('__history/1/restore', { method: 'POST', body: '{}' }), { code: 'ARTIFACT_BUSY' });
});

test('a wrong parent or channel cannot complete a History request', async t => {
  const f = fixture({}, () => undefined); t.after(f.dispose);
  let completed = false;
  const task = f.target.fetch('__history').then(value => { completed = true; return value; });
  const call = f.calls().at(-1), response = { result: { status: 200, headers: {}, body: encoded('{}') } };
  f.answer(call, response, {}, f.configuration.channel);
  f.answer(call, response, f.target.parent, 'wrong-channel');
  await setImmediate(); assert.equal(completed, false);
  f.answer(call, response);
  assert.equal((await task).status, 200);
});

test('the scoped server proxy preserves client attribution and read-only response security headers', async t => {
  const sent = [];
  const transport = createEditorTransport({ editorFor: async () => ({ url: 'http://127.0.0.1:4710' + serverPath }),
    fetcher: async (url, options) => { sent.push({ url: String(url), ...options }); return new Response('<h1>Read-only tokens</h1>', { headers: {
      'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'none'", 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'set-cookie': 'not-forwarded', server: 'not-forwarded',
    } }); } });
  t.after(() => transport.dispose());
  const result = await transport.request('artwork', { path: '__ds/reference/', headers: { 'X-Deck-Client': 'native-client-1' } });
  assert.equal(sent[0].url, 'http://127.0.0.1:4710' + serverPath + '__ds/reference/');
  assert.equal(sent[0].headers.get('x-deck-client'), 'native-client-1');
  assert.equal(sent[0].headers.get('origin'), 'http://127.0.0.1:4710');
  assert.equal(result.headers['content-security-policy'], "default-src 'none'; script-src 'none'");
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers.server, undefined);
  assert.equal(Buffer.from(result.body, 'base64').toString(), '<h1>Read-only tokens</h1>');
  for (const headers of [{ authorization: 'forbidden' }, { 'x-deck-client': 'line\nbreak' }, { 'x-deck-client': 'x'.repeat(4097) }]) {
    assert.throws(() => validateEditorRequest({ headers }), { code: 'INVALID_EDITOR_REQUEST' });
  }
});

test('native network-sharing and raw archive endpoints are refused including encoded aliases', () => {
  const base = 'http://127.0.0.1:4710' + serverPath;
  for (const relative of ['__share/status', '__share/archive', '%5f%5fshare/status', '%2f__share/archive', '__share//action']) {
    assert.throws(() => editorRequestUrl(base, relative), { code: 'EDITOR_NETWORK_SHARING_UNAVAILABLE' });
  }
  for (const relative of ['../outside', '%2e%2e/outside', 'https://example.test/', 'v/1/%252e%252e/escape']) {
    assert.throws(() => editorRequestUrl(base, relative), { code: 'INVALID_EDITOR_REQUEST' });
  }
});
