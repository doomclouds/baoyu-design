import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { createDesignService } from '../source/server/service.mjs';
import { createLibraryStore } from '../source/library/index.mjs';

const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const vendor = path.join(pluginRoot, 'skills/codex-design-system/scripts/editor/artifact-type/vendor');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function serviceFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-native-html-integrity-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root });
  const record = await store.create({ kind: 'design', title: 'Native HTML integrity' });
  return { store, record, service: createDesignService({ store, editorOpen: () => assert.fail('Hashing must not open an editor.') }) };
}

function nativeFixture(t, service, id) {
  const listeners = new Map(), requests = [];
  const emit = event => { for (const listener of listeners.get('message') || []) listener(event); };
  const parent = { postMessage(message) {
    if (message.type !== 'codex-design:editor-request') return;
    requests.push(message);
    assert.equal(message.action, 'editor.digest');
    Promise.resolve().then(() => service.invoke(message.action, { ...message.payload, id })).then(
      result => emit({ source: parent, data: { type: 'codex-design:editor-response', channel: 'native-integrity-channel', requestId: message.requestId, result } }),
      error => emit({ source: parent, data: { type: 'codex-design:editor-response', channel: 'native-integrity-channel', requestId: message.requestId,
        error: { code: error.code, message: error.message } } }),
    );
  } };
  const target = { parent, crypto: {}, atob, btoa,
    fetch: () => assert.fail('Canonical local SRI verification must not fetch remote bytes.'),
    addEventListener(type, listener) { const group = listeners.get(type) || []; group.push(listener); listeners.set(type, group); },
  };
  // Match editor.document: the bootstrap is serialized without any module
  // closure, and the opaque browser context has no native crypto.subtle.
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target)', {
    configuration: { baseUrl: `https://codex-design.invalid/artifacts/${id}/`, artifactId: id, channel: 'native-integrity-channel' }, target,
    URL, Request, Response, Headers, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, DOMException, Event, EventTarget, MessageEvent,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  t.after(() => { for (const listener of listeners.get('unload') || []) listener({}); });
  return { target, requests };
}

function canonicalIntegrity(source, crypto) {
  const registration = /\b[at]\(e,"verifyExportAssetIntegrity",\(\)=>([\w$]+)\)/.exec(source);
  assert.ok(registration, 'The actual canonical SRI export is required.');
  const start = source.lastIndexOf('function mU(e){', registration.index);
  assert.ok(start >= 0 && registration.index - start < 2_000, 'Review a changed canonical integrity module.');
  const part = readCommentComponent(source.slice(start), /^function mU\(e\)\{/);
  assert.ok(part && part.text.includes(registration[0]));
  const base64Export = /\b[at]\(e,"encodeBinaryBase64",\(\)=>([\w$]+)\)/.exec(source);
  assert.ok(base64Export);
  const encodeStart = source.lastIndexOf('function ' + base64Export[1] + '(', base64Export.index);
  const encode = readCommentComponent(source.slice(encodeStart), new RegExp('^function ' + escape(base64Export[1]) + '\\([^)]*\\)\\{'));
  assert.ok(encode && encode.text.length < 500);
  const exports = { encodeBinaryBase64: vm.runInNewContext('(' + encode.text + ')', { Uint8Array, btoa }) };
  vm.runInNewContext('(' + part.text + ')(exports)()', {
    exports, crypto, Uint8Array, CompressionStream,
    t(object, property, get) { Object.defineProperty(object, property, { get }); },
  });
  const integrityFor = property => {
    const entry = new RegExp('\\b[at]\\(e,"' + property + '",\\(\\)=>(' + '[\\w$]+' + ')(?=[,)])').exec(source);
    assert.ok(entry);
    const value = new RegExp('\\b' + escape(entry[1]) + '="(sha384-[A-Za-z0-9+/=]+)"').exec(source.slice(entry.index, entry.index + 6_000));
    assert.ok(value, 'Use the actual bundled runtime SRI, not a fixture hash.');
    return value[1];
  };
  return { verify: exports.verifyExportAssetIntegrity, integrityFor };
}

test('the actual Canvas HTML SRI helper verifies both bundled React runtimes over the serialized native digest RPC', async t => {
  const f = await serviceFixture(t), native = nativeFixture(t, f.service, f.record.id);
  const editor = path.join(pluginRoot, 'skills/codex-design/scripts/editor');
  const html = await readFile(path.join(editor, 'index.html'), 'utf8');
  const entry = /<script\b[^>]*type="module"[^>]*src="(\.\/assets\/index-[^"/]+\.js)"/.exec(html);
  assert.ok(entry, 'Use the actual packaged Canvas module.');
  const canonical = canonicalIntegrity(await readFile(path.join(editor, entry[1]), 'utf8'), native.target.crypto);
  for (const [file, property] of [['react.production.min.js', 'exportReactUmdIntegrity'], ['react-dom.production.min.js', 'exportReactDomUmdIntegrity']]) {
    // Verify the exact distributed bytes. No newline normalization or fixture
    // hash may conceal a packaging/SRI mismatch in the actual native editor.
    const bytes = new Uint8Array(await readFile(path.join(vendor, file)));
    const integrity = canonical.integrityFor(property);
    assert.equal(await canonical.verify(bytes, integrity), true, file);
    const changed = bytes.slice(); changed[Math.floor(changed.length / 2)] ^= 1;
    assert.equal(await canonical.verify(changed, integrity), false, file + ' with changed bytes');
  }
  assert.equal(native.requests.length, 4);
  assert.ok(native.requests.every(request => request.payload.algorithm === 'SHA-384'));
  const bytes = new TextEncoder().encode('native content identity');
  assert.equal(Buffer.from(await native.target.crypto.subtle.digest({ name: 'sha-256' }, bytes)).toString('hex'), createHash('sha256').update(bytes).digest('hex'));
});

