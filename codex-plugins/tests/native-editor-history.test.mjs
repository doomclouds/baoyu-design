import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mountNativeEditor } from '../source/ui/native-editor.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const listeners = new Map(), sent = [], invoked = [], failures = [];
  const owner = { innerHeight: 800,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const iframe = { ownerDocument: { defaultView: owner }, setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    contentWindow: { postMessage: message => sent.push(message) } };
  const bridge = { invoke: async (action, payload) => { invoked.push({ action, payload }); return { html: '<html><body>Readonly version</body></html>', readOnly: true }; } };
  const handle = mountNativeEditor({ iframe, bridge, artifactId: 'fixed-artwork', channel: 'history-channel',
    document: { html: '<html><body>Current artwork</body></html>' }, onError: failure => failures.push(failure), ...options });
  t.after(() => handle.dispose());
  const receive = async (type, data = {}, { source = iframe.contentWindow, channel = 'history-channel' } = {}) => {
    for (const listener of listeners.get('message') || []) await listener({ source, data: { type, channel, ...data } });
  };
  const ready = () => receive('codex-design:editor-app-ready');
  const acknowledgeFlush = () => receive('codex-design:editor-flushed', { requestId: sent.findLast(message => message.type === 'codex-design:editor-flush').requestId, saved: true });
  return { handle, iframe, sent, invoked, failures, receive, ready, acknowledgeFlush, listeners };
}

test('mounted History waits for actual app readiness, full flush and its exact frame/request acknowledgement', async t => {
  const f = fixture(t);
  const opening = f.handle.openHistory();
  assert.equal(f.handle.openHistory(), opening, 'One pending History open is shared.');
  assert.equal(f.sent.length, 0);
  await f.receive('codex-design:editor-app-ready', {}, { source: {} });
  assert.equal(f.sent.length, 0);
  await f.ready(); await drain();
  assert.equal(f.sent.at(-1).type, 'codex-design:editor-flush');
  assert.equal(f.sent.some(message => message.type === 'codex-design:editor-history-open'), false);
  await f.acknowledgeFlush(); await drain();
  const request = f.sent.at(-1);
  assert.equal(request.type, 'codex-design:editor-history-open');
  assert.match(request.requestId, /^[a-f0-9-]{36}$/);
  let settled = false; void opening.then(() => { settled = true; }, () => { settled = true; });
  for (const invalid of [{ source: {} }, { channel: 'another-artwork' }]) {
    await f.receive('codex-design:editor-history-opened', { requestId: request.requestId, opened: true }, invalid);
  }
  await f.receive('codex-design:editor-history-opened', { requestId: 'wrong-request', opened: true });
  await drain(); assert.equal(settled, false);
  await f.receive('codex-design:editor-history-opened', { requestId: request.requestId, opened: true });
  assert.deepEqual(await opening, { opened: true });
});

test('a refused save never opens History and an unavailable acknowledgement rejects without leaving a pending operation', async t => {
  const f = fixture(t); await f.ready();
  const refused = f.handle.openHistory(); await drain();
  await f.receive('codex-design:editor-flushed', { requestId: f.sent.at(-1).requestId, saved: false, error: { code: 'EDITOR_UNSAVED_CHANGES', message: 'Still saving.' } });
  await assert.rejects(refused, { code: 'EDITOR_UNSAVED_CHANGES' });
  assert.equal(f.sent.some(message => message.type === 'codex-design:editor-history-open'), false);
  const unavailable = f.handle.openHistory(); await drain(); await f.acknowledgeFlush(); await drain();
  await f.receive('codex-design:editor-history-opened', { requestId: f.sent.at(-1).requestId, opened: false,
    error: { code: 'NATIVE_HISTORY_UNAVAILABLE', message: 'This editor does not expose History.' } });
  await assert.rejects(unavailable, { code: 'NATIVE_HISTORY_UNAVAILABLE' });
  const retry = f.handle.openHistory(); await drain(); await f.acknowledgeFlush(); await drain();
  await f.receive('codex-design:editor-history-opened', { requestId: f.sent.at(-1).requestId, opened: true });
  assert.equal((await retry).opened, true);
});

