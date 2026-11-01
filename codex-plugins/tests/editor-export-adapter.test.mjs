import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptEditorExportFallbacks, throwNativeEditorExportFailure } from '../source/scripts/editor-export-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
async function bundle(kind) {
  const directory = path.join(pluginRoot, 'skills', `codex-${kind}`, 'scripts/editor/assets');
  const filename = (await fs.readdir(directory)).find(name => /^index.*\.js$/.test(name));
  return fs.readFile(path.join(directory, filename), 'utf8');
}
// Read the same immutable upstream input as build.mjs. Generated bundles may
// already carry the adapter marker and cannot exercise its drift detection.
const canonicalDirectory = fileURLToPath(new URL('../../skills/claude-design/scripts/editor/assets/', import.meta.url));
const canonicalFilename = (await fs.readdir(canonicalDirectory)).find(name => /^index.*\.js$/.test(name));
const original = await fs.readFile(path.join(canonicalDirectory, canonicalFilename), 'utf8');
assert.equal(original.includes('/* codex-design:native-export-save-results */'), false);
const adapted = adaptEditorExportFallbacks(original);

function exportedFunction(source, property) {
  const found = [...source.matchAll(new RegExp(`\\b[at]\\(e,"${property}",\\(\\)=>([\\w$]+)\\)`, 'g'))];
  assert.equal(found.length, 1, `the actual ${property} export must remain unique`);
  const name = found[0][1], start = source.lastIndexOf('function ' + name + '(', found[0].index);
  const part = readCommentComponent(source.slice(start), new RegExp(`^function ${name}\\([^)]*\\)\\{`));
  assert.ok(part && part.text.length < 12_000, `extract only the actual ${property} function`);
  const code = (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + part.text;
  new vm.Script('(' + code + ')');
  return code;
}

function fixture({ native = true, errorCode = 'EXPORT_UNCONFIRMED', warningCount = 0, capability = true } = {}) {
  let currentError = errorCode;
  const saves = [], downloads = [], events = [], reports = [], toasts = [], busy = [];
  const bytes = new Uint8Array([0, 255, 42]);
  const e = {
    async resolveHostCapability() { return capability ? { async save(value) {
      saves.push(value);
      if (currentError) throw Object.assign(new Error(currentError === 'EXPORT_UNCONFIRMED' ? 'The export may already have been saved. Check the selected folder.' : 'Save As failed.'), { code: currentError });
      return { saved: true };
    } } : null; },
    downloadsWithheld: async () => false,
    reportExportBuilt() {}, reportExportOutcome(...value) { reports.push(value); },
    reportExportEvent(value) { reports.push(value); },
    selectionExportFileName: () => 'Canvas.png', dataUrlToBytes: () => bytes,
    triggerBrowserDownload(uri, filename) { downloads.push({ uri, filename }); },
    classifyImageSaveOutcome: value => value, classifyExportSaveOutcome: (kind, outcome) => ({ kind, outcome }),
    classifyExportFailure: kind => ['failed', kind], healthReporter: { report(...value) { reports.push(value); } },
    designAnalyticsEvents: { exported: { png: 'png', jpg: 'jpg', zip: 'zip' } },
    exportImageMimeTypes: { png: 'image/png', jpg: 'image/jpeg' }, exportDeliveryEventName: 'export-delivery',
    formatMessage: (value, params = {}) => value.defaultMessage.replace('{name}', params.name ?? ''),
    missingExportAssetSuffix: () => undefined,
  };
  const dom = {
    document: { body: { appendChild() {} }, createElement() { return { href: '', download: '', style: {}, click() { downloads.push({ uri: this.href, filename: this.download }); }, remove() {} }; } },
    window: { dispatchEvent(value) { events.push(value.detail); } },
    URL: { createObjectURL: () => 'blob:export-fixture', revokeObjectURL() {} }, setTimeout: () => 0,
    CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail; } },
  };
  const context = vm.createContext({ e, Blob, Uint8Array, ...dom,
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: { channel: 'export-test-channel' } } : {}),
    b: () => () => {}, p: () => () => {}, x: async () => false, r: () => true,
    a: async (_, format) => ({ ok: true, uri: `data:${e.exportImageMimeTypes[format]};base64,AP8q`, embedWarningCount: warningCount }),
    h: async () => ({ blob: new Blob([bytes], { type: 'application/pdf' }), filename: 'Canvas.pdf', pages: 1, exported: 1, embedWarningCount: warningCount }),
    c: () => ({}), n: 'application/pdf',
  });
  context.__codexThrowNativeExportFailure = vm.runInContext('(' + throwNativeEditorExportFailure.toString() + ')', context);
  context.w = vm.runInContext('(' + exportedFunction(original, 'downloadErrorCode') + ')', context);
  e.saveThroughHost = vm.runInContext('(' + exportedFunction(adapted, 'saveThroughHost') + ')', context);
  return { e, context, dom, bytes, saves, downloads, events, reports, toasts, busy,
    setSaveError(value) { currentError = value; },
    image: vm.runInContext('(' + exportedFunction(adapted, 'exportArtboardImage') + ')', context),
    pdf: vm.runInContext('(' + exportedFunction(adapted, 'exportPdf') + ')', context),
  };
}

