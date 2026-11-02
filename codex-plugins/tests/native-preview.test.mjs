import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { installNativePreviews } from '../source/scripts/native-preview.mjs';
import { buildEditorDocument } from '../source/server/editor-document.mjs';

const baseUrl = 'https://codex-design.invalid/artifacts/11111111-2222-4333-8444-555555555555/';
const subscription = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const encode = value => Buffer.from(value).toString('base64');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// Minimal browser contracts, not a second implementation of the preview
// controller. Native rendering and the real DOM parser remain host checks.
class Emitter {
  handlers = new Map();
  addEventListener(type, callback) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(callback); }
  removeEventListener(type, callback) { this.handlers.get(type)?.delete(callback); }
  async emit(type, event) { await Promise.all([...(this.handlers.get(type) || [])].map(callback => callback(event))); }
}
class Element extends Emitter {
  constructor(name, document) { super(); this.localName = name; this.ownerDocument = document; this.nodeType = 1; this.attrs = new Map(); this.children = []; this.style = {}; this.textContent = ''; if (name === 'iframe') this.contentWindow = new Window(); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  get isConnected() { return this === this.ownerDocument?.documentElement || Boolean(this.parentNode?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove?.(); this.children.push(node); node.parentNode = this; } }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove?.(); this.children.unshift(node); node.parentNode = this; } }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = undefined; } }
  focus() { this.ownerDocument.activeElement = this; }
  get outerHTML() { return `<${this.localName}${[...this.attrs].map(([name, value]) => ` ${name}="${escape(value)}"`).join('')}>${escape(this.textContent)}${this.children.map(node => node.outerHTML).join('')}</${this.localName}>`; }
}
class Document extends Emitter {
  constructor() { super(); this.documentElement = new Element('html', this); this.head = new Element('head', this); this.body = new Element('body', this); this.documentElement.append(this.head, this.body); this.activeElement = this.body; }
  createElement(name) { return new Element(name, this); }
  querySelectorAll(selector) {
    const names = selector.split(','), found = [];
    const walk = element => { if (selector === '*' || names.includes(element.localName) || selector.startsWith('[') && element.hasAttribute(selector.slice(1, -1))) found.push(element); for (const child of element.children) walk(child); };
    walk(this.documentElement); return found;
  }
}
class Window extends Emitter {
  messages = [];
  postMessage(message, origin) { this.messages.push({ message, origin }); }
}
function unsafeReference() {
  const parsed = new Document(), nodes = {};
  const add = (name, attrs, text, parent = parsed.body) => { const node = parsed.createElement(name); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); node.textContent = text; parent.append(node); return node; };
  nodes.script = add('script', {}, 'alert("untrusted")');
  nodes.refresh = add('meta', { 'http-equiv': 'refresh', content: '0;url=https://outside.invalid' }, '', parsed.head);
  nodes.external = add('a', { href: 'https://outside.invalid', target: '_blank', ping: 'https://outside.invalid/ping', onclick: 'alert(1)' }, 'Guide link');
  nodes.hash = add('a', { href: '#tokens', target: '_blank' }, 'Tokens');
  nodes.image = add('img', { src: 'https://outside.invalid/image.png', onerror: 'alert(1)' }, '');
  nodes.frame = add('iframe', { srcdoc: '<script>alert(1)</script>' }, '');
  add('style', {}, 'body{color:#0066cc}', parsed.head);
  add('h1', {}, 'Copied design system');
  return { parsed, nodes };
}

