import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { createEditorTransport, editorRequestUrl, isValidBase64 } from '../source/server/editor-transport.mjs';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { mountNativeEditor } from '../source/ui/native-editor.mjs';

async function editor(t) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const bytes = Buffer.concat(body);
    const binary = request.headers['content-type'] === 'application/octet-stream';
    calls.push({ path: request.url, method: request.method, origin: request.headers.origin, body: binary ? '[binary]' : bytes.toString() });
    if (request.url === '/granted/session/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': heartbeat\n\nevent: comments\ndata: {"items":["saved"]}\n\n');
      return;
    }
    if (request.url === '/granted/session/redirect') { response.writeHead(302, { location: '/outside-grant' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', etag: '"revision-2"' });
    response.end(JSON.stringify({ saved: request.method === 'POST', ...(binary ? { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } : {}) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/granted/session/`;
  const transport = createEditorTransport({ editorFor: async id => { assert.equal(id, 'artwork-one'); return { url: base }; } });
  t.after(() => transport.dispose());
  return { transport, calls, base };
}

test('permitted multi-megabyte editor payloads validate without a recursive regex stack overflow', () => {
  assert.equal(isValidBase64(Buffer.alloc(4 * 1024 * 1024, 0xab).toString('base64')), true);
  for (const value of ['A', 'AAA', 'A===', 'AA=A', 'AA==AAAA', 'AAA-', 'AA\n=']) assert.equal(isValidBase64(value), false, value);
  for (const value of ['', 'AA==', 'AAA=', 'AAAA']) assert.equal(isValidBase64(value), true, value);
});

test('native editor broker reads and writes only its authenticated artwork HTTP subtree', async t => {
  const f = await editor(t);
  const result = await f.transport.request('artwork-one', { path: '__deck/publish', method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"title":"Saved"}').toString('base64') });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(result.body, 'base64')), { saved: true });
  assert.equal(result.headers.etag, '"revision-2"');
  assert.deepEqual(f.calls, [{ path: '/granted/session/__deck/publish', method: 'POST', origin: new URL(f.base).origin, body: '{"title":"Saved"}' }]);
  for (const path of ['../outside', '%2e%2e/outside', '%252e%252e/outside', '/outside', '//example.com/', 'https://example.com/', 'safe\\..\\outside', 'safe%2f..%2foutside', '__deck/events#fragment']) {
    assert.throws(() => editorRequestUrl(f.base, path), { code: 'INVALID_EDITOR_REQUEST' });
  }
  await assert.rejects(f.transport.request('artwork-one', { path: 'safe', headers: { authorization: 'not-accepted' } }), { code: 'INVALID_EDITOR_REQUEST' });
  await assert.rejects(f.transport.request('artwork-one', { path: 'redirect' }));
  assert.equal(f.calls.some(call => call.path === '/outside-grant'), false);
});

test('native editor live events retain snapshots and enforce artwork ownership when polling', async t => {
  const f = await editor(t);
  const opened = await f.transport.openEvents('artwork-one', 'events');
  const first = await f.transport.pollEvents('artwork-one', opened.subscriptionId, 0);
  assert.equal(first.ended, false);
  assert.deepEqual(first.events.map(event => ({ type: event.event, data: JSON.parse(event.data) })), [{ type: 'comments', data: { items: ['saved'] } }]);
  await assert.rejects(f.transport.pollEvents('artwork-two', opened.subscriptionId, 0), { code: 'EDITOR_SUBSCRIPTION_UNAVAILABLE' });
  assert.deepEqual(await f.transport.pollEvents('artwork-one', opened.subscriptionId, 0), first);
  await f.transport.closeEvents('artwork-one', opened.subscriptionId);
  await assert.rejects(f.transport.pollEvents('artwork-one', opened.subscriptionId, first.cursor), { code: 'EDITOR_SUBSCRIPTION_UNAVAILABLE' });
});

test('a real four-MiB binary artwork upload survives the scoped proxy byte-for-byte', async t => {
  const f = await editor(t);
  const bytes = Buffer.alloc(4 * 1024 * 1024, 0xab);
  const response = await f.transport.request('artwork-one', { path: '__deck/assets', method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes.toString('base64') });
  const result = JSON.parse(Buffer.from(response.body, 'base64'));
  assert.equal(result.bytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('the editor fetch adapter roundtrips binary content through MCP without a browser HTTP request', async () => {
  const callbacks = new Map(), requests = [];
  const parent = { postMessage(message) {
    requests.push(message);
    queueMicrotask(() => callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-response', channel: 'channel-test', requestId: message.requestId, result: { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from([0, 255, 42]).toString('base64') } } }));
  } };
  const target = { parent, fetch: async () => { throw new Error('A native editor must not make a local browser HTTP request.'); },
    addEventListener: (type, listener) => callbacks.set(type, listener), btoa, atob };
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', artifactId: 'one', channel: 'channel-test', language: 'zh' }, target);
  const response = await target.fetch('project/image.png');
  assert.equal(response.url, 'https://codex-design.invalid/artifacts/one/project/image.png');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 255, 42]);
  assert.equal(requests[1].action, 'editor.request');
  assert.equal(requests[1].payload.request.path, 'project/image.png');
  await target.fetch('/_api/session');
  assert.equal(requests.at(-1).payload.request.path, '_api/session');
  await target.fetch('/_blob/0123456789abcdef0123456789abcdef');
  assert.equal(requests.at(-1).payload.request.path, '_blob/0123456789abcdef0123456789abcdef');
  assert.equal(target.__CODEX_DESIGN_EDITOR_I18N__.preference, 'zh');
});

test('native local download capabilities wait for the host save result and propagate cancellation', async () => {
  const callbacks = new Map(), sent = [];
  const parent = { postMessage: message => sent.push(message) };
  const target = { parent, fetch: async () => {}, addEventListener: (type, listener) => callbacks.set(type, listener), btoa, atob };
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'download-channel' }, target);
  target.designHost = { artifact: {}, downloads: { save: async () => { throw new Error('The unawaited browser anchor fallback must not be used.'); } } };
  let completed = false;
  const save = target.designHost.downloads.save({ filename: 'artwork.png', data: new Blob([new Uint8Array([0, 255, 42])], { type: 'image/png' }) }).then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  const request = sent.at(-1);
  assert.equal(request.action, 'editor.download');
  assert.equal(request.payload.mimeType, 'image/png');
  assert.deepEqual([...Buffer.from(request.payload.base64, 'base64')], [0, 255, 42]);
  callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-response', channel: 'download-channel', requestId: request.requestId, result: { saved: true } } });
  assert.deepEqual(await save, { saved: true });
  const cancelled = target.designHost.downloads.save({ filename: 'cancelled.txt', data: new Blob(['text']) });
  await new Promise(resolve => setImmediate(resolve));
  callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-response', channel: 'download-channel', requestId: sent.at(-1).requestId, error: { code: 'DOWNLOAD_CANCELLED', message: 'Cancelled.' } } });
  await assert.rejects(cancelled, { code: 'declined' });
});

test('the native bootstrap refuses a same-origin parent instead of exposing the MCP bridge', () => {
  const sent = [];
  const target = { document: {}, parent: { document: {}, postMessage: message => sent.push(message) } };
  assert.throws(() => installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'isolated-test' }, target), { name: 'SecurityError' });
  assert.equal(sent[0].type, 'codex-design:editor-diagnostic');
  assert.equal(sent.some(message => message.type === 'codex-design:editor-transport-ready'), false);
});

test('React srcdoc attributes receive one preview adapter while canonical source and unrelated attributes stay unchanged', () => {
  class Element {
    constructor() { this.attributes = {}; }
    setAttribute(name, value) { this.attributes[String(name).toLowerCase()] = String(value); }
  }
  class Frame extends Element {}
  const setAttribute = Element.prototype.setAttribute;
  Object.defineProperty(Frame.prototype, 'srcdoc', { configurable: true, get() { return this.attributes.srcdoc || ''; }, set(value) { setAttribute.call(this, 'srcdoc', value); } });
  const target = { parent: { postMessage() {} }, fetch: async () => {}, addEventListener() {}, btoa, atob, Element, HTMLIFrameElement: Frame };
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'preview-test' }, target);
  const frame = new Frame();
  const source = '<html><head></head><body><img src="/_blob/0123456789abcdef0123456789abcdef"></body></html>';
  frame.setAttribute('srcDoc', source);
  assert.equal(frame.srcdoc, source);
  assert.equal((frame.attributes.srcdoc.match(/data-codex-native-preview-transport/g) || []).length, 1);
  frame.setAttribute('srcdoc', frame.attributes.srcdoc);
  assert.equal(frame.srcdoc, source);
  assert.equal((frame.attributes.srcdoc.match(/data-codex-native-preview-transport/g) || []).length, 1);
  const ordinary = new Element(); ordinary.setAttribute('data-other', 'unchanged');
  assert.equal(ordinary.attributes['data-other'], 'unchanged');
});

test('the exact packaged DS React URLs become ordered offline scripts without changing canonical component source or SRI', () => {
  class Element { constructor() { this.attributes = {}; } setAttribute(name, value) { this.attributes[name] = value; } }
  class Frame extends Element {}
  const set = Element.prototype.setAttribute;
  Object.defineProperty(Frame.prototype, 'srcdoc', { configurable: true, get() { return this.attributes.srcdoc || ''; }, set(value) { set.call(this, 'srcdoc', value); } });
  const target = { parent: { postMessage() {} }, fetch: async () => {}, addEventListener() {}, btoa, atob, Element, HTMLIFrameElement: Frame };
  const react = 'data:text/javascript;base64,' + Buffer.from('window.React={createElement(){}};').toString('base64');
  const dom = 'data:text/javascript;base64,' + Buffer.from('window.ReactDOM={};').toString('base64');
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'vendor-test', previewVendors: [
    { file: 'react.production.min.js', url: react }, { file: 'react-dom.production.min.js', url: dom },
  ] }, target);
  const source = '<html><head><script src="/artifacts/one/artifact-type/vendor/react.production.min.js" integrity="sha384-original"></script><script src="/artifact-type/vendor/react-dom.production.min.js"></script><script>window.RunComponent();</script></head></html>';
  const frame = new Frame(); frame.srcdoc = source;
  assert.equal(frame.srcdoc, source);
  assert.ok(frame.attributes.srcdoc.includes('src="' + react + '"'));
  assert.ok(frame.attributes.srcdoc.includes('src="' + dom + '"'));
  assert.ok(frame.attributes.srcdoc.indexOf(react) < frame.attributes.srcdoc.indexOf(dom));
  assert.ok(frame.attributes.srcdoc.indexOf(dom) < frame.attributes.srcdoc.indexOf('window.RunComponent()'));
  assert.ok(frame.attributes.srcdoc.includes('integrity="sha384-original"'));
});

test('the isolated editor supplies standards-shaped UUID v4 ids from getRandomValues when randomUUID is unavailable', () => {
  const target = { parent: { postMessage() {} }, fetch: async () => {}, addEventListener() {}, btoa, atob,
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } };
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'uuid-test' }, target);
  const ids = Array.from({ length: 20 }, () => target.crypto.randomUUID());
  assert.equal(new Set(ids).size, 20);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the parent frame broker rejects another frame and cannot be redirected to another artwork', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let listener;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_, value) => { listener = value; }, removeEventListener() {} } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
  const calls = [], replies = [], attributes = {};
  const iframe = { setAttribute: (name, value) => { attributes[name] = value; }, contentWindow: { postMessage: message => replies.push(message) } };
  const instance = mountNativeEditor({ iframe, bridge: { invoke: async (action, payload) => { calls.push({ action, payload }); return { status: 200 }; } }, artifactId: 'fixed-artwork', channel: 'channel', document: { html: '<!doctype html><body>设计作品</body>' } });
  t.after(() => instance.dispose());
  const data = { type: 'codex-design:editor-request', channel: 'channel', requestId: '1', action: 'editor.request', payload: { id: 'other-artwork', request: { path: 'safe' } } };
  await listener({ source: {}, data });
  await listener({ source: iframe.contentWindow, data: { ...data, channel: 'wrong-channel' } });
  assert.equal(calls.length, 0);
  await listener({ source: iframe.contentWindow, data });
  assert.deepEqual(calls, [{ action: 'editor.request', payload: { id: 'fixed-artwork', request: { path: 'safe' } } }]);
  assert.equal(replies[0].result.status, 200);
  assert.equal(attributes.sandbox.includes('allow-same-origin'), true);
  assert.equal(attributes.sandbox.includes('allow-forms'), true);
  assert.equal(attributes.sandbox.includes('allow-popups'), false);
  assert.equal(attributes.sandbox.includes('allow-top-navigation'), false);
  assert.ok(iframe.src.startsWith('data:text/html;base64,'));
  assert.ok(iframe.src.length < 4096, 'The browser navigation URL contains only a tiny isolated loader.');
  await listener({ source: iframe.contentWindow, data: { type: 'codex-design:editor-document-request', channel: 'channel' } });
  assert.match(replies.at(-1).html, /设计作品/);
  assert.equal(iframe.srcdoc, undefined, 'A same-origin-enabled srcdoc editor could access its MCP host and is forbidden.');
  const loader = Buffer.from(iframe.src.split(',')[1], 'base64').toString('utf8');
  assert.ok(loader.includes('content="form-action &#39;none&#39;"'));
  const code = /<script>([\s\S]*)<\/script>/.exec(loader)[1];
  const writes = [], requests = [];
  let receiver;
  const parent = { postMessage: message => requests.push(message) };
  const forwarded = [];
  const innerAttributes = {};
  const inner = { setAttribute(name, value) { innerAttributes[name] = value; }, contentWindow: { postMessage: message => forwarded.push(message) }, set srcdoc(value) { writes.push(value); } };
  const target = { parent, addEventListener: (_, callback) => { receiver = callback; }, removeEventListener() {} };
  vm.runInNewContext(code, { window: target, document: { createElement: () => inner, body: { appendChild() {} } } });
  assert.equal(requests[0].type, 'codex-design:editor-document-request');
  const payload = { type: 'codex-design:editor-document', channel: 'channel', html: '<body>isolated editor</body>' };
  receiver({ source: {}, data: payload });
  receiver({ source: parent, data: { ...payload, channel: 'forged' } });
  receiver({ source: parent, data: { ...payload, html: 'x'.repeat(24 * 1024 * 1024 + 1) } });
  assert.deepEqual(writes, []);
  receiver({ source: parent, data: payload });
  receiver({ source: parent, data: { ...payload, html: '<body>second document refused</body>' } });
  assert.deepEqual(writes, [payload.html]);
  assert.ok(innerAttributes.sandbox.includes('allow-forms'));
  assert.equal(innerAttributes.sandbox.includes('allow-top-navigation'), false);
  const outgoing = { type: 'codex-design:editor-request', channel: 'channel', requestId: 'inner-1', action: 'editor.request', payload: {} };
  receiver({ source: {}, data: outgoing });
  assert.equal(requests.length, 1);
  receiver({ source: inner.contentWindow, data: { ...outgoing, type: 'unapproved-transport' } });
  assert.equal(requests.length, 1);
  receiver({ source: inner.contentWindow, data: outgoing });
  assert.equal(requests.length, 2);
  receiver({ source: parent, data: { type: 'codex-design:editor-response', channel: 'channel', requestId: 'inner-1', result: {} } });
  assert.equal(forwarded.length, 1);
});

test('SHA-256 and preview-only embedded asset URLs roundtrip without persisting data URLs, including cache eviction', async () => {
  const callbacks = new Map(), requests = [];
  const assets = Array.from({ length: 129 }, (_, index) => {
    const bytes = Buffer.from('artwork asset ' + index);
    return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 32), bytes };
  });
  const parent = { postMessage(message) {
    if (message.type !== 'codex-design:editor-request') return;
    requests.push(message);
    let result;
    if (message.action === 'editor.digest') result = { base64: createHash('sha256').update(Buffer.from(message.payload.base64, 'base64')).digest('base64') };
    else {
      const id = message.payload.request.path.split('/')[1];
      const asset = assets.find(value => value.id === id);
      result = { status: 200, headers: { 'content-type': asset ? 'image/png' : 'application/json' }, body: asset ? asset.bytes.toString('base64') : Buffer.from('{}').toString('base64') };
    }
    queueMicrotask(() => callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-response', channel: 'asset-channel', requestId: message.requestId, result } }));
  } };
  const target = { parent, fetch: async () => { throw new Error('No browser HTTP requests are permitted.'); }, addEventListener: (type, listener) => callbacks.set(type, listener), btoa, atob,
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } };
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', artifactId: 'one', channel: 'asset-channel' }, target);
  const digest = await target.crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
  assert.equal(Buffer.from(digest).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(target.crypto.subtle.digest('SHA-1', new Uint8Array()), { name: 'NotSupportedError' });
  let first;
  for (const asset of assets) {
    const embedded = await target.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__('/_blob/' + asset.id);
    if (!first) first = embedded;
  }
  const text = '<img src="' + first + '"><h1>Edited heading</h1>';
  await target.fetch('__deck/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: { 'project/Main.dc.html': { base64: Buffer.from(text).toString('base64'), contentType: 'text/html' } } }) });
  const published = JSON.parse(Buffer.from(requests.at(-1).payload.request.body, 'base64'));
  const html = Buffer.from(published.files['project/Main.dc.html'].base64, 'base64').toString();
  assert.match(html, new RegExp('/_blob/' + assets[0].id));
  assert.equal(html.includes('data:image'), false);
  assert.match(html, /Edited heading/);
  assert.ok(requests.filter(request => request.action === 'editor.digest').length >= 2, 'Evicted aliases are recovered from their content hash instead of unbounded URL retention.');
});

test('an editor transport handshake does not conceal a frame that never mounts its real editor controls', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let listener;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_, value) => { listener = value; }, removeEventListener() {} } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
  const failures = [];
  const iframe = { setAttribute() {}, contentWindow: { postMessage() {} } };
  const handle = mountNativeEditor({ iframe, bridge: { invoke() {} }, artifactId: 'fixed-artwork', channel: 'ready-test', document: { html: '<html><body><div id="root" data-placeholder></div></body></html>' }, startupTimeoutMs: 10, onError: error => failures.push(error) });
  await listener({ source: iframe.contentWindow, data: { type: 'codex-design:editor-transport-ready', channel: 'ready-test' } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(failures.map(error => error.code), ['EDITOR_START_TIMEOUT']);
  handle.dispose();
});

test('the editor flush acknowledgement waits for the captured original publish queue and reports failure honestly', async () => {
  const callbacks = new Map(), sent = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const parent = { postMessage: message => sent.push(message) };
  const target = { parent, fetch: async () => {}, addEventListener: (type, listener) => callbacks.set(type, listener), btoa, atob,
    __CODEX_DESIGN_EDITOR_FLUSH__: async () => { await gate; return true; } };
  installNativeEditorTransport({ baseUrl: 'https://codex-design.invalid/artifacts/one/', artifactId: 'one', channel: 'flush-channel' }, target);
  callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-flush', channel: 'flush-channel', requestId: 'flush-1' } });
  await Promise.resolve();
  assert.equal(sent.some(message => message.type === 'codex-design:editor-flushed'), false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).saved, true);
  target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => false;
  callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-flush', channel: 'flush-channel', requestId: 'flush-2' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.at(-1).saved, false);
  assert.equal(sent.at(-1).error.code, 'EDITOR_UNSAVED_CHANGES');
});

test('a mounted native editor cannot acknowledge unsaved navigation until its exact frame confirms saving', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let listener;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_, value) => { listener = value; }, removeEventListener() {} } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
  const sent = [];
  const iframe = { setAttribute() {}, contentWindow: { postMessage: message => sent.push(message) } };
  const handle = mountNativeEditor({ iframe, bridge: { invoke() {} }, artifactId: 'fixed-artwork', channel: 'flush-channel', document: { html: '<html><body>editor</body></html>' } });
  await listener({ source: iframe.contentWindow, data: { type: 'codex-design:editor-app-ready', channel: 'flush-channel' } });
  const saved = handle.flush();
  const request = sent.at(-1);
  assert.equal(request.type, 'codex-design:editor-flush');
  await listener({ source: {}, data: { type: 'codex-design:editor-flushed', channel: 'flush-channel', requestId: request.requestId, saved: true } });
  await listener({ source: iframe.contentWindow, data: { type: 'codex-design:editor-flushed', channel: 'flush-channel', requestId: request.requestId, saved: false, error: { code: 'EDITOR_UNSAVED_CHANGES', message: 'Still saving.' } } });
  await assert.rejects(saved, { code: 'EDITOR_UNSAVED_CHANGES' });
  handle.dispose();
});
