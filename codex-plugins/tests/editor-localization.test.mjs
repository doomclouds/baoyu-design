import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { build, transform } from 'esbuild';
import {
  EDITOR_KINDS, EDITOR_UI_ZH, extractNativeMessages, createEditorCatalog,
  extractStaticChromeMessages,
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

test('floating comment-list empty states and resolved timestamp suffix translate without changing status or user data', async () => {
  for (const kind of EDITOR_KINDS) {
    const assets = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
    const source = await fs.readFile(path.join(assets, kind === 'dashboard' ? '../comments.js' : file), 'utf8');
    const patched = adaptStaticCommentChrome(source);
    assert.ok(patched.includes('t("chrome.noOpenComments"'), kind + ': actual floating empty-state branch');
    if (source.includes('&&" · Resolved"')) assert.ok(patched.includes('t("chrome.resolvedSuffix"'), kind + ': actual timestamp suffix');
  }
  const fixture = 'var ui={children:showResolved?"No comments yet.":"No open comments."};var short={children:showResolved?"No comments.":"No open comments."};function time(at){return"2 小时"}var entry={at:"2026-11-01",status:"resolved",text:"No open comments."};var resolved=entry.status==="resolved";var timestamp={children:[time(entry.at),resolved&&" · Resolved"]};var data={status:"resolved",text:" · Resolved",value:"No comments."};';
  for (const showResolved of [false, true]) {
    const { target } = browser('zh-CN'); initializeEditorLocalization(target); target.showResolved = showResolved;
    vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
    assert.equal(target.ui.children, showResolved ? '尚无批注。' : '没有未解决的批注。');
    assert.equal(target.short.children, showResolved ? '暂无批注。' : '没有未解决的批注。');
    assert.equal(target.timestamp.children.join(''), '2 小时 · 已解决');
    assert.equal(target.entry.status, 'resolved'); assert.equal(target.entry.text, 'No open comments.');
    assert.deepEqual({ ...target.data }, { status: 'resolved', text: ' · Resolved', value: 'No comments.' });
  }
});

test('comment icon identities and other conditional machine fields survive localization in all four real editor modules', async () => {
  const fixture = 'var filled=false;var icon={name:filled?"CommentFilled":"Comment",icon:filled?"CommentFilled":"Comment",type:filled?"Delete":"Comment",key:filled?"Reply":"Comment",value:filled?"Reply":"Comment"};var ui={label:filled?"Reply":"Comment",tooltip:filled?"Reply":"Comment"};var plain=filled?"Reply":"Comment";var machine={subtitle:"Reply",outline:"Comment",displaycontent:"Reply"};';
  const { target } = browser('zh-CN');
  target.__CODEX_DESIGN_EDITOR_RESOURCES__ = createEditorCatalog('slides', [fixture]);
  initializeEditorLocalization(target);
  vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
  assert.deepEqual({ ...target.icon }, { name: 'Comment', icon: 'Comment', type: 'Comment', key: 'Comment', value: 'Comment' });
  assert.equal(target.plain, 'Comment'); assert.equal(target.ui.label, '批注'); assert.equal(target.ui.tooltip, '批注');
  assert.deepEqual({ ...target.machine }, { subtitle: 'Reply', outline: 'Comment', displaycontent: 'Reply' });
  for (const kind of EDITOR_KINDS) {
    const assets = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
    let source = await fs.readFile(path.join(assets, file), 'utf8');
    if (kind === 'dashboard') source += '\n' + await fs.readFile(path.join(assets, '../comments.js'), 'utf8');
    const patched = adaptStaticCommentChrome(source);
    const icons = [...source.matchAll(/\b(?:name|icon):[A-Za-z_$][\w$]*\?"CommentFilled":"Comment"/g)].map(match => match[0]);
    assert.ok(icons.length > 0, kind + ': the actual comment icon callsite must be checked');
    for (const icon of icons) assert.ok(patched.includes(icon), kind + ': icon identity must stay an English enum');
    assert.doesNotMatch(patched, /\b(?:name|icon):[^,}]{0,150}\?"CommentFilled":\(globalThis\.codexDesignEditorI18n/, kind);
    assert.ok(patched.includes('t("chrome.comment"') || [...extractStaticChromeMessages(source).values()].includes('Comment'), kind + ': visible comment text still has localization');
  }
});

test('real Slides toolbar and Design System onboarding static callsites join the runtime catalog without changing model or export strings', async () => {
  const sources = [];
  for (const kind of ['slides', 'design-system']) {
    const assets = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
    sources.push(await fs.readFile(path.join(assets, file), 'utf8'));
  }
  const slides = extractStaticChromeMessages(sources[0]);
  for (const label of ['Text', 'Image or video', 'Table', 'Shapes', 'Download', 'Present', 'Speaker notes']) assert.ok([...slides.values()].includes(label), label);
  const designSystem = extractStaticChromeMessages(sources[1]);
  for (const label of ['Not sure where to start?', 'Sync from GitHub', 'Add color group', 'Upload brand files']) assert.ok([...designSystem.values()].includes(label), label);
  const snippet = 'var busy=false;var toolbar={label:"Text",tooltip:"Image or video","aria-label":"Speaker notes",what:"Add color group"};var download={label:busy?"Saving…":"Download"};var welcome={children:"Not sure where to start?"};var options={github:["Sync from GitHub","Point the agent at a repository; it imports tokens and components from code."],upload:["Upload brand files","Drop in logos, fonts, guidelines and token files; the agent drafts from them.","FileUpload"]};var model={text:"Text",role:"Table",name:"Present",icon:"Shapes",value:"Download"};var rawHtml="<h1>Text</h1>";';
  for (const [locale, expected] of [['zh-CN', ['文本', '图片或视频', '演讲者备注', '添加颜色分组', '下载', '不知道从哪里开始？', '从 GitHub 同步']], ['en-US', ['Text', 'Image or video', 'Speaker notes', 'Add color group', 'Download', 'Not sure where to start?', 'Sync from GitHub']]]) {
    const { target } = browser(locale);
    target.__CODEX_DESIGN_EDITOR_RESOURCES__ = createEditorCatalog('slides', [...sources, snippet]);
    initializeEditorLocalization(target);
    vm.runInNewContext(adaptStaticCommentChrome(snippet), target);
    assert.deepEqual([target.toolbar.label, target.toolbar.tooltip, target.toolbar['aria-label'], target.toolbar.what, target.download.label, target.welcome.children, target.options.github[0]], expected);
    assert.equal(target.options.upload[2], 'FileUpload', 'icon names remain canonical');
    assert.deepEqual({ ...target.model }, { text: 'Text', role: 'Table', name: 'Present', icon: 'Shapes', value: 'Download' });
    assert.equal(target.rawHtml, '<h1>Text</h1>');
  }
});

test('Canvas toolbar helper labels and its dedicated display-name map translate while tool IDs and icons remain unchanged', async () => {
  const assets = path.join(repository, 'skills/claude-design/scripts/editor/assets');
  const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  const source = await fs.readFile(path.join(assets, file), 'utf8');
  assert.ok(source.includes('k("text","Text","t",'));
  const fixture = 'var calls=[];function k(tool,label,shortcut,options){calls.push({tool,label,shortcut,options})}k("select","Select","esc",{icon:"Cursor"});k("text","Text","t",{glyph:"TextIcon"});k("frame","Artboard","a",{glyph:"ArtboardIcon"});k("note","Note","n",{icon:"Note"});var names={hand:"Hand",text:"Text",frame:"Artboard",note:"Note",draw:"Pencil",rect:"Rectangle",oval:"Oval",arrow:"Arrow",line:"Line",pen:"Pen"};var group="绘图工具";var menu={menuLabel:"More "+group};var page={id:"page-1",name:"Page 1"};';
  const { target } = browser('zh-CN');
  target.__CODEX_DESIGN_EDITOR_RESOURCES__ = createEditorCatalog('design', [source, fixture]);
  initializeEditorLocalization(target);
  vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
  assert.deepEqual(Array.from(target.calls, item => item.label), ['选择', '文本', '画板', '便笺']);
  assert.deepEqual(Array.from(target.calls, item => item.tool), ['select', 'text', 'frame', 'note']);
  assert.equal(target.calls[0].options.icon, 'Cursor'); assert.equal(target.calls[3].options.icon, 'Note');
  assert.equal(target.names.text, '文本'); assert.equal(target.names.frame, '画板');
  assert.equal(target.menu.menuLabel, '更多绘图工具');
  assert.equal(target.page.name, 'Page 1', 'a stored page title is content, not editor chrome');
});

test('Canvas accessible page and artboard counts translate only surrounding UI text, preserving authored titles', async () => {
  const assets = path.join(repository, 'skills/claude-design/scripts/editor/assets');
  const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  const source = await fs.readFile(path.join(assets, file), 'utf8');
  const patched = adaptStaticCommentChrome(source);
  assert.ok(patched.includes('t(tm>0?"canvas.pagesCountLabel":"canvas.pagesLabel"'));
  assert.ok(patched.includes('t("canvas.artboardPosition"'));
  const fixture = 'var title="Page 1",n=0;function pageLabel(){return title+", "+(n>0?String(n)+" pages":"pages")}function artboard(i,count,name){return"Artboard "+String(i+1)+" of "+String(count)+": "+name}var content={name:"Page 1",title:"Artboard 1"};';
  for (const [locale, expected] of [['zh-CN', ['Page 1，页面', 'Page 1，2 个页面', '画板 1 / 2：My title']], ['en-US', ['Page 1, pages', 'Page 1, 2 pages', 'Artboard 1 of 2: My title']]]) {
    const { target } = browser(locale); initializeEditorLocalization(target);
    vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
    assert.equal(target.pageLabel(), expected[0]); target.n = 2;
    assert.equal(target.pageLabel(), expected[1]); assert.equal(target.artboard(0, 2, 'My title'), expected[2]);
    assert.deepEqual({ ...target.content }, { name: 'Page 1', title: 'Artboard 1' });
  }
});

test('the observed Canvas empty-artboards explanation translates through its exact UI formatter', async () => {
  const assets = path.join(repository, 'skills/claude-design/scripts/editor/assets');
  const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  const source = await fs.readFile(path.join(assets, file), 'utf8');
  assert.ok(adaptStaticCommentChrome(source).includes('t(da.artboards.length===0?"canvas.emptyCanvasArtboards":"canvas.emptyPageArtboards"'));
  const fixture = 'var da={artboards:[]};function explanation(){return(da.artboards.length===0?"This canvas":"This page")+" has no artboards yet. Add one, or let the agent add some."}var content={name:"Page 1",text:"This canvas"};';
  for (const [locale, canvas, page] of [
    ['zh-CN', '此画布尚无画板。请添加一个画板，或让代理添加。', '此页面尚无画板。请添加一个画板，或让代理添加。'],
    ['en-US', 'This canvas has no artboards yet. Add one, or let the agent add some.', 'This page has no artboards yet. Add one, or let the agent add some.'],
  ]) {
    const { target } = browser(locale); initializeEditorLocalization(target);
    vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
    assert.equal(target.explanation(), canvas); target.da.artboards.push({}); assert.equal(target.explanation(), page);
    assert.deepEqual({ ...target.content }, { name: 'Page 1', text: 'This canvas' });
  }
});

test('Design System preview failure warnings translate through exact UI sentence callsites', async () => {
  const assets = path.join(repository, 'skills/claude-design-system/scripts/editor/assets');
  const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  const source = await fs.readFile(path.join(assets, file), 'utf8'), patched = adaptStaticCommentChrome(source);
  assert.ok(patched.includes('t("ds.previewNavigated"')); assert.ok(patched.includes('t("ds.previewScriptFailed"'));
  const fixture = 'var moved=false,failed=true;var warning=moved?"Live preview stopped — the preview navigated away.":failed?"This preview could not run: a script it needs did not load, or threw while loading. Showing the static preview.":null;var icon={name:failed?"CommentFilled":"Comment"};';
  const { target } = browser('zh-CN'); initializeEditorLocalization(target);
  vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
  assert.equal(target.warning, '预览所需的脚本未能加载，或在加载时发生错误。当前显示静态预览。');
  assert.equal(target.icon.name, 'CommentFilled');
});

test('actual comment pins and Design System usage, typography, theme and storage labels localize while artwork names remain data', async () => {
  const sources = [];
  for (const kind of EDITOR_KINDS) {
    const assets = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
    const source = await fs.readFile(path.join(assets, kind === 'dashboard' ? '../comments.js' : file), 'utf8');
    assert.ok(adaptStaticCommentChrome(source).includes('t("chrome.commentPin"'), kind + ': actual pin callsite');
    if (kind === 'design-system') sources.push(source);
  }
  const source = sources[0], patched = adaptStaticCommentChrome(source);
  for (const key of ['ds.noFontFiles', 'ds.storageUsage', 'ds.previewThemeLabel']) assert.ok(patched.includes('t("' + key + '"'), key);
  assert.equal((patched.match(/t\("ds\.storageUsage"/g) || []).length, 2, 'both listed and fallback storage counters use the same localized formatter');
  const fixture = 'var p={n:1},pin={label:p.n>0?`Comment ${p.n}`:"Resolved comment"};function note({title:t="Usage notes",label:l}){return t+": "+l}var R={name:"haze"},theme={"aria-label":R.name+", Preview theme"};var kinds={spacing:{value:"8px",label:"spacing value"},radius:{value:"4px",label:"corner radius"}};var f={jsx:(c,p)=>p},e={EmptyEditorList:{}};var empty=f.jsx(e.EmptyEditorList,{text:"No font files yet"});var ui={label:"Cover"};function K(x){return String(x)+"KB"}var A={usage:{files:1,bytes:2,maxBytes:10}};var usage="Stored alongside the page: "+String(A.usage.files)+(A.usage.files===1?" file":" files")+" · "+K(A.usage.bytes)+" of "+K(A.usage.maxBytes)+" used";';
  const { target } = browser('zh-CN');
  target.__CODEX_DESIGN_EDITOR_RESOURCES__ = createEditorCatalog('design-system', [source, fixture]);
  target.authored = { name: 'Palette', title: 'Spacing', text: 'No font files yet', fit: 'Cover', tokenName: 'haze' };
  initializeEditorLocalization(target); vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
  assert.equal(target.pin.label, '批注 1'); assert.equal(target.note({ label: 'haze' }), '使用说明: haze');
  assert.equal(target.theme['aria-label'], 'haze，预览主题');
  assert.equal(target.kinds.spacing.label, '间距值'); assert.equal(target.kinds.radius.label, '圆角半径');
  assert.equal(target.empty.text, '尚无字体文件'); assert.equal(target.ui.label, '覆盖', 'image-fit Cover keeps its separate meaning');
  assert.equal(target.usage, '随作品存储：1 个文件 · 已用 2KB / 10KB');
  assert.deepEqual({ ...target.authored }, { name: 'Palette', title: 'Spacing', text: 'No font files yet', fit: 'Cover', tokenName: 'haze' });
});

test('Design System Cover preview uses its exact native message ID and component title, independently of image-fit Cover', () => {
  const fixture = 'var native={defaultMessage:"Cover",id:"M+FVeeY9De"};var fit={defaultMessage:"Cover",id:"image-fit-cover"};var f={jsx:(c,p)=>p},e={StaticPreviewFrame:{}};var cover=f.jsx(e.StaticPreviewFrame,{html:"",head:"",title:"Cover"});var image={label:"Cover"};';
  const catalog = createEditorCatalog('design-system', [fixture]);
  assert.equal(catalog.resources.zh.editor['M+FVeeY9De'], '封面');
  assert.equal(catalog.resources.zh.editor['image-fit-cover'], '覆盖');
  const { target } = browser('zh-CN'); target.__CODEX_DESIGN_EDITOR_RESOURCES__ = catalog;
  initializeEditorLocalization(target); vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
  assert.equal(target.cover.title, '封面'); assert.equal(target.image.label, '覆盖');
});

test('the four editors localize their exact pending-sync status widget without changing state enums or authored messages', async () => {
  for (const kind of EDITOR_KINDS) {
    const assets = path.join(repository, 'skills', 'claude-' + kind, 'scripts/editor/assets');
    const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
    const source = await fs.readFile(path.join(assets, file), 'utf8');
    assert.ok(adaptStaticCommentChrome(source).includes('t("chrome.syncing"'), kind + ': real sync widget');
  }
  const fixture = 'var state="pending",store={message:null};var label=store.message??(state==="pending"?"Syncing…":state==="error"?"Couldn’t sync — click to retry":"All changes synced");var status={status:"saving",message:"Syncing…"};var machine={name:state==="pending"?"CommentFilled":"Comment",value:"Syncing…"};';
  const { target } = browser('zh-CN'); initializeEditorLocalization(target);
  vm.runInNewContext(adaptStaticCommentChrome(fixture), target);
  assert.equal(target.label, '同步中…'); assert.equal(target.status.message, '同步中…');
  assert.equal(target.status.status, 'saving'); assert.equal(target.state, 'pending');
  assert.deepEqual({ ...target.machine }, { name: 'CommentFilled', value: 'Syncing…' });
});

test('Slides accessibility formatters translate navigation and thumbnail labels without changing titles, ids or native comment label logic', async () => {
  const assets = path.join(repository, 'skills/claude-slides/scripts/editor/assets');
  const file = (await fs.readdir(assets)).find(name => /^index-.*\.js$/.test(name));
  const source = await fs.readFile(path.join(assets, file), 'utf8'), patched = adaptStaticCommentChrome(source);
  const thumbnailStart = source.indexOf('function M(Q,$,ee,le=0){let Z=(0,e.slideDisplayLabel)(Q);');
  assert.ok(thumbnailStart >= 0);
  const thumbnail = source.slice(thumbnailStart, source.indexOf('function D(', thumbnailStart));
  const commentEnd = source.indexOf('"formatOpenCommentCount",');
  const commentStart = source.lastIndexOf('function G(', commentEnd);
  const comments = source.slice(commentStart, source.indexOf('function V(', commentStart));
  const announceStart = source.indexOf('function i(c,s,h){return"Slide "');
  const announce = source.slice(announceStart, source.indexOf('}return a(e,"ReactSlideAnnouncement"', announceStart) + 1);
  assert.ok(announce.length > 20);
  const ariaStart = source.indexOf('"aria-label":"Slide "+String(Mt.n)');
  const aria = source.slice(ariaStart, source.indexOf(',"aria-current":', ariaStart));
  assert.ok(patched.includes('formatSlideLabel({number:$+1'));
  assert.ok(patched.includes('formatSlideLabel({number:c+1,count:s'));
  assert.ok(patched.includes('formatSlideLabel?.({number:Mt.n'));
  const nativeCalls = [...source.matchAll(/v\("slide","Slide "\+String\(([A-Za-z_$][\w$]*)\),\1\)/g)].map(match => match[0]);
  assert.ok(nativeCalls.length >= 2, 'actual native comment labels must be audited');
  for (const call of nativeCalls) assert.ok(patched.includes(call), 'native comment object labels remain unchanged');
  const title = 'Original title · 标题', slide = { id: 'cover', title, skipped: false };
  for (const [locale, label, announcement, other] of [
    ['zh-CN', '幻灯片 1（缩略图）：' + title + '，1 条未解决批注', '幻灯片 1 / 5：' + title, '幻灯片 2：Other title'],
    ['en-US', 'Slide 1 (thumbnail): ' + title + ', 1 open comment', 'Slide 1 of 5: ' + title, 'Slide 2: Other title'],
  ]) {
    const { target } = browser(locale);
    target.__CODEX_DESIGN_EDITOR_RESOURCES__ = createEditorCatalog('slides', [source]);
    initializeEditorLocalization(target);
    target.e = { slideDisplayLabel: value => value.title, formatOpenCommentCount: count => target.G(count) };
    target.Mt = { id: 'cover', n: 1 }; target.ge = 'cover'; target.nl = title; target.me = new Map([['cover', 1]]);
    vm.runInNewContext(adaptStaticCommentChrome(thumbnail + comments + announce + 'var element={' + aria + ',"data-slide-id":Mt.id};'), target);
    assert.equal(target.M(slide, 0, true, 1), label);
    assert.equal(target.i(0, 5, title), announcement);
    assert.equal(target.M({ id: 'body', title: 'Other title' }, 1, false), other);
    assert.equal(target.element['aria-label'], label); assert.equal(target.element['data-slide-id'], 'cover');
    assert.equal(slide.id, 'cover'); assert.equal(slide.title, title);
  }
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
      assert.deepEqual(report[kind], { native: 1, translatedNative: 1, static: 1, translatedStatic: 1 });
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
