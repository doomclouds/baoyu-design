import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildEditorDocument, adaptInlineEditorScript } from '../source/server/editor-document.mjs';
import { bindNativeMotionDocument, bindNativeMotionPlayer } from '../source/scripts/motion-player-adapter.mjs';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { createArtifactThumbnail } from '../source/library/thumbnail.mjs';

const editorRoot = fileURLToPath(new URL('../../skills/claude-motion/scripts/editor/', import.meta.url));
const artifactId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const virtualBase = `https://codex-design.invalid/artifacts/${artifactId}/`;

function transportFixture(handler, options = {}) {
  const listeners = new Map(), calls = [];
  const emit = (name, event) => { for (const listener of listeners.get(name) || []) listener(event); };
  const parent = { postMessage(message) {
    if (message.type !== 'codex-design:editor-request') return;
    calls.push(message);
    Promise.resolve().then(() => handler(message)).then(result => emit('message', { source: parent,
      data: { type: 'codex-design:editor-response', channel: 'motion-test', requestId: message.requestId, result },
    }), error => emit('message', { source: parent,
      data: { type: 'codex-design:editor-response', channel: 'motion-test', requestId: message.requestId, error: { code: error.code, message: error.message } },
    }));
  } };
  const target = { parent, btoa, atob, Event,
    fetch: async () => { throw new Error('The player must use its native transport.'); },
    addEventListener(name, listener) { const group = listeners.get(name) || []; group.push(listener); listeners.set(name, group); },
    dispatchEvent(event) { emit(event.type, event); return !event.defaultPrevented; },
  };
  const configuration = { baseUrl: virtualBase, artifactId, channel: 'motion-test', kind: 'motion', ...options };
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target);', {
    configuration, target, URL, Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, Blob, DOMException, Event, EventTarget, MessageEvent,
    setTimeout: (callback, ms) => setTimeout(callback, ms === 500 ? 0 : ms), clearTimeout, setInterval, clearInterval,
  });
  return { target, calls, dispose: () => emit('unload', {}) };
}

test('the complete upstream Motion player assembles into an inline native document', async () => {
  const baseUrl = 'http://127.0.0.1:12345/motion/verified-session/';
  const result = await buildEditorDocument({ baseUrl, config: { virtualBase, bootstrap: 'globalThis.nativeMotionTest=true;' },
    fetchLocal: async value => {
      const url = new URL(value), relative = url.pathname.slice(new URL(baseUrl).pathname.length);
      assert.equal(url.origin, 'http://127.0.0.1:12345');
      return new Response(await fs.readFile(path.join(editorRoot, relative || 'index.html')));
    },
  });
  assert.ok(result.bytes > 4_000_000, 'the actual timeline/player stays in the document');
  assert.ok(result.html.includes('codex-design:native-motion-player'));
  assert.ok(result.html.includes('codex-design:native-agent-drafts'));
  assert.ok(result.html.includes('__CODEX_DESIGN_EDITOR_FLUSH__'));
  const tags = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assert.doesNotMatch(tags, /<script\b[^>]*\bsrc=|<link\b[^>]*rel="stylesheet"/i);
  for (const file of ['local-host.js', 'artifact-type/app.js']) {
    const source = adaptInlineEditorScript(await fs.readFile(path.join(editorRoot, file), 'utf8'), virtualBase + file);
    assert.doesNotThrow(() => new vm.Script(source));
  }
});

test('the upstream HTTP boot shim cannot replace native fetch or event transport', () => {
  const raw = `(function(BASE){\nvar P=location.protocol;
function under(u){return BASE+u}
var F=window.fetch;window.fetch=function(u){return F(under(u))};
const protocol='baoyu-sse';class S{}window.EventSource=S;
})("/motion/local/");window.__baoyuHistory={base:"/motion/local/",canRestore:true};`;
  const source = adaptInlineEditorScript(raw, virtualBase + '__codex/boot.js');
  const fetch = () => 'native', events = class NativeEvents {};
  const native = { window: { fetch, EventSource: events }, __CODEX_DESIGN_EDITOR_TRANSPORT__: {} };
  vm.runInNewContext(source, native);
  assert.equal(native.window.fetch, fetch);
  assert.equal(native.window.EventSource, events);
  assert.equal(native.window.__baoyuHistory.canRestore, true, 'owner/history metadata still initializes');
  const ordinary = { window: { fetch, EventSource: events }, location: { protocol: 'http:' } };
  vm.runInNewContext(source, ordinary);
  assert.notEqual(ordinary.window.EventSource, events, 'ordinary HTTP sessions retain their original scope shim');
});