function fixture(options = {}) {
  const document = new Document(), target = new Window(), calls = [], fetched = [], blobs = new Map(), revoked = [], external = [];
  let uuid = 0, objectUrl = 0;
  target.document = document; target.atob = atob; target.btoa = btoa;
  target.crypto = { randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` };
  target.URL = { createObjectURL(blob) { const url = `blob:preview-${++objectUrl}`; blobs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); blobs.delete(url); } };
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__ = { readOnly: options.readOnly === true, hostContext: options.hostContext };
  target.open = function (...args) { external.push(args); return 'external-window'; };
  const originalOpen = target.open;
  const reference = unsafeReference();
  const create = document.createElement.bind(document);
  document.createElement = name => {
    const element = create(name);
    if (name === 'template') {
      element.content = { querySelectorAll: selector => reference.parsed.querySelectorAll(selector).filter(node => !['html', 'head', 'body'].includes(node.localName)) };
      Object.defineProperty(element, 'innerHTML', { set(html) { fetched.push({ html, inertTemplate: element }); },
        get() { return [...reference.parsed.head.children, ...reference.parsed.body.children].map(node => node.outerHTML).join(''); } });
    }
    return element;
  };
  target.DOMParser = class { constructor() { throw new Error('Active editor DOMParser must not parse reference HTML.'); } };
  target.fetch = async (...args) => { fetched.push(args); return options.fetch ? options.fetch(...args) : new Response('<html><head></head><body>Copied</body></html>', { headers: { 'content-type': 'text/html' } }); };
  const rpc = async (action, payload) => {
    calls.push({ action, payload });
    if (options.rpc) return await options.rpc(action, payload);
    if (action === 'editor.previewDocument') return { html: '<html><head></head><body>Snapshot editor</body></html>' };
    if (action === 'editor.events.open') return { subscriptionId: subscription, cursor: 0 };
    if (action === 'editor.events.poll') return { cursor: payload.cursor + 1, events: [{ event: 'files', data: '{}', cursor: payload.cursor + 1 }] };
    if (action === 'editor.events.close') return { closed: true };
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: encode('snapshot') };
  };
  let flushed = 0;
  const flush = async () => { flushed++; return options.flush ? await options.flush() : { saved: true }; };
  const install = options.install || (options.serialized ? vm.runInNewContext('(' + installNativePreviews.toString() + ')', { URL, Blob, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout }) : installNativePreviews);
  const controller = install({ target, baseUrl, rpc, flush });
  const overlays = () => document.querySelectorAll('[data-codex-native-preview]');
  const frames = () => document.querySelectorAll('iframe');
  const status = () => document.querySelectorAll('p').at(-1);
  const channel = () => calls.filter(call => call.action === 'editor.previewDocument').at(-1)?.payload.channel;
  const message = async (data, source = frames().at(-1)?.contentWindow) => target.emit('message', { source, data: { channel: channel(), ...data } });
  const request = async (requestId, action, payload, extra = {}) => { await message({ type: 'codex-design:editor-request', requestId, action, payload, ...extra }); return frames().at(-1)?.contentWindow.messages.filter(item => item.message.requestId === requestId).at(-1)?.message; };
  return { target, document, controller, calls, fetched, blobs, revoked, external, originalOpen, reference, overlays, frames, status, channel, message, request, get flushed() { return flushed; } };
}

test('serialized installer opens one isolated historical modal after flushing current changes', async t => {
  const f = fixture({ serialized: true }); t.after(f.controller.dispose);
  assert.equal(await f.controller.open('v/7/'), true);
  assert.equal(f.flushed, 1); assert.equal(f.overlays().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { action: 'editor.previewDocument', payload: { version: 7, channel: f.channel() } });
  const frame = f.frames()[0];
  assert.match(frame.src, /^data:text\/html;base64,/);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  const loader = Buffer.from(frame.src.split(',')[1], 'base64').toString();
  assert.ok(loader.includes('event.source === window.parent'));
  assert.ok(loader.includes('event.source === editor.contentWindow'));
  assert.equal(loader.includes('allow-downloads'), false); assert.equal(loader.includes('allow-forms'), false);
  await f.message({ type: 'codex-design:editor-document-request' }, {});
  assert.equal(frame.contentWindow.messages.length, 0);
  await f.message({ type: 'codex-design:editor-document-request', channel: 'foreign' });
  assert.equal(frame.contentWindow.messages.length, 0);
  await f.message({ type: 'codex-design:editor-document-request' });
  assert.match(frame.contentWindow.messages[0].message.html, /Snapshot editor/);
  assert.equal(f.status().hidden, undefined);
  await f.message({ type: 'codex-design:editor-app-ready' });
  assert.equal(f.status().hidden, true);
});

test('actual tiny loader accepts its parent once and relays only its exact child and documented messages', async t => {
  const f = fixture(); t.after(f.controller.dispose); await f.controller.open('v/1/');
  const outer = f.frames()[0], loaderWindow = outer.contentWindow, loaderDocument = new Document();
  loaderWindow.parent = f.target; loaderWindow.document = loaderDocument;
  const html = Buffer.from(outer.src.split(',')[1], 'base64').toString();
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  vm.runInNewContext(script, { window: loaderWindow, document: loaderDocument });
  assert.equal(f.target.messages.filter(item => item.message.type === 'codex-design:editor-document-request').length, 1);
  const incoming = (source, message) => loaderWindow.emit('message', { source, data: { channel: f.channel(), ...message } });
  await incoming({}, { type: 'codex-design:editor-document', html: '<p>foreign</p>' });
  assert.equal(loaderDocument.querySelectorAll('iframe').length, 0);
  await incoming(f.target, { type: 'codex-design:editor-document', html: '<p>first</p>' });
  const inner = loaderDocument.querySelectorAll('iframe')[0];
  assert.equal(inner.srcdoc, '<p>first</p>');
  assert.equal(inner.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  await incoming(f.target, { type: 'codex-design:editor-document', html: '<p>replacement</p>' });
  assert.equal(inner.srcdoc, '<p>first</p>');
  const before = f.target.messages.length;
  await incoming({}, { type: 'codex-design:editor-request', action: 'editor.request' });
  await incoming(inner.contentWindow, { type: 'arbitrary-host-command' });
  assert.equal(f.target.messages.length, before);
  await incoming(inner.contentWindow, { type: 'codex-design:editor-request', action: 'editor.request' });
  assert.equal(f.target.messages.length, before + 1);
  await incoming({}, { type: 'codex-design:editor-response', requestId: 'x' });
  assert.equal(inner.contentWindow.messages.length, 0);
  await incoming(f.target, { type: 'codex-design:editor-response', requestId: 'x' });
  assert.equal(inner.contentWindow.messages[0].message.requestId, 'x');
});

test('published bundled installer survives actual editor-document HTML escaping and its loader starts a handshake', async t => {
  const source = await fs.readFile(new URL('../codex-design/server/index.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function installNativePreviews('), end = source.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const installer = source.slice(start, end + 2);
  new vm.Script('(' + installer + ')');
  const assembled = await buildEditorDocument({ baseUrl: 'http://127.0.0.1:12345/slides/grant/',
    fetchLocal: async () => new Response('<html><head></head><body>Editor</body></html>'),
    config: { virtualBase: baseUrl, bootstrap: 'globalThis.previewInstall=(' + installer + ');' } });
  const bootstrap = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(assembled.html);
  assert.ok(bootstrap);
  const context = vm.createContext({ URL, Blob, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout });
  vm.runInContext(bootstrap[1], context);
  const f = fixture({ install: context.previewInstall }); t.after(f.controller.dispose);
  await f.controller.open('v/1/');
  const frame = f.frames()[0]; assert.ok(frame, f.status().textContent);
  const loader = Buffer.from(frame.src.split(',')[1], 'base64').toString();
  const script = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(loader);
  assert.ok(script, 'the computed tiny loader has a real script closing tag');
  const loaderWindow = frame.contentWindow, loaderDocument = new Document(); loaderWindow.parent = f.target; loaderWindow.document = loaderDocument;
  vm.runInNewContext(script[1], { window: loaderWindow, document: loaderDocument });
  assert.equal(f.target.messages.at(-1).message.type, 'codex-design:editor-document-request');
  const incoming = (source, message) => loaderWindow.emit('message', { source, data: { channel: f.channel(), ...message } });
  await f.message({ type: 'codex-design:editor-document-request' });
  const documentMessage = frame.contentWindow.messages.at(-1).message;
  await incoming(f.target, documentMessage);
  const inner = loaderDocument.querySelectorAll('iframe')[0];
  assert.ok(inner, 'the genuine bundled loader applies the returned document without external helpers');
  assert.equal(inner.srcdoc, documentMessage.html);
  await incoming(inner.contentWindow, { type: 'codex-design:editor-transport-ready' });
  assert.equal(f.target.messages.at(-1).message.type, 'codex-design:editor-transport-ready');
  await f.message(f.target.messages.at(-1).message);
  const hostContext = frame.contentWindow.messages.at(-1).message;
  await incoming(f.target, hostContext);
  assert.equal(inner.contentWindow.messages.at(-1).message.type, 'codex-design:host-context-changed');
  await incoming(inner.contentWindow, { type: 'codex-design:editor-request', requestId: 'bundled-get', action: 'editor.request', payload: { request: { path: 'v/1/project/deck.json', method: 'GET' } } });
  await f.message(f.target.messages.at(-1).message);
  await incoming(f.target, frame.contentWindow.messages.at(-1).message);
  assert.equal(inner.contentWindow.messages.at(-1).message.result.status, 200);
  await incoming(inner.contentWindow, { type: 'codex-design:editor-app-ready' });
  await f.message(f.target.messages.at(-1).message);
  assert.equal(f.status().hidden, true);
});

test('actual tiny loader reports document-application failures and bounds runtime errors without forwarding unknown child messages', async t => {
  const f = fixture(); t.after(f.controller.dispose); await f.controller.open('v/1/');
  const outer = f.frames()[0], loaderWindow = outer.contentWindow, loaderDocument = new Document(); loaderWindow.parent = f.target; loaderWindow.document = loaderDocument;
  const html = Buffer.from(outer.src.split(',')[1], 'base64').toString();
  const script = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)[1];
  vm.runInNewContext(script, { window: loaderWindow, document: loaderDocument });
  assert.equal(f.target.messages[0].message.type, 'codex-design:editor-document-request');
  const create = loaderDocument.createElement.bind(loaderDocument);
  loaderDocument.createElement = () => { throw new Error('Cannot apply historical frame'); };
  await loaderWindow.emit('message', { source: f.target, data: { type: 'codex-design:editor-document', channel: f.channel(), html: '<p>history</p>' } });
  let diagnostics = f.target.messages.filter(item => item.message.type === 'codex-design:editor-diagnostic');
  assert.equal(diagnostics.length, 1); assert.match(diagnostics[0].message.message, /Cannot apply historical frame/);
  for (let i = 0; i < 8; i++) await loaderWindow.emit('error', { message: 'x'.repeat(3000) });
  await loaderWindow.emit('unhandledrejection', { reason: new Error('late rejection') });
  diagnostics = f.target.messages.filter(item => item.message.type === 'codex-design:editor-diagnostic');
  assert.equal(diagnostics.length, 4); assert.ok(diagnostics.every(item => item.message.message.length <= 1027));
  loaderDocument.createElement = create;
  const fresh = new Window(), freshDocument = new Document(); fresh.parent = f.target; fresh.document = freshDocument;
  vm.runInNewContext(script, { window: fresh, document: freshDocument });
  await fresh.emit('message', { source: f.target, data: { type: 'codex-design:editor-document', channel: f.channel(), html: '<p>history</p>' } });
  const inner = freshDocument.querySelectorAll('iframe')[0];
  const before = f.target.messages.length;
  await fresh.emit('message', { source: inner.contentWindow, data: { type: 'codex-design:preview-stage', channel: f.channel(), stage: 'app-ready' } });
  assert.equal(f.target.messages.length, before);
});

test('historical broker permits only version-scoped GET/HEAD and strips attempted artwork authority', async t => {
  const f = fixture(); t.after(f.controller.dispose); await f.controller.open('v/7/');
  for (const method of ['GET', 'HEAD']) {
    const response = await f.request(method, 'editor.request', { id: 'different-artwork', request: { path: 'v/7/project/a.html', method, headers: { Accept: 'text/html' }, id: 'different-artwork' } });
    assert.equal(response.result.status, 200);
    assert.deepEqual(f.calls.at(-1).payload, { request: { path: 'v/7/project/a.html', method, headers: { accept: 'text/html' } } });
  }
  const before = f.calls.length;
  for (const [id, action, payload] of [
    ['write', 'editor.request', { request: { path: 'v/7/__deck/publish', method: 'POST' } }],
    ['body', 'editor.request', { request: { path: 'v/7/project/a.html', body: '' } }],
    ['download', 'editor.download', {}], ['draft', 'request.draftAdded', {}], ['nested', 'editor.previewDocument', { version: 1 }],
  ]) assert.equal((await f.request(id, action, payload)).error.code, 'PREVIEW_READ_ONLY');
  for (const [i, value] of ['project/a.html', 'v/8/project/a.html', 'v/7/../8/a', 'v/7/%2e%2e/a', 'v/7/%252e%252e/a', 'v/7/%5c..%5ca', 'v/7/project%2Fsecret.html', '/v/7/a', 'https://outside.invalid/v/7/a', 'v/7/a#hash'].entries()) {
    assert.equal((await f.request('path' + i, 'editor.request', { request: { path: value } })).error.code, 'PREVIEW_READ_ONLY');
  }
  assert.equal(f.calls.length, before);
});

test('historical broker accepts only bounded canonical SHA-256 input', async t => {
  const f = fixture(); t.after(f.controller.dispose); await f.controller.open('v/1/');
  assert.equal((await f.request('digest', 'editor.digest', { algorithm: 'SHA-256', base64: 'Zg==' })).result.status, 200);
  const before = f.calls.length;
  for (const [i, payload] of [{ algorithm: 'SHA-1', base64: 'Zg==' }, { algorithm: 'SHA-256', base64: 'Zh==' }, { algorithm: 'SHA-256', base64: '!' }, { algorithm: 'SHA-256', base64: 'A'.repeat(44_739_245) }].entries()) {
    assert.equal((await f.request('bad' + i, 'editor.digest', payload)).error.code, 'PREVIEW_READ_ONLY');
  }
  assert.equal(f.calls.length, before);
});

test('historical subscriptions are owned, replayed once, and closed when the modal closes', async () => {
  const f = fixture(); await f.controller.open('v/7/');
  const opened = await f.request('open', 'editor.events.open', { path: 'v/7/__deck/events' });
  assert.equal(opened.result.subscriptionId, subscription);
  await f.request('open', 'editor.events.open', { path: 'v/7/__deck/events' });
  assert.equal(f.calls.filter(call => call.action === 'editor.events.open').length, 1);
  assert.equal((await f.request('foreign', 'editor.events.poll', { subscriptionId: 'foreign', cursor: 0 })).error.code, 'PREVIEW_READ_ONLY');
  assert.equal((await f.request('future', 'editor.events.poll', { subscriptionId: subscription, cursor: 1 })).error.code, 'PREVIEW_READ_ONLY');
  assert.equal((await f.request('poll', 'editor.events.poll', { subscriptionId: subscription, cursor: 0 })).result.cursor, 1);
  await f.message({ type: 'codex-design:preview-close' }); await setImmediate();
  assert.equal(f.overlays().length, 0);
  assert.equal(f.calls.filter(call => call.action === 'editor.events.close').length, 1);
  f.controller.dispose(); await setImmediate();
  assert.equal(f.calls.filter(call => call.action === 'editor.events.close').length, 1);
});

test('pending subscription opens are reclaimed after disposal and cannot recreate the modal', async () => {
  const waiting = deferred();
  const f = fixture({ rpc: async action => action === 'editor.previewDocument' ? { html: '<html>old</html>' } : action === 'editor.events.open' ? waiting.promise : { closed: true } });
  await f.controller.open('v/7/');
  const operation = f.request('open', 'editor.events.open', { path: 'v/7/__deck/events' });
  await setImmediate(); f.controller.dispose();
  waiting.resolve({ subscriptionId: subscription, cursor: 0 }); await operation; await setImmediate();
  assert.equal(f.overlays().length, 0);
  assert.equal(f.calls.filter(call => call.action === 'editor.events.close').length, 1);
});

test('a failed stream close retains ownership so final preview cleanup can still close it', async () => {
  let closes = 0;
  const f = fixture({ rpc: async action => {
    if (action === 'editor.previewDocument') return { html: '<html>history</html>' };
    if (action === 'editor.events.open') return { subscriptionId: subscription, cursor: 0 };
    if (action === 'editor.events.close' && ++closes === 1) throw new Error('Temporary close failure');
    return { closed: true };
  } });
  await f.controller.open('v/7/'); await f.request('open', 'editor.events.open', { path: 'v/7/__deck/events' });
  assert.equal((await f.request('close', 'editor.events.close', { subscriptionId: subscription })).error.message, 'Temporary close failure');
  f.controller.dispose(); await setImmediate();
  assert.equal(closes, 2);
});

test('a malformed stream receipt with a valid ID is reclaimed before reporting failure', async t => {
  const f = fixture({ rpc: async action => action === 'editor.previewDocument' ? { html: '<html>history</html>' }
    : action === 'editor.events.open' ? { subscriptionId: subscription, cursor: -1 } : { closed: true } }); t.after(f.controller.dispose);
  await f.controller.open('v/7/');
  assert.equal((await f.request('open', 'editor.events.open', { path: 'v/7/__deck/events' })).error.code, 'PREVIEW_FAILED');
  await setImmediate(); assert.equal(f.calls.filter(call => call.action === 'editor.events.close').length, 1);
});

test('read requests have a bounded pending queue and a reused identifier cannot change its payload', async t => {
  const reads = [];
  const f = fixture({ rpc: async action => {
    if (action === 'editor.previewDocument') return { html: '<html>history</html>' };
    const waiting = deferred(); reads.push(waiting); return waiting.promise;
  } }); t.after(f.controller.dispose); await f.controller.open('v/7/');
  const tasks = Array.from({ length: 33 }, (_, i) => f.request('read' + i, 'editor.request', { request: { path: 'v/7/project/a.html' } }));
  await setImmediate(); assert.equal(reads.length, 32);
  const frame = f.frames()[0];
  assert.equal(frame.contentWindow.messages.find(item => item.message.requestId === 'read32').message.error.code, 'PREVIEW_BUSY');
  assert.equal((await f.request('read0', 'editor.request', { request: { path: 'v/7/project/other.html' } })).error.code, 'PREVIEW_REQUEST_CONFLICT');
  for (const waiting of reads) waiting.resolve({ status: 200, body: '' });
  await Promise.all(tasks);
  await f.request('read0', 'editor.request', { request: { path: 'v/7/project/a.html' } });
  assert.equal(reads.length, 32);
});

test('completed response bytes are bounded and live subscription receipts survive eviction', async t => {
  const large = 'A'.repeat(33 * 1024 * 1024);
  const f = fixture({ rpc: async action => action === 'editor.previewDocument' ? { html: '<html>history</html>' }
    : action === 'editor.events.open' ? { subscriptionId: subscription, cursor: 0 } : { status: 200, body: large } }); t.after(f.controller.dispose);
  await f.controller.open('v/7/');
  await f.request('stream', 'editor.events.open', { path: 'v/7/__deck/events' });
  await f.request('large1', 'editor.request', { request: { path: 'v/7/project/a.html' } });
  await f.request('large2', 'editor.request', { request: { path: 'v/7/project/b.html' } });
  await f.request('large2', 'editor.request', { request: { path: 'v/7/project/b.html' } });
  assert.equal(f.calls.filter(call => call.action === 'editor.request').length, 2);
  await f.request('stream', 'editor.events.open', { path: 'v/7/__deck/events' });
  assert.equal(f.calls.filter(call => call.action === 'editor.events.open').length, 1);
  await f.request('large1', 'editor.request', { request: { path: 'v/7/project/a.html' } });
  assert.equal(f.calls.filter(call => call.action === 'editor.request').length, 3, 'evicted immutable GET results can be read again');
});

test('a single oversized response is refused and an obsolete queued read never reaches RPC', async () => {
  const f = fixture({ rpc: async action => action === 'editor.previewDocument' ? { html: '<html>history</html>' } : { body: 'A'.repeat(65 * 1024 * 1024) } });
  await f.controller.open('v/7/');
  assert.equal((await f.request('huge', 'editor.request', { request: { path: 'v/7/project/a.html' } })).error.code, 'PREVIEW_TOO_LARGE');
  const before = f.calls.length;
  const pending = f.request('late', 'editor.request', { request: { path: 'v/7/project/late.html' } });
  f.controller.close(); await pending;
  assert.equal(f.calls.length, before); f.controller.dispose();
});

test('out-of-order event poll completions never move the owned cursor backwards', async t => {
  const polls = [];
  const f = fixture({ rpc: async action => {
    if (action === 'editor.previewDocument') return { html: '<html>history</html>' };
    if (action === 'editor.events.open') return { subscriptionId: subscription, cursor: 0 };
    const waiting = deferred(); polls.push(waiting); return waiting.promise;
  } }); t.after(f.controller.dispose); await f.controller.open('v/7/');
  await f.request('stream', 'editor.events.open', { path: 'v/7/__deck/events' });
  const first = f.request('poll1', 'editor.events.poll', { subscriptionId: subscription, cursor: 0 });
  const second = f.request('poll2', 'editor.events.poll', { subscriptionId: subscription, cursor: 0 });
  await setImmediate(); polls[1].resolve({ cursor: 2, events: [] }); await second;
  polls[0].resolve({ cursor: 1, events: [] }); await first;
  const next = f.request('poll3', 'editor.events.poll', { subscriptionId: subscription, cursor: 2 });
  await setImmediate(); assert.equal(polls.length, 3); polls[2].resolve({ cursor: 2, events: [] }); await next;
});

test('replacing or closing an asynchronous open preserves only the current modal', async () => {
  const first = deferred(); let flushes = 0;
  const f = fixture({ flush: () => ++flushes === 1 ? first.promise : { saved: true } });
  const pending = f.controller.open('v/1/');
  assert.equal(await f.controller.open('v/2/'), true);
  first.resolve({ saved: true }); assert.equal(await pending, false);
  assert.equal(f.calls.filter(call => call.action === 'editor.previewDocument').length, 1);
  assert.equal(f.calls[0].payload.version, 2); assert.equal(f.overlays().length, 1);
  f.controller.dispose(); assert.equal(f.overlays().length, 0);
  assert.equal(f.target.open, f.originalOpen);
  assert.equal(f.target.handlers.get('message').size, 0);
  assert.equal(f.document.handlers.get('click').size, 0);
});

test('passive Design System pages have no script/network/navigation authority and revoke only their own URL', async () => {
  const f = fixture(); const before = f.document.createElement('button'); f.document.body.append(before); before.focus();
  assert.equal(await f.controller.open('__ds/qa/'), true);
  assert.equal(f.fetched[0][0], baseUrl + '__ds/qa/');
  assert.equal(f.calls.length, 0);
  assert.equal(f.fetched[1].inertTemplate.isConnected, false, 'reference markup is parsed only inside detached template content');
  const frame = f.frames()[0], html = await f.blobs.get(frame.src).text(), { nodes } = f.reference;
  assert.equal(frame.getAttribute('sandbox'), ''); assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(nodes.script.parentNode, undefined); assert.equal(nodes.refresh.parentNode, undefined); assert.equal(nodes.frame.parentNode, undefined);
  assert.equal(nodes.external.hasAttribute('href'), false); assert.equal(nodes.external.hasAttribute('onclick'), false);
  assert.equal(nodes.external.getAttribute('aria-disabled'), 'true');
  assert.equal(nodes.hash.getAttribute('href'), '#tokens'); assert.equal(nodes.hash.hasAttribute('target'), false);
  assert.equal(nodes.image.hasAttribute('src'), false); assert.equal(nodes.image.hasAttribute('onerror'), false);
  assert.ok(html.includes("script-src 'none'")); assert.ok(html.includes("connect-src 'none'")); assert.ok(html.includes('no-referrer'));
  assert.equal(/<script\b/.test(html), false);
  f.controller.close(); assert.deepEqual(f.revoked, [frame.src]); assert.equal(f.document.activeElement, before);
  f.controller.dispose(); assert.equal(f.revoked.length, 1);
});

test('failed reference/history opens retain a visible error and a usable close control', async () => {
  for (const options of [{ fetch: async () => new Response('Missing', { status: 404, headers: { 'content-type': 'text/html' } }) },
    { rpc: async () => { throw Object.assign(new Error('Version does not exist.'), { code: 'NOT_FOUND' }); } },
    { flush: async () => ({ saved: false }) }]) {
    const f = fixture(options);
    assert.equal(await f.controller.open(options.fetch ? '__ds/missing/' : 'v/9/'), false);
    assert.equal(f.status().getAttribute('role'), 'alert');
    assert.ok(f.status().textContent.length > 0);
    await f.document.querySelectorAll('button').at(-1).emit('click', {});
    assert.equal(f.overlays().length, 0); f.controller.dispose();
  }
});

test('late reference results after disposal create neither a blob nor a frame', async () => {
  const waiting = deferred(), f = fixture({ fetch: () => waiting.promise });
  const operation = f.controller.open('__ds/qa/'); await setImmediate(); f.controller.dispose();
  waiting.resolve(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(await operation, false); assert.equal(f.overlays().length, 0); assert.equal(f.blobs.size, 0);
});

test('only ordinary external opens retain original behavior; local or unknown virtual links never leak into a browser tab', async () => {
  const f = fixture();
  assert.equal(f.target.open('https://example.com/guide', '_blank'), 'external-window');
  assert.equal(f.target.open('mailto:hello@example.com'), 'external-window');
  for (const value of ['http://127.0.0.1:4710/private/', 'http://localhost.:4710/', 'http://[::ffff:127.0.0.1]:1/', 'http://codex-design.invalid/private', baseUrl + 'project/a.html', 'v/0/', 'javascript:alert(1)', 'data:text/html,private']) assert.equal(f.target.open(value), null);
  await setImmediate(); assert.equal(f.external.length, 2);
  assert.equal(f.status().getAttribute('role'), 'alert');
  f.controller.dispose(); assert.equal(f.target.open, f.originalOpen);
});

test('known anchor opens stay internal and readonly style updates omit profiles and capabilities', async t => {
  const f = fixture({ hostContext: { theme: 'dark', styles: { variables: { '--font-sans': 'QA' } }, user: { name: 'private' }, capabilities: ['write'] } }); t.after(f.controller.dispose);
  const link = f.document.createElement('a'); link.setAttribute('href', 'v/3/');
  let prevented = 0;
  await f.document.emit('auxclick', { button: 2, composedPath: () => [link], preventDefault() { prevented++; }, stopPropagation() {} });
  assert.equal(prevented, 0); assert.equal(f.overlays().length, 0);
  await f.document.emit('click', { composedPath: () => [link], preventDefault() { prevented++; }, stopPropagation() {} });
  await setImmediate(); assert.equal(prevented, 1); assert.equal(f.external.length, 0);
  await f.message({ type: 'codex-design:editor-transport-ready' });
  const frame = f.frames()[0];
  let context = frame.contentWindow.messages.at(-1).message.context;
  assert.deepEqual(context, { theme: 'dark', styles: { variables: { '--font-sans': 'QA' } } });
  f.controller.updateHostContext({ theme: 'light', styles: { variables: { '--font-sans': 'New QA' } }, user: 'private' });
  context = frame.contentWindow.messages.at(-1).message.context;
  assert.equal(context.theme, 'light'); assert.equal(context.user, undefined);
  await f.message({ type: 'codex-design:preview-close' }); assert.equal(f.overlays().length, 0);
});

test('readonly nested editors cannot install another preview controller', async () => {
  const f = fixture({ readOnly: true });
  assert.equal(f.target.open, f.originalOpen); assert.equal(await f.controller.open('v/1/'), false);
  assert.equal(f.calls.length, 0); assert.equal(f.overlays().length, 0); f.controller.dispose();
});
