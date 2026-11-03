import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';

function fixture(configuration, handler) {
  const listeners = new Map(), calls = [], timers = [];
  const emit = (name, event) => { for (const callback of listeners.get(name) || []) callback(event); };
  const parent = { postMessage(message) {
    if (message.type !== 'codex-design:editor-request') return;
    calls.push(message);
    Promise.resolve().then(() => handler(message)).then(result => emit('message', { source: parent,
      data: { type: 'codex-design:editor-response', channel: 'system-sync-test', requestId: message.requestId, result },
    }), error => emit('message', { source: parent,
      data: { type: 'codex-design:editor-response', channel: 'system-sync-test', requestId: message.requestId, error: { code: error.code, message: error.message } },
    }));
  } };
  const target = { parent, btoa, atob, Event,
    fetch: async () => { throw new Error('No external fetch is allowed.'); },
    addEventListener(name, callback) { const group = listeners.get(name) || []; group.push(callback); listeners.set(name, group); },
    dispatchEvent(event) { emit(event.type, event); return !event.defaultPrevented; },
  };
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target);', {
    configuration: { baseUrl: 'https://codex-design.invalid/artifacts/11111111-1111-4111-8111-111111111111/',
      artifactId: '11111111-1111-4111-8111-111111111111', channel: 'system-sync-test', ...configuration },
    target, URL, Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, Blob, DOMException, Event, EventTarget, MessageEvent,
    setTimeout(callback, ms) { timers.push(ms); return setTimeout(callback, ms); }, clearTimeout, setInterval, clearInterval,
  });
  return { target, calls, timers, dispose: () => emit('unload', {}) };
}

for (const kind of ['slides', 'design']) test(`${kind} Theme sync flushes edits before the native confirmation and returns its canonical status`, async t => {
  let release;
  const expected = { namespace: 'brand', changed: [], removed: [], copied: 2, canSync: true };
  const f = fixture({ kind }, message => {
    assert.equal(message.action, 'editor.systemSync');
    assert.equal(message.payload.namespace, 'brand');
    assert.deepEqual(Object.keys(message.payload), ['namespace'], 'No source path or copy instruction comes from the frame.');
    return expected;
  });
  t.after(f.dispose);
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = () => new Promise(resolve => { release = resolve; });
  const syncing = f.target.fetch('__ds-sync/brand', { method: 'POST' });
  await setImmediate();
  assert.equal(f.calls.length, 0);
  release(true);
  const response = await syncing;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.includes(45_000), false, 'A user confirmation must not expire behind an open dialog.');
});

test('cancelling native Theme sync preserves the source-behind state and performs no legacy POST', async t => {
  const behind = { namespace: 'brand', changed: ['tokens.json'], removed: [], copied: 0, canSync: true };
  const f = fixture({ kind: 'slides' }, () => behind);
  t.after(f.dispose);
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => true;
  const response = await f.target.fetch('__ds-sync/brand', { method: 'POST' });
  assert.deepEqual(await response.json(), behind);
  assert.deepEqual(f.calls.map(call => call.action), ['editor.systemSync']);
});

test('historical films and unsupported kinds cannot start design-system sync', async t => {
  for (const options of [{ kind: 'slides', readOnly: true }, { kind: 'motion' }, { kind: 'dashboard' }, { kind: 'design-system' }]) {
    const f = fixture(options, () => assert.fail('A refused sync must not contact the parent.'));
    t.after(f.dispose);
    f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => assert.fail('A refused sync must not flush or write artwork.');
    await assert.rejects(f.target.fetch('__ds-sync/brand', { method: 'POST' }), { code: options.readOnly ? 'EDITOR_PREVIEW_READ_ONLY' : 'SYSTEM_SYNC_UNAVAILABLE' });
    assert.equal(f.calls.length, 0);
  }
});

test('Theme status reads stay read-only and do not open a sync confirmation', async t => {
  const f = fixture({ kind: 'design' }, message => {
    assert.equal(message.action, 'editor.request');
    assert.equal(message.payload.request.method, 'GET');
    return { status: 200, headers: { 'content-type': 'application/json' }, body: btoa('{"changed":["tokens.json"]}') };
  });
  t.after(f.dispose);
  const response = await f.target.fetch('__ds-sync/brand');
  assert.deepEqual(await response.json(), { changed: ['tokens.json'] });
});
