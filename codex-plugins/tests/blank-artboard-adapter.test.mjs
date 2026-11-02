import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptBlankArtboardCreation, completeNativeBlankArtboard, syncNativeBlankArtboardPreviews } from '../source/scripts/blank-artboard-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const rawAssets = fileURLToPath(new URL('../../skills/claude-design/scripts/editor/assets/', import.meta.url));
const filename = (await fs.readdir(rawAssets)).find(name => /^index.*\.js$/.test(name));
const original = await fs.readFile(path.join(rawAssets, filename), 'utf8');
const adapted = adaptBlankArtboardCreation(original);
const prelude = adapted.slice(0, adapted.indexOf(original.slice(0, 80)));
assert.ok(prelude.length > 0 && prelude.length < 12_000);

function exported(property) {
  const matches = [...original.matchAll(new RegExp(`\\b[at]\\(e,"${property}",\\(\\)=>([\\w$]+)`, 'g'))];
  assert.equal(matches.length, 1);
  const name = matches[0][1], start = original.lastIndexOf('function ' + name + '(', matches[0].index);
  const part = readCommentComponent(original.slice(start), new RegExp(`^function ${name}\\([^)]*\\)\\{`));
  assert.ok(part && part.text.length < 5_000, property);
  new vm.Script('(' + part.text + ')');
  return part.text;
}

function numericExport(property) {
  const match = new RegExp(`\\b[at]\\(e,"${property}",\\(\\)=>([\\w$]+)`).exec(original);
  assert.ok(match);
  const initialization = original.slice(match.index, original.indexOf('}}function', match.index));
  assert.ok(initialization.length < 50_000, property + ' initialization');
  const values = [...initialization.matchAll(new RegExp(`\\b${match[1]}=(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?=[,;}])`, 'g'))];
  assert.equal(values.length, 1, property);
  return Number(values[0][1]);
}

function uiOwner(source) {
  const part = readCommentComponent(source, /\(([\w$]+),([\w$]+),([\w$]+)\)=>\{let ([\w$]+)=([\w$]+)\.content\(\)\.files,([\w$]+)=\(0,e\.uniqueArtboardFile\)\(\4,"Artboard",[\w$]+\);/);
  assert.ok(part && part.text.length < 3_000);
  return part.text;
}

function batchOwner(source) {
  const part = readCommentComponent(source, /add:async\(([\w$]+),([\w$]+)\)=>\{(?=let [\w$]+=\/\^)/);
  assert.ok(part && part.text.length < 4_000);
  return part.text.slice('add:'.length);
}

function fixture({ native = true, source = adapted, files = {}, boards = [], nextFile = 'Artboard.dc.html' } = {}) {
  const writes = [], history = [], errors = [], events = [];
  const e = {
    blankDcDocument: vm.runInNewContext('(' + exported('blankDcDocument') + ')'),
    insertBlankArtboardMarkup: (blank, markup) => markup,
    uniqueArtboardFile: () => nextFile,
    PlatformFileContentHandler_4: file => file,
    PlatformFileContentConstant_5: numericExport('PlatformFileContentConstant_5'),
    PlatformFileContentConstant_6: numericExport('PlatformFileContentConstant_6'),
    PlatformFileContentConstant_16: numericExport('PlatformFileContentConstant_16'),
    PlatformFileContentLimit_6: numericExport('PlatformFileContentLimit_6'),
    PlatformFileContentFilesValue: 1_000,
    nextArtboardTitle: () => 'Artboard 1', duplicateArtboardTitle: () => 'Copy',
    PlatformFileContentSlice: value => value, artboardAppearanceProperties: () => ({}),
    isLoadingArtboardHtml: () => false,
    getKvClient: () => ({ async set(key, text) { writes.push({ key, text }); events.push('write'); files[key] = text; }, async get(key) { return files[key]; }, async delete(key) { delete files[key]; } }),
    frameAnalyticsReporter() {}, designAnalyticsEvents: { artboardInserted: 'inserted' },
  };
  const context = vm.createContext({ e,
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: { channel: 'blank-test' } } : {}),
    se: { content: () => ({ files }) }, Et: () => 'id', sa: { current: false }, tl: { current: boards }, ga: { current: { artboards: boards } },
    ne: () => ({ x: 0, y: 0 }), _l: () => ({}), xg: { current: () => ({}) }, Hn: { current: new Map() }, be: () => boards,
    fs: { current(value) { history.push(value); events.push('history'); } },
    Mr() { events.push('metadata'); }, Cn() {}, Ms() {}, Qi() {}, $d() {}, An() {},
    ge(message) { errors.push(message); },
  });
  // Preserve the actual batch owner's existing rounding/clamping expression.
  const sizing = /Ce=Le=>(Math\.min\(e\.PlatformFileContentLimit_6,Math\.max\(e\.PlatformFileContentConstant_16,Math\.round\(Le\)\)\))/.exec(original);
  assert.ok(sizing); context.Ce = vm.runInContext('(Le=>' + sizing[1] + ')', context);
  vm.runInContext(prelude, context);
  return { files, writes, history, errors, events, e, context,
    ui: vm.runInContext('(' + uiOwner(source) + ')', context),
    batch: vm.runInContext('(' + batchOwner(source) + ')', context),
  };
}

