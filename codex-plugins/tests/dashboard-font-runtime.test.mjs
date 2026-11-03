import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { repairEditorRuntime } from '../source/scripts/editor-runtime-adapter.mjs';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';

const missing = 'url(/_runtime/AnthropicSerif-Roman-Variable-26-179-2.ac9c19c70558c515.woff2)';
const directory = new URL('../../skills/claude-dashboard/scripts/editor/assets/', import.meta.url);
async function original() {
  for (const name of await fs.readdir(directory)) if (/^index-.*\.js$/.test(name)) {
    const source = await fs.readFile(new URL(name, directory), 'utf8');
    if (source.includes('"loadAnthropicSerifFont"')) return source;
  }
  assert.fail('The actual Dashboard font loader is missing.');
}
function loader(source) {
  const exported = /\b[at]\(e,"loadAnthropicSerifFont",\(\)=>([\w$]+)\)/.exec(source);
  assert.ok(exported);
  const name = exported[1].replaceAll('$', '\\$');
  const start = source.lastIndexOf('function ' + exported[1] + '(', exported.index);
  const part = readCommentComponent(source.slice(start), new RegExp(`^function ${name}\\([^)]*\\)\\{`));
  assert.ok(part); return part.text;
}
async function invoke(source, native, existing = []) {
  const requests = [], fonts = new Set(existing);
  const context = { document: { fonts }, console: { warn() {} },
    FontFace: class {
      constructor(family, url, options) { this.family = family; this.url = url; this.options = options; }
      async load() { requests.push(this.url); return this; }
    },
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: {} } : {}),
  };
  vm.runInNewContext('(' + loader(source) + ')();', context);
  await Promise.resolve();
  return { requests, fonts };
}

test('the real Dashboard loader makes no unavailable hosted-font request in a native document', async () => {
  const source = repairEditorRuntime(await original());
  assert.match(source, /codex-design:native-dashboard-font-fallback/);
  const result = await invoke(source, true);
  assert.deepEqual(result.requests, []);
  assert.equal(result.fonts.size, 0, 'No substitute face or artwork typography is installed.');
});

test('existing loaded fonts stay intact and ordinary HTTP retains its original loader', async () => {
  const originalSource = await original(), source = repairEditorRuntime(originalSource);
  const existing = { family: 'Anthropic Serif', status: 'loaded' };
  const native = await invoke(source, true, [existing]);
  assert.equal(native.fonts.has(existing), true); assert.equal(native.fonts.size, 1);
  assert.deepEqual(native.requests, []);
  for (const code of [originalSource, source]) {
    const ordinary = await invoke(code, false);
    assert.deepEqual(ordinary.requests, [missing]);
    assert.equal(ordinary.fonts.size, 1);
  }
});

test('a supplied embedded font source is not disabled by the known missing-host-resource adapter', async () => {
  const embedded = 'url(data:font/woff2;base64,d09GMg==)';
  const source = repairEditorRuntime((await original()).replace(missing, embedded));
  assert.doesNotMatch(source, /codex-design:native-dashboard-font-fallback/);
  assert.deepEqual((await invoke(source, true)).requests, [embedded]);
});