// Extract the actual ZIP delivery/catch/finally tail without executing the
// React canvas or reconstructing its branch logic in this test.
function zipCaller(f) {
  const matches = [...adapted.matchAll(/\b([\w$]+)=await\(0,e\.saveThroughHost\)\(([\w$]+),([\w$]+)\),([\w$]+)=\(0,e\.missingExportAssetSuffix\)\(([\w$]+)\.missing\);if\(/g)];
  assert.equal(matches.length, 1);
  const match = matches[0], after = adapted.slice(match.index);
  const end = /\}finally\{([\w$]+)\(!1\)\}/.exec(after);
  assert.ok(end);
  const tail = after.slice(0, end.index + end[0].length);
  assert.ok(tail.length < 3500);
  const toast = /,([\w$]+)\("Couldn't build the HTML zip: "/.exec(tail)?.[1];
  assert.ok(toast);
  const context = vm.createContext({ e: f.e, Blob, ...f.dom,
    ...(f.context.__CODEX_DESIGN_EDITOR_TRANSPORT__ ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: f.context.__CODEX_DESIGN_EDITOR_TRANSPORT__ } : {}),
    [toast]: (...value) => f.toasts.push(value), [end[1]]: value => f.busy.push(value),
  });
  return vm.runInContext(`(async function(${match[2]},${match[3]},${match[5]}){try{let ${tail}})`, context);
}

function warningCardDownload(f) {
  const card = adapted.indexOf('"data-testid":"export-delivery-card"');
  const end = adapted.lastIndexOf('})()};return', card) + 1;
  const start = adapted.lastIndexOf('async()=>{', end);
  assert.ok(start > 0 && end > start && end - start < 6000);
  const code = adapted.slice(start, end);
  const save = /let\{outcome:([\w$]+),code:([\w$]+)\}=await\(0,e\.saveThroughHost\)\(([\w$]+),([\w$]+)\)/.exec(code);
  const busy = /finally\{([\w$]+)\(!1\)\}/.exec(code)?.[1];
  const component = adapted.slice(adapted.lastIndexOf('function ', start), start);
  const toast = /let\{showToast:([\w$]+)\}=\(0,e\.useToast\)\(\)/.exec(component)?.[1];
  assert.ok(save && busy && toast);
  const context = vm.createContext({ e: f.e, Blob, ...f.dom,
    ...(f.context.__CODEX_DESIGN_EDITOR_TRANSPORT__ ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: f.context.__CODEX_DESIGN_EDITOR_TRANSPORT__ } : {}),
    [save[3]]: new Blob([f.bytes], { type: 'image/png' }), [save[4]]: 'Canvas.png',
    [toast]: (...value) => f.toasts.push(value), [busy]: value => f.busy.push(value),
    w: true, p: new Set(), S() {}, m: code => code, i: 'blob:export-fixture',
  });
  return vm.runInContext('(' + code + ')', context);
}

