import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adaptNativeEditorLanguage } from '../source/scripts/native-editor-language-adapter.mjs';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const plugin = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const bundles = new Map();
for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
  const root = path.join(plugin, 'skills/codex-' + kind, 'scripts/editor');
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const entry = /<script\b[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
  assert.ok(entry, kind + ' uses its actual generated editor entry');
  bundles.set(kind, await fs.readFile(path.join(root, entry), 'utf8'));
}

class Element {
  children = []; attributes = new Map(); style = {}; listeners = new Map(); parent = null; shadowRoot = null; className = '';
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  get classList() { return { contains: value => this.className.split(/\s+/).includes(value), toggle: (value, on) => {
    const values = new Set(this.className.split(/\s+/).filter(Boolean));
    if (on) values.add(value); else values.delete(value);
    this.className = [...values].join(' ');
  } }; }
  append(...values) { for (const value of values) { if (value instanceof Element) { value.remove(); value.parent = this; } this.children.push(value); } }
  replaceChildren(...values) { for (const child of [...this.children]) if (child instanceof Element) child.remove(); this.children = []; this.append(...values); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  attachShadow() { return this.shadowRoot = new Element('shadow-root', this.ownerDocument); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  click() { this.listeners.get('click')?.(); }
  get textContent() { return this.children.map(child => child instanceof Element ? child.textContent : String(child)).join(''); }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parent?.isConnected); }
}

function nodes(root) { return [root, ...(root.shadowRoot ? nodes(root.shadowRoot) : []), ...root.children.flatMap(child => child instanceof Element ? nodes(child) : [])]; }
function conflictModule(source) {
  const selector = /const ([\w$]+)=(?:globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__\?!1:)?\/\^zh\\b\/i\.test\(navigator\.language\);/.exec(source);
  const factory = readCommentComponent(source, /function ([\w$]+)\(\)\{if\(typeof document>"u"\)return null;const [\w$]+=[\w$]+\("div",\{"data-baoyu-clash-layer":""\}\)/);
  assert.ok(selector && factory && factory.start > selector.index, 'Read the actual generated canonical clash module.');
  const row = readCommentComponent(source.slice(factory.end), /^function ([\w$]+)\(([\w$]+),([\w$]+)\)\{/);
  assert.ok(row, 'The canonical conflict row immediately follows its factory.');
  return source.slice(selector.index, factory.end + row.end) + `;globalThis.conflicts=${factory.match[1]}();`;
}

function runtime(source, { native = true, language = 'zh-CN' } = {}) {
  const document = {};
  document.body = new Element('body', document);
  document.createElement = tag => new Element(tag, document);
  const navigator = { language, languages: [language] };
  const target = { document, navigator, ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: {} } : {}) };
  target.window = target;
  vm.runInNewContext(conflictModule(source), target);
  return { target, navigator, document, show: (...args) => target.conflicts.show(...args),
    elements: () => nodes(document.body), buttons: () => nodes(document.body).filter(node => node.tagName === 'BUTTON'),
    text: className => nodes(document.body).find(node => node.classList.contains(className))?.textContent };
}

