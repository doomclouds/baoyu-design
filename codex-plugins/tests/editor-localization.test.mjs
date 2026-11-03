import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import { createHash } from 'node:crypto';
import {
  EDITOR_KINDS, extractNativeMessages, createEditorCatalog, NATIVE_HOST_MESSAGE_OVERRIDES,
  adaptEditorLocalization, adaptStaticCommentChrome,
} from '../editor-localization.mjs';
import { repairEditorRuntime } from '../source/scripts/editor-runtime-adapter.mjs';
import { includePublishedSource } from '../publish-filter.mjs';
import { adaptNativeHostErrors } from '../source/scripts/native-editor-language-adapter.mjs';
import {
  initializeEditorLocalization, resolveLanguage, LANGUAGE_EVENT, PENDING_LANGUAGE_EVENT,
} from '../source/scripts/editor-localization.js';

const repository = path.resolve(import.meta.dirname, '../..');
const reviewedHostText = {
  BNC1wrrvvB: 'This artwork could not be loaded. Reopen it in Codex Design and check that its local files are available.',
  oeBy29hnwL: 'Saving is unavailable in this view. Reopen the artwork in Codex Design to reconnect local editing.',
  aKvb9N4RA6: 'Couldn’t prepare this design to send: the design contains what looks like a private editor access link, which cannot be sent.',
  OcwDW1DfuT: 'This view could not save the requested video format. Reopen the artwork in Codex Design and try the export again.',
  W1u6GkazZ0: 'Press Save video to choose a local destination. If that fails, reopen this artwork in Codex Design and export again.',
  WQZQZTd1Yn: 'If saving keeps failing, reopen this artwork in Codex Design and export again. The export renders the video from the start.',
  'RcLB4R+/kt': 'Transparent MOV export is unavailable in this local editor. Choose MP4 or GIF instead.',
};

function browser(language = 'zh-CN', configuration = {}, saved = 'zh') {
  const listeners = new Map(), events = [], storage = new Map([['codex-design.ui-language', saved]]);
  const accesses = { read: 0, write: 0 };
  const authored = { title: '中文作品', paragraph: '原文不能翻译', comment: '请保留此中文批注', chat: '中文聊天内容',
    date: new Intl.DateTimeFormat('zh-CN').format(new Date(2026, 10, 1)) };
  const navigator = { language, languages: [language] };
  const target = {
    navigator, Intl,
    __CODEX_DESIGN_EDITOR_I18N__: configuration,
    __CODEX_DESIGN_EDITOR_RESOURCES__: createEditorCatalog('slides', ['x({defaultMessage:"Cancel",id:"cancel"})']),
    localStorage: { getItem: key => { accesses.read++; return storage.get(key); }, setItem: (key, value) => { accesses.write++; storage.set(key, value); } },
    location: { href: 'http://localhost/slides/grant/?codexDesignLanguage=zh', reload: () => { throw new Error('Unsafe automatic reload'); } },
    document: { documentElement: { lang: 'zh-CN' },
      querySelectorAll: () => { throw new Error('UI language must not scan authored DOM'); },
      createTreeWalker: () => { throw new Error('UI language must not scan authored DOM'); } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    addEventListener: (type, listener) => { const group = listeners.get(type) || []; group.push(listener); listeners.set(type, group); },
    dispatchEvent: event => { events.push(event); for (const listener of listeners.get(event.type) || []) listener(event); },
    console, setTimeout, clearTimeout,
  };
  target.parent = target;
  return { target, authored, navigator, storage, accesses, events };
}

test('all five real editors have exact English-only catalogs and retain the historical four-editor inventory', async () => {
  const inventory = JSON.parse(await fs.readFile(new URL('../source/scripts/locales/native-en.json', import.meta.url), 'utf8'));
  const discovered = new Set();
  for (const kind of EDITOR_KINDS) {
    const editor = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor');
    const assets = path.join(editor, 'assets');
    const file = kind === 'motion' ? path.join(editor, 'artifact-type/app.js')
      : path.join(assets, (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name)));
    const source = await fs.readFile(file, 'utf8');
    const native = extractNativeMessages(source), catalog = createEditorCatalog(kind, [source]);
    assert.ok(native.size > 50, kind);
    assert.equal(catalog.language, 'en'); assert.deepEqual(Object.keys(catalog.resources), ['en']);
    assert.equal(catalog.coverage.englishNative, native.size);
    for (const [key, english] of native) {
      if (kind !== 'motion') discovered.add(english);
      assert.equal(catalog.resources.en.editor[key], reviewedHostText[key] ?? english);
    }
    assert.equal(adaptStaticCommentChrome(source), source, 'the removed translation adapter must not rewrite canonical literals');
    const repaired = repairEditorRuntime(source);
    assert.deepEqual([...extractNativeMessages(repaired)], [...native], 'runtime repairs preserve native IDs and canonical defaults');
    const localErrors = adaptNativeHostErrors(source);
    assert.deepEqual([...extractNativeMessages(localErrors)], [...native], 'capability error adaptation preserves canonical message definitions');
    assert.equal(adaptNativeHostErrors(localErrors), localErrors);
    await transform(localErrors, { loader: 'js' });
    await transform(repaired, { loader: 'js' });
  }
  assert.deepEqual([...discovered].sort(), inventory.messages.map(item => item.text).sort());
});

