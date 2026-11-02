import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adaptCommentViewport, nativeCommentBottom } from '../source/scripts/comment-viewport-adapter.mjs';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { mountNativeEditor, nativeCommentViewportHint } from '../source/ui/native-editor.mjs';

const upstream = fileURLToPath(new URL('../../skills/', import.meta.url));
const nativeFlag = '__CODEX_DESIGN_EDITOR_TRANSPORT__';
const viewportEvent = 'codex-design:comment-viewport-changed';
const popoverPattern = /function ([\w$]+)\(\{pin:[\w$]+,win:[\w$]+,onEscape:[\w$]+,children:[\w$]+\}\)\{/;
const listPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,dark:[\w$]+,top:[\w$]+,onClose:[\w$]+\}\)\{/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function canonical(kind) {
  const directory = path.join(upstream, 'claude-' + kind, 'scripts/editor');
  const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
  return (await fs.readFile(path.join(directory, kind === 'dashboard' ? 'comments.js' : /<script type="module"[^>]*src="([^"]+)"/.exec(html)[1]), 'utf8')).replaceAll('\r\n', '\n');
}

function helperSource(source) {
  return ['__codexCommentBottom', '__codexCommentPopoverStyle', '__codexCommentListStyle']
    .map(name => readCommentComponent(source, new RegExp(`function (${name})\\([^{]*\\) \\{`))?.text || '').join('\n');
}

function render(source, pattern, input, { native = false, height = 420 } = {}) {
  const part = readCommentComponent(source, pattern);
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const react = { useRef: () => ({ current: { offsetHeight: height } }), useState: initial => [initial === false ? false : height, () => {}], useLayoutEffect() {} };
  const values = { input, [nativeFlag]: native ? input.win?.[nativeFlag] || {} : undefined, Math, Number };
  for (const match of part.text.matchAll(/([\w$]+)\.(?:jsx|jsxs)\b/g)) values[match[1]] = jsx;
  for (const match of part.text.matchAll(/([\w$]+)\.(?:useRef|useState|useLayoutEffect)\b/g)) values[match[1]] = react;
  const dimensions = /Math\.min\(([\w$]+),[\w$]+\.innerWidth-2\*([\w$]+)\)/.exec(part.text);
  if (dimensions) { values[dimensions[1]] = 330; values[dimensions[2]] = 8; }
  const offsets = /\.left\+([\w$]+)\+([\w$]+)/.exec(part.text);
  if (offsets) { values[offsets[1]] = 36; values[offsets[2]] = 6; }
  const listDimensions = /right:([\w$]+),width:([\w$]+)/.exec(part.text);
  if (listDimensions) { values[listDimensions[1]] = 16; values[listDimensions[2]] = 330; }
  const context = new Proxy(values, { get: (object, key) => key === 'globalThis' ? context : Object.hasOwn(object, key) ? object[key] : () => undefined });
  return vm.runInNewContext(helperSource(source) + '\n' + part.text + `;${part.match[1]}(input)`, context);
}

function win({ bottom = 72, innerHeight = 698, scrollY = 0, innerWidth = 1100 } = {}) {
  return { innerWidth, innerHeight, scrollX: 0, scrollY, [nativeFlag]: { commentViewport: { bottom } } };
}

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
  test(`${kind}: real canonical comment cards retain legacy anchors and only clamp native bottom collisions`, async () => {
    const source = await canonical(kind), adapted = adaptCommentViewport(source);
    assert.equal(adaptCommentViewport(adapted), adapted);
    const cases = [
      { height: 180, pin: { left: 500, top: 100, flip: false } },
      { height: 420, pin: { left: 500, top: 650, flip: false } },
      { height: 900, pin: { left: 500, top: 650, flip: true } },
      { height: 420, pin: { left: 500, top: 870, flip: false }, scrollY: 220 },
      { height: 250, pin: { left: 250, top: 400, flip: true }, innerWidth: 300, innerHeight: 500 },
    ];
    for (const example of cases) {
      const viewport = win(example), input = { win: viewport, pin: example.pin, onEscape() {}, children: 'Canonical comment/reply UI' };
      const original = render(source, popoverPattern, input, example);
      const legacy = render(adapted, popoverPattern, input, example);
      assert.deepEqual({ ...legacy.props.style }, { ...original.props.style }, 'HTTP keeps its exact geometry and receives no overflow cap.');
      assert.equal(legacy.props['data-codex-comment-popover'], undefined);
      const actual = render(adapted, popoverPattern, input, { ...example, native: true });
      assert.equal(actual.props.style.left, original.props.style.left);
      assert.equal(actual.props.style.width, original.props.style.width);
      assert.equal(actual.props.children, original.props.children);
      assert.equal(actual.props['data-codex-comment-popover'], '');
      assert.equal(actual.props.style.maxHeight, viewport.innerHeight - 72 - 16);
      assert.equal(actual.props.style.overflowY, 'auto');
      assert.equal(actual.props.style.overscrollBehavior, 'contain');
      assert.ok(actual.props.style.top >= viewport.scrollY + 8);
      assert.ok(actual.props.style.top + Math.min(example.height, actual.props.style.maxHeight) <= viewport.scrollY + viewport.innerHeight - 72 - 8);
      if (example.pin.top === 100) assert.equal(actual.props.style.top, original.props.style.top, 'A card already above the reserve stays anchored.');
    }
    const viewport = win({ bottom: 0 });
    const input = { win: viewport, pin: { left: 500, top: 650 }, onEscape() {} };
    const zero = render(adapted, popoverPattern, input, { native: true });
    assert.equal(zero.props.style.top, render(source, popoverPattern, input).props.style.top, 'An explicitly nonoverlapping frame does not reserve another 72px.');
    viewport[nativeFlag].commentViewport.bottom = 150;
    const larger = render(adapted, popoverPattern, input, { native: true });
    assert.equal(larger.props.style.top, zero.props.style.top - 150);
    viewport.innerHeight = 420;
    const smaller = render(adapted, popoverPattern, input, { native: true, height: 900 });
    assert.equal(smaller.props.style.maxHeight, 254);
    assert.equal(smaller.props.style.top, 8);
    assert.equal(adaptCommentViewport('<section style="height:1200px">Authored design</section>'), '<section style="height:1200px">Authored design</section>');
    const integrated = adaptInlineEditorScript(source, 'https://codex-design.invalid/editor.js');
    assert.match(integrated, /codex-design:native-comment-viewport/);
  });

  test(`${kind}: native All comments list retains its toolbar position and scrolls above the same reserve`, async () => {
    const source = await canonical(kind), adapted = adaptCommentViewport(source), viewport = win();
    const input = { controller: { win: viewport }, state: { snapshot: { threads: [] } }, top: 50, dark: false, onClose() {} };
    const original = render(source, listPattern, input);
    const legacy = render(adapted, listPattern, input);
    assert.deepEqual({ ...legacy.props.style }, { ...original.props.style });
    const actual = render(adapted, listPattern, input, { native: true });
    assert.equal(actual.props.style.top, original.props.style.top);
    assert.equal(actual.props.style.right, original.props.style.right);
    assert.equal(actual.props.style.width, original.props.style.width);
    assert.equal(actual.props.style.maxHeight, 560);
    assert.equal(actual.props['data-codex-comment-list-viewport'], '');
    viewport[nativeFlag].commentViewport.bottom = 0;
    assert.equal(render(adapted, listPattern, input, { native: true }).props.style.maxHeight, 632);
  });

  test(`${kind}: canonical batched viewport subscription handles the private event and cleans every listener/frame`, async () => {
    const source = adaptCommentViewport(await canonical(kind));
    const name = /function ([\w$]+)\([\w$]+\)\{(?:const|let)\[,[\w$]+\]=(?:(?:[\w$]+\.useState)|(?:\(0,[\w$]+\.useState\)))\(0\);[^\n]*?codex-design:comment-viewport-changed/.exec(source)?.[1];
    assert.ok(name);
    const part = readCommentComponent(source, new RegExp(`function (${escape(name)})\\([\\w$]+\\)\\{`));
    for (const native of [false, true]) {
      const viewport = new EventTarget(), frames = new Map();
      let frameId = 0, renders = 0, cleanup;
      viewport.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
      viewport.cancelAnimationFrame = id => frames.delete(id);
      const flush = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
      const react = { useState: () => [0, () => { renders++; }], useEffect: effect => { cleanup = effect(); } };
      const namespace = /([\w$]+)\.useState/.exec(part.text)[1];
      vm.runInNewContext(part.text + `;${name}(viewport)`, { viewport, [namespace]: react, [nativeFlag]: native ? {} : undefined });
      viewport.dispatchEvent(new Event(viewportEvent)); viewport.dispatchEvent(new Event(viewportEvent));
      assert.equal(frames.size, native ? 1 : 0);
      flush(); assert.equal(renders, native ? 1 : 0);
      viewport.dispatchEvent(new Event('scroll')); viewport.dispatchEvent(new Event('resize'));
      assert.equal(frames.size, 1); flush();
      assert.equal(renders, native ? 2 : 1);
      viewport.dispatchEvent(new Event(viewportEvent));
      cleanup(); assert.equal(frames.size, 0);
      viewport.dispatchEvent(new Event(viewportEvent)); viewport.dispatchEvent(new Event('scroll')); viewport.dispatchEvent(new Event('resize'));
      assert.equal(frames.size, 0);
    }
  });
}

test('outer viewport hints translate only the actual reserved overlap into the editor coordinate system', () => {
  const viewport = { innerHeight: 890 }, frame = { clientHeight: 698, getBoundingClientRect: () => ({ bottom: 886, height: 698 }) };
  assert.deepEqual(nativeCommentViewportHint(frame, {}, viewport), { bottom: 68 });
  frame.getBoundingClientRect = () => ({ bottom: 790, height: 602 });
  assert.deepEqual(nativeCommentViewportHint(frame, {}, viewport), { bottom: 0 });
  frame.clientHeight = 602;
  assert.deepEqual(nativeCommentViewportHint(frame, { safeAreaInsets: { bottom: 140 } }, viewport), { bottom: 40 });
  frame.clientHeight = 1204;
  assert.deepEqual(nativeCommentViewportHint(frame, { safeAreaInsets: { bottom: 140 } }, viewport), { bottom: 80 }, 'A scaled iframe uses inner CSS pixels.');
  frame.clientHeight = 602;
  viewport.visualViewport = { offsetTop: 50, height: 650 };
  assert.deepEqual(nativeCommentViewportHint(frame, {}, viewport), { bottom: 162 });
  delete viewport.visualViewport;
  for (const bottom of [null, undefined, '140', -1, NaN, Infinity]) assert.deepEqual(nativeCommentViewportHint(frame, { safeAreaInsets: { bottom }, containerDimensions: { height: 99999 } }, viewport), { bottom: 0 });
  assert.equal(nativeCommentViewportHint({}, {}, viewport), undefined);
  frame.getBoundingClientRect = () => ({ bottom: 800, height: 0 });
  assert.equal(nativeCommentViewportHint(frame, {}, viewport), undefined);
  for (const bottom of [null, undefined, -1, NaN, Infinity, '0']) assert.equal(nativeCommentBottom({ [nativeFlag]: { commentViewport: { bottom } } }), 72);
  assert.equal(nativeCommentBottom(win({ bottom: 0 })), 0);
});

test('native transport validates viewport hints, preserves partial contexts, resets missing snapshot hints and emits only its own event', () => {
  const events = [], listeners = new Map(), parent = { postMessage() {} };
  const target = { parent, fetch: async () => { assert.fail('A viewport update must not fetch/publish artwork.'); }, btoa, atob,
    addEventListener: (name, handler) => listeners.set(name, handler), dispatchEvent: event => events.push(event.type), Event };
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target)', {
    target, configuration: { baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'viewport-channel' },
    URL, Map, Set, Uint8Array, EventTarget, Event, MessageEvent, AbortController, DOMException, Blob, Request, Response, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  });
  const receive = (data, source = parent) => listeners.get('message')({ source, data: { type: viewportEvent, channel: 'viewport-channel', ...data } });
  const bottom = () => target[nativeFlag].commentViewport.bottom;
  assert.equal(bottom(), 72);
  receive({ commentViewport: { bottom: 0 } }); assert.equal(bottom(), 0);
  receive({ commentViewport: { bottom: 0 } }); assert.equal(events.length, 1);
  receive({ type: 'codex-design:host-context-changed', context: { theme: 'dark' } }); assert.equal(bottom(), 0);
  receive({ commentViewport: { bottom: 140 } }, {}); assert.equal(bottom(), 0);
  receive({ channel: 'another-channel', commentViewport: { bottom: 140 } }); assert.equal(bottom(), 0);
  receive({ type: 'codex-design:host-context-changed', context: { theme: 'light' }, hostContextIsSnapshot: true, commentViewport: { bottom: 140 } }); assert.equal(bottom(), 140);
  receive({ type: 'codex-design:host-context-changed', context: {}, hostContextIsSnapshot: true }); assert.equal(bottom(), 72);
  receive({ commentViewport: { bottom: 0 } });
  receive({ commentViewport: null }); assert.equal(bottom(), 72);
  for (const value of [-10, '40', Infinity, NaN]) receive({ commentViewport: { bottom: value } });
  assert.equal(bottom(), 72);
  assert.ok(events.every(name => name === viewportEvent));
  listeners.get('unload')();
  const count = events.length;
  receive({ commentViewport: { bottom: 200 } });
  assert.equal(events.length, count); assert.equal(bottom(), 72);
});