test('dialog cancellation after posting History sends a scoped close and ignores a late acknowledgement', async t => {
  const f = fixture(t); await f.ready();
  const controller = new AbortController();
  const opening = f.handle.openHistory({ signal: controller.signal });
  await drain(); await f.acknowledgeFlush(); await drain();
  const request = f.sent.at(-1);
  controller.abort(Object.assign(new Error('Dialog closed.'), { code: 'EDITOR_HISTORY_CANCELLED' }));
  await assert.rejects(opening, { code: 'EDITOR_HISTORY_CANCELLED' });
  assert.deepEqual(f.sent.at(-1), { type: 'codex-design:editor-history-close', channel: 'history-channel', requestId: request.requestId });
  await f.receive('codex-design:editor-history-opened', { requestId: request.requestId, opened: true });
  assert.equal(f.sent.filter(message => message.type === 'codex-design:editor-history-open').length, 1);
});

test('startup failure, History acknowledgement timeout and disposal reject bounded operations', async t => {
  const startup = fixture(t, { startupTimeoutMs: 10 });
  const waiting = startup.handle.openHistory();
  const rejected = assert.rejects(waiting, { code: 'EDITOR_START_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 25)); await rejected;
  assert.equal(startup.sent.some(message => message.type === 'codex-design:editor-history-open'), false);
  const timed = fixture(t, { historyTimeoutMs: 10 }); await timed.ready();
  const noReply = timed.handle.openHistory(); await drain(); await timed.acknowledgeFlush();
  await assert.rejects(noReply, { code: 'EDITOR_HISTORY_TIMEOUT' });
  assert.equal(timed.sent.at(-1).type, 'codex-design:editor-history-close');
  const disposed = fixture(t);
  const cancelled = disposed.handle.openHistory(); disposed.handle.dispose();
  await assert.rejects(cancelled, { code: 'EDITOR_CLOSED' });
  assert.equal(disposed.listeners.get('message').size, 0);
  await assert.rejects(disposed.handle.openHistory(), { code: 'EDITOR_CLOSED' });
});

test('the isolated loader forwards History controls and acknowledgements only over its actual parent/frame channel', t => {
  const f = fixture(t);
  const loader = Buffer.from(f.iframe.src.split(',')[1], 'base64').toString('utf8');
  const code = /<script>([\s\S]*)<\/script>/.exec(loader)[1];
  let receive;
  const outer = [], inner = [];
  const parent = { postMessage: message => outer.push(message) };
  const editor = { setAttribute() {}, contentWindow: { postMessage: message => inner.push(message) } };
  const window = { parent, addEventListener(_name, listener) { receive = listener; } };
  vm.runInNewContext(code, { window, document: { createElement: () => editor, body: { appendChild() {} } } });
  receive({ source: parent, data: { type: 'codex-design:editor-document', channel: 'history-channel', html: '<html>Current</html>' } });
  for (const type of ['codex-design:editor-history-open', 'codex-design:editor-history-close']) {
    const message = { type, channel: 'history-channel', requestId: 'scoped' };
    receive({ source: {}, data: message }); receive({ source: parent, data: { ...message, channel: 'wrong' } });
    const before = inner.length; receive({ source: parent, data: message }); assert.equal(inner.length, before + 1);
    assert.equal(inner.at(-1).type, type);
  }
  const reply = { type: 'codex-design:editor-history-opened', channel: 'history-channel', requestId: 'scoped', opened: true };
  const before = outer.length;
  receive({ source: {}, data: reply }); receive({ source: editor.contentWindow, data: { ...reply, channel: 'wrong' } });
  assert.equal(outer.length, before);
  receive({ source: editor.contentWindow, data: reply }); assert.equal(outer.length, before + 1);
});

test('read-only preview document requests retain the forced artwork identity in the actual parent broker', async t => {
  const f = fixture(t);
  await f.receive('codex-design:editor-request', { requestId: 'preview-1', action: 'editor.previewDocument', payload: { id: 'another-artwork', version: 3 } });
  assert.deepEqual(f.invoked, [{ action: 'editor.previewDocument', payload: { id: 'fixed-artwork', version: 3 } }]);
  assert.match(f.sent.at(-1).result.html, /Readonly version/);
  assert.equal(f.sent.at(-1).result.readOnly, true);
});
