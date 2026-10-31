import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import {
  EDITOR_KINDS, EDITOR_UI_ZH, extractNativeMessages, createEditorCatalog,
  adaptEditorLocalization, adaptStaticCommentChrome, icuArguments, assertTranslationArguments,
} from '../editor-localization.mjs';
import {
  initializeEditorLocalization, resolveLanguage, LANGUAGE_EVENT, PENDING_LANGUAGE_EVENT,
} from '../source/scripts/editor-localization.js';

const repository = path.resolve(import.meta.dirname, '../..');

function browser(language = 'zh-CN', configuration = {}, saved = null) {
  const listeners = new Map();
  const events = [];
  const storage = new Map(saved ? [['codex-design.ui-language', saved]] : []);
  const authored = { title: 'Reply', paragraph: 'Save', comment: 'Delete this comment?', chat: 'Comments' };
  const target = {
    navigator: { language, languages: [language] },
    __CODEX_DESIGN_EDITOR_I18N__: configuration,
    __CODEX_DESIGN_EDITOR_RESOURCES__: createEditorCatalog('slides', ['x({defaultMessage:"Cancel",id:"cancel"})']),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    location: { href: 'http://localhost/slides/grant/', reload: () => { throw new Error('Unsafe automatic reload'); } },
    document: {
      documentElement: { lang: 'en' },
      querySelectorAll: () => { throw new Error('UI localization must not scan authored DOM'); },
      createTreeWalker: () => { throw new Error('UI localization must not scan authored DOM'); },
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    addEventListener: (type, listener) => { const group = listeners.get(type) || []; group.push(listener); listeners.set(type, group); },
    dispatchEvent: event => { events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); },
    console, setTimeout, clearTimeout,
  };
  target.parent = target;
  return { target, authored, storage, events };
}