function producerFixture({ native = true, released = false, steps = [] } = {}) {
  const saves = [], declined = [], results = [], queue = new Map(), active = new Map();
  const request = { id: 'original-request' }, execution = { request, interactive: true, bundle: false, windowMs: 500, released };
  const descriptor = { format: 'svg', variant: 'selection', releaseRequestAfterMs: 5,
    async produce() { return { data: new Uint8Array([1, 2]), filename: 'Canvas.svg' }; } };
  let takes = 0, busy = 0;
  const e = {
    async saveThroughHost(...args) {
      saves.push(args);
      const step = steps[saves.length - 1] ?? { outcome: 'saved', code: '' };
      return typeof step === 'function' ? step() : step;
    },
    declineFrameExport(value) { declined.push(value); },
    holdExportBusy() { busy++; return () => { busy--; }; },
  };
  const context = vm.createContext({ e, AbortController,
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: { channel: 'export-test-channel' } } : {}),
    r(format, fallback) { takes++; const item = queue.get(format); queue.delete(format); return item ?? fallback; },
    l() {}, i: value => value.outcome === 'saved' || value.outcome === 'declined',
    o: () => descriptor, g: queue, h: active, u() {}, c: () => false,
    m: { onResult(value) { results.push(value); } },
  });
  context.v = vm.runInContext('(' + exportedFunction(adapted, 'runExportProducer') + ')', context);
  const receive = vm.runInContext('(' + exportedFunction(adapted, 'receiveExportRequest') + ')', context);
  return { descriptor, execution, request, saves, declined, results, queue, active,
    get takes() { return takes; }, get busy() { return busy; },
    run: () => context.v(descriptor, execution, new AbortController().signal),
    receive: () => receive('svg', request, true, 'selection', false, 500),
  };
}

function nativeSaveFailure(code = 'EXPORT_UNCONFIRMED') {
  return Object.assign(new Error('The export save result is uncertain.'), { code, nativeExportSaveFailure: true });
}

test('actual registered export reports a terminal native save failure and declines only its captured request', async () => {
  const newer = { request: { id: 'newer-request' }, interactive: true };
  let f;
  f = producerFixture({ steps: [() => {
    f.queue.set('svg', newer);
    throw nativeSaveFailure();
  }] });
  const result = await f.run();
  assert.equal(result.format, 'svg'); assert.equal(result.variant, 'selection');
  assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'EXPORT_UNCONFIRMED');
  assert.equal(result.filename, 'Canvas.svg');
  assert.equal(f.saves.length, 1); assert.equal(f.takes, 1);
  assert.deepEqual(f.declined, [f.request]);
  assert.equal(f.queue.get('svg'), newer, 'an arriving request must remain queued for the next producer');
});

test('actual registered export request_unknown retry preserves native failure and declines the original request once', async () => {
  const f = producerFixture({ steps: [
    { outcome: 'unsupported', code: 'request_unknown' },
    () => { throw nativeSaveFailure('EXPORT_SAVE_FAILED'); },
  ] });
  const result = await f.run();
  assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'EXPORT_SAVE_FAILED');
  assert.equal(f.saves.length, 2); assert.equal(f.takes, 1);
  assert.equal(f.saves[0][2].request, f.request);
  assert.equal(f.saves[1].length, 2, 'the existing retry uses the standalone save capability');
  assert.deepEqual(f.declined, [f.request]);
});

test('actual registered released request failure does not decline a request already released by the host', async () => {
  const f = producerFixture({ released: true, steps: [() => { throw nativeSaveFailure(); }] });
  assert.equal((await f.run()).outcome, 'failed');
  assert.equal(f.saves.length, 1); assert.equal(f.takes, 1); assert.deepEqual(f.declined, []);
  assert.equal(f.saves[0].length, 2);
});