test('only seven reviewed host-message IDs receive exact local-operation wording', () => {
  assert.deepEqual(Object.keys(NATIVE_HOST_MESSAGE_OVERRIDES).sort(), Object.keys(reviewedHostText).sort());
  const record = (id, text) => '{defaultMessage:' + JSON.stringify(text) + ',id:' + JSON.stringify(id) + '}';
  for (const [id, reviewed] of Object.entries(NATIVE_HOST_MESSAGE_OVERRIDES)) {
    assert.equal(reviewed.message, reviewedHostText[id]);
    for (const original of reviewed.sources) {
      const source = record(id, original);
      assert.equal(extractNativeMessages(source).get(id), original);
      assert.equal(createEditorCatalog('motion', [source]).resources.en.editor[id], reviewedHostText[id]);
      assert.equal(createEditorCatalog('motion', [record('unreviewed-' + id, original)]).resources.en.editor['unreviewed-' + id], original);
    }
    assert.throws(() => createEditorCatalog('motion', [record(id, 'An unreviewed future capability message')]), /Unreviewed native host message variant/);
  }
  const source = 'var authored={title:"A story about Claude",copyright:"Anthropic",font:"Anthropic Sans"};';
  assert.equal(adaptStaticCommentChrome(source), source);
  assert.equal(adaptNativeHostErrors(source), source);
});

test('reviewed missing-self errors use local wording only inside a native editor and retain protocol codes', () => {
  for (const host of ['claude', 'slidesHost', 'designHost', 'designSystemHost']) {
    const original = `window.${host}.self is missing — this view’s runtime predates the self capability (or this page is running outside a Frame shell and the emulator). Content cannot be saved from here.`;
    const source = `var authored=${JSON.stringify(original)};function missing(){throw Error(${JSON.stringify(original)})}function denied(){throw{code:"not_granted",message:"The self capability is not available to this view."}}`;
    const adapted = adaptNativeHostErrors(source);
    assert.equal(adaptNativeHostErrors(adapted), adapted);
    const standalone = {}; vm.runInNewContext(adapted, standalone);
    assert.throws(() => standalone.missing(), error => error.message === original);
    assert.throws(() => standalone.denied(), error => error.code === 'not_granted' && error.message === 'The self capability is not available to this view.');
    const native = { __CODEX_DESIGN_EDITOR_TRANSPORT__: {} }; vm.runInNewContext(adapted, native);
    assert.equal(native.authored, original, 'an identical string used as authored data is unchanged');
    assert.throws(() => native.missing(), error => error.message === reviewedHostText.oeBy29hnwL);
    assert.throws(() => native.denied(), error => error.code === 'not_granted' && error.message === 'Permission to save is unavailable in this view. Reopen the artwork in Codex Design to retry.');
  }
});

