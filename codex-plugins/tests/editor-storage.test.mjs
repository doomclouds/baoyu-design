import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';

const configuration = { baseUrl: 'https://codex-design.invalid/artifacts/storage-test/', artifactId: 'storage-test', channel: 'storage-test-channel', hostDepth: 2 };

function fixture({ origin = 'null', withDocument = true, storage } = {}) {
  const attributes = {}, messages = [];
  let parentStorageReads = 0;
  const host = new Proxy({}, { get(_object, key) {
    if (key === 'document' || key === 'codexDesignBridge') throw new DOMException('Cross-origin host access is blocked.', 'SecurityError');
    if (key === 'localStorage' || key === 'sessionStorage') parentStorageReads++;
    return undefined;
  } });
  const target = {
    parent: { parent: host, postMessage: message => messages.push(message) },
    location: { origin }, fetch: async () => new Response(''), addEventListener() {}, btoa, atob,
    ...(withDocument ? { document: { documentElement: { setAttribute: (key, value) => { attributes[key] = value; } } } } : {}),
  };
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, get() {
      if (storage) return storage[key];
      throw new DOMException('Storage is disabled in an opaque document.', 'SecurityError');
    } });
  }
  return { target, attributes, messages, parentStorageReads: () => parentStorageReads };
}

test('opaque editor supplies separate document-local Storage with consistent string, key and removal semantics', () => {
  const f = fixture();
  installNativeEditorTransport(configuration, f.target);
  const local = f.target.localStorage, session = f.target.sessionStorage;
  assert.equal(f.attributes['data-codex-ui-storage'], 'memory');
  assert.equal(f.attributes['data-codex-parent-isolation'], 'blocked');
  assert.equal(f.attributes['data-codex-editor-origin'], 'null');
  assert.equal(f.parentStorageReads(), 0);
  assert.equal(local.length, 0);
  assert.equal(local.getItem('missing'), null);
  local.setItem(42, false);
  local.setItem('null-value', null);
  local.setItem('undefined-value', undefined);
  assert.equal(local.getItem('42'), 'false');
  assert.equal(local.getItem('null-value'), 'null');
  assert.equal(local.getItem('undefined-value'), 'undefined');
  assert.equal(local.length, 3);
  assert.equal(local.key(0), '42');
  assert.equal(local.key(99), null);
  assert.equal(local.key(-1), null);
  local.setItem(42, 100);
  assert.equal(local.length, 3);
  assert.equal(local.key(0), '42', 'overwriting a key retains its position');
  assert.equal(local.getItem(42), '100');
  assert.equal(session.getItem(42), null, 'session preferences do not share the local map');
  session.setItem(42, 'session');
  local.removeItem('null-value');
  local.removeItem('missing');
  assert.equal(local.length, 2);
  local.clear();
  assert.equal(local.length, 0);
  assert.equal(local.key(0), null);
  assert.equal(session.getItem(42), 'session');
});

test('the real vendor setter ordering can open, close and reopen Properties with functional toggles', () => {
  const f = fixture();
  installNativeEditorTransport(configuration, f.target);
  const key = 'dc-editor-props-open-v2';
  let renderedOpen = false;
  const read = () => JSON.parse(f.target.localStorage.getItem(key) ?? 'false');
  const set = value => {
    const next = typeof value === 'function' ? value(read()) : value;
    // The Canvas vendor hook writes Storage before updating its React state.
    f.target.localStorage.setItem(key, JSON.stringify(next));
    renderedOpen = next;
  };
  set(true);
  assert.equal(renderedOpen, true, 'floating text toolbar opens Properties');
  set(previous => !previous);
  assert.equal(renderedOpen, false, 'global toggle closes Properties');
  set(previous => !previous);
  assert.equal(renderedOpen, true, 'a second functional toggle reads the retained value');
  set(previous => !previous);
  assert.equal(renderedOpen, false);
  f.target.localStorage.setItem('dc-editor-mode', JSON.stringify('tweaks'));
  assert.equal(JSON.parse(f.target.localStorage.getItem('dc-editor-mode')), 'tweaks');
});

test('usable real storage stays untouched and non-opaque/no-document environments gain no fallback', () => {
  const local = { getItem() { return 'real-local'; }, setItem() {} };
  const session = { getItem() { return 'real-session'; }, setItem() {} };
  const available = fixture({ storage: { localStorage: local, sessionStorage: session } });
  const descriptor = Object.getOwnPropertyDescriptor(available.target, 'localStorage');
  installNativeEditorTransport(configuration, available.target);
  assert.equal(available.target.localStorage, local);
  assert.equal(available.target.sessionStorage, session);
  assert.equal(Object.getOwnPropertyDescriptor(available.target, 'localStorage').get, descriptor.get);
  assert.equal(available.attributes['data-codex-ui-storage'], undefined);
  for (const options of [{ origin: 'https://editor.example' }, { withDocument: false }]) {
    const f = fixture(options);
    const getter = Object.getOwnPropertyDescriptor(f.target, 'localStorage').get;
    installNativeEditorTransport(configuration, f.target);
    assert.equal(Object.getOwnPropertyDescriptor(f.target, 'localStorage').get, getter);
    assert.equal(f.attributes['data-codex-ui-storage'], undefined);
  }
});

test('serialized bootstrap is self-contained, supports absent Storage globals and never persists across documents', () => {
  const first = fixture();
  const run = target => vm.runInNewContext(`(${installNativeEditorTransport.toString()})(configuration, target)`, {
    configuration, target, URL, EventTarget, Event, MessageEvent, AbortController, DOMException, Uint8Array,
    setTimeout, clearTimeout, btoa, atob,
  }, { timeout: 2_000 });
  run(first.target);
  first.target.localStorage.setItem('dc-editor-props-open-v2', 'true');
  const second = fixture();
  run(second.target);
  assert.equal(second.target.localStorage.getItem('dc-editor-props-open-v2'), null);
  assert.equal(first.target.localStorage.getItem('dc-editor-props-open-v2'), 'true');
  const absent = fixture();
  delete absent.target.localStorage;
  delete absent.target.sessionStorage;
  run(absent.target);
  assert.equal(absent.target.localStorage.length, 0);
  assert.equal(absent.target.sessionStorage.length, 0);
  assert.ok(absent.messages.some(message => message.type === 'codex-design:editor-transport-ready'));
});
