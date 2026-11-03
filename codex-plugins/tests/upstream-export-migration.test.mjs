import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { startArtifactServer } from './artifact-server-fixture.mjs';

const require = createRequire(import.meta.url);
const { runtime } = require('../../skills/claude-slides/scripts/editor/node/compiler.cjs');
runtime.initializePptxFontEmbedding();
runtime.initializeFontInlining();
const fontDirectory = fileURLToPath(new URL('../../skills/claude-slides/scripts/editor/assets/', import.meta.url));
const fontName = (await fs.readdir(fontDirectory)).find(name => name.endsWith('.woff2'));
assert.ok(fontName, 'use an actual shipped font for decoder and CSS checks');
const fontBytes = new Uint8Array(await fs.readFile(path.join(fontDirectory, fontName)));
const family = 'Migration QA';
const fontUrl = 'https://fonts.gstatic.com/migration-qa.woff2';
const face = (url = fontUrl, range = 'U+0-10FFFF') => `@font-face{font-family:'${family}';font-style:normal;font-weight:400;src:url(${url}) format('woff2');unicode-range:${range};}`;
const faces = [{ family, href: 'https://fonts.googleapis.com/css2?family=Migration+QA:wght@400;700' }];
const slides = [{ frames: [{ node: { kind: 'text', text: '测试A', style: { fontFamily: { family, fallback: 'Arial' }, fontWeight: 400 } } }] }];
const licences = { cleared: name => name, unchecked: () => false, noticesOf: () => new Map() };

test('actual new compiler inlines shipped WOFF2 bytes into HTML CSS without leaving a remote font URL', async () => {
  const css = '@import url("https://fonts.googleapis.com/css2?family=Migration+QA");';
  const dataUrl = 'data:font/woff2;base64,' + Buffer.from(fontBytes).toString('base64');
  const requests = [];
  const result = await runtime.inlineGoogleFontFaces(css, { loadedFaces: 'all', text: '测试A',
    fetchText: async url => { requests.push(url); return face(); },
    fetchDataUrl: async url => { requests.push(url); return dataUrl; } });
  assert.equal(result.requested, true);
  assert.equal(result.unavailable, false);
  assert.equal(result.overBudget, false);
  assert.ok(result.css.includes(dataUrl));
  assert.equal(result.css.includes(fontUrl), false);
  assert.ok(requests.includes(fontUrl));
  assert.deepEqual([...result.carried], [family]);
});

test('actual new WOFF2 decoder and font parser retain variable-font rejection for PPTX', async () => {
  const decoded = await runtime.decompressWoff2(fontBytes);
  const info = runtime.readFontTables(decoded);
  assert.equal(info.flavor, 'truetype');
  assert.ok(info.tables.includes('glyf'));
  assert.ok(info.tables.includes('fvar'), 'the actual shipped icon font is variable, not an Arial acceptance sample');
  const result = await runtime.embedGoogleFontsForPptx(slides, faces, {}, licences,
    { fetchText: async () => face(), fetchBytes: async () => fontBytes });
  assert.equal(result.requested, true);
  assert.equal(result.fonts.length, 0);
  assert.equal(result.families[0].outcome, 'variable');
});

// The embedding algorithm is real compiled code. Its parser dependency is a
// controlled boundary here: the separate test above executes the actual parser
// and WOFF2 decoder. These large payloads test the budget, not real glyph data.
async function withFontMetadata(run) {
  const descriptor = Object.getOwnPropertyDescriptor(runtime, 'readFontTables');
  Object.defineProperty(runtime, 'readFontTables', { configurable: true, value: () => ({ flavor: 'truetype', tables: ['glyf'],
    names: { family, subfamily: 'Regular' }, os2: { fsType: 0 } }) });
  try { return await run(); }
  finally { Object.defineProperty(runtime, 'readFontTables', descriptor); }
}

test('actual PPTX font embedding requests a Unicode text subset when text spans multiple font blocks', async () => {
  await withFontMetadata(async () => {
    const sheets = [], files = [];
    const result = await runtime.embedGoogleFontsForPptx(slides, faces, {}, licences, {
      fetchText: async url => { sheets.push(url); return url.includes('&text=') ? face('https://fonts.gstatic.com/qa-subset.woff2')
        : face('https://fonts.gstatic.com/qa-latin.woff2', 'U+0-7F') + face('https://fonts.gstatic.com/qa-cjk.woff2', 'U+4E00-9FFF'); },
      fetchBytes: async url => { files.push(url); return new Uint8Array([1, 2, 3]); },
    });
    const subsetSheets = sheets.filter(url => url.includes('&text='));
    assert.ok(subsetSheets.length > 0);
    for (const url of subsetSheets) {
      const text = new URL(url).searchParams.get('text');
      assert.ok(text.includes('测') && text.includes('试') && text.includes('A'));
    }
    assert.ok(files.every(url => url.endsWith('/qa-subset.woff2')));
    assert.equal(result.families[0].outcome, 'carried');
    assert.equal(result.fonts.length, 1, 'equal font bytes are carried once');
    assert.ok(result.notes.some(note => note.key === 'font_only_deck_characters' || JSON.stringify(note).includes('font_only_deck_characters')));
  });
});