async function originalCheck(t, html, spec) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-blank-contract-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('codex-blank-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, spec.file), html);
  await fs.writeFile(path.join(project, 'canvas.json'), JSON.stringify({ v: 3, title: 'Blank contract QA', createdOnFiles: { v: 1, at: '2026-11-02T00:00:00Z' },
    boards: { [spec.file]: { x: spec.x ?? 0, y: spec.y ?? 0, w: spec.w, h: spec.h } }, order: [spec.file] }));
  const checker = fileURLToPath(new URL('../../skills/claude-design/scripts/artifact.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [checker, 'check', directory], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(run.stdout);
  return { status: run.status, result, stderr: run.stderr };
}

function preview(html) { return JSON.parse(/data-props='([^']*)'/.exec(html)[1].replaceAll('&#39;', "'").replaceAll('&amp;', '&')); }

for (const [name, size] of [['default', undefined], ['portrait', { x: 20, y: 30, w: 390, h: 844 }], ['custom', { x: 5, y: 7, w: 918.25, h: 667.5 }]]) test(`actual native UI ${name} blank artboard saves once with the resolved size and passes the unmodified checker`, async t => {
  const f = fixture();
  f.ui(size, '', undefined); await setImmediate();
  assert.deepEqual(f.errors, []); assert.equal(f.writes.length, 1);
  const entry = f.history[0].entries[0];
  assert.equal(entry.src, f.writes[0].text);
  assert.deepEqual(preview(entry.src).$preview, { width: entry.spec.w, height: entry.spec.h });
  assert.ok(entry.src.indexOf('data-dc-script') > entry.src.indexOf('</x-dc>'));
  const checked = await originalCheck(t, entry.src, entry.spec);
  assert.equal(checked.status, 0, JSON.stringify(checked.result));
});

test('actual native batch creation uses the existing normalized size and passes the unmodified checker', async t => {
  const f = fixture();
  await f.batch([{ body: '', w: 9000.4, h: 811.6 }], undefined);
  assert.deepEqual(f.errors, []); assert.equal(f.writes.length, 1);
  const entry = f.history[0].entries[0];
  assert.equal(entry.spec.w, f.e.PlatformFileContentLimit_6); assert.equal(entry.spec.h, 812);
  assert.deepEqual(preview(entry.src).$preview, { width: entry.spec.w, height: entry.spec.h });
  assert.equal((await originalCheck(t, entry.src, entry.spec)).status, 0);
});

test('the actual template replacement preserves generated logic while edited text still passes the original checker', async t => {
  const f = fixture(); f.ui(undefined, undefined, undefined); await setImmediate();
  const entry = f.history[0].entries[0];
  const replace = vm.runInNewContext('(' + exported('replaceDcTemplate') + ')');
  const start = entry.src.indexOf('<x-dc>') + '<x-dc>'.length, end = entry.src.indexOf('</x-dc>');
  const changed = replace(entry.src, { templateStart: start, templateEnd: end, unclosed: false }, entry.src.slice(start, end).replace('</section>', '<div>Edited text</div></section>'));
  assert.equal(changed.slice(changed.indexOf('<script type="text/x-dc"')), entry.src.slice(entry.src.indexOf('<script type="text/x-dc"')));
  assert.match(changed, /Edited text/);
  assert.equal((await originalCheck(t, changed, entry.spec)).status, 0);
});

function localStore(native = true) {
  const part = readCommentComponent(adapted, /function ([\w$]+)\(([\w$]+)\)\{(?=if\(globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__\)\2=__codexSyncBlankPreviews)/);
  assert.ok(part && part.text.length < 350);
  const observed = [];
  const context = vm.createContext({ O: null, e: { canvasMetadataFile: 'canvas.json' }, he() {}, ge() {}, at() { observed.push(context.O); },
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: { channel: 'state-test' } } : {}) });
  vm.runInContext(prelude, context);
  const update = vm.runInContext('(' + part.text + ')', context);
  return { apply(state) { const count = observed.length; update(state); assert.equal(observed.length, count + 1); return observed.at(-1); } };
}

const applyLocalState = (state, native = true) => localStore(native).apply(state);

test('the actual local content-update owner keeps resized index and generated preview in the same save state', async t => {
  const f = fixture(); f.ui({ x: 0, y: 0, w: 390, h: 844 }); await setImmediate();
  const entry = f.history[0].entries[0], size = { ...entry.spec, w: 1080, h: 680 };
  const state = { title: 'QA', content: { files: { [size.file]: entry.src, 'canvas.json': JSON.stringify({ v: 3, boards: { [size.file]: size } }) } } };
  const result = applyLocalState(state);
  const changed = result.content.files[size.file];
  assert.notEqual(result, state);
  assert.deepEqual(preview(changed).$preview, { width: 1080, height: 680 });
  assert.equal(changed.replace(/data-props='[^']*'/, ''), entry.src.replace(/data-props='[^']*'/, ''), 'markup, logic and all other attributes are unchanged');
  assert.equal(result.content.files['canvas.json'], state.content.files['canvas.json']);
  assert.equal((await originalCheck(t, changed, size)).status, 0);
  assert.equal(applyLocalState(state, false), state, 'legacy state updates remain untouched');
});

function indexedState(width = 400, height = 600) {
  const file = 'Own.dc.html';
  const blank = vm.runInNewContext('(' + exported('blankDcDocument') + ')')();
  const html = completeNativeBlankArtboard(blank, { file, w: 400, h: 600 });
  const index = JSON.stringify({ boards: { [file]: { w: width, h: height }, 'Large.dc.html': { w: 800, h: 600 } } });
  return { content: { files: { [file]: html, 'canvas.json': index, 'Large.dc.html': '<x-dc>' + 'large text '.repeat(100_000) + '</x-dc>' } } };
}

test('the actual store owner skips every other HTML read when typing leaves the index unchanged', () => {
  const store = localStore(), state = indexedState();
  store.apply(state);
  state.content.files['Own.dc.html'] = state.content.files['Own.dc.html'].replace('</section>', '<div>Typed</div></section>');
  Object.defineProperty(state.content.files, 'Large.dc.html', { configurable: true, enumerable: true,
    get() { throw new Error('An unchanged index must not read a different large artboard.'); } });
  const result = store.apply(state);
  assert.equal(result, state);
  assert.match(result.content.files['Own.dc.html'], /Typed/);
});

test('the actual store owner synchronizes A to B to A even when callers mutate the previous state in place', () => {
  const store = localStore(), state = indexedState();
  const a = state.content.files['canvas.json'];
  store.apply(state);
  state.content.files['canvas.json'] = JSON.stringify({ boards: { 'Own.dc.html': { w: 700, h: 900 } } });
  const b = store.apply(state);
  assert.deepEqual(preview(b.content.files['Own.dc.html']).$preview, { width: 700, height: 900 });
  state.content.files = b.content.files;
  state.content.files['canvas.json'] = a;
  const restored = store.apply(state);
  assert.deepEqual(preview(restored.content.files['Own.dc.html']).$preview, { width: 400, height: 600 });
});

test('different actual store owners do not share index caches and direct helper calls remain uncached and pure', () => {
  const first = localStore(), second = localStore();
  const input = indexedState(500, 700), originalIndex = input.content.files['canvas.json'];
  assert.deepEqual(preview(first.apply(input).content.files['Own.dc.html']).$preview, { width: 500, height: 700 });
  assert.deepEqual(preview(second.apply(input).content.files['Own.dc.html']).$preview, { width: 500, height: 700 });
  assert.deepEqual(preview(input.content.files['Own.dc.html']).$preview, { width: 400, height: 600 });
  for (let pass = 0; pass < 2; pass++) {
    const result = syncNativeBlankArtboardPreviews(input, 'canvas.json');
    assert.deepEqual(preview(result.content.files['Own.dc.html']).$preview, { width: 500, height: 700 });
    assert.equal(input.content.files['canvas.json'], originalIndex);
  }
});

test('failed computations do not cache the new index and the owner cache also distinguishes its index filename', () => {
  const store = localStore(), state = indexedState(500, 700);
  const html = state.content.files['Own.dc.html'];
  Object.defineProperty(state.content.files, 'Own.dc.html', { configurable: true, enumerable: true,
    get() { throw new Error('Temporary read failure.'); } });
  assert.throws(() => store.apply(state), /Temporary read failure/);
  Object.defineProperty(state.content.files, 'Own.dc.html', { configurable: true, enumerable: true, writable: true, value: html });
  assert.deepEqual(preview(store.apply(state).content.files['Own.dc.html']).$preview, { width: 500, height: 700 });
  const owner = () => {};
  const input = indexedState(500, 700);
  syncNativeBlankArtboardPreviews(input, 'canvas.json', owner);
  input.content.files['other-index.json'] = input.content.files['canvas.json'];
  const result = syncNativeBlankArtboardPreviews(input, 'other-index.json', owner);
  assert.deepEqual(preview(result.content.files['Own.dc.html']).$preview, { width: 500, height: 700 });
});

test('only a validated generated owner marker can synchronize preview; other props retain their meaning', () => {
  const spec = { file: 'Own.dc.html', w: 400, h: 600 };
  const blank = vm.runInNewContext('(' + exported('blankDcDocument') + ')')();
  const owned = completeNativeBlankArtboard(blank, spec);
  const props = { $preview: { width: 400, height: 600, extra: 'kept' }, accent: { editor: 'color', default: '#123456' }, text: "A & B's <label>" };
  const withProps = owned.replace(/data-props='[^']*'/, "data-props='" + JSON.stringify(props).replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('<', '&lt;') + "'");
  const state = html => ({ content: { files: { 'Own.dc.html': html, 'canvas.json': JSON.stringify({ boards: { 'Own.dc.html': { w: 500, h: 700 } } }) } } });
  const updated = syncNativeBlankArtboardPreviews(state(withProps), 'canvas.json');
  const parsed = JSON.parse(/data-props='([^']*)'/.exec(updated.content.files['Own.dc.html'])[1].replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
  assert.deepEqual(parsed, { ...props, $preview: { ...props.$preview, width: 500, height: 700 } });
  for (const html of [blank, owned.replace('data-codex-design-blank="Own.dc.html"', ''), owned.replace('Own.dc.html', 'Source.dc.html'), owned.replace('return {};', 'return { custom: true };'), owned.replace('data-props=', 'data-other=')]) {
    const input = state(html); assert.equal(syncNativeBlankArtboardPreviews(input, 'canvas.json'), input);
  }
  const copy = { content: { files: { 'Copy.dc.html': owned, 'canvas.json': JSON.stringify({ boards: { 'Copy.dc.html': { w: 700, h: 900 } } }) } } };
  assert.equal(syncNativeBlankArtboardPreviews(copy, 'canvas.json'), copy, 'a copied marker does not claim a different file');
});