test('only the two reviewed upstream export-menu message variants can share an ID', () => {
  const pairs = [
    ['j5PBn2aWFZ', 'No artboard was chosen in time, so the export was cancelled. Open Export to export again.', 'No artboard was chosen in time, so the export was cancelled. Open Share to export again.'],
    ['pYPDbUJ2RQ', 'Leaving that view cancelled the export. Open Export to export again.', 'Leaving that view cancelled the export. Open Share to export again.'],
  ];
  const record = (id, text) => '{defaultMessage:' + JSON.stringify(text) + ',id:' + JSON.stringify(id) + '}';
  for (const [id, menu, share] of pairs) {
    for (const texts of [[menu, share], [share, menu]]) {
      assert.equal(extractNativeMessages(texts.map(text => record(id, text)).join(';')).get(id), menu);
      assert.equal(createEditorCatalog('design', texts.map(text => record(id, text))).resources.en.editor[id], menu);
    }
    assert.throws(() => extractNativeMessages(record(id, menu) + ';' + record(id, 'Unknown export behavior')), /Conflicting native editor message/);
    assert.throws(() => extractNativeMessages(record('unknown-' + id, menu) + ';' + record('unknown-' + id, share)), /Conflicting native editor message/);
  }
});

test('old Chinese/system preferences, query parameters, host locale and navigator cannot select another UI language', () => {
  for (const saved of ['zh', 'system', 'en']) {
    const f = browser('zh-TW', { preference: 'zh', systemLocale: 'zh-CN' }, saved);
    const before = JSON.stringify(f.authored), originalIntl = f.target.Intl;
    // Even a cached old catalog cannot re-enable its Chinese resource.
    f.target.__CODEX_DESIGN_EDITOR_RESOURCES__.resources.zh = { editor: { cancel: '取消', 'chrome.reply': '回复' } };
    const api = initializeEditorLocalization(f.target);
    assert.equal(api.getLanguage(), 'en'); assert.equal(api.getPreference(), 'en');
    assert.equal(api.t('chrome.reply'), 'Reply'); assert.equal(f.target.__appifact_i18n.settled.cancel, 'Cancel');
    assert.equal(f.target.__appifact_i18n.lang, 'en-US'); assert.equal(f.target.document.documentElement.lang, 'en');
    assert.deepEqual(f.accesses, { read: 0, write: 0 }); assert.equal(f.storage.get('codex-design.ui-language'), saved);
    assert.equal(f.target.navigator, f.navigator); assert.equal(f.navigator.language, 'zh-TW'); assert.equal(f.target.Intl, originalIntl);
    assert.equal(JSON.stringify(f.authored), before);
  }
  assert.equal(resolveLanguage('zh', { systemLocale: 'zh-CN' }), 'en');
  assert.equal(resolveLanguage('system', { navigator: { language: 'zh-CN' } }), 'en');
});

test('legacy language messages and compatibility setters cannot change English or request a reload', () => {
  const f = browser(), api = initializeEditorLocalization(f.target);
  for (const preference of ['zh', 'system', 'en', 'fr']) {
    const state = api.setPreference(preference);
    assert.equal(state.language, 'en'); assert.equal(state.pendingLanguage, 'en'); assert.equal(state.requiresReload, false);
  }
  f.target.parent = { postMessage() { throw new Error('Language switching must not message its parent'); } };
  for (const event of [
    { type: LANGUAGE_EVENT, detail: { preference: 'zh' } },
    { type: 'storage', key: 'codex-design.ui-language', newValue: 'zh' },
    { type: 'languagechange' },
    { type: 'message', source: f.target.parent, origin: 'http://localhost', data: { type: LANGUAGE_EVENT, preference: 'zh' } },
  ]) f.target.dispatchEvent(event);
  assert.equal(api.getLanguage(), 'en'); assert.equal(api.getStatus().requiresReload, false);
  assert.ok(f.events.filter(event => event.type === PENDING_LANGUAGE_EVENT).every(event => event.detail.language === 'en'));
  assert.deepEqual(f.accesses, { read: 0, write: 0 });
});

