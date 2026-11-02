import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptBlankArtboardCreation, completeNativeBlankArtboard, syncNativeBlankArtboardPreviews } from '../source/scripts/blank-artboard-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const rawAssets = fileURLToPath(new URL('../../skills/claude-design/scripts/editor/assets/', import.meta.url));
const filename = (await fs.readdir(rawAssets)).find(name => /^index.*\.js$/.test(name));
const original = (await fs.readFile(path.join(rawAssets, filename), 'utf8')).replaceAll('\r\n', '\n');
const adapted = adaptBlankArtboardCreation(original);
const prelude = adapted.slice(0, adapted.indexOf(original.slice(0, 80)));
assert.ok(prelude.length > 0 && prelude.length < 12_000);

// Load real, lazily linked vendor factories without mounting React or a UI.
// The bounded parser fallback handles regex literals in the shared metadata
// factory that the lightweight brace reader intentionally does not parse.
function vendorRuntime() {
  const exports = [...adapted.matchAll(/\b[at]\(e,"([^"\n]+)",\(\)=>([\w$]+)/g)];
  const factories = [...adapted.matchAll(/function ([\w$]+)\(e\)\{var /g)];
  const loaded = new Set(), target = { recordEdit() {} };
  let context;
  const load = property => {
    const item = exports.find(match => match[1] === property);
    if (!item) throw new Error('Missing vendor export: ' + String(property));
    const factory = factories.filter(match => match.index < item.index).at(-1);
    assert.ok(factory && !loaded.has(factory[1]), 'a missing export must have an uninitialized vendor factory');
    loaded.add(factory[1]);
    let text;
    try {
      const part = readCommentComponent(adapted.slice(factory.index), new RegExp(`^function ${factory[1]}\\(e\\)\\{`));
      new vm.Script('(' + part.text + ')'); text = part.text;
    } catch { /* Use the JS parser to find the actual factory boundary. */ }
    if (!text) for (let end = adapted.indexOf('}', item.index); end > 0 && end < factory.index + 100_000; end = adapted.indexOf('}', end + 1)) {
      const candidate = adapted.slice(factory.index, end + 1);
      try { new vm.Script('(' + candidate + ')'); text = candidate; break; } catch { /* Not this closing brace. */ }
    }
    assert.ok(text, 'extract the complete actual vendor factory for ' + property);
    vm.runInContext('(' + text + ')', context)(registry)();
  };
  const registry = new Proxy(target, { get(object, property) { if (!Reflect.has(object, property)) load(property); return Reflect.get(object, property); } });
  const bootstrap = readCommentComponent(original, /function ([\w$]+)\(e\)\{(?=e\.load_react=)/);
  assert.ok(bootstrap, 'the real vendor dependency registry bootstrap exists');
  for (const entry of bootstrap.text.matchAll(/e\.(initializeNpm_[\w$]+)=\(\)=>\{\}/g)) target[entry[1]] = () => {};
  context = vm.createContext({ e: registry, t: (object, name, get, set) => Object.defineProperty(object, name, { get, set, configurable: true }),
    TextEncoder, TextDecoder, Uint8Array, Blob, URL, atob, btoa, setTimeout, clearTimeout, setInterval, clearInterval, performance, structuredClone, console,
    __CODEX_DESIGN_EDITOR_TRANSPORT__: { channel: 'actual-resize-test' } });
  const runtimeFactories = [...original.matchAll(/function ([\w$]+)\(\)\{if\(([\w$]+)\)return ([\w$]+);\2=1;var [\w$]+=Symbol\.for\("react\.transitional\.element"\)/g)]
    .map(match => ({ ...readCommentComponent(original, new RegExp(`function (${match[1]})\\(\\)\\{`)), flag: match[2], value: match[3] }));
  const react = runtimeFactories.find(part => part.text.includes('.useState=') && /\.version="19\./.test(part.text));
  const jsx = runtimeFactories.find(part => part.text.includes('.jsx=') && part.text.includes('.jsxs='));
  assert.ok(react && react.text.length < 10_000 && jsx && jsx.text.length < 1_000);
  for (const part of [react, jsx]) Object.assign(context, { [part.flag]: 0, [part.value]: {} });
  const reactRuntime = vm.runInContext('(' + react.text + ')()', context);
  const jsxRuntime = vm.runInContext('(' + jsx.text + ')()', context);
  target.load_react = () => reactRuntime; target.load_react_jsx_runtime = () => jsxRuntime;
  const dom = [...original.matchAll(/function ([\w$]+)\(\)\{if\(([\w$]+)\)return ([\w$]+);\2=1;/g)]
    .map(match => ({ ...readCommentComponent(original, new RegExp(`function (${match[1]})\\(\\)\\{`)), flag: match[2], value: match[3] }))
    .find(part => part.text.length < 10_000 && part.text.includes('.createPortal=') && /\.version="19\./.test(part.text));
  assert.ok(dom, 'the real ReactDOM exports factory exists');
  const reactLoader = /;var [\w$]+=([\w$]+)\(\)/.exec(dom.text)?.[1];
  assert.ok(reactLoader);
  Object.assign(context, { [dom.flag]: 0, [dom.value]: {}, [reactLoader]: () => reactRuntime });
  const domRuntime = vm.runInContext('(' + dom.text + ')()', context);
  target.load_react_dom = () => domRuntime;
  const provideRuntime = (factory, runtime) => {
    const use = original.indexOf('.exports=' + factory.match[1] + '()');
    let wrapper;
    for (let start = original.lastIndexOf('function ', use); start >= 0 && use - start < 2_000; start = original.lastIndexOf('function ', start - 1)) {
      const part = readCommentComponent(original.slice(start), /^function ([\w$]+)\(\)\{/);
      if (part && start + part.end > use) { wrapper = { ...part, end: start + part.end }; break; }
    }
    assert.ok(wrapper, 'the actual package loader for ' + factory.match[1]);
    const declaration = new RegExp(`^var ([\\w$]+)=${wrapper.match[1]}\\(\\);const ([\\w$]+)=[\\w$]+\\(\\1\\),([\\w$]+)=`).exec(original.slice(wrapper.end));
    assert.ok(declaration, 'the actual imported runtime namespace');
    Object.assign(context, { [wrapper.match[1]]: () => runtime, [declaration[1]]: runtime,
      [declaration[2]]: runtime, [declaration[3]]: { ...runtime, default: runtime } });
  };
  provideRuntime(react, reactRuntime); provideRuntime(jsx, jsxRuntime); provideRuntime(dom, domRuntime);
  // The new history/document module shares the real, pure class-name runtime.
  // Load those shipped definitions rather than replacing metadata or merge code.
  const classNames = /e\.npm_clsx_[\w$]+=([\w$]+)/.exec(bootstrap.text)?.[1];
  const classFunction = classNames && readCommentComponent(original, new RegExp(`function (${classNames})\\([^)]*\\)\\{`));
  const classHelper = /=[\w$]+\[[\w$]+\]\)&&\([\w$]+=([\w$]+)\(/.exec(classFunction?.text ?? '')?.[1];
  const validators = /e\.npm_validators_[\w$]+=([\w$]+)/.exec(bootstrap.text)?.[1];
  assert.ok(classHelper && validators, 'canonical pure dependency names');
  const pureStart = original.indexOf('function ' + classHelper + '('), minimum = original.indexOf(validators + '=Object.defineProperty(', pureStart);
  let pure;
  for (let end = original.indexOf(';', minimum); minimum >= 0 && end > 0 && end < pureStart + 100_000; end = original.indexOf(';', end + 1)) {
    const candidate = original.slice(pureStart, end + 1);
    try { new vm.Script(candidate); pure = candidate; break; } catch { /* Find the full canonical declaration boundary. */ }
  }
  assert.ok(pure && pure.length < 100_000, 'the bounded, pure dependency program exists');
  vm.runInContext(pure, context);
  const unmountedUi = name => new Proxy(function () { throw new Error('Unexpected UI execution in filesystem fixture: ' + name); }, {
    get(_target, property) { return property === '__esModule' ? false : unmountedUi(name + '.' + String(property)); },
    apply() { throw new Error('Unexpected UI execution in filesystem fixture: ' + name); },
    construct() { throw new Error('Unexpected UI construction in filesystem fixture: ' + name); },
  });
  for (const entry of bootstrap.text.matchAll(/e\.(npm_[\w$]+)=([\w$]+)/g)) {
    try { target[entry[1]] = vm.runInContext(entry[2], context); }
    catch (error) {
      if (error.name !== 'ReferenceError') throw error;
      // The verified host bootstrap also supplies opaque UI dependencies.
      // This filesystem port never mounts them; fail if one is actually used.
      target[entry[1]] = unmountedUi(entry[1]);
    }
  }
  vm.runInContext(prelude, context);
  return { e: registry, context };
}

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
  const ui = uiOwner(source), batch = batchOwner(source);
  const names = {
    document: /let [\w$]+=([\w$]+)\.content\(\)\.files/.exec(ui)?.[1],
    allocating: /\(0,e\.uniqueArtboardFile\)\([\w$]+,"Artboard",([\w$]+)\)/.exec(ui)?.[1],
    adding: /&&\(([\w$]+)\.current=!0\)/.exec(ui)?.[1],
    boards: /let [\w$]+=([\w$]+)\.current\.filter/.exec(ui)?.[1],
    manifest: /\.\.\.([\w$]+)\.current\.artboards/.exec(ui)?.[1],
    position: /[\w$]+\?\?([\w$]+)\([\w$]+\),/.exec(ui)?.[1],
    appearance: /\.\.\.([\w$]+)\(\)\}/.exec(ui)?.[1],
    history: /([\w$]+)\.current\(\{kind:"add",entries:/.exec(ui)?.[1],
    metadata: /([\w$]+)\(\{artboards:/.exec(ui)?.[1],
    errors: /,([\w$]+)\(\(0,e\.formatMessage\)/.exec(ui)?.[1],
    pendingOwners: /=>?([\w$]+)\.current\.get\(/.exec(batch)?.[1],
    boardList: /,[\w$]+=\[\.\.\.([\w$]+)\(\)\]/.exec(batch)?.[1],
    batchAppearance: /\.\.\.([\w$]+)\.current\(\)\}/.exec(batch)?.[1],
  };
  for (const [name, value] of Object.entries(names)) assert.ok(value, 'actual creation seam: ' + name);
  const bindings = { e, ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: { channel: 'blank-test' } } : {}) };
  // Only callbacks surrounding the extracted creation owners are substituted;
  // their source-selection, sizing and file-writing code executes unchanged.
  for (const text of [ui, batch]) for (const match of text.matchAll(/(?<![\w$.])([\w$]+)\(/g)) {
    if (!['if', 'for', 'catch', 'async', 'Set', 'String'].includes(match[1]) && !match[1].startsWith('__codex')) bindings[match[1]] ??= () => {};
  }
  Object.assign(bindings, {
    [names.document]: { content: () => ({ files }) }, [names.allocating]: () => 'id', [names.adding]: { current: false },
    [names.boards]: { current: boards }, [names.manifest]: { current: { artboards: boards } },
    [names.position]: () => ({ x: 0, y: 0 }), [names.appearance]: () => ({}),
    [names.batchAppearance]: { current: () => ({}) }, [names.pendingOwners]: { current: new Map() }, [names.boardList]: () => boards,
    [names.history]: { current(value) { history.push(value); events.push('history'); } },
    [names.metadata]() { events.push('metadata'); }, [names.errors](message) { errors.push(message); },
  });
  const context = vm.createContext(bindings);
  // Preserve the actual batch owner's existing rounding/clamping expression.
  const sizing = /([\w$]+)=([\w$]+)=>(Math\.min\(e\.PlatformFileContentLimit_6,Math\.max\(e\.PlatformFileContentConstant_16,Math\.round\(\2\)\)\))/.exec(original);
  assert.ok(sizing); context[sizing[1]] = vm.runInContext('(' + sizing[2] + '=>' + sizing[3] + ')', context);
  vm.runInContext(prelude, context);
  return { files, writes, history, errors, events, e, context,
    ui: vm.runInContext('(' + ui + ')', context),
    batch: vm.runInContext('(' + batch + ')', context),
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
  const aliases = /;([\w$]+)=([\w$]+),([\w$]+)\(\2\.content\.files\),([\w$]+)\(!1\),([\w$]+)\(\)\}/.exec(part.text);
  assert.ok(aliases, 'the actual local update callbacks must be identifiable');
  const context = vm.createContext({ [aliases[1]]: null, e: { canvasMetadataFile: 'canvas.json' }, [aliases[3]]() {}, [aliases[4]]() {}, [aliases[5]]() { observed.push(context[aliases[1]]); },
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

async function actualDocument(t, runtime = vendorRuntime()) {
  const { e, context } = runtime;
  const initialSpec = { file: 'Owned.dc.html', x: 0, y: 0, w: 800, h: 600 };
  const initialHtml = completeNativeBlankArtboard(e.blankDcDocument(), initialSpec);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-real-resize-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'project'));
  const initialIndex = { v: 3, title: 'Actual Resize QA', createdOnFiles: { v: 1, at: '2026-11-02T00:00:00Z' },
    boards: { [initialSpec.file]: { x: 0, y: 0, w: 800, h: 600 } }, order: [initialSpec.file], launch: { view: 'canvas' }, pages: [], notes: {}, designSystems: [] };
  await fs.writeFile(path.join(directory, 'project/canvas.json'), JSON.stringify(initialIndex));
  await fs.writeFile(path.join(directory, 'project', initialSpec.file), initialHtml);
  const hash = text => createHash('sha256').update(text).digest('hex');
  let version = 0;
  const saved = new Map(), batches = [];
  for (const file of ['canvas.json', initialSpec.file]) saved.set('project/' + file, await fs.readFile(path.join(directory, 'project', file), 'utf8'));
  const port = { canWrite: true, version: () => ({ version: 'v' + version }),
    list: async () => [...saved].map(([path, text]) => ({ path, sha256: hash(text), size: Buffer.byteLength(text), contentType: path.endsWith('.json') ? 'application/json' : 'text/html' })),
    readText: async file => ({ text: saved.get(file), sha256: hash(saved.get(file)) }),
    readBytes: async file => ({ bytes: new TextEncoder().encode(saved.get(file)), sha256: hash(saved.get(file)) }),
    onRemoteChange: () => () => {}, liveSha: file => saved.has(file) ? hash(saved.get(file)) : null,
    async publish(batch, options) {
      // A filesystem port fixture is the persistence boundary, not a second
      // implementation of metadata mutation, normalization or dirty selection.
      for (const [file, expected] of Object.entries(options.ifMatch)) assert.equal(saved.has(file) ? hash(saved.get(file)) : null, expected);
      const files = {};
      for (const [file, entry] of Object.entries(batch)) {
        assert.ok(file.startsWith('project/') && !file.includes('..'));
        const text = typeof entry === 'string' ? entry : entry.content;
        assert.equal(typeof text, 'string'); files[file] = text;
      }
      batches.push(files);
      for (const [file, text] of Object.entries(files)) { await fs.writeFile(path.join(directory, file), text); saved.set(file, text); }
      return { ok: true, version: 'v' + (++version), shas: Object.fromEntries(Object.keys(files).map(file => [file, hash(saved.get(file))])), preconditionsChecked: true };
    },
  };
  const doc = e.createFilesDesignDocument({ port, canWrite: true, defaultTitle: 'Actual Resize QA' });
  t.after(() => doc.dispose());
  for (let attempt = 0; attempt < 100 && doc.loadState() === 'loading'; attempt++) await setImmediate();
  assert.equal(doc.loadState(), 'live');
  assert.ok(Array.isArray(JSON.parse(doc.content().files[e.canvasMetadataFile]).artboards), 'the real live seam is not the disk boards map');
  const kv = e.createDocumentKvAdapter(doc);
  const mutation = readCommentComponent(original, /\(([\w$]+),([\w$]+)\)=>\{(?=let [\w$]+=\(0,e\.mergeMissingCanvasManifestMetadata\))/);
  assert.ok(mutation && mutation.text.length < 700);
  const owner = vm.runInContext('(' + mutation.text + ')', context);
  const aliases = {
    manifest: /\?\?([\w$]+)\.current/.exec(mutation.text)?.[1],
    pending: /;([\w$]+)\.current=[\w$]+,/.exec(mutation.text)?.[1],
    revision: /,([\w$]+)\.current\+\+/.exec(mutation.text)?.[1],
    normalize: /===void 0\?([\w$]+)\(/.exec(mutation.text)?.[1],
    errors: /=>?([\w$]+)\(\(0,e\.formatMessage\)/.exec(mutation.text)?.[1],
  };
  for (const [name, value] of Object.entries(aliases)) assert.ok(value, 'actual Resize seam: ' + name);
  const callbacks = {};
  for (const match of mutation.text.matchAll(/(?<![\w$.])([\w$]+)\(/g)) if (!['if', 'String'].includes(match[1])) callbacks[match[1]] ??= () => {};
  const manifest = () => e.parseCanvasMetadata(doc.content().files[e.canvasMetadataFile], doc.content().files);
  return { doc, kv, batches, runtime, manifest,
    async text(value) {
      e.setKvClient(kv);
      await kv.set(e.PlatformFileContentHandler_4(initialSpec.file), doc.content().files[initialSpec.file].replace('</section>', '<div>' + value + '</div></section>'));
      await doc.settle();
    },
    async commit(value) {
      e.setKvClient(kv);
      Object.assign(context, callbacks, { [aliases.manifest]: { current: manifest() }, [aliases.pending]: { current: null },
        [aliases.revision]: { current: 0 }, [aliases.normalize]: value => value,
        [aliases.errors](message) { throw new Error(message); } });
      owner(value); await doc.settle();
    },
    async disk() { return { index: JSON.parse(await fs.readFile(path.join(directory, 'project/canvas.json'), 'utf8')),
      html: await fs.readFile(path.join(directory, 'project', initialSpec.file), 'utf8') }; },
    check() {
      const checker = fileURLToPath(new URL('../../skills/claude-design/scripts/artifact.mjs', import.meta.url));
      const checked = spawnSync(process.execPath, [checker, 'check', directory], { encoding: 'utf8', windowsHide: true });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    },
  };
}

test('actual Resize metadata owner, KV adapter, files store and publisher persist matching dimensions after text editing', async t => {
  const f = await actualDocument(t);
  await f.text('Text before Resize'); f.batches.length = 0;
  await f.commit({ artboards: [{ ...f.manifest().artboards[0], w: 900, h: 620 }] });
  const { index: disk, html } = await f.disk();
  const file = 'Owned.dc.html';
  assert.equal(disk.boards[file].w, 900); assert.equal(disk.boards[file].h, 620);
  assert.deepEqual(preview(html).$preview, { width: 900, height: 620 }); assert.match(html, /Text before Resize/);
  assert.equal(f.batches.length, 1, 'the actual publisher sends the component and index together');
  assert.deepEqual(Object.keys(f.batches[0]).sort(), ['project/Owned.dc.html', 'project/canvas.json']);
  f.check();
});

test('actual mutable Resize payloads and two live stores keep their own matching persistent previews', async t => {
  const runtime = vendorRuntime(), first = await actualDocument(t, runtime), second = await actualDocument(t, runtime);
  const payload = first.manifest();
  for (const [width, height] of [[900, 620], [800, 600], [900, 620]]) {
    Object.assign(payload.artboards[0], { w: width, h: height });
    first.batches.length = 0;
    await first.commit(payload);
    const disk = await first.disk();
    assert.deepEqual(preview(disk.html).$preview, { width, height });
    assert.equal(disk.index.boards['Owned.dc.html'].w, width);
    assert.equal(first.batches.length, 1);
    assert.deepEqual(Object.keys(first.batches[0]).sort(), ['project/Owned.dc.html', 'project/canvas.json']);
    first.check();
  }
  await second.commit({ artboards: [{ ...second.manifest().artboards[0], w: 900, h: 620 }] });
  assert.deepEqual(preview((await second.disk()).html).$preview, { width: 900, height: 620 });
  second.check();
});

test('real legacy layout shape keeps typing fast, rejects malformed dimensions and retries failed calculations', () => {
  const state = indexedState(), store = localStore();
  const layout = (w, h) => JSON.stringify({ artboards: [{ file: 'Own.dc.html', x: 0, y: 0, w, h }, { file: 'Large.dc.html', w: 800, h: 600 }] });
  const first = layout(400, 600);
  state.content.files['canvas.json'] = first; store.apply(state);
  const large = state.content.files['Large.dc.html'];
  Object.defineProperty(state.content.files, 'Large.dc.html', { configurable: true, enumerable: true, get() { throw new Error('unchanged layout read'); } });
  assert.equal(store.apply(state), state);
  state.content.files['canvas.json'] = layout(900, 620);
  assert.throws(() => store.apply(state), /unchanged layout read/);
  Object.defineProperty(state.content.files, 'Large.dc.html', { configurable: true, enumerable: true, writable: true, value: large });
  const result = store.apply(state);
  assert.deepEqual(preview(result.content.files['Own.dc.html']).$preview, { width: 900, height: 620 });
  for (const artboards of [[null], [{ file: 'Own.dc.html', w: '900', h: 620 }], [{ file: 'Own.dc.html', w: Infinity, h: 620 }],
    [{ file: 'Own.dc.html', w: 900, h: 620 }, { file: 'Own.dc.html', w: 901, h: 621 }]]) {
    const input = { content: { files: { ...state.content.files, 'canvas.json': JSON.stringify({ artboards }) } } };
    assert.equal(syncNativeBlankArtboardPreviews(input, 'canvas.json'), input);
  }
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
  const ui = uiOwner(original);
  const markup = /\(0,e\.insertBlankArtboardMarkup\)\(\(0,e\.blankDcDocument\)\(\),[\w$]+\)/.exec(ui)?.[0];
  const add = /kind:"add",entries:\[\{file:[\w$]+,src:[\w$]+,spec:[\w$]+\}\]/.exec(ui)?.[0];
  const batch = batchOwner(original);
  const body = /[\w$]+\.body\.trim\(\)===""/.exec(batch)?.[0];
  assert.ok(markup && add && body);
  for (const [from, to, scope] of [[markup, markup.replace('insertBlankArtboardMarkup', 'changedBlankMarkup'), ui], [add, add.replace('kind:"add"', 'kind:"changed-add"'), ui], [body, body.replace('.body.', '.changedBody.'), batch]]) {
    assert.ok(original.includes(from));
    const changed = scope ? original.replace(scope, scope.replace(from, to)) : original.replace(from, to);
    assert.throws(() => adaptBlankArtboardCreation(changed), /canonical/);
  }
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const dir = fileURLToPath(new URL('../../skills/claude-' + kind + '/scripts/editor/assets/', import.meta.url));
    const file = (await fs.readdir(dir)).find(name => /^index.*\.js$/.test(name));
    const source = (await fs.readFile(path.join(dir, file), 'utf8')).replaceAll('\r\n', '\n');
    if (kind !== 'design') assert.equal(adaptBlankArtboardCreation(source), source);
    const script = adaptInlineEditorScript(source, `https://codex-design.invalid/${kind}/index.js`);
    const checked = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, kind + ': ' + checked.stderr);
  }
});