test('Motion flush waits for the live-store write acknowledgement and removes stale ownership on disposal', async () => {
  const target = {}, changes = [];
  let pending = 1, disposed = false;
  const document = {
    async save() { changes.push('save'); },
    flushNow() { changes.push('flush'); setTimeout(() => { pending = 0; }, 30); },
    dirty: () => pending > 0,
    syncDetail: () => ({ pending, flights: pending }),
    saveState: () => ({ status: pending ? 'saving' : 'ready' }),
    dispose() { disposed = true; },
  };
  bindNativeMotionDocument(document, target);
  assert.equal(await target.__CODEX_DESIGN_EDITOR_FLUSH__(), true);
  assert.deepEqual(changes, ['save', 'flush']);
  assert.equal(pending, 0);
  document.dispose();
  assert.equal(disposed, true);
  assert.equal(target.__CODEX_DESIGN_EDITOR_FLUSH__, undefined);
});

test('Motion flush refuses a rejected edit instead of confirming that it was saved', async () => {
  for (const dirty of [true, false]) {
    const target = {};
    bindNativeMotionDocument({ save: async () => {}, flushNow() {}, dirty: () => dirty,
      syncDetail: () => ({ pending: dirty ? 1 : 0, flights: 0 }), saveState: () => ({ status: 'error' }), dispose() {},
    }, target);
    await assert.rejects(target.__CODEX_DESIGN_EDITOR_FLUSH__(), /unsaved changes/);
  }
});

test('native Motion selection preserves playback time and recut authored time separately', async () => {
  const target = {}, seeks = [];
  const host = { state: { t: 3.5, meta: { parts: [{ from: 10, start: 0 }] } }, seek: async t => seeks.push(t) };
  bindNativeMotionPlayer(host, (parts, t) => parts[0].from + t, target);
  assert.equal(target.__CODEX_DESIGN_MOTION_PLAYER__.state().t, 3.5);
  assert.equal(target.__CODEX_DESIGN_MOTION_PLAYER__.authoredTime(), 13.5);
  await target.__CODEX_DESIGN_MOTION_PLAYER__.seek(2);
  assert.deepEqual(seeks, [2]);
});

test('MP4 jobs flush saved edits, return only a scoped file receipt and save through the native dialog', async t => {
  const resource = { filename: '电影.mp4', mimeType: 'video/mp4', bytes: 150_000_000, exportToken: jobId, artifactId };
  let flushes = 0, polls = 0;
  const f = transportFixture(message => {
    if (message.action === 'editor.download') {
      assert.equal(message.payload.exportToken, jobId);
      assert.equal(message.payload.artifactId, artifactId);
      assert.equal(message.payload.base64, undefined, 'large movie bytes never cross the iframe message channel');
      return { path: '/user-selected/电影.mp4' };
    }
    if (message.payload.operation === 'start') {
      assert.equal(flushes, 1);
      assert.deepEqual(Object.keys(message.payload.options), ['height', 'fps']);
      return { jobId, status: 'running' };
    }
    if (message.payload.operation === 'status') return ++polls === 1
      ? { jobId, status: 'running', progress: { phase: 'frames', done: 3, total: 30 } }
      : { jobId, status: 'completed', resource };
    throw new Error('Unexpected export operation.');
  });
  t.after(f.dispose);
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => { flushes++; return true; };
  f.target.claude = {};
  const progress = [];
  const result = await f.target.__CODEX_DESIGN_MOTION_EXPORT__({ format: 'mp4', options: { height: 720, fps: 30, arbitraryPath: '/refused' } }, value => progress.push(value));
  assert.equal(result.bytes, resource.bytes);
  assert.equal(progress[0].done, 3);
  const saved = await f.target.claude.downloads.save({ filename: result.filename, data: result });
  assert.equal(saved.path, '/user-selected/电影.mp4');
  assert.equal(f.calls.some(call => call.payload.operation === 'cancel'), false);
});

