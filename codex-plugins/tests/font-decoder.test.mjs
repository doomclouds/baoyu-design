import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import { standaloneFontDecoder, adaptEditorLocalization, EDITOR_KINDS } from '../editor-localization.mjs';
import { buildEditorDocument } from '../source/server/editor-document.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
const originalAssets = path.join(repository, 'skills/claude-slides/scripts/editor/assets');
const files = await fs.readdir(originalAssets);
const entryName = files.find(name => /^index-[A-Za-z0-9_-]+\.js$/.test(name));
const decoderName = files.find(name => /^woff2-decoder-[A-Za-z0-9_-]+\.js$/.test(name));
const entry = await fs.readFile(path.join(originalAssets, entryName), 'utf8');
const originalDecoder = await fs.readFile(path.join(originalAssets, decoderName), 'utf8');

test('the actual decoder copies only the reviewed pure interop helpers and refuses dependency drift', async () => {
  const decoder = standaloneFontDecoder(entry, originalDecoder, entryName);
  assert.ok(decoder.startsWith('/* codex-design:standalone-font-decoder-v1 */'));
  assert.equal(decoder.includes('./' + entryName), false);
  assert.equal(/\bimport\s*(?:[({"']|\.)/.test(decoder), false);
  assert.equal(standaloneFontDecoder(entry, decoder, entryName), decoder);
  await transform(decoder, { loader: 'js', format: 'esm' });
  assert.throws(() => standaloneFontDecoder(entry, originalDecoder, 'index-other.js'), /dependency changed/);
  assert.throws(() => standaloneFontDecoder(entry, originalDecoder.replace('g as ', 'unknown as '), entryName), /dependency changed/);
  assert.throws(() => standaloneFontDecoder(entry.replace('function j0(e){return e&&e.__esModule', 'function j0(e){return e&&e.changedModule'), originalDecoder, entryName), /interop helper changed/);
  assert.throws(() => standaloneFontDecoder(entry, originalDecoder + '\nimport "./unreviewed.js";', entryName), /another module dependency/);
});

async function stagedEditors(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-font-decoder-'));
  const relative = path.relative(os.tmpdir(), temporary);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const pluginRoot = path.join(temporary, 'plugin');
  for (const kind of EDITOR_KINDS) {
    const editor = path.join(pluginRoot, 'skills', 'codex-' + kind, 'scripts/editor');
    await fs.mkdir(path.join(editor, 'assets'), { recursive: true });
    if (kind === 'slides') {
      await fs.cp(originalAssets, path.join(editor, 'assets'), { recursive: true });
      await fs.copyFile(path.join(repository, 'skills/claude-slides/scripts/editor/index.html'), path.join(editor, 'index.html'));
    } else {
      const entry = kind === 'motion' ? 'artifact-type/app.js' : 'assets/index-test.js';
      await fs.mkdir(path.dirname(path.join(editor, entry)), { recursive: true });
      await fs.writeFile(path.join(editor, 'index.html'), `<html><head><script type="module" src="./${entry}"></script></head><body></body></html>`);
      await fs.writeFile(path.join(editor, entry), 'var label={defaultMessage:"Cancel",id:"cancel"};');
      if (kind === 'motion') await fs.writeFile(path.join(editor, 'local-host.js'), 'var localHost=true;');
    }
  }
  const localization = await build({ entryPoints: [path.join(repository, 'codex-plugins/source/scripts/editor-localization.js')], bundle: true,
    format: 'iife', platform: 'browser', write: false });
  const bundlePath = path.join(temporary, 'editor-localization.js');
  await fs.writeFile(bundlePath, localization.outputFiles[0].contents);
  await adaptEditorLocalization(pluginRoot, { bundlePath });
  return { temporary, pluginRoot, bundlePath, editor: path.join(pluginRoot, 'skills/codex-slides/scripts/editor') };
}

test('the real localization and native assembler produce an executable standalone decoder with a new immutable URL', async t => {
  const staged = await stagedEditors(t);
  const assets = path.join(staged.editor, 'assets');
  const builtFiles = await fs.readdir(assets);
  const decoderFile = builtFiles.find(name => /^woff2-decoder-codex-[a-f0-9]{16}\.js$/.test(name));
  assert.ok(decoderFile);
  assert.equal(builtFiles.includes(decoderName), false, 'the old immutable URL does not serve changed bytes');
  const html = await fs.readFile(path.join(staged.editor, 'index.html'), 'utf8');
  const main = /<script\b[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
  assert.ok(main && main.includes('index-codex-'));
  const module = await fs.readFile(path.join(staged.editor, main), 'utf8');
  assert.equal(module.includes(`import("./${decoderName}")`), false);
  assert.equal(module.includes(`import("./${decoderFile}")`), true);

  const baseUrl = 'http://127.0.0.1:4710/slides/authenticated-font-test/';
  const requested = [];
  const assembled = await buildEditorDocument({ baseUrl, fetchLocal: async value => {
    const url = new URL(value), base = new URL(baseUrl);
    assert.equal(url.origin, base.origin);
    assert.ok(url.pathname.startsWith(base.pathname));
    const name = url.pathname.slice(base.pathname.length) || 'index.html';
    const filename = path.join(staged.editor, name);
    const local = path.relative(staged.editor, filename);
    assert.ok(local && !local.startsWith('..') && !path.isAbsolute(local));
    requested.push(name);
    return new Response(await fs.readFile(filename));
  }, config: { virtualBase: 'https://codex-design.invalid/artifacts/font-test/' } });
  assert.ok(requested.includes('assets/' + decoderFile));
  assert.equal(requested.includes('assets/' + entryName), false);
  const decoderModules = [...assembled.html.matchAll(/\bimport\("(data:text\/javascript;base64,[^"]+)"\)/g)]
    .map(match => Buffer.from(match[1].slice('data:text/javascript;base64,'.length), 'base64').toString())
    .filter(source => source.startsWith('/* codex-design:standalone-font-decoder-v1 */'));
  assert.equal(decoderModules.length, 1, 'the actual native assembly includes the repaired decoder once');
  const compiled = await transform(decoderModules[0], { loader: 'js', format: 'iife', globalName: 'CodexFontDecoder', target: 'es2022' });
  const fetched = [];
  const browser = {
    document: { currentScript: { src: 'https://codex-design.invalid/assets/' + decoderFile } },
    atob, btoa, TextDecoder, TextEncoder, Uint8Array, WebAssembly, setTimeout, clearTimeout, console,
    fetch: async value => {
      const url = String(value); fetched.push(url);
      assert.ok(url.startsWith('data:application/octet-stream;base64,'), 'the codec needs only its bundled WASM bytes');
      return new Response(Buffer.from(url.slice('data:application/octet-stream;base64,'.length), 'base64'));
    },
  };
  browser.window = browser;
  const context = vm.createContext(browser);
  vm.runInContext(compiled.code, context);
  const inputName = files.find(name => /^anthropicons-.*\.woff2$/.test(name));
  assert.ok(inputName, 'use a genuine, already shipped WOFF2 fixture');
  const input = new Uint8Array(await fs.readFile(path.join(originalAssets, inputName)));
  let timer;
  const decoded = await Promise.race([context.CodexFontDecoder.default(input), new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('The actual decoder did not initialize.')), 6000);
  })]).finally(() => clearTimeout(timer));
  const bytes = Buffer.from(decoded);
  assert.equal(bytes.readUInt32BE(0), 0x00010000);
  const count = bytes.readUInt16BE(4), tables = [];
  assert.ok(count > 5 && 12 + count * 16 <= bytes.length);
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    tables.push(bytes.toString('ascii', at, at + 4));
    assert.ok(bytes.readUInt32BE(at + 8) + bytes.readUInt32BE(at + 12) <= bytes.length);
  }
  for (const table of ['glyf', 'cmap', 'name']) assert.ok(tables.includes(table), table);
  assert.ok(fetched.length > 0);
  await adaptEditorLocalization(staged.pluginRoot, { bundlePath: staged.bundlePath });
  assert.equal(await fs.readFile(path.join(staged.editor, 'index.html'), 'utf8'), html, 'a repeated build is idempotent');
  assert.equal((await fs.readdir(assets)).filter(name => /^woff2-decoder-/.test(name)).length, 1);
});