function eventSurface() {
  const listeners = new Map();
  return { listeners,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) { for (const listener of [...listeners.get(type) || []]) listener(event); },
  };
}

test('native editor forwards full theme snapshots and changing geometry hints, then disconnects every viewport observer/subscription', () => {
  const sent = [], observers = [], viewport = eventSurface(), visual = eventSurface();
  viewport.innerHeight = 890; viewport.visualViewport = visual;
  viewport.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(element) { this.element = element; } disconnect() { this.closed = true; } };
  let rect = { bottom: 886, height: 698 }, subscriber, unsubscribed = false;
  const iframe = Object.assign(eventSurface(), { ownerDocument: { defaultView: viewport }, clientHeight: 698,
    contentWindow: { postMessage: message => sent.push(message) }, getBoundingClientRect: () => rect, setAttribute() {} });
  const context = { theme: 'dark', styles: { variables: { '--font-sans': 'Host UI' } } };
  const bridge = { hostContext: context, invoke() {}, subscribe(callback) { subscriber = callback; return () => { unsubscribed = true; }; } };
  const editor = mountNativeEditor({ iframe, bridge, artifactId: 'one', channel: 'outer-viewport', document: { html: '<html><body>Canonical editor</body></html>' } });
  viewport.dispatch('message', { source: iframe.contentWindow, data: { type: 'codex-design:editor-transport-ready', channel: 'outer-viewport' } });
  assert.equal(sent.at(-1).context, context);
  assert.equal(sent.at(-1).hostContextIsSnapshot, true);
  assert.deepEqual(sent.at(-1).commentViewport, { bottom: 68 });
  assert.equal(observers[0].element, iframe);
  rect = { bottom: 790, height: 602 }; iframe.clientHeight = 602;
  observers[0].callback();
  assert.equal(sent.at(-1).type, viewportEvent); assert.deepEqual(sent.at(-1).commentViewport, { bottom: 0 });
  const count = sent.length; viewport.dispatch('scroll'); assert.equal(sent.length, count);
  bridge.hostContext = { ...context, safeAreaInsets: { bottom: 140 } };
  subscriber({ type: 'host-context.changed' });
  assert.equal(sent.at(-1).context, bridge.hostContext); assert.equal(sent.at(-1).hostContextIsSnapshot, true);
  assert.deepEqual(sent.at(-1).commentViewport, { bottom: 40 });
  viewport.innerHeight = 950; viewport.dispatch('resize'); assert.deepEqual(sent.at(-1).commentViewport, { bottom: 0 });
  visual.offsetTop = 0; visual.height = 700; visual.dispatch('resize'); assert.deepEqual(sent.at(-1).commentViewport, { bottom: 230 });
  const loader = Buffer.from(iframe.src.split(',')[1], 'base64').toString();
  assert.match(loader, /codex-design:comment-viewport-changed/);
  editor.dispose();
  assert.equal(observers[0].closed, true); assert.equal(unsubscribed, true);
  for (const surface of [viewport, visual, iframe]) for (const handlers of surface.listeners.values()) assert.equal(handlers.size, 0);
  const after = sent.length; observers[0].callback(); subscriber({ type: 'host-context.changed' });
  viewport.dispatch('resize'); visual.dispatch('resize'); assert.equal(sent.length, after);
});
