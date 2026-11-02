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
    assert.equal(result.html.includes('/* codex-design:native-conflict-language */'), ['slides', 'design'].includes(kind), kind + ' adapts only its separate canonical conflict-language branch');
    if (kind === 'slides') assert.equal(/import\("data:text\/javascript;base64,/.test(result.html), true);
    if (kind !== 'dashboard') {
      assert.equal(/globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__\?null:/.test(result.html), true);
      assert.equal(/__CODEX_DESIGN_EDITOR_FLUSH__=async\(\)=>\{await globalThis\.__CODEX_DESIGN_EDITOR_SETTLE__\?\.\(\);return [\w$]+\([\w$]+,[\w$]+\)\}/.test(result.html), true, kind + ' settles its live session before the original publish-idle flush closure');
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

test('the actual Dashboard presence initializer uses the native base on opaque documents and retains ordinary HTTP behavior', async () => {
  const raw = await fs.readFile(path.join(plugin, 'skills/codex-dashboard/scripts/editor/local-host.js'), 'utf8');
  const initializer = source => {
    const lines = source.match(/^\s*var presence = AT === null \? pageRoom\([^\r\n]+ : null;$/gm) || [];
    assert.equal(lines.length, 1, 'Exercise the genuine Dashboard initializer, not a rewritten sample.');
    return lines[0] + '\npresence;';
  };
  const original = initializer(raw);
  const adapted = initializer(adaptInlineEditorScript(raw, virtualBase + 'local-host.js'));
  const context = (href, native) => ({ URL, AT: null, PEER: 'presence-test-peer', location: { href },
    pageRoom: (base, peer) => ({ base, peer }),
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: { baseUrl: virtualBase } } : {}) });
  for (const opaque of ['about:srcdoc', 'data:text/html;base64,PGh0bWw+']) {
    assert.throws(() => vm.runInNewContext(original, context(opaque, true)), { name: 'TypeError', code: 'ERR_INVALID_URL' }, 'The unadapted upstream line reproduces the native boot failure.');
    const native = vm.runInNewContext(adapted, context(opaque, true));
    assert.equal(native.base, virtualBase);
    assert.equal(native.peer, 'presence-test-peer');
  }
  const ordinaryUrl = 'http://127.0.0.1:12345/dashboard/grant/index.html?at=2';
  for (const source of [original, adapted]) {
    const ordinary = vm.runInNewContext(source, context(ordinaryUrl, false));
    assert.equal(ordinary.base, 'http://127.0.0.1:12345/dashboard/grant/');
    assert.equal(ordinary.peer, 'presence-test-peer');
  }
  assert.equal(vm.runInNewContext(adapted, { ...context('about:srcdoc', true), AT: '2' }), null, 'Historical views still skip presence.');
});

test('native URL selectors tolerate formatting while preserving unsupported forms and ordinary fallbacks', () => {
  const nativeContext = { URL, target: { location: { href: 'about:srcdoc' } }, location: { href: 'about:srcdoc' },
    __CODEX_DESIGN_EDITOR_TRANSPORT__: { baseUrl: virtualBase, language: 'en' } };
  for (const source of ['new URL("./",target.location.href).href', 'new URL ( "./" , target . location . href ) . href',
    "new URL( './',\n location.href\n).href", 'new URL ( "./" , location . href ) . href']) {
    const adapted = adaptInlineEditorScript(source, virtualBase + 'local-host.js');
    assert.equal(vm.runInNewContext(adapted, nativeContext), virtualBase, source);
    const href = 'http://localhost:4000/editor/file.html';
    assert.equal(vm.runInNewContext(adapted, { URL, target: { location: { href } }, location: { href } }), 'http://localhost:4000/editor/', 'Ordinary execution still resolves its own URL.');
  }
  const language = 'new URL ( target . location . href ) . searchParams . get ( "codexDesignLanguage" )';
  const adaptedLanguage = adaptInlineEditorScript(language, virtualBase + 'local-host.js');
  assert.equal(vm.runInNewContext(adaptedLanguage, nativeContext), 'en');
  assert.equal(vm.runInNewContext(adaptedLanguage, { URL, target: { location: { href: 'http://localhost:4000/?codexDesignLanguage=fr' } } }), 'fr');
  for (const source of ['new URL("../",location.href).href', 'new URL("./",other.href).href', 'new URL(target.location.href).searchParams.get("unrelated")']) {
    assert.equal(adaptInlineEditorScript(source, virtualBase + 'local-host.js'), source, 'Only the existing local-host and language selectors are adapted.');
  }
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