test('actual registered export controller delivers failure through onResult and releases active/busy state', async () => {
  const f = producerFixture({ steps: [() => { throw nativeSaveFailure(); }] });
  await f.receive();
  assert.equal(f.results.length, 1); assert.equal(f.results[0].outcome, 'failed');
  assert.equal(f.results[0].code, 'EXPORT_UNCONFIRMED');
  assert.deepEqual(f.declined, [f.request]);
  assert.equal(f.queue.size, 0); assert.equal(f.active.size, 0); assert.equal(f.busy, 0);
  assert.equal(f.saves.length, 1); assert.equal(f.takes, 1);
});

test('actual registered export retains saved, cancelled and standalone error behavior', async () => {
  const saved = producerFixture();
  assert.equal((await saved.run()).outcome, 'delivered'); assert.deepEqual(saved.declined, []);
  const cancelled = producerFixture({ steps: [{ outcome: 'declined', code: 'declined' }] });
  const result = await cancelled.run();
  assert.equal(result.outcome, 'declined'); assert.equal(result.code, 'declined');
  assert.deepEqual(cancelled.declined, []);
  const failure = nativeSaveFailure();
  const standalone = producerFixture({ native: false, steps: [() => { throw failure; }] });
  await assert.rejects(standalone.run(), error => error === failure);
  assert.deepEqual(standalone.declined, []);
});

for (const format of ['png', 'jpg', 'pdf']) test(`actual Design ${format} caller propagates uncertain Close without another save or ready/success outcome`, async () => {
  const f = fixture();
  const operation = format === 'pdf' ? f.pdf({}, {}, 'Canvas') : f.image({}, 'Canvas', format);
  await assert.rejects(operation, error => error.code === 'EXPORT_UNCONFIRMED' && error.nativeExportSaveFailure === true);
  assert.equal(f.saves.length, 1);
  assert.equal(f.downloads.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.reports.some(value => value?.saveOutcome === 'saved'), false);
});

test('actual Design HTML zip caller reports the native save failure/code rather than build-ready or success', async () => {
  const f = fixture();
  const result = await zipCaller(f)(new Blob([f.bytes]), 'Canvas-html.zip', { missing: [] });
  assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'EXPORT_UNCONFIRMED');
  assert.equal(f.saves.length, 1); assert.equal(f.downloads.length, 0); assert.equal(f.events.length, 0);
  assert.equal(f.toasts.length, 1); assert.match(f.toasts[0][0], /may already have been saved/);
  assert.equal(f.toasts[0][0].includes("Couldn't build"), false);
  assert.deepEqual(f.busy, [false]);
});

test('native cancellation retains the actual declined outcomes and never opens another save or success notice', async () => {
  const f = fixture({ errorCode: 'declined' });
  assert.equal((await f.image({}, 'Canvas', 'png')).saveOutcome, 'declined');
  assert.equal((await f.pdf({}, {}, 'Canvas')).saveOutcome, 'declined');
  await zipCaller(f)(new Blob([f.bytes]), 'Canvas-html.zip', { missing: [] });
  assert.equal(f.saves.length, 3); assert.equal(f.downloads.length, 0); assert.equal(f.events.length, 0); assert.equal(f.toasts.length, 0);
});

test('successful native saves retain exact actual caller success behavior and do not emit browser-ready fallback', async () => {
  const f = fixture({ errorCode: null });
  assert.equal((await f.image({}, 'Canvas', 'jpg')).saveOutcome, 'saved');
  assert.equal((await f.pdf({}, {}, 'Canvas')).saveOutcome, 'saved');
  await zipCaller(f)(new Blob([f.bytes]), 'Canvas-html.zip', { missing: [] });
  assert.equal(f.saves.length, 3); assert.equal(f.downloads.length, 0); assert.equal(f.events.length, 0);
  assert.equal(f.toasts[0][0], 'Saved Canvas-html.zip.');
});