for (const kind of ['slides', 'design']) {
  test(`${kind}: the actual generated native conflict UI remains English under Chinese system languages and preserves all three choices`, () => {
    const source = bundles.get(kind);
    const adapted = adaptInlineEditorScript(source, 'https://codex-design.invalid/artifacts/test/assets/editor.js');
    assert.equal(adaptNativeEditorLanguage(adaptNativeEditorLanguage(source)), adaptNativeEditorLanguage(source));
    for (const language of ['zh-CN', 'zh-TW', 'en-US']) {
      const actual = runtime(adapted, { language });
      const conflict = Object.freeze({ kind: kind === 'design' ? 'board' : 'slide', path: 'project/中文内容.html', slideNo: 1, label: '中文画板', by: Object.freeze({ id: 'agent', name: 'Agent', agent: true }) });
      const calls = [];
      for (const [label, choice] of [['Use theirs', 'theirs'], ['Keep mine', 'mine'], ['Keep both', 'copy']]) {
        actual.show([conflict], (file, value) => calls.push({ file, value }));
        assert.equal(actual.text('title'), kind === 'design' ? 'Agent just changed “中文画板”' : 'Agent just changed slide 1');
        assert.equal(actual.text('sub'), 'Your edits on it are not saved yet. Pick one:');
        assert.deepEqual(actual.buttons().map(button => button.textContent), ['Use theirs', 'Keep mine', 'Keep both']);
        const button = actual.buttons().find(button => button.textContent === label);
        assert.ok(button.getAttribute('title'));
        button.click(); button.click();
        assert.deepEqual(calls.at(-1), { file: conflict.path, value: choice });
      }
      assert.equal(calls.length, 3, 'Canonical choice callbacks still run only once per displayed row.');
      const named = Object.freeze({ ...conflict, by: Object.freeze({ id: 'person', name: '中文作者' }) });
      actual.show([named], () => {});
      assert.ok(actual.text('title').startsWith('中文作者 just changed '));
      if (kind === 'design') {
        actual.show([{ ...conflict, deleted: true }], () => {});
        assert.equal(actual.text('title'), 'Agent just deleted “中文画板”');
        assert.equal(actual.buttons()[1].getAttribute('title'), 'Save this board back, with your edits');
      }
      assert.equal(actual.target.navigator, actual.navigator);
      assert.equal(actual.navigator.language, language);
      assert.equal(conflict.label, '中文画板');
      actual.show([], () => {});
      assert.equal(actual.document.body.children.length, 0);
    }
  });

  test(`${kind}: the adapted canonical bundle preserves standalone Chinese and English conflict semantics`, () => {
    const source = adaptNativeEditorLanguage(bundles.get(kind));
    const conflict = { kind: 'slide', slideNo: 1, path: 'project/slides/cover.html', by: { agent: true, id: 'agent' } };
    const chinese = runtime(source, { native: false, language: 'zh-CN' });
    chinese.show([conflict], () => {});
    assert.deepEqual(chinese.buttons().map(button => button.textContent), ['用他的', '保留我的', '两份都留']);
    assert.equal(chinese.text('sub'), '你在这页上的改动还没保存，选一个：');
    const english = runtime(source, { native: false, language: 'en-US' });
    english.show([conflict], () => {});
    assert.deepEqual(english.buttons().map(button => button.textContent), ['Use theirs', 'Keep mine', 'Keep both']);
  });
}

test('all four generated bundles are audited without changing unrelated locale-sensitive authoring behavior or content', () => {
  for (const [kind, source] of bundles) {
    const adapted = adaptNativeEditorLanguage(source);
    if (['design-system', 'dashboard'].includes(kind)) assert.equal(adapted, source, kind + ' has no separate clash language module');
    else {
      const restored = adapted.replace('/* codex-design:native-conflict-language */\n', '')
        .replace('=globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?!1:/^zh', '=/^zh');
      assert.equal(restored, source, kind + ' changes only the known chrome-language selector');
      assert.ok(adapted.includes('你在这页上的改动还没保存，选一个：'), 'Standalone dictionaries are retained.');
    }
  }
});

test('changed, removed, mismatched or duplicated canonical language anchors fail closed', () => {
  const source = bundles.get('slides');
  const flag = /const ([\w$]+)=\/\^zh\\b\/i\.test\(navigator\.language\);/.exec(source)[1];
  for (const changed of [
    source.replace('"data-baoyu-clash-layer"', '"data-renamed-clash-layer"'),
    source.replace(`const ${flag}=/^zh\\b/i.test(navigator.language);`, `const ${flag}=/^zh\\b/i.test(navigator.languages[0]);`),
    source.replace(`=${flag}?{changed:`, '=renamedFlag?{changed:'),
    source.replace('copy:"Keep both"', 'copy:"Changed action"'),
    source + source,
  ]) assert.throws(() => adaptNativeEditorLanguage(changed), { code: 'EDITOR_LANGUAGE_ADAPTER_UNSUPPORTED' });
});