test('legacy, custom markup, custom page rules and copied documents retain their exact original creation bytes', async () => {
  const custom = '<!doctype html><x-dc><div>Custom</div></x-dc><script data-dc-script>class Custom {}</script>';
  for (const native of [false, true]) for (const markup of [undefined, custom]) {
    if (native && markup === undefined) continue;
    const before = fixture({ source: original, native }), after = fixture({ native });
    before.ui(undefined, markup); after.ui(undefined, markup); await setImmediate();
    assert.equal(after.writes[0].text, before.writes[0].text); assert.deepEqual(after.events, before.events);
  }
  const empty = vm.runInNewContext('(' + exported('blankDcDocument') + ')')();
  for (const entry of [{ body: '<div>Custom body</div>', w: 800, h: 600 }, { body: '', pageRule: '/*ask:page*/body{background:#fff}/*ask:page-end*/', w: 800, h: 600 }, { from: 'Source.dc.html', body: '', w: 800, h: 600 }]) {
    const options = { files: { 'Source.dc.html': custom }, boards: [{ file: 'Source.dc.html', w: 800, h: 600 }] };
    const before = fixture({ ...options, files: { ...options.files }, source: original }), after = fixture({ ...options, files: { ...options.files } });
    await before.batch([entry]); await after.batch([entry]);
    assert.equal(after.writes[0].text, before.writes[0].text);
  }
  const legacy = fixture({ native: false }); await legacy.batch([{ body: '', w: 800, h: 600 }]); assert.equal(legacy.writes[0].text, empty);
});