test('English UI date and accessibility helpers preserve Chinese titles and authored dates', () => {
  const f = browser(), api = initializeEditorLocalization(f.target), before = JSON.stringify(f.authored);
  const now = new Date(2026, 10, 1, 12, 0), old = new Date(now.getTime() - 3 * 60_000).toISOString();
  assert.equal(api.formatCommentTime(old, now), '3m'); assert.equal(api.formatCommentTime('not a date', now), '');
  assert.match(api.formatCommentTimestamp(new Date(2026, 9, 31, 11), now), /^Yesterday, /);
  assert.equal(api.formatSlideLabel({ number: 1, count: 5, title: '中文标题' }), 'Slide 1 of 5: 中文标题');
  assert.equal(api.formatSlideLabel({ number: 2, title: '作品原文', thumbnail: true }), 'Slide 2 (thumbnail): 作品原文');
  assert.equal(JSON.stringify(f.authored), before);
});

test('English-only source adaptation never rewrites icon identities, enums, authored strings or original menu literals', () => {
  const source = 'var selected=false;var icon={name:selected?"CommentFilled":"Comment",type:"resolved",value:"Cover"};var ui={label:"Cover",children:"No open comments."};var content={title:"中文作品",text:"中文批注"};';
  assert.equal(adaptStaticCommentChrome(source), source);
  const sandbox = {}; vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.icon.name, 'Comment'); assert.equal(sandbox.icon.type, 'resolved'); assert.equal(sandbox.icon.value, 'Cover');
  assert.equal(sandbox.ui.label, 'Cover'); assert.equal(sandbox.content.text, '中文批注');
});