test('four real editors expose native message IDs and every native UI message has Chinese ICU resources', async () => {
  const inventory = JSON.parse(await fs.readFile(new URL('../source/scripts/locales/native-en.json', import.meta.url), 'utf8'));
  const discovered = new Set();
  for (const kind of EDITOR_KINDS) {
    const assets = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
    const source = await fs.readFile(path.join(assets, file), 'utf8');
    assert.ok(source.includes('__appifact_i18n'), kind + ' must retain its original native i18n entrypoint');
    const native = extractNativeMessages(source);
    const catalog = createEditorCatalog(kind, [source]);
    assert.ok(native.size > 50, kind);
    assert.equal(catalog.coverage.translatedNative, catalog.coverage.native, kind + ': an English fallback is not a translated UI');
    assert.deepEqual(Object.keys(catalog.resources.zh.editor).sort(), Object.keys(catalog.resources.en.editor).sort(), kind + ': shared component/comment UI must also have explicit translations');
    for (const [key, english] of native) {
      discovered.add(english);
      assert.ok(catalog.resources.zh.editor[key]?.trim(), kind + ': ' + english);
      assertTranslationArguments(english, catalog.resources.zh.editor[key]);
    }
    const patched = adaptStaticCommentChrome(source);
    assert.deepEqual([...extractNativeMessages(patched)], [...native], kind + ': chrome adaptation must preserve native message IDs and canonical defaults');
    await transform(patched, { loader: 'js' });
    const commentsSource = kind === 'dashboard'
      ? await fs.readFile(path.join(assets, '../comments.js'), 'utf8') : source;
    const commentsPatched = adaptStaticCommentChrome(commentsSource);
    assert.ok(commentsPatched.includes('t("chrome.openComments",'), kind + ': open comment count');
    assert.equal((commentsPatched.match(/return globalThis\.codexDesignEditorI18n\.formatCommentTime\(/g) || []).length, 1, kind + ': relative comment dates');
    assert.equal((commentsPatched.match(/return globalThis\.codexDesignEditorI18n\.formatCommentTimestamp\(/g) || []).length, 1, kind + ': absolute comment dates');
    if (kind === 'dashboard') await transform(commentsPatched, { loader: 'js' });
  }
  assert.deepEqual([...discovered].sort(), inventory.messages.map(item => item.text).sort(), 'upstream UI additions require an explicit inventory/translation review');
});

test('i18next feeds native labels without translating any design, comment, or chat content', () => {
  const { target, authored } = browser();
  const before = JSON.stringify(authored);
  const api = initializeEditorLocalization(target);
  assert.equal(api.getLanguage(), 'zh');
  assert.equal(api.t('chrome.reply'), '回复');
  assert.equal(api.t('chrome.replies', { count: 3 }), '3 条回复');
  assert.equal(api.t('chrome.openComments', { count: 2 }), '2 条未解决批注');
  assert.equal(target.__appifact_i18n.settled.cancel, '取消');
  assert.equal(target.__appifact_i18n.lang, 'zh-CN');
  assert.equal(target.document.documentElement.lang, 'zh-CN');
  assert.equal(JSON.stringify(authored), before);
});

test('system locale, explicit English/Chinese, and safe reopen work in both directions', () => {
  assert.equal(resolveLanguage('system', { navigator: { language: 'zh-TW' } }), 'zh');
  assert.equal(resolveLanguage('system', { systemLocale: 'en-GB', navigator: { language: 'zh-CN' } }), 'en');
  assert.equal(resolveLanguage('system', { navigator: { language: 'ja-JP' } }), 'en');
  const first = browser('zh-CN');
  const chinese = initializeEditorLocalization(first.target);
  const pendingEnglish = chinese.setPreference('en');
  assert.equal(pendingEnglish.requiresReload, true);
  assert.equal(chinese.getLanguage(), 'zh', 'open editor constants stay coherent until a safe reopen');
  assert.equal(first.target.__appifact_i18n.settled.cancel, '取消');
  assert.equal(first.events.at(-1).type, PENDING_LANGUAGE_EVENT);
  const second = browser('zh-CN', {}, first.storage.get('codex-design.ui-language'));
  const english = initializeEditorLocalization(second.target);
  assert.equal(english.t('chrome.reply'), 'Reply');
  assert.equal(english.t('chrome.replies', { count: 1 }), '1 reply');
  assert.equal(english.t('chrome.openComments', { count: 1 }), '1 open comment');
  assert.equal(second.target.__appifact_i18n.settled.cancel, 'Cancel');
  assert.equal(english.setPreference('system').pendingLanguage, 'zh');
  assert.equal(english.getLanguage(), 'en');
  assert.throws(() => english.setPreference('fr'), /Expected UI language/);
});

test('shared setting events mark an editor for safe reopen and ignore unrelated parent messages', () => {
  const { target } = browser('en-US');
  const api = initializeEditorLocalization(target);
  target.dispatchEvent({ type: LANGUAGE_EVENT, detail: { preference: 'zh' } });
  assert.equal(api.getStatus().requiresReload, true);
  assert.equal(api.getLanguage(), 'en');
  target.dispatchEvent({ type: 'message', source: {}, origin: 'http://unrelated', data: { type: LANGUAGE_EVENT, preference: 'en' } });
  assert.equal(api.getPreference(), 'zh');
  const parentReplies = [];
  target.parent = { postMessage: (payload, origin) => parentReplies.push({ payload, origin }) };
  target.dispatchEvent({ type: 'message', source: target.parent, origin: 'http://library', data: { type: LANGUAGE_EVENT, preference: 'en' } });
  assert.equal(api.getStatus().requiresReload, false);
  assert.equal(parentReplies[0].origin, 'http://library');
});

test('ICU validation preserves dynamic arguments, plural controllers, and rich text tags', () => {
  assert.deepEqual(icuArguments('{n, plural, =1 {One} other {<strong>{count}</strong> files}}'), ['count', 'n']);
  assert.deepEqual(icuArguments("Literal '{noArgument}' and {actual}"), ['actual']);
  assert.doesNotThrow(() => assertTranslationArguments('{n, plural, one {{count} row} other {{count} rows}}', '{n, plural, other {{count} 行}}'));
  assert.throws(() => assertTranslationArguments('{n, plural, other {{count} rows}}', '{count} 行'), /changed ICU arguments/);
  assert.throws(() => assertTranslationArguments('<strong>{name}</strong>', '{name}'), /rich-text tags/);
  assert.throws(() => icuArguments('{count, plural, one {One}}'), /Invalid editor ICU/);
});

test('comment timestamps follow UI language without changing authored dates', () => {
  const chinese = initializeEditorLocalization(browser('zh-CN').target);
  const english = initializeEditorLocalization(browser('en-US').target);
  const now = new Date(2026, 9, 31, 12, 0);
  const before = new Date(now.getTime() - 3 * 60_000).toISOString();
  assert.equal(chinese.formatCommentTime(before, now), '3 分钟');
  assert.equal(english.formatCommentTime(before, now), '3m');
  assert.equal(chinese.formatCommentTime('not a date', now), '');
  assert.match(chinese.formatCommentTimestamp(new Date(2026, 9, 30, 11, 0), now), /^昨天 /);
  assert.match(english.formatCommentTimestamp(new Date(2026, 9, 30, 11, 0), now), /^Yesterday, /);
  assert.equal(before, new Date(now.getTime() - 3 * 60_000).toISOString());
});

test('compiled comment menus translate known UI callsites while native defaults and authored fields remain intact', () => {
  const source = 'var ui={label:"Reply",children:"Show resolved",title:"Delete this comment?",placeholder:"Add your comment","aria-label":"Comment actions"};var content={text:"Reply",value:"Delete",name:"Comments"};var native={defaultMessage:"Cancel",id:"native-cancel"};var n=2;var replies=n===1?"1 reply":`${n} replies`;function composer({placeholder:r="Add your comment",label:t="Comment"}){return[r,t]}';
  const patched = adaptStaticCommentChrome(source);
  assert.equal(adaptStaticCommentChrome(patched), patched, 'adaptation must be idempotent');
  assert.ok(patched.includes('defaultMessage:"Cancel",id:"native-cancel"'));
  const { target } = browser();
  initializeEditorLocalization(target);
  vm.runInNewContext(patched, target);
  assert.equal(target.ui.label, '回复');
  assert.equal(target.ui.children, '显示已解决的批注');
  assert.equal(target.ui.placeholder, '添加你的批注');
  assert.equal(target.replies, '2 条回复');
  assert.deepEqual([...target.composer({})], ['添加你的批注', '批注']);
  assert.deepEqual({ ...target.content }, { text: 'Reply', value: 'Delete', name: 'Comments' });
});

test('Dashboard header and default edit controls translate without rewriting authored Sources content', async () => {
  const assets = path.join(repository, 'skills/claude-dashboard/scripts/editor/assets');
  const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  const source = await fs.readFile(path.join(assets, file), 'utf8');
  for (const literal of ['label:"Sources"', '"aria-label":"What a click on the page does"', 'tooltip:"Use the page"', 'tooltip:"Edit the page (Beta)"']) assert.ok(source.includes(literal), literal);
  const patched = adaptStaticCommentChrome(source);
  for (const key of ['dashboard.sources', 'dashboard.clickBehavior', 'dashboard.usePage', 'dashboard.editPage', 'dashboard.undo', 'dashboard.redo', 'dashboard.unsavedCount']) assert.ok(patched.includes(`t("${key}"`), key);
  assert.ok(!patched.includes('label:"Sources"'));
  assert.ok(!patched.includes('tooltip:"Use the page"'));
  assert.ok(!patched.includes('tooltip:"Edit the page (Beta)"'));
  const authoredHtml = '<article><h2>Sources</h2><p>Read the Sources panel for the calculation.</p></article>';
  const fixture = 'var title="User artwork";var authored={text:"Sources",value:"Sources",name:"Sources"};var ui={label:"Sources","aria-label":"What a click on the page does",tooltip:"Use the page"};var pencil={tooltip:"Edit the page (Beta)",disabledReason:"Save or cancel your changes first."};var count=2;var edits=count===1?"1 unsaved change":String(count)+" unsaved changes";';
  for (const [language, expected] of [['zh-CN', ['来源', '单击页面时的操作', '使用页面', '编辑页面（测试版）', '2 项未保存的修改']], ['en-US', ['Sources', 'What a click on the page does', 'Use the page', 'Edit the page (Beta)', '2 unsaved changes']]]) {
    const { target } = browser(language);
    initializeEditorLocalization(target);
    vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
    assert.deepEqual([target.ui.label, target.ui['aria-label'], target.ui.tooltip, target.pencil.tooltip, target.edits], expected);
    assert.deepEqual({ ...target.authored }, { text: 'Sources', value: 'Sources', name: 'Sources' });
    assert.equal(authoredHtml, '<article><h2>Sources</h2><p>Read the Sources panel for the calculation.</p></article>');
  }
});

test('build helper loads resources and a self-contained classic i18next bundle before all four editors', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-i18n-'));
  try {
    const result = await build({ entryPoints: [path.join(repository, 'codex-plugins/source/scripts/editor-localization.js')], bundle: true, format: 'iife', platform: 'browser', write: false });
    const bundlePath = path.join(temporary, 'runtime.js');
    await fs.writeFile(bundlePath, result.outputFiles[0].contents);
    for (const kind of EDITOR_KINDS) {
      const editor = path.join(temporary, 'plugin/skills/codex-' + kind, 'scripts/editor');
      await fs.mkdir(path.join(editor, 'assets'), { recursive: true });
      await fs.writeFile(path.join(editor, 'index.html'), '<html><head><script src="./comments.js"></script><script type="module" src="./assets/index-test.js"></script></head><body><div id="root"></div></body></html>');
      await fs.writeFile(path.join(editor, 'assets/index-test.js'), 'var native={defaultMessage:"Cancel",id:"cancel"};var ui={label:"Reply"};');
    }
    const pluginRoot = path.join(temporary, 'plugin');
    const report = await adaptEditorLocalization(pluginRoot, { bundlePath });
    for (const kind of EDITOR_KINDS) {
      assert.deepEqual(report[kind], { native: 1, translatedNative: 1 });
      const editor = path.join(pluginRoot, 'skills/codex-' + kind, 'scripts/editor');
      const before = await fs.readFile(path.join(editor, 'index.html'), 'utf8');
      assert.ok(before.indexOf('data-codex-editor-i18n-resources') < before.indexOf('data-codex-editor-i18n>'));
      assert.ok(before.indexOf('data-codex-editor-i18n>') < before.indexOf('src="./comments.js"'));
      assert.ok(!/<script[^>]+data-codex-editor-i18n[^>]+(?:defer|type="module")/.test(before));
      const resourceFile = /src="\.\/assets\/(codex-editor-resources-[a-f0-9]+\.js)"/.exec(before)[1];
      const runtimeFile = /src="\.\/assets\/(codex-editor-localization-[a-f0-9]+\.js)"/.exec(before)[1];
      const { target } = browser('zh-CN');
      target.window = target;
      vm.runInNewContext(await fs.readFile(path.join(editor, 'assets', resourceFile), 'utf8'), target);
      vm.runInNewContext(await fs.readFile(path.join(editor, 'assets', runtimeFile), 'utf8'), target);
      assert.equal(target.__appifact_i18n.settled.cancel, '取消');
      const editorModule = /<script\b[^>]*type="module"[^>]*src="\.\/assets\/([^"]+)"/.exec(before)?.[1];
      assert.match(editorModule, /^index-codex-[a-f0-9]{16}\.js$/, 'immutable UI bundles require a changed URL when their bytes change');
      await assert.rejects(fs.stat(path.join(editor, 'assets/index-test.js')), { code: 'ENOENT' });
      await transform(await fs.readFile(path.join(editor, 'assets', editorModule), 'utf8'));
      await adaptEditorLocalization(pluginRoot, { bundlePath });
      assert.equal(await fs.readFile(path.join(editor, 'index.html'), 'utf8'), before);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
