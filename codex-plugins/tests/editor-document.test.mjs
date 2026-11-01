import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { repairEditorRuntime } from '../source/scripts/editor-runtime-adapter.mjs';
import { buildEditorDocument, adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const plugin = fileURLToPath(new URL('../codex-design/', import.meta.url));
const baseUrl = 'http://127.0.0.1:12345/slides/grant/';
const virtualBase = 'https://codex-design.invalid/artifacts/00000000-0000-4000-8000-000000000000/';

test('native document assembly inlines the four actual editors without HTTP script/style/font dependencies', async () => {
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const directory = path.join(plugin, 'skills', 'codex-' + kind, 'scripts/editor');
    const fetchLocal = async value => {
      const url = new URL(value);
      const relative = url.pathname.slice(new URL(baseUrl).pathname.length);
      const bytes = relative === '__codex/annotations.js' ? Buffer.from('// annotations')
        : await fs.readFile(path.join(directory, relative || 'index.html'));
      return new Response(bytes);
    };
    const result = await buildEditorDocument({ baseUrl, fetchLocal, config: { virtualBase, bootstrap: 'globalThis.testBootstrap=true;' } });
    assert.ok(result.html.includes('globalThis.testBootstrap=true;'), kind);
    assert.ok(result.html.includes('<base href="' + virtualBase), kind);
    assert.ok(result.html.includes('<meta http-equiv="Content-Security-Policy" content="form-action \'none\'">'), kind + ' prevents external form navigation');
    const markup = result.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    assert.equal(/<script\b[^>]*\bsrc\s*=/i.test(markup), false, kind);
    assert.equal(/<link\b[^>]*\brel="stylesheet"/i.test(markup), false, kind);
    assert.equal(/data:font\/woff2;base64,/.test(result.html), true, kind);
    assert.ok(result.bytes > 1_000_000, kind + ' retains its real editor');
    assert.equal(result.sha256.length, 64);
    if (kind === 'slides') assert.equal(/import\("data:text\/javascript;base64,/.test(result.html), true);
    if (kind !== 'dashboard') {
      assert.equal(/globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__\?null:/.test(result.html), true);
      assert.equal(/__CODEX_DESIGN_EDITOR_FLUSH__=\(\)=>[\w$]+\([\w$]+,[\w$]+\)/.test(result.html), true, kind + ' retains the original publish-idle flush closure');
    }
  }
});

test('native document assembly refuses escaped assets and enforces the payload limit', async () => {
  const fetchLocal = async () => new Response('<html><head><script src="https://example.com/private.js"></script></head></html>');
  await assert.rejects(buildEditorDocument({ baseUrl, fetchLocal, config: { virtualBase } }), { code: 'EDITOR_ASSET_REFUSED' });
  await assert.rejects(buildEditorDocument({ baseUrl, fetchLocal: async () => new Response('<html><head></head></html>'), config: { virtualBase }, maxBytes: 5 }), { code: 'EDITOR_DOCUMENT_TOO_LARGE' });
});

test('native local-host patch preserves the ordinary fallback and does not rewrite copy', () => {
  const source = 'const r=e.base??new URL("./",t.location.href).href,c=OH(t),s=c?null:e.localComments?.(r);const copy="Hello";';
  const adapted = adaptInlineEditorScript(source, virtualBase + 'assets/main.js');
  assert.ok(adapted.includes('globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??new URL'));
  assert.ok(adapted.includes('c=globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?null:OH(t)'));
  assert.ok(adapted.includes('const copy="Hello";'));
});

test('opaque-origin UUID fallback uses WebCrypto and remains valid inside serialized nested runtime code', () => {
  const source = 'const nested="crypto.randomUUID()";const direct=crypto.randomUUID();({nested,direct});';
  const adapted = adaptInlineEditorScript(source, virtualBase + 'assets/main.js');
  const context = { crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, Uint8Array };
  const result = vm.runInNewContext(adapted, context);
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(result.direct, pattern);
  assert.match(vm.runInNewContext(result.nested, context), pattern);
  assert.equal(result.nested.includes('Math.random'), false);
});

test('native chrome retains local export and canonical toolbar comments without altering ordinary or foreign frame behavior', () => {
  const source = 'function link(w){return w.parent===w?null:{post:()=>{}}}const options={localComments:b=>make({base:b,toolbar:!0})};({standalone:window.parent===window,local:link(window),foreign:link(other),comments:options.localComments("root")});';
  const adapted = adaptInlineEditorScript(source, virtualBase + 'assets/main.js');
  const frame = { parent: {} }, other = { parent: {} };
  const native = vm.runInNewContext(adapted, { window: frame, other, make: value => value, __CODEX_DESIGN_EDITOR_TRANSPORT__: {} });
  assert.equal(native.standalone, true);
  assert.equal(native.local, null);
  assert.equal(typeof native.foreign.post, 'function');
  assert.equal(native.comments.toolbar, true);
  const ordinary = vm.runInNewContext(adapted, { window: frame, other, make: value => value });
  assert.equal(ordinary.standalone, false);
  assert.equal(typeof ordinary.local.post, 'function');
  assert.equal(ordinary.comments.toolbar, true);
});

test('a first-open export dialog initializes its existing sheet React dependency in both ordinary and native editors', () => {
  const source = 'let ReactForSheet;function initialize(){ReactForSheet={useContext:()=>({trees:["ready"]})}}function announce(){let trees=ReactForSheet.useContext(registry.sheetParentContext)?.trees;return trees}const registry={sheetParentContext:{}};function register(){}register(registry,"useSheetTreeDialogAnnouncement",()=>announce);register(registry,"initializeSheetMeasurement",()=>initialize);announce();';
  const adapted = adaptInlineEditorScript(source, virtualBase + 'assets/main.js');
  assert.deepEqual([...vm.runInNewContext(adapted)], ['ready']);
  assert.deepEqual([...vm.runInNewContext(repairEditorRuntime(source))], ['ready']);
  assert.equal(repairEditorRuntime(repairEditorRuntime(source)), repairEditorRuntime(source));
  assert.throws(() => vm.runInNewContext(source), { name: 'TypeError' });
});

test('only the CDS Form wrapper renders a semantic form while retaining its fieldset provider, ref and submit handler', () => {
  const provider = {};
  const ref = {};
  const submit = () => {};
  const source = '({form:jsx.jsx(registry.baseFieldsetRoot,{ref:reference,"data-cds":"Form",disabled:true,onSubmit:submit}),group:jsx.jsx(registry.baseFieldsetRoot,{ref:reference,"data-cds":"Fieldset",disabled:true})});';
  const repaired = repairEditorRuntime(source);
  const result = vm.runInNewContext(repaired, { registry: { baseFieldsetRoot: provider }, jsx: { jsx: (type, props) => ({ type, props }) }, reference: ref, submit });
  assert.equal(result.form.type, provider);
  assert.equal(result.form.props.render.type, 'form');
  assert.equal(result.form.props.ref, ref);
  assert.equal(result.form.props.disabled, true);
  assert.equal(result.form.props.onSubmit, submit);
  assert.equal(result.group.props.render, undefined);
  assert.equal(repairEditorRuntime(repaired), repaired);
});