test('independent dialog and Form runtime repairs remain active and idempotent', () => {
  const source = 'function init(){calls.push("init")}function hook(){let p=r.useContext(e.sheetParentContext);return p}a(e,"useSheetTreeDialogAnnouncement",()=>hook);a(e,"initializeSheetMeasurement",()=>init);var form=t.jsx(e.baseFieldsetRoot,{ref:ref,"data-cds":"Form",disabled:true});';
  const repaired = repairEditorRuntime(source);
  assert.match(repaired, /function hook\(\)\{init\(\);let p=/);
  assert.ok(repaired.includes('render:t.jsx("form",{}),ref:ref,"data-cds":"Form",disabled:true'));
  assert.equal(repairEditorRuntime(repaired), repaired);
  const calls = [], sandbox = { calls, r: { useContext: () => 'context' }, e: { sheetParentContext: {}, baseFieldsetRoot: {} },
    a() {}, t: { jsx: (type, props) => ({ type, props }) }, ref: {} };
  vm.runInNewContext(repaired, sandbox);
  assert.equal(sandbox.hook(), 'context'); assert.deepEqual(calls, ['init']); assert.equal(sandbox.form.props.disabled, true);
});

test('publication excludes unused locale history without changing runtime, vendor or artwork assets', () => {
  for (const name of ['scripts/locales', 'scripts/locales/native-en.json', 'scripts/locales/native-zh-part-1.json', 'scripts/locales/native-zh-static.json', 'ui/locales/zh.js']) assert.equal(includePublishedSource(name), false, name);
  assert.equal(includePublishedSource('scripts\\locales\\native-zh-part-4.json'), false);
  for (const name of ['', 'scripts/editor-runtime-adapter.mjs', 'scripts/editor-localization.js', 'ui/locales/en.js', 'assets/icon.png', 'skills/codex-design-system/scripts/editor/artifact-type/vendor/react.production.min.js']) assert.equal(includePublishedSource(name), true, name);
});

test('all five generated editor fixtures load only English resources before runtime without translating Chinese content', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-editor-en-only-'));
  try {
    const result = await build({ entryPoints: [path.join(repository, 'codex-plugins/source/scripts/editor-localization.js')], bundle: true, format: 'iife', platform: 'browser', write: false });
    const bundlePath = path.join(temporary, 'runtime.js'); await fs.writeFile(bundlePath, result.outputFiles[0].contents);
    const pluginRoot = path.join(temporary, 'plugin');
    for (const kind of EDITOR_KINDS) {
      const editor = path.join(pluginRoot, 'skills', 'codex-' + kind, 'scripts/editor');
      const entry = kind === 'motion' ? 'artifact-type/app.js' : 'assets/index-test.js';
      await fs.mkdir(path.join(editor, 'assets'), { recursive: true });
      await fs.mkdir(path.dirname(path.join(editor, entry)), { recursive: true });
      await fs.writeFile(path.join(editor, 'index.html'), `<html><head><script src="./comments.js"></script><script type="module" src="./${entry}"></script></head><body><div id="root"></div></body></html>`);
      await fs.writeFile(path.join(editor, entry), 'var native={defaultMessage:"Cancel",id:"cancel"};var ui={label:"Reply"};var authored={title:"中文作品",text:"用户中文批注"};');
      if (kind === 'motion') await fs.writeFile(path.join(editor, 'local-host.js'), 'var localHost=true;');
      await fs.writeFile(path.join(editor, 'comments.js'), 'var icon={name:"Comment"};');
    }
    const report = await adaptEditorLocalization(pluginRoot, { bundlePath });
    for (const kind of EDITOR_KINDS) {
      assert.deepEqual(report[kind], { native: 1, englishNative: 1 });
      const editor = path.join(pluginRoot, 'skills/codex-' + kind, 'scripts/editor');
      const html = await fs.readFile(path.join(editor, 'index.html'), 'utf8');
      assert.ok(html.indexOf('data-codex-editor-i18n-resources') < html.indexOf('data-codex-editor-i18n>'));
      assert.ok(html.indexOf('data-codex-editor-i18n>') < html.indexOf('src="./comments.js"'));
      const resourceFile = /src="\.\/assets\/(codex-editor-resources-[a-f0-9]+\.js)"/.exec(html)[1];
      const runtimeFile = /src="\.\/assets\/(codex-editor-localization-[a-f0-9]+\.js)"/.exec(html)[1];
      for (const file of [resourceFile, runtimeFile]) {
        const bytes = await fs.readFile(path.join(editor, 'assets', file));
        assert.ok(html.includes('integrity="sha384-' + createHash('sha384').update(bytes).digest('base64') + '"'));
      }
      const f = browser('zh-CN', { preference: 'zh' }, 'zh'); f.target.window = f.target;
      vm.runInNewContext(await fs.readFile(path.join(editor, 'assets', resourceFile), 'utf8'), f.target);
      assert.deepEqual(Object.keys(f.target.__CODEX_DESIGN_EDITOR_RESOURCES__.resources), ['en']);
      vm.runInNewContext(await fs.readFile(path.join(editor, 'assets', runtimeFile), 'utf8'), f.target);
      vm.runInNewContext(await fs.readFile(path.join(editor, kind === 'motion' ? 'artifact-type/app.js' : 'assets/index-test.js'), 'utf8'), f.target);
      assert.equal(f.target.__appifact_i18n.lang, 'en-US'); assert.equal(f.target.__appifact_i18n.settled.cancel, 'Cancel');
      assert.equal(f.target.ui.label, 'Reply'); assert.equal(f.target.authored.title, '中文作品'); assert.equal(f.target.authored.text, '用户中文批注');
    }
    const before = await fs.readFile(path.join(pluginRoot, 'skills/codex-slides/scripts/editor/index.html'), 'utf8');
    await adaptEditorLocalization(pluginRoot, { bundlePath });
    assert.equal(await fs.readFile(path.join(pluginRoot, 'skills/codex-slides/scripts/editor/index.html'), 'utf8'), before);
  } finally {
    const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