test('native digest rejects unaudited algorithms before RPC and preserves the strict 32 MiB transfer bound', async t => {
  const f = await serviceFixture(t), native = nativeFixture(t, f.service, f.record.id);
  for (const algorithm of ['SHA-1', 'SHA-512', 'MD5', 'sha384', 'SHA-384\n']) {
    await assert.rejects(native.target.crypto.subtle.digest(algorithm, new Uint8Array()), { name: 'NotSupportedError' });
  }
  assert.equal(native.requests.length, 0);
  await assert.rejects(native.target.crypto.subtle.digest('SHA-384', new Uint8Array(32 * 1024 * 1024 + 1)), { name: 'OperationError' });
  assert.equal(native.requests.length, 0);
  const framed = new Uint8Array([9, 8, 7, 6]);
  assert.equal(Buffer.from(await native.target.crypto.subtle.digest('SHA-384', framed.subarray(1, 3))).toString('hex'), createHash('sha384').update(Buffer.from([8, 7])).digest('hex'));
});

test('the real digest service keeps artifact ownership, strict base64 and bounded algorithm validation', async t => {
  const f = await serviceFixture(t);
  const payload = { id: f.record.id, algorithm: 'SHA-384', base64: 'YWJj' };
  assert.equal((await f.service.invoke('editor.digest', payload)).base64, createHash('sha384').update('abc').digest('base64'));
  for (const algorithm of ['sha384', 'SHA-512', 'SHA-1', 'MD5', {}, null]) {
    await assert.rejects(f.service.invoke('editor.digest', { ...payload, algorithm }), { code: 'INVALID_EDITOR_DIGEST' });
  }
  for (const base64 of ['A', 'AAA', 'AA=A', 'AA==AAAA', 'YWJj\n', 'AA-_']) {
    await assert.rejects(f.service.invoke('editor.digest', { ...payload, base64 }), { code: 'INVALID_EDITOR_DIGEST' });
  }
  await assert.rejects(f.service.invoke('editor.digest', { ...payload, id: 'not-an-id' }), { code: 'INVALID_ID' });
  await assert.rejects(f.service.invoke('editor.digest', { ...payload, id: '22222222-2222-4222-8222-222222222222' }), { code: 'NOT_FOUND' });
  const atLimit = Buffer.alloc(32 * 1024 * 1024);
  assert.equal((await f.service.invoke('editor.digest', { ...payload, base64: atLimit.toString('base64') })).base64, createHash('sha384').update(atLimit).digest('base64'));
  await assert.rejects(f.service.invoke('editor.digest', { ...payload, base64: Buffer.alloc(32 * 1024 * 1024 + 1).toString('base64') }), { code: 'INVALID_EDITOR_DIGEST' });
  await f.store.trash(f.record.id);
  await assert.rejects(f.service.invoke('editor.digest', payload), { code: 'NOT_FOUND' });
});