test('the unchanged legacy blank remains a real original-checker failure rather than a weakened contract', async t => {
  const f = fixture({ native: false }); f.ui(); await setImmediate();
  const entry = f.history[0].entries[0], checked = await originalCheck(t, entry.src, entry.spec);
  assert.equal(checked.status, 1); assert.match(JSON.stringify(checked.result), /missing the.*data-dc-script/);
});

test('blank adaptation is idempotent, refuses drift, preserves the shared factory and leaves all four assemblies parseable', async () => {
  assert.equal(adaptBlankArtboardCreation(adapted), adapted);
  assert.equal(vm.runInNewContext('(' + exported('blankDcDocument') + ')')().includes('data-dc-script'), false);
  for (const [from, to] of [['(0,e.insertBlankArtboardMarkup)((0,e.blankDcDocument)(),be)', '(0,e.changedBlankMarkup)((0,e.blankDcDocument)(),be)'], ['kind:"add",entries:[{file:Ge,src:st,spec:Dt}]', 'kind:"changed-add",entries:[{file:Ge,src:st,spec:Dt}]'], ['Pt.body.trim()===""', 'Pt.changedBody.trim()===""']]) {
    assert.ok(original.includes(from)); assert.throws(() => adaptBlankArtboardCreation(original.replace(from, to)), /canonical/);
  }
  const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const dir = path.join(pluginRoot, 'skills', 'codex-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(dir)).find(name => /^index.*\.js$/.test(name));
    const source = await fs.readFile(path.join(dir, file), 'utf8');
    if (kind !== 'design') assert.equal(adaptBlankArtboardCreation(source), source);
    const script = adaptInlineEditorScript(source, `https://codex-design.invalid/${kind}/index.js`);
    const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, kind + ': ' + checked.stderr);
  }
});
