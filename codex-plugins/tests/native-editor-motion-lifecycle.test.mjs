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
    const sent = [];
    const iframe = { ownerDocument: { defaultView: owner }, contentWindow: { postMessage: message => sent.push(message) },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
    const editor = mountNativeEditor({ iframe, bridge, artifactId, channel, document: { html: '<html><body>Motion lifecycle fixture</body></html>' } });
    editors.push(editor);
    return { editor, sent, request: (requestId, payload) => Promise.all([...(listeners.get('message') || [])].map(callback => callback({
      source: iframe.contentWindow, data: { type: 'codex-design:editor-request', channel, requestId, action: 'editor.motionExport', payload },
    }))) };
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
