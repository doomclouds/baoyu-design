import test from 'node:test';
import assert from 'node:assert/strict';
import { mountNativeEditor } from '../source/ui/native-editor.mjs';

const firstId = '11111111-2222-4333-8444-555555555555';
const secondId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const firstJob = '22222222-3333-4444-8555-666666666666';
const secondJob = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const drain = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture(t, onCall = () => undefined) {
  const listeners = new Map(), calls = [], editors = [];
  const owner = { innerHeight: 800,
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); } };
  const bridge = { invoke: async (action, payload) => {
    calls.push({ action, payload });
    return await onCall(action, payload) ?? { jobId: payload.id === firstId ? firstJob : secondJob, status: payload.operation === 'cancel' ? 'cancelled' : 'running' };
  } };
  const mount = (artifactId, channel) => {
    const sent = [], attributes = new Map();
    const iframe = { ownerDocument: { defaultView: owner }, contentWindow: { postMessage: message => sent.push(message) },
      setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); }, addEventListener() {}, removeEventListener() {} };
    const editor = mountNativeEditor({ iframe, bridge, artifactId, channel, document: { html: '<html><body>Motion lifecycle fixture</body></html>' } });
    editors.push(editor);
    const receive = (type, data = {}) => Promise.all([...(listeners.get('message') || [])].map(callback => callback({
      source: iframe.contentWindow, data: { type, channel, ...data },
    })));
    return { editor, sent, attributes, receive, request: (requestId, payload) => receive('codex-design:editor-request', { requestId, action: 'editor.motionExport', payload }) };
  };
  t.after(() => { for (const editor of editors) editor.dispose(); });
  return { mount, calls, listeners, cancellations: () => calls.filter(call => call.payload.operation === 'cancel') };
}

test('parent editor disposal cancels only its running Motion job with a fixed artwork identity after the inner listener is removed', async t => {
  const f = fixture(t), first = f.mount(firstId, 'first-motion-channel'), second = f.mount(secondId, 'second-motion-channel');
  await first.request('first-start', { id: secondId, operation: 'start', format: 'mp4' });
  await second.request('second-start', { id: firstId, operation: 'start', format: 'mp4' });
  assert.deepEqual(f.calls.map(call => call.payload.id), [firstId, secondId]);
  first.editor.dispose(); first.editor.dispose(); await drain();
  assert.equal(f.listeners.get('message').size, 1);
  assert.deepEqual(f.cancellations(), [{ action: 'editor.motionExport', payload: { id: firstId, operation: 'cancel', jobId: firstJob } }]);
  await first.request('late-inner-unload', { id: secondId, operation: 'cancel', jobId: secondJob });
  assert.equal(f.cancellations().length, 1, 'An unload message from the removed inner listener cannot reach another artwork.');
  await second.request('second-status', { id: firstId, operation: 'status', jobId: secondJob });
  assert.deepEqual(f.calls.at(-1).payload, { id: secondId, operation: 'status', jobId: secondJob });
  second.editor.dispose(); await drain();
  assert.deepEqual(f.cancellations().at(-1), { action: 'editor.motionExport', payload: { id: secondId, operation: 'cancel', jobId: secondJob } });
});

test('a Motion start that returns its job id after parent disposal is cancelled without a reply or cross-artwork cancellation', async t => {
  const gate = deferred();
  const f = fixture(t, (_action, payload) => payload.id === firstId && payload.operation === 'start' ? gate.promise : undefined);
  const first = f.mount(firstId, 'delayed-motion-channel'), second = f.mount(secondId, 'other-motion-channel');
  const pending = first.request('delayed-start', { id: secondId, operation: 'start', format: 'mp4' });
  await drain();
  await second.request('other-start', { id: firstId, operation: 'start', format: 'mp4' });
  first.editor.dispose(); await drain();
  assert.equal(f.listeners.get('message').size, 1); assert.deepEqual(f.cancellations(), []);
  gate.resolve({ jobId: firstJob, status: 'running' }); await pending; await drain();
  assert.deepEqual(f.cancellations(), [{ action: 'editor.motionExport', payload: { id: firstId, operation: 'cancel', jobId: firstJob } }]);
  assert.equal(first.sent.some(message => message.type === 'codex-design:editor-response'), false, 'The closed frame must not receive a late start response.');
  assert.equal(second.sent.filter(message => message.type === 'codex-design:editor-response').length, 1);
  await second.request('other-status', { operation: 'status', jobId: secondJob });
  assert.equal(f.cancellations().some(call => call.payload.id === secondId), false);
});