for (const format of ['png', 'pdf']) test(`native ${format} embedded-image warnings keep a real ready-to-download card and await explicit Download`, async () => {
  const f = fixture({ errorCode: null, warningCount: 2 });
  const result = format === 'pdf' ? await f.pdf({}, {}, 'Canvas') : await f.image({}, 'Canvas', format);
  assert.equal(result.saveOutcome, 'unsupported', 'the built warning artifact has not been saved');
  assert.equal(f.saves.length, 0); assert.equal(f.downloads.length, 0);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].embedWarningCount, 2);
  if (format === 'pdf') assert.deepEqual([...new Uint8Array(await f.events[0].file.blob.arrayBuffer())], [...f.bytes]);
  else assert.equal(f.events[0].url, 'data:image/png;base64,AP8q');
  assert.equal(f.toasts.length, 0);
  await warningCardDownload(f)();
  assert.equal(f.saves.length, 1); assert.equal(f.downloads.length, 0);
  assert.equal(f.toasts[0][0], 'Saved Canvas.png.');
});

test('actual warning-card Download can cancel or close uncertainly without saved feedback, then retry only on another explicit click', async () => {
  const f = fixture({ errorCode: 'declined' });
  const download = warningCardDownload(f);
  await download();
  assert.equal(f.saves.length, 1); assert.equal(f.toasts.length, 0);
  f.setSaveError('EXPORT_UNCONFIRMED');
  const result = await download();
  assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'EXPORT_UNCONFIRMED');
  assert.equal(f.saves.length, 2); assert.equal(f.downloads.length, 0); assert.equal(f.events.length, 0);
  assert.equal(f.toasts.length, 1); assert.match(f.toasts[0][0], /may already have been saved/);
  f.setSaveError(null);
  await download();
  assert.equal(f.saves.length, 3); assert.equal(f.toasts.at(-1)[0], 'Saved Canvas.png.');
});

test('standalone Design image, PDF, ZIP and warning delivery retain their legacy browser fallback', async () => {
  const f = fixture({ native: false });
  assert.equal((await f.image({}, 'Canvas', 'png')).saveOutcome, 'unsupported');
  assert.equal((await f.pdf({}, {}, 'Canvas')).saveOutcome, 'unsupported');
  await zipCaller(f)(new Blob([f.bytes]), 'Canvas-html.zip', { missing: [] });
  assert.equal(f.saves.length, 3); assert.equal(f.downloads.length, 3); assert.equal(f.events.length, 3);
  const warnings = fixture({ native: false, warningCount: 1 });
  await warnings.image({}, 'Canvas', 'png');
  await warnings.pdf({}, {}, 'Canvas');
  assert.equal(warnings.saves.length, 0); assert.equal(warnings.downloads.length, 2); assert.equal(warnings.events.length, 2);
});

test('native unavailable capability fails explicitly instead of taking a second download route', async () => {
  const f = fixture({ capability: false });
  await assert.rejects(f.image({}, 'Canvas', 'png'), { code: 'no_shell_save' });
  assert.equal(f.saves.length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.events.length, 0);
});

test('the adapter is idempotent, refuses changed canonical anchors and leaves all four assembled bundles parseable', async () => {
  assert.equal(adaptEditorExportFallbacks(adapted), adapted);
  const saving = exportedFunction(original, 'saveThroughHost');
  const changed = saving.replace('code:"no_shell_save"', 'code:"changed_no_shell_save"');
  assert.notEqual(changed, saving);
  assert.throws(() => adaptEditorExportFallbacks(original.replace(saving, changed)), /canonical/);
  assert.throws(() => adaptEditorExportFallbacks(original.replace('id:"dUR5426EKh"', 'id:"changed-card"')), /warning card/);
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const raw = await bundle(kind);
    if (kind !== 'design') assert.equal(adaptEditorExportFallbacks(raw), raw);
    const assembled = adaptInlineEditorScript(raw, `https://codex-design.invalid/${kind}/index.js`);
    const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: assembled, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.equal(parsed.status, 0, kind + ': ' + (parsed.stderr || parsed.error?.message || '').slice(-500));
  }
});