test('actual PPTX default budget accepts over 4 MiB and refuses over 16 MiB with a budget outcome', async () => {
  await withFontMetadata(async () => {
    for (const [size, expected] of [[5 * 1024 * 1024, 'carried'], [17 * 1024 * 1024, 'budget']]) {
      const bytes = new Uint8Array(size);
      const result = await runtime.embedGoogleFontsForPptx(slides, faces, {}, licences,
        { fetchText: async () => face(), fetchBytes: async () => bytes });
      assert.equal(result.families[0].outcome, expected);
      assert.equal(result.fonts.length, expected === 'carried' ? 1 : 0);
      if (expected === 'carried') assert.equal(result.fonts[0].data.byteLength, size);
    }
  });
});

const canvasDirectory = fileURLToPath(new URL('../../skills/claude-design/scripts/editor/assets/', import.meta.url));
const canvasName = (await fs.readdir(canvasDirectory)).find(name => /^index.*\.js$/.test(name));
const canvasSource = await fs.readFile(path.join(canvasDirectory, canvasName), 'utf8');
function standaloneBootstrap() {
  const exported = /e\.injected_PTt=([\w$]+)/.exec(canvasSource);
  assert.ok(exported);
  const declaration = new RegExp(`\\b${exported[1]}=\x60`).exec(canvasSource);
  assert.ok(declaration);
  const start = declaration.index + declaration[0].length - 1;
  let end = start + 1;
  for (; end < canvasSource.length; end++) {
    if (canvasSource[end] === '\\') { end++; continue; }
    if (canvasSource[end] === '`') break;
  }
  assert.ok(end < start + 100_000 && canvasSource[end] === '`');
  const value = vm.runInNewContext(canvasSource.slice(start, end + 1));
  assert.equal(typeof value, 'string');
  return value;
}
const bootstrap = standaloneBootstrap();
const navigation = readCommentComponent(bootstrap, /helper_openLinkedPage2 = function\([^)]*\) \{/);
const linkedClick = readCommentComponent(bootstrap, /function\(event, \.\.\._extraArguments12\) \{/);
assert.ok(navigation && linkedClick);

function navigationFixture() {
  const sourceWindow = {}, frame = { contentWindow: sourceWindow, src: 'blob:old', getAttribute(name) { return this[name]; } };
  const state = { a: '<h1>A</h1>', b: '<h1>B</h1>' }, mounts = [], warnings = [];
  const context = vm.createContext({ URL, console: { warn(...args) { warnings.push(args); } },
    value_isPageRoot: true, document: { querySelectorAll: () => [frame] }, value_framePages: new Map([[frame, 'a']]),
    value_pagePaths: { a: 'pages/A.dc.html', b: 'pages/B.dc.html' }, value_pageOfUrl: {},
    value_pageByPath: { 'pages/A.dc.html': 'a', 'pages/B.dc.html': 'b' }, state, value_linkedPageUrls: {},
    helper_mountPage2(target, hash, html, id) { mounts.push({ target, hash, html, id }); target.src = 'blob:' + id + hash; context.value_framePages.set(target, id); },
  });
  const open = vm.runInContext('(' + navigation.text.slice(navigation.text.indexOf('function(')) + ')', context);
  return { sourceWindow, frame, state, mounts, warnings, context, open };
}

test('actual exported Canvas navigation opens a relative artboard in the same frame and reuses its blob', () => {
  const f = navigationFixture();
  f.open(f.sourceWindow, 'B.dc.html#detail');
  assert.equal(f.frame.src, 'blob:b#detail');
  assert.equal(f.mounts[0].html, '<h1>B</h1>');
  f.open(f.sourceWindow, 'A.dc.html');
  assert.equal(f.frame.src, 'blob:a');
  f.open(f.sourceWindow, 'B.dc.html#second');
  assert.equal(f.frame.src, 'blob:b#second');
  assert.equal(f.mounts.length, 2, 'subsequent visits reuse the already built page URL');
});

test('actual exported Canvas navigation refuses unknown frames, external URLs and missing pages', () => {
  const f = navigationFixture();
  f.open({}, 'B.dc.html');
  f.open(f.sourceWindow, 'https://outside.invalid/B.dc.html');
  f.open(f.sourceWindow, '../private.dc.html');
  f.open(f.sourceWindow, 'Missing.dc.html');
  assert.equal(f.mounts.length, 0);
  assert.equal(f.frame.src, 'blob:old');
  assert.equal(f.warnings.length, 2);
});

test('actual exported Canvas click handler intercepts only ordinary relative HTML navigation', () => {
  const messages = [];
  const context = vm.createContext({ value_OWN_TARGET: '*', window: { location: { href: 'blob:a#old' }, parent: { postMessage(...args) { messages.push(args); } } } });
  const click = vm.runInContext('(' + linkedClick.text + ')', context);
  function event(href, attributes = {}, changes = {}) {
    let prevented = 0;
    const node = { nodeType: 1, localName: 'a', hasAttribute: key => key === 'href' || Object.hasOwn(attributes, key), getAttribute: key => key === 'href' ? href : attributes[key] ?? null };
    return { button: 0, defaultPrevented: false, composedPath: () => [node], preventDefault() { prevented++; }, ...changes, get prevented() { return prevented; } };
  }
  const ordinary = event('B.dc.html#next'); click(ordinary);
  assert.equal(ordinary.prevented, 1);
  assert.equal(messages[0][0].__bundler_open, 'B.dc.html#next');
  assert.equal(messages[0][0].__bundler_from, 'blob:a');
  for (const e of [event('https://outside.invalid/B.dc.html'), event('B.dc.html', { download: '' }), event('B.dc.html', { target: '_blank' }), event('B.dc.html', {}, { ctrlKey: true }), event('#same'), event('file.png')]) {
    click(e); assert.equal(e.prevented, 0);
  }
  assert.equal(messages.length, 1);
});

for (const kind of ['design', 'slides']) test(`actual ${kind} Theme endpoint serves only its copied Design System with passive HTML policy`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-upstream-theme-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  let server;
  t.after(async () => { await server?.close(); await setImmediate(); await fs.rm(root, { recursive: true, force: true }); });
  const project = path.join(root, 'project'), copy = path.join(project, 'ds', 'qa');
  await fs.mkdir(path.join(copy, 'components', 'Card'), { recursive: true });
  const index = kind === 'design' ? 'canvas.json' : 'deck.json';
  await fs.writeFile(path.join(project, index), JSON.stringify({ title: 'Theme QA', designSystems: [{ namespace: 'qa', title: 'Copied QA', version: '1', artifact: path.join(root, 'unrelated-source') }] }));
  const tokens = { color: { themes: [{ id: 'light', name: 'Light' }], tokens: [{ name: 'accent', value: '#0066cc' }] }, type: { families: { sans: 'Arial' }, groups: [] } };
  await fs.writeFile(path.join(copy, 'tokens.json'), JSON.stringify(tokens));
  await fs.writeFile(path.join(copy, 'README.md'), '# Local guide\n\n<script>alert("must not run")</script>\n\n[Private](../../../private.txt)');
  await fs.writeFile(path.join(copy, 'components', 'Card', 'README.md'), '# Card\n\nCopied card description.');
  await fs.writeFile(path.join(copy, 'components', 'Card', 'preview.html'), '<script>alert("not a passive preview")</script><div>Card preview</div>');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'README.md'), 'PRIVATE_OUTSIDE_MARKER');
  await fs.symlink(outside, path.join(project, 'ds', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  server = await startArtifactServer(fileURLToPath(new URL(`../../skills/claude-${kind}/scripts/server.mjs`, import.meta.url)), root);
  const page = await fetch(new URL('__ds/qa/', server.url));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.match(html, /Read-only copy this/);
  assert.match(html, /Copied QA/); assert.match(html, /#0066cc/); assert.match(html, /Copied card description/);
  assert.equal(/<script\b/i.test(html), false);
  assert.equal(html.includes('href="../../../private.txt"'), false);
  const preview = await fetch(new URL('project/ds/qa/components/Card/preview.html', server.url));
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-security-policy'), page.headers.get('content-security-policy'));
  const linked = await fetch(new URL('__ds/linked/', server.url));
  assert.equal(linked.status, 404);
  assert.equal((await linked.text()).includes('PRIVATE_OUTSIDE_MARKER'), false);
  assert.equal(await fs.readFile(path.join(copy, 'tokens.json'), 'utf8'), JSON.stringify(tokens));
});