test('a closing flush promotes the same in-flight writer and a failed save releases inert state without pretending it was saved', async t => {
  const f = fixture(t), frame = f.mount(firstId, 'promoted-close-channel');
  await frame.receive('codex-design:editor-app-ready');
  const normal = frame.editor.flush(), closing = frame.editor.flush({ closing: true });
  let settled = false;
  const results = Promise.allSettled([normal, closing]).then(value => { settled = true; return value; });
  const saves = frame.sent.filter(message => message.type === 'codex-design:editor-flush');
  assert.equal(saves.length, 2);
  assert.equal(saves[0].requestId, saves[1].requestId, 'Promotion must not create a second writer.');
  assert.equal(saves[1].closing, true);
  assert.equal(frame.attributes.has('inert'), true);
  await frame.receive('codex-design:editor-flushed', { requestId: saves[0].requestId, saved: true });
  await drain();
  assert.equal(settled, false, 'An already travelling generic save ACK cannot confirm the last blur edit in a promoted close.');
  assert.equal(frame.attributes.has('inert'), true);
  await frame.receive('codex-design:editor-flushed', { requestId: saves[0].requestId, closing: true, saved: false,
    error: { code: 'EDITOR_UNSAVED_CHANGES', message: 'The film could not be saved.' } });
  for (const result of await results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'EDITOR_UNSAVED_CHANGES');
  }
  assert.equal(frame.attributes.has('inert'), false);
  assert.equal(frame.attributes.has('aria-busy'), false);
  assert.ok(frame.sent.some(message => message.type === 'codex-design:editor-cancel-close'));
  const retried = frame.editor.flush();
  const request = frame.sent.filter(message => message.type === 'codex-design:editor-flush').at(-1);
  assert.notEqual(request.requestId, saves[0].requestId);
  await frame.receive('codex-design:editor-flushed', { requestId: request.requestId, saved: true });
  assert.deepEqual(await retried, { saved: true });
});

test('aborting a closing caller cancels only its wait while the shared writer still requires an exact save acknowledgement', async t => {
  const f = fixture(t), frame = f.mount(firstId, 'abort-close-channel');
  await frame.receive('codex-design:editor-app-ready');
  const controller = new AbortController();
  const cancelled = frame.editor.flush({ closing: true, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  const request = frame.sent.find(message => message.type === 'codex-design:editor-flush');
  controller.abort();
  assert.equal((await cancelled).error.name, 'AbortError');
  assert.equal(frame.attributes.has('inert'), false);
  let saved = false;
  const remaining = frame.editor.flush().then(value => { saved = true; return value; });
  await drain();
  assert.equal(saved, false);
  assert.equal(frame.sent.filter(message => message.type === 'codex-design:editor-flush').length, 1, 'Caller cancellation cannot restart or discard the active writer.');
  await frame.receive('codex-design:editor-flushed', { requestId: 'an-unrelated-request', saved: true });
  assert.equal(saved, false);
  await frame.receive('codex-design:editor-flushed', { requestId: request.requestId, closing: true, saved: true });
  await drain();
  const fresh = frame.sent.filter(message => message.type === 'codex-design:editor-flush').at(-1);
  assert.notEqual(fresh.requestId, request.requestId);
  assert.equal(saved, false, 'A later caller must obtain a fresh receipt after the cancelled close writer finishes.');
  await frame.receive('codex-design:editor-flushed', { requestId: request.requestId, closing: true, saved: true });
  assert.equal(saved, false);
  await frame.receive('codex-design:editor-flushed', { requestId: fresh.requestId, saved: true });
  assert.deepEqual(await remaining, { saved: true });
});

test('cancelled close A cannot confirm a later close B until its fresh request receives an explicit closing acknowledgement', async t => {
  const f = fixture(t), frame = f.mount(firstId, 'cancel-and-reclose-channel');
  await frame.receive('codex-design:editor-app-ready');
  let oldGenericSaved = false, newCloseSaved = false;
  const generic = frame.editor.flush().then(value => { oldGenericSaved = true; return value; });
  const controller = new AbortController();
  const closeA = frame.editor.flush({ closing: true, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
  const old = frame.sent.filter(message => message.type === 'codex-design:editor-flush').at(-1);
  controller.abort(); assert.equal((await closeA).error.name, 'AbortError');
  const closeB = frame.editor.flush({ closing: true }).then(value => { newCloseSaved = true; return value; });
  await drain();
  assert.equal(frame.sent.filter(message => message.type === 'codex-design:editor-flush').length, 2, 'The cancelled gesture writer must settle before another writer starts.');
  await frame.receive('codex-design:editor-flushed', { requestId: old.requestId, saved: true });
  await drain(); assert.equal(oldGenericSaved, false); assert.equal(newCloseSaved, false);
  await frame.receive('codex-design:editor-flushed', { requestId: old.requestId, closing: true, saved: true });
  assert.deepEqual(await generic, { saved: true }); await drain();
  const fresh = frame.sent.filter(message => message.type === 'codex-design:editor-flush').at(-1);
  assert.notEqual(fresh.requestId, old.requestId); assert.equal(fresh.closing, true);
  assert.equal(newCloseSaved, false);
  await frame.receive('codex-design:editor-flushed', { requestId: old.requestId, closing: true, saved: true });
  await frame.receive('codex-design:editor-flushed', { requestId: fresh.requestId, saved: true });
  await drain(); assert.equal(newCloseSaved, false, 'Neither the previous close ACK nor a generic fresh ACK can confirm close B.');
  await frame.receive('codex-design:editor-flushed', { requestId: fresh.requestId, closing: true, saved: true });
  assert.deepEqual(await closeB, { saved: true });
});
