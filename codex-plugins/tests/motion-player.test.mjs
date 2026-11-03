import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildEditorDocument, adaptInlineEditorScript } from '../source/server/editor-document.mjs';
import { bindNativeMotionDocument, bindNativeMotionPlayer, bindNativeMotionRoot, bindNativeMotionEditState, bindNativeMotionCommit, bindNativeMotionAudioRender } from '../source/scripts/motion-player-adapter.mjs';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { createArtifactThumbnail } from '../source/library/thumbnail.mjs';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';

const editorRoot = fileURLToPath(new URL('../../skills/claude-motion/scripts/editor/', import.meta.url));
const artifactId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const virtualBase = `https://codex-design.invalid/artifacts/${artifactId}/`;

function transportFixture(handler, options = {}, configure) {
  const listeners = new Map(), calls = [], messages = [];
  const emit = (name, event) => { for (const listener of listeners.get(name) || []) listener(event); };
  const parent = { postMessage(message) {
    messages.push(message);
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
  configure?.(target, parent);
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target);', {
    configuration, target, URL, Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, Blob, DOMException, Event, EventTarget, MessageEvent,
    setTimeout: (callback, ms) => setTimeout(callback, ms === 500 ? 0 : ms), clearTimeout, setInterval, clearInterval,
  });
  return { target, parent, calls, messages, emit, dispose: () => emit('unload', {}) };
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