test('an aborted MP4 export cancels the already-confirmed renderer job', async t => {
  const controller = new AbortController();
  const f = transportFixture(message => {
    if (message.payload.operation === 'start') { controller.abort(); return { jobId, status: 'running' }; }
    if (message.payload.operation === 'cancel') return { jobId, status: 'cancelled' };
    throw new Error('An aborted export must not keep polling.');
  });
  t.after(f.dispose);
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => true;
  await assert.rejects(f.target.__CODEX_DESIGN_MOTION_EXPORT__({ format: 'mp4' }, undefined, controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.calls.map(call => call.payload.operation), ['start', 'cancel']);
});

test('closing the native player cancels its active renderer job without waiting for a status response', async () => {
  let pending;
  const polling = new Promise(resolve => { pending = resolve; });
  const f = transportFixture(message => {
    if (message.payload.operation === 'start') return { jobId, status: 'running' };
    if (message.payload.operation === 'status') { pending(); return new Promise(() => {}); }
    if (message.payload.operation === 'cancel') return { jobId, status: 'cancelled' };
    throw new Error('Unexpected export operation.');
  });
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => true;
  const result = f.target.__CODEX_DESIGN_MOTION_EXPORT__({ format: 'mp4' });
  const rejected = assert.rejects(result, { code: 'EDITOR_CLOSED' });
  await polling; f.dispose(); await rejected;
  assert.equal(f.calls.filter(call => call.payload.operation === 'cancel').length, 1);
});

test('read-only Motion does not expose export jobs and cannot save another film receipt', async t => {
  const readOnly = transportFixture(() => assert.fail('A historical film cannot start a render.'), { readOnly: true });
  t.after(readOnly.dispose);
  assert.equal(readOnly.target.__CODEX_DESIGN_MOTION_EXPORT__, undefined);
  const f = transportFixture(() => assert.fail('A foreign receipt cannot reach Save As.'));
  t.after(f.dispose); f.target.claude = {};
  await assert.rejects(f.target.claude.downloads.save({ filename: 'movie.mp4', data: { exportToken: jobId, artifactId: 'foreign', mimeType: 'video/mp4' } }), { code: 'INVALID_DOWNLOAD' });
});

function thumbnailStore(files) {
  return {
    get: async () => ({ id: artifactId, kind: 'motion', title: 'A real film title', contentStatus: 'ok' }),
    listFiles: async () => Object.entries(files).map(([name, bytes]) => ({ path: name, bytes: bytes.length, contentType: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' })),
    readFile: async (_id, name, options) => ({ bytes: files[name].length,
      ...(options.encoding === 'utf8' ? { text: files[name].toString() } : { data: files[name].toString('base64') }) }),
  };
}

test('Motion library covers never execute film code or pretend a title card is a rendered frame', async () => {
  const files = { 'db/film/meta.json': Buffer.from('{"title":"A real film title"}'),
    'db/film/script.json': Buffer.from('{"code":"globalThis.PWNED=true"}') };
  const cover = await createArtifactThumbnail(thumbnailStore(files), artifactId);
  assert.equal(cover.fidelity, 'content-reference');
  assert.match(cover.srcdoc, /No stored poster or still frame/);
  assert.doesNotMatch(cover.srcdoc, /PWNED|<script\b|<iframe\b/);
  assert.match(cover.notes.join(' '), /title only/);
});

test('Motion library covers use a real uploaded poster through the content boundary', async () => {
  const id = '0123456789abcdef0123456789abcdef';
  const files = { 'db/film/meta.json': Buffer.from('{"title":"Stored poster"}'),
    'db/assets/poster.png.json': Buffer.from(JSON.stringify({ ref: '/_blob/' + id, mime: 'image/png' })),
    ['_blobs/' + id]: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'),
    ['_blobs/' + id + '.json']: Buffer.from('{"contentType":"image/png"}') };
  const cover = await createArtifactThumbnail(thumbnailStore(files), artifactId);
  assert.match(cover.srcdoc, /data:image\/png;base64,/);
  assert.doesNotMatch(cover.srcdoc, /No stored poster/);
  assert.equal(cover.sourceFile, 'db/assets/poster.png.json');
  assert.match(cover.notes.join(' '), /stored poster/);
});