test('the actual Motion source-export templates stay editable without a false author watermark', async () => {
  const original = await fs.readFile(path.join(editorRoot, 'artifact-type/app.js'), 'utf8');
  const source = adaptInlineEditorScript(original, virtualBase + 'artifact-type/app.js');
  const introduction = source.indexOf('"Editable Motion film. Saved on "');
  assert.ok(introduction > 0);
  const start = source.lastIndexOf('function ', introduction);
  const readme = readCommentComponent(source.slice(start), /^function ([\w$]+)\(([^)]*)\)\{/);
  assert.ok(readme);
  const text = vm.runInNewContext('(' + readme.text + ')(detail)', { detail: {
    day: '2026-11-04', leftOut: [], parts: ['film.json'], assets: false, uploads: false,
    byHand: [], picks: { page: 0, nowhere: 0 }, fonts: true, out: [],
  } });
  assert.match(text, /^Editable Motion film\. Saved on 2026-11-04\. This folder contains editable code\./);
  assert.doesNotMatch(text, /Made with Claude Motion|An AI model wrote this code/);
  assert.match(source, /SAFETY\n  The animation is stored as editable code\. Treat it as you would any code from outside\./);
  assert.doesNotMatch(source, /The animation's code was written by Claude/);
  assert.equal(source.includes('format:"claude-motion-source"'), true, 'The source-file compatibility format is not renamed.');
  assert.match(text, /keep each license file with them/);
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

test('a clean store does not confirm a local wording candidate until canonical validation and save finish', async () => {
  const target = {}; let pending = true, saves = 0;
  bindNativeMotionDocument({ save: async () => { saves++; }, flushNow() {}, dirty: () => false,
    syncDetail: () => ({ pending: 0, flights: 0 }), saveState: () => ({ status: 'ready' }), dispose() {},
  }, target);
  bindNativeMotionEditState('wording', () => ({ pending, error: null }), target);
  const result = target.__CODEX_DESIGN_EDITOR_FLUSH__();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(saves, 0);
  pending = false;
  assert.equal(await result, true); assert.equal(saves, 1);
});

test('native saving reuses the canonical complete UI commit before checking the document', async () => {
  const target = {}, order = [];
  bindNativeMotionDocument({ save: async () => { order.push('document-save'); }, flushNow() {}, dirty: () => false,
    syncDetail: () => ({ pending: 0, flights: 0 }), saveState: () => ({ status: 'ready' }), dispose() {},
  }, target);
  bindNativeMotionCommit(() => order.push('canonical-input-recut-retouch'), target);
  await target.__CODEX_DESIGN_EDITOR_FLUSH__();
  assert.ok(order.indexOf('canonical-input-recut-retouch') < order.indexOf('document-save'));
});

test('the actual wording setter lets an explicit no-op Reset recover a rejected draft without swallowing a new rejection', async () => {
  const original = await fs.readFile(path.join(editorRoot, 'artifact-type/app.js'), 'utf8');
  const source = adaptInlineEditorScript(original, virtualBase + 'artifact-type/app.js');
  const exported = /a\(e,"useWordingEdits",\(\)=>([\w$]+)/.exec(source);
  const start = source.lastIndexOf('function ' + exported[1] + '(', exported.index);
  const hook = readCommentComponent(source.slice(start), /^function [\w$]+\([^)]*\)\{/).text;
  const setter = readCommentComponent(hook, /[\w$]+=t\.useCallback\(\(([\w$]+),([\w$]+)\)=>\{if\(!([\w$]+)\.current\.active\|\|([\w$]+)\.readOnly\(\)\)return;/);
  const rejected = readCommentComponent(hook, /let [\w$]+=([\w$]+)=>\{(?=if\(globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__\)__codexWordingClose\.current\.error)/);
  assert.ok(setter && rejected);
  const clear = /;([\w$]+)\(\[\]\),([\w$]+)\.clear\(\)/.exec(rejected.text);
  const state = { current: { active: true, away: () => false, lines: [] } };
  const close = { current: { expected: undefined, error: null } };
  const context = { __CODEX_DESIGN_EDITOR_TRANSPORT__: {}, __codexWordingClose: close,
    [setter.match[3]]: state, [setter.match[4]]: { readOnly: () => false }, [clear[1]]: () => {}, [clear[2]]: { clear() {} },
    e: { setRetypedLine: (lines, id) => lines.filter(line => line.was !== id), serializeRetypedLines: lines => lines.length ? JSON.stringify(lines) : null, showEditorToast() {} } };
  const reset = vm.runInNewContext(`(${setter.match[1]},${setter.match[2]})=>{` + setter.text.slice(setter.text.indexOf('=>{') + 3), context);
  const reject = vm.runInNewContext(`(${rejected.match[1]})=>{` + rejected.text.slice(rejected.text.indexOf('=>{') + 3), context);
  reject('First render rejection'); assert.equal(close.current.error, 'First render rejection');
  reset('missing-old-edit', ''); assert.equal(close.current.error, null); assert.equal(close.current.expected, null);
  const target = {}; let saves = 0;
  bindNativeMotionDocument({ save: async () => { saves++; }, flushNow() {}, dirty: () => false,
    syncDetail: () => ({ pending: 0, flights: 0 }), saveState: () => ({ status: 'ready' }), dispose() {},
  }, target);
  bindNativeMotionEditState('wording', () => ({ pending: close.current.expected !== null, error: close.current.error }), target);
  assert.equal(await target.__CODEX_DESIGN_EDITOR_FLUSH__(), true); assert.equal(saves, 1);
  reject('New render rejection');
  await assert.rejects(target.__CODEX_DESIGN_EDITOR_FLUSH__(), /New render rejection/); assert.equal(saves, 1);
});

test('a newly accepted candidate during a store save must settle before its closing acknowledgement', async () => {
  const target = {}; let pending = false, saved, entered;
  const started = new Promise(resolve => { entered = resolve; });
  bindNativeMotionDocument({ save: () => { entered(); return new Promise(resolve => { saved = resolve; }); }, flushNow() {}, dirty: () => false,
    syncDetail: () => ({ pending: 0, flights: 0 }), saveState: () => ({ status: 'ready' }), dispose() {},
  }, target);
  bindNativeMotionEditState('wording', () => ({ pending, error: null }), target);
  let confirmed = false;
  const result = target.__CODEX_DESIGN_EDITOR_FLUSH__().then(value => { confirmed = true; return value; });
  await started; pending = true; saved();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(confirmed, false);
  pending = false; assert.equal(await result, true);
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

test('prepare-close quiesces playback before save and cancel keeps the live writer editable without restarting sound', async () => {
  const target = {}, events = [];
  let dirty = true;
  const document = { async save() { events.push('save'); }, flushNow() { dirty = false; }, dirty: () => dirty,
    syncDetail: () => ({ pending: dirty ? 1 : 0, flights: 0 }), saveState: () => ({ status: 'ready' }), dispose() { events.push('document.dispose'); } };
  const host = { state: { playing: true, t: 2 }, pause() { events.push('pause'); this.state.playing = false; },
    holdPreview(value) { events.push('hold:' + value); }, play() { events.push('play'); }, prime() { events.push('prime'); },
    dispose() { events.push('host.dispose'); } };
  bindNativeMotionDocument(document, target); bindNativeMotionPlayer(host, (_parts, t) => t, target);
  target.__CODEX_DESIGN_EDITOR_PREPARE_CLOSE__();
  host.play(); host.prime();
  assert.deepEqual(events, ['pause'], 'Rendering needed to validate local edits remains available until they are saved.');
  assert.equal(await target.__CODEX_DESIGN_EDITOR_FLUSH__(), true);
  assert.equal(events.at(-1), 'hold:true');
  assert.equal(events.includes('document.dispose'), false);
  target.__CODEX_DESIGN_EDITOR_CANCEL_CLOSE__();
  assert.equal(events.at(-1), 'hold:false');
  assert.equal(events.includes('play'), false, 'Cancellation does not suddenly resume audio.');
  dirty = true;
  assert.equal(await target.__CODEX_DESIGN_EDITOR_FLUSH__(), true);
  assert.equal(events.filter(value => value === 'save').length, 2);
});

test('final release unmounts React, disposes the writer/player once and rejects late resource binding', async () => {
  const target = {}, released = [];
  const host = { state: {}, pause() {}, holdPreview() {}, dispose() { released.push('host'); } };
  const document = { save: async () => {}, flushNow() {}, dirty: () => false, syncDetail: () => ({ pending: 0, flights: 0 }),
    saveState: () => ({ status: 'ready' }), dispose() { released.push('document'); } };
  bindNativeMotionDocument(document, target); bindNativeMotionPlayer(host, (_parts, t) => t, target);
  bindNativeMotionRoot({ unmount() { released.push('root'); host.dispose(); } }, target);
  target.__CODEX_DESIGN_EDITOR_DISPOSE__(); target.__CODEX_DESIGN_EDITOR_DISPOSE__();
  assert.deepEqual(released, ['root', 'host', 'document']);
  assert.equal(target.__CODEX_DESIGN_MOTION_PLAYER__, undefined);
  assert.equal(target.__CODEX_DESIGN_EDITOR_FLUSH__, undefined);
  const late = { state: {}, play() { assert.fail('A closed editor cannot start playback.'); },
    prime() { assert.fail('A closed editor cannot prime audio.'); }, load() { assert.fail('A closed editor cannot load another film.'); },
    dispose() { released.push('late host'); } };
  bindNativeMotionPlayer(late, (_parts, t) => t, target);
  late.play(); late.prime(); assert.equal(await late.load({}), null);
  bindNativeMotionDocument({ ...document, dispose() { released.push('late document'); } }, target);
  assert.equal(bindNativeMotionRoot({ unmount() { released.push('late root'); } }, target), false);
  assert.equal(target.__CODEX_DESIGN_MOTION_PLAYER__, undefined);
  assert.deepEqual(released.slice(-3), ['late host', 'late document', 'late root']);
});

test('a transport closed before the first Motion binding cannot resurrect a cold-loading film', async () => {
  const f = transportFixture(() => assert.fail('A closed frame cannot start a request.'));
  f.dispose();
  const released = [];
  bindNativeMotionDocument({ save() { assert.fail('No late save.'); }, dispose() { released.push('document'); } }, f.target);
  const host = { state: {}, play() { assert.fail('No late playback.'); }, prime() { assert.fail('No late audio.'); }, load() { assert.fail('No late render.'); }, dispose() { released.push('host'); } };
  bindNativeMotionPlayer(host, (_parts, time) => time, f.target);
  host.play(); host.prime(); assert.equal(await host.load({}), null);
  assert.equal(bindNativeMotionRoot({ unmount() { released.push('root'); } }, f.target), false);
  assert.deepEqual(released, ['document', 'host', 'root']);
  assert.equal(f.target.__CODEX_DESIGN_EDITOR_FLUSH__, undefined);
  assert.equal(f.target.__CODEX_DESIGN_MOTION_PLAYER__, undefined);
});

test('a late store-unavailable render cannot revive the released React root', () => {
  const target = {}, calls = [];
  const root = { render(value) { calls.push(value); }, unmount() { calls.push('unmount'); } };
  bindNativeMotionRoot(root, target);
  root.render('initial');
  target.__CODEX_DESIGN_EDITOR_DISPOSE__();
  root.render('store unavailable'); root.unmount();
  assert.equal(bindNativeMotionRoot(root, target), false);
  assert.deepEqual(calls, ['initial', 'unmount']);
});

test('a closing promotion shares the pending store save and cleanup runs once on dispose plus unload', async () => {
  const f = transportFixture(() => assert.fail('This save does not need a server request.'));
  let release, saves = 0, prepared = 0, cancelled = 0, disposed = 0;
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = () => { saves++; return new Promise(resolve => { release = resolve; }); };
  f.target.__CODEX_DESIGN_EDITOR_PREPARE_CLOSE__ = () => { prepared++; };
  f.target.__CODEX_DESIGN_EDITOR_CANCEL_CLOSE__ = () => { cancelled++; };
  f.target.__CODEX_DESIGN_EDITOR_DISPOSE__ = () => { disposed++; };
  const send = data => f.emit('message', { source: f.parent, data: { channel: 'motion-test', ...data } });
  send({ type: 'codex-design:editor-flush', requestId: 'save-1' });
  send({ type: 'codex-design:editor-flush', requestId: 'save-1', closing: true });
  assert.equal(saves, 1); assert.equal(prepared, 1); assert.equal(disposed, 0);
  release(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  const acknowledgements = f.messages.filter(message => message.type === 'codex-design:editor-flushed');
  assert.equal(acknowledgements.length, 1); assert.equal(acknowledgements[0].saved, true);
  assert.equal(acknowledgements[0].closing, true);
  send({ type: 'codex-design:editor-cancel-close' }); assert.equal(cancelled, 1);
  send({ type: 'codex-design:editor-dispose' }); f.dispose();
  assert.equal(disposed, 1);
});

test('promoting a completed generic flush submits a fresh closing save instead of replaying its old acknowledgement', async () => {
  const f = transportFixture(() => assert.fail('No server request is needed.'));
  let saves = 0;
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => { saves++; return true; };
  const send = closing => f.emit('message', { source: f.parent, data: { type: 'codex-design:editor-flush', channel: 'motion-test', requestId: 'same-id', ...(closing ? { closing: true } : {}) } });
  send(false); await new Promise(resolve => setTimeout(resolve, 0));
  send(true); await new Promise(resolve => setTimeout(resolve, 0));
  const acknowledgements = f.messages.filter(message => message.type === 'codex-design:editor-flushed');
  assert.equal(saves, 2);
  assert.equal(acknowledgements[0].closing, undefined); assert.equal(acknowledgements[1].closing, true);
  f.dispose();
});

test('closing blurs input before quiescing previews and disposal disconnects the pending readiness observer', async () => {
  const events = [], observers = []; let ready = false;
  const f = transportFixture(() => assert.fail('No server request is needed.'), {}, (target, parent) => {
    for (const name of ['document', 'codexDesignBridge']) Object.defineProperty(parent, name, { get() { throw new DOMException('Isolated host', 'SecurityError'); } });
    target.document = { body: null, documentElement: { setAttribute() {}, getAttribute() { return null; } },
      activeElement: { blur() { events.push('blur'); } }, addEventListener() {}, removeEventListener() {},
      querySelector() { return ready ? {} : null; } };
    target.MutationObserver = class { constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  });
  f.target.__CODEX_DESIGN_EDITOR_PREPARE_CLOSE__ = () => events.push('prepare');
  f.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => { events.push('save'); return true; };
  f.emit('message', { source: f.parent, data: { type: 'codex-design:editor-flush', channel: 'motion-test', requestId: 'closing', closing: true } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(events.indexOf('blur') < events.indexOf('prepare'));
  assert.ok(events.indexOf('prepare') < events.indexOf('save'));
  f.dispose(); ready = true;
  for (const observer of observers) { assert.equal(observer.disconnected, true); observer.callback([]); }
  assert.equal(f.messages.some(message => message.type === 'codex-design:editor-app-ready'), false);
});

test('forced disposal interrupts a pending writer barrier instead of confirming a late clean state', async () => {
  const target = {}; let dirty = true;
  bindNativeMotionDocument({ save: async () => {}, flushNow() {}, dirty: () => dirty,
    syncDetail: () => ({ pending: dirty ? 1 : 0, flights: 0 }), saveState: () => ({ status: 'saving' }), dispose() {},
  }, target);
  const waiting = target.__CODEX_DESIGN_EDITOR_FLUSH__();
  const rejected = assert.rejects(waiting, /closed/);
  await new Promise(resolve => setTimeout(resolve, 0));
  target.__CODEX_DESIGN_EDITOR_DISPOSE__(); dirty = false;
  await rejected;
});

test('a late decoded artwork asset is rejected after final disposal and cannot refill the released cache', async t => {
  const f = transportFixture(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: btoa('image bytes') }));
  let begin, finish;
  const decoding = new Promise(resolve => { begin = resolve; });
  t.mock.method(Response.prototype, 'arrayBuffer', () => { begin(); return new Promise(resolve => { finish = resolve; }); });
  const asset = f.target.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__('/_blob/0123456789abcdef0123456789abcdef');
  const rejected = assert.rejects(asset, { code: 'EDITOR_CLOSED' });
  await decoding; f.dispose();
  finish(new Uint8Array([1, 2, 3]).buffer);
  await rejected;
  assert.equal(f.target.__CODEX_DESIGN_EDITOR_TRANSPORT__.disposed, true);
  await assert.rejects(f.target.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__('/_blob/0123456789abcdef0123456789abcdef'), { code: 'EDITOR_CLOSED' });
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

function offlineAudioFixture(calls = []) {
  let paused;
  return {
    state: 'suspended', currentTime: 1, length: 90 * 48_000, sampleRate: 48_000,
    startRendering() { calls.push('start'); this.state = 'running'; return new Promise(() => {}); },
    suspend(at) { calls.push(['suspend', at]); return new Promise(resolve => { paused = () => { this.state = 'suspended'; resolve(); }; }); },
    resume() { calls.push('resume'); this.state = 'running'; return Promise.resolve(); },
    finishPause() { paused(); },
  };
}

test('closing waits for offline normalization to pause and cancelled closing restarts deferred analysis', async () => {
  const target = {}, calls = [], document = { save: async () => {}, flushNow() {}, dirty: () => false,
    syncDetail: () => ({ pending: 0, flights: 0 }), saveState: () => ({ status: 'ready' }), dispose() {} };
  bindNativeMotionDocument(document, target);
  const context = bindNativeMotionAudioRender(offlineAudioFixture(calls), target);
  context.startRendering(); target.__CODEX_DESIGN_EDITOR_PREPARE_CLOSE__();
  let acknowledged = false; const flush = target.__CODEX_DESIGN_EDITOR_FLUSH__().then(() => { acknowledged = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(acknowledged, false);
  context.finishPause(); await flush; assert.equal(context.state, 'suspended');
  const deferredCalls = [], deferred = bindNativeMotionAudioRender(offlineAudioFixture(deferredCalls), target);
  deferred.startRendering().catch(() => {}); assert.deepEqual(deferredCalls, []);
  target.__CODEX_DESIGN_EDITOR_CANCEL_CLOSE__();
  assert.equal(context.state, 'running'); assert.deepEqual(deferredCalls, ['start']);
  target.__CODEX_DESIGN_EDITOR_DISPOSE__();
  const lateCalls = [], late = bindNativeMotionAudioRender(offlineAudioFixture(lateCalls), target);
  await assert.rejects(late.startRendering(), /closed/); assert.deepEqual(lateCalls, []);
});

test('late suspension resumes after close cancellation and a new analysis schedules its pause before starting', async () => {
  const target = {}, calls = [], context = bindNativeMotionAudioRender(offlineAudioFixture(calls), target);
  target.__CODEX_DESIGN_EDITOR_PREPARE_CLOSE__(); context.startRendering();
  assert.deepEqual(calls, [['suspend', 1.02], 'start']);
  target.__CODEX_DESIGN_EDITOR_CANCEL_CLOSE__(); context.finishPause();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.state, 'running'); assert.equal(calls.at(-1), 'resume');
  target.__CODEX_DESIGN_EDITOR_DISPOSE__();
});
