import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { repairEditorRuntime } from './source/scripts/editor-runtime-adapter.mjs';

export const EDITOR_KINDS = ['slides', 'design', 'design-system', 'dashboard'];

// Author-maintained translations of editor chrome only. Keys here are the
// upstream defaultMessage strings, never strings read from a user's files.
export const EDITOR_BASE_ZH = Object.freeze({
  'Name': '名称', 'Preview': '预览', 'Value': '值', 'Add': '添加', 'Cancel': '取消',
  'Rename…': '重命名…', 'Rename': '重命名', 'Download': '下载', 'Copy it': '复制',
  'New set': '新建分组', 'File name': '文件名', 'Video': '视频', '{kind} · {size}': '{kind} · {size}',
  'Copy {value}': '复制 {value}', 'Couldn’t copy': '无法复制', 'Inherits {theme}': '继承 {theme}',
  'A group needs a name.': '请为分组命名。', 'Removed {name}': '已移除 {name}', 'Deleted {name}': '已删除 {name}',
  'A request to the agent is on its way': '请求正在发送给代理', 'Asking the agent': '正在请求代理',
  'Still working on your previous change. Try again in a moment.': '上一次修改仍在处理中，请稍后重试。',
  'rate-limited — add it again in a minute': '请求过于频繁，请稍后重新添加',
  'Collapse {name}': '收起 {name}', 'Expand {name}': '展开 {name}', 'Read-only document': '只读文档',
  'Remove': '移除', 'Delete {name}': '删除 {name}', 'Remove {name}': '移除 {name}',
  'Guidance for the agent — voice, do’s and don’ts, anything the tokens can’t say.': '代理指引：语气、注意事项，以及设计令牌无法表达的要求。',
  'Overview': '概览', 'Colors': '颜色', 'Typography': '字体排版', 'Spacing': '间距',
  'Radius': '圆角', 'Radii': '圆角', 'Shadows': '阴影', 'Components': '组件', 'Assets': '素材', 'Files': '文件',
  'Ask the agent for a palette, a dark or high-contrast theme, a check for contrast and colour-blind safety, or to pull the colours from your repo — or add groups by hand.': '请代理创建调色板、深色或高对比度主题，检查对比度和色觉无障碍，或从仓库提取颜色；也可以手动添加分组。',
  'Ask the agent to pick a type pairing, set up display, heading and body styles, or load your brand fonts — or add styles yourself.': '请代理搭配字体，设置展示、标题和正文样式，或加载品牌字体；也可以自行添加样式。',
  'Ask the agent for a spacing scale — a few steps from tight to roomy — or add values yourself, with a note on when to use each.': '请代理制定从紧凑到宽松的间距等级；也可以自行添加数值并说明适用场景。',
  'Ask the agent for the corner radii, from sharp to fully round, or add them yourself.': '请代理制定从直角到全圆角的圆角值，也可以自行添加。',
  'Ask the agent for an elevation scale, one shadow per level in each theme, or add them yourself.': '请代理制定层级阴影，为每个主题的各层级设置阴影，也可以自行添加。',
  'Ask the agent to build components from your code or a description — buttons, inputs, cards — and their previews and usage notes land here.': '请代理根据代码或描述创建按钮、输入框、卡片等组件，预览和使用说明会显示在这里。',
  'Ask the agent to gather your logos and icons from a repo, or drop files anywhere on the page.': '请代理从仓库收集标志和图标，也可以将文件拖到页面任意位置。',
  'Ask the agent to fill this in, or add values with a note on when to use each.': '请代理补充内容，也可以自行添加数值并说明适用场景。',
  'No colors yet.': '尚无颜色。', 'No type styles or font files yet.': '尚无字体样式或字体文件。',
  'No spacing values yet.': '尚无间距值。', 'No corner radii yet.': '尚无圆角值。', 'No shadows yet.': '尚无阴影。',
  'No components yet.': '尚无组件。', 'No files yet.': '尚无文件。', 'No tokens yet.': '尚无设计令牌。', 'Nothing here yet.': '这里暂无内容。',
  'In view: {item}, in {section}.': '当前可见：{section} 中的 {item}。', 'In view: {item}, in this page.': '当前页面可见：{item}。',
  'In view: {section}.': '当前可见：{section}。',
  'A file here was changed by someone else while you were editing it. Choose theirs or yours at the top of the page.': '编辑期间，其他人修改了这里的文件。请在页面顶部选择保留对方版本或你的版本。',
  'needs your choice': '需要你选择', '{section}, {count}': '{section}，{count}', '{name}, {detail}': '{name}，{detail}',
  'Search': '搜索', 'No matches for “{query}”': '未找到“{query}”的匹配项',
  '{n, plural, one {Showing {shown} of {count} matches. Keep typing to narrow it down.} other {Showing {shown} of {count} matches. Keep typing to narrow it down.}}': '{n, plural, other {显示 {count} 个匹配项中的 {shown} 个，请继续输入以缩小范围。}}',
  '{n, plural, one {{count} match} other {{count} matches}}': '{n, plural, other {{count} 个匹配项}}',
  '{at} of {total}': '{at} / {total}', 'Sections': '章节',
  'Press Command+F in this field to find text on the page instead.': '在此输入框中按 Command+F 可改为查找页面文字。',
  'Press Ctrl+F in this field to find text on the page instead.': '在此输入框中按 Ctrl+F 可改为查找页面文字。',
  '{page} page, press {keys} to focus it': '{page} 页面，按 {keys} 聚焦',
  'Ask the agent': '请求代理', 'Allow': '允许', 'Reconnect': '重新连接', 'Connect': '连接',
  'Allow {connector}': '允许 {connector}', 'Reconnect {connector}': '重新连接 {connector}', 'Connect {connector}': '连接 {connector}',
  'Close': '关闭', 'Back': '返回', 'Done': '完成', 'Confirm': '确认', 'Clear': '清除', 'Dismiss': '忽略',
  'Loading': '正在加载', 'Loading…': '正在加载…', 'More options': '更多选项', 'Open': '打开',
  'Edit': '编辑', 'View': '查看', 'Save': '保存', 'Save anyway': '仍然保存', 'Delete': '删除',
  'Copy': '复制', 'Copied': '已复制', 'Duplicate': '创建副本', 'Restore': '恢复', 'Reset': '重置',
  'Previous': '上一项', 'Next': '下一项', 'Retry': '重试', 'Try again': '重试', 'Select all': '全选',
  'Properties': '属性', 'Appearance': '外观', 'Layout': '布局', 'Background': '背景',
  'Background color': '背景颜色', 'No background': '无背景', 'Color': '颜色', 'Gradient': '渐变',
  'Border': '边框', 'Border color': '边框颜色', 'Corner radius': '圆角半径', 'Padding': '内边距',
  'Width': '宽度', 'Height': '高度', 'Min width': '最小宽度', 'Max width': '最大宽度',
  'Min height': '最小高度', 'Max height': '最大高度', 'Size': '尺寸', 'Sizing': '尺寸调整',
  'Sans-serif': '无衬线', 'Serif': '衬线', 'Monospace': '等宽', 'Text': '文本', 'Font': '字体',
  'Weight': '字重', 'Text style': '文本样式', 'Line height': '行高', 'Letter spacing': '字距',
  'Letter spacing (px)': '字距（px）', 'Line height · Letter spacing': '行高 · 字距',
  'Underline': '下划线', 'Strikethrough': '删除线', 'Bold': '加粗', 'Italic': '斜体',
  'Uppercase': '大写', 'Lowercase': '小写', 'Capitalize': '首字母大写', 'Mixed': '混合',
  'Custom': '自定义', 'Default': '默认', 'Theme default': '主题默认', 'Style default': '样式默认',
  'System font': '系统字体', 'Search fonts': '搜索字体', 'Advanced': '高级', 'None': '无',
  'Align': '对齐', 'Left': '左侧', 'Right': '右侧', 'Top': '顶部', 'Bottom': '底部',
  'Middle': '中部', 'Center': '居中', 'Baseline': '基线', 'Start': '起点', 'End': '终点',
  'Stretch': '拉伸', 'Horizontal': '水平', 'Vertical': '垂直', 'Gap': '间隙', 'Fill': '填充',
  'Hug': '适应内容', 'Fixed': '固定', 'Auto': '自动', 'auto': '自动', 'Stack': '堆叠', 'Grid': '网格',
  'Layered': '分层', 'Solid': '实线', 'Dashed': '虚线', 'Dotted': '点线', 'No border': '无边框',
  'Image': '图片', 'Icon': '图标', 'Glyph': '字形', 'Line': '线条', 'Connector': '连接线',
  'Table': '表格', 'Columns': '列', 'Rows': '行', 'Column widths': '列宽', 'Header row': '表头行',
  'Embed': '嵌入内容', 'Thickness': '粗细', 'Direction': '方向', 'Resize': '调整大小',
  'Fit': '适应', 'Cover': '覆盖', 'Contain': '完整显示', 'Radial': '径向', 'Linear': '线性',
  'Alt text': '替代文本', 'Delay': '延迟', 'On click': '单击时', 'With slide': '随幻灯片',
  'Transition': '切换效果', 'Slide': '幻灯片', 'Canvas': '画布', 'Thumbnail': '缩略图',
  'Slide {n}': '第 {n} 张幻灯片', 'Slide {n} / {count}': '幻灯片 {n} / {count}',
  'Add slide': '添加幻灯片', 'New slide': '新建幻灯片', 'New section': '新建章节',
  'Previous slide': '上一张幻灯片', 'Next slide': '下一张幻灯片', 'First slide': '第一张幻灯片', 'Last slide': '最后一张幻灯片',
  'Speaker notes': '演讲者备注', 'No notes for this slide.': '这张幻灯片没有备注。',
  'Speaker notes. Never shown on the slide.': '演讲者备注，不会显示在幻灯片上。',
  'Show speaker notes': '显示演讲者备注', 'Hide speaker notes': '隐藏演讲者备注',
  'Show slide thumbnails': '显示幻灯片缩略图', 'Hide slide thumbnails': '隐藏幻灯片缩略图',
  'Copy link to slide': '复制幻灯片链接', 'Set as thumbnail': '设为缩略图', 'Add slide after': '在后面添加幻灯片',
  'Unskip slide': '取消跳过幻灯片', 'No slides yet.': '尚无幻灯片。', 'No slides': '没有幻灯片',
  'Pause': '暂停', 'Resume': '继续', 'Elapsed': '已用时间', 'Elapsed (paused)': '已用时间（已暂停）',
  'Speaker notes · {n} / {count}': '演讲者备注 · {n} / {count}', 'No slide here.': '这里没有幻灯片。',
  'Edit the notes from here': '在这里编辑备注', 'Close speaker notes window': '关闭演讲者备注窗口',
  'Exit full screen (F)': '退出全屏（F）', 'Full screen (F)': '全屏（F）', 'Exit (Esc)': '退出（Esc）',
  'Full screen isn’t available here': '这里无法使用全屏', 'Next: {title}': '下一张：{title}',
  'Blank': '空白', 'Title': '标题', 'Section': '章节', 'Title + body': '标题 + 正文', 'Bullets': '项目符号',
  'Two columns': '双栏', 'Quote': '引用', 'Image + caption': '图片 + 说明', 'Closing': '结束页',
  'Download as PDF': '下载为 PDF', 'Image quality': '图片质量', 'Higher quality makes a larger file.': '质量越高，文件越大。',
  'Include speaker notes': '包含演讲者备注', 'None of the slides being exported has speaker notes.': '待导出的幻灯片均无演讲者备注。',
  'Good': '良好', 'Better': '较好', 'Best': '最佳', 'Export notes': '导出备注', '{kind} ready': '{kind} 已就绪',
  'Replace…': '替换…', 'Choose image…': '选择图片…', 'Pick an image first': '请先选择图片',
  'Pick a border style first': '请先选择边框样式', 'Add a border first': '请先添加边框',
  'Column span': '跨列数', 'Row span': '跨行数', 'Cell role': '单元格角色', 'Default (body)': '默认（正文）',
  'Col {column}': '第 {column} 列', 'Align self': '自身对齐', 'Justify self': '自身主轴对齐',
  'Grow': '扩展比例', 'Shrink': '收缩比例', 'Basis': '基础尺寸', 'Aspect': '宽高比',
  'Emphasis': '强调', 'List': '列表', 'Case': '大小写', 'Reset Spacing': '重置间距',
  'No type styles in this presentation’s design system': '此演示文稿的设计系统中没有字体样式',
  'No type styles in this presentation': '此演示文稿中没有字体样式', 'Custom — {style}': '自定义 — {style}',
  'Filled': '实心', 'Straight': '直线', 'Elbow': '折线',
  'Down-right': '右下', 'Down-left': '左下', 'Up-right': '右上', 'Up-left': '左上',
  'Fade': '淡入淡出', 'Push': '推进', 'Magic move': '神奇移动', 'Nothing to paste.': '没有可粘贴的内容。',
  'Comment': '批注', 'Comments': '批注', 'Reply': '回复', 'Send to agent': '发送给代理',
  'Resolve': '解决', 'Reopen': '重新打开', 'Resolved': '已解决', 'Unresolved': '未解决',
  'Edit comment': '编辑批注', 'Delete comment': '删除批注', 'Add a comment': '添加批注',
  'Search comments': '搜索批注', 'No comments yet': '尚无批注', 'Comment mode': '批注模式',
});

export function loadEditorTranslations() {
  const result = { ...EDITOR_BASE_ZH };
  for (let part = 1; part <= 4; part++) {
    const file = new URL(`./source/scripts/locales/native-zh-part-${part}.json`, import.meta.url);
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    for (const [message, translated] of Object.entries(entries)) {
      if (typeof translated === 'string' && translated.trim()) result[message] = translated;
    }
  }
  Object.assign(result, JSON.parse(readFileSync(new URL('./source/scripts/locales/native-zh-static.json', import.meta.url), 'utf8')));
  return result;
}

export const EDITOR_UI_ZH = Object.freeze(loadEditorTranslations());

const STATIC_UI_PROPERTIES = '(?<![\\w$])(?:"aria-label"|label|title|placeholder|description|content|footnote|children|tooltip|tip|disabledTip|disabledReason|confirmLabel|cancelLabel|group|noUndo|noRedo|cancel|save|saves|noSave|what|hint|line|create|back|noFiles|adding|noneKept|removeLater|menuLabel|groupLabel)';
const WELCOME_ARRAY = /(?<![\w$])(?:github|connect|upload):\[((?:"(?:\\.|[^"\\])*",?){1,3})\]/g;
const CANVAS_TOOL_LABEL_MAP = /\{hand:"Hand",text:"Text",frame:"Artboard",note:"Note",draw:"Pencil",rect:"Rectangle",oval:"Oval",arrow:"Arrow",line:"Line",pen:"Pen"\}/g;
const CANVAS_TOOL_BUTTON_LABEL = /\b[A-Za-z_$][\w$]*\("(?:select|hand|text|frame|note)",("(?:Select|Hand|Text|Artboard|Note)"),"(?:esc|[htan])"/g;
const staticUiKey = text => 'static.' + createHash('sha256').update(text).digest('hex').slice(0, 16);

// The original editors translate message IDs, but several toolbars and empty
// states still use literal UI properties. Inventory those compiled callsites,
// including simple conditional labels; never inspect an artwork or its DOM.
export function extractStaticChromeMessages(source, translations = EDITOR_UI_ZH) {
  const found = new Map();
  const add = literal => {
    let text; try { text = JSON.parse(literal); } catch { return; }
    if (translations[text] && !icuArguments(text).length) found.set(staticUiKey(text), text);
  };
  for (const match of source.matchAll(new RegExp(STATIC_UI_PROPERTIES + ':("(?:\\\\.|[^"\\\\])*")', 'g'))) add(match[1]);
  for (const match of source.matchAll(new RegExp(STATIC_UI_PROPERTIES + ':([^,;{}]{1,300})', 'g'))) {
    for (const literal of match[1].matchAll(/"(?:\\.|[^"\\])*"/g)) add(literal[0]);
  }
  for (const match of source.matchAll(WELCOME_ARRAY)) for (const literal of match[1].matchAll(/"(?:\\.|[^"\\])*"/g)) add(literal[0]);
  for (const match of source.matchAll(CANVAS_TOOL_LABEL_MAP)) for (const literal of match[0].matchAll(/:"(?:\\.|[^"\\])*"/g)) add(literal[0].slice(1));
  for (const match of source.matchAll(CANVAS_TOOL_BUTTON_LABEL)) add(match[1]);
  return found;
}

const CHROME_MESSAGES = {
  'canvas.emptyCanvasArtboards': 'This canvas has no artboards yet. Add one, or let the agent add some.',
  'canvas.emptyPageArtboards': 'This page has no artboards yet. Add one, or let the agent add some.',
  'slides.numberLabel': 'Slide {{number}}', 'slides.positionLabel': 'Slide {{number}} of {{count}}',
  'slides.skippedSuffix': ' (skipped)', 'slides.thumbnailSuffix': ' (thumbnail)', 'slides.titleSuffix': ': {{title}}',
  'slides.openCommentSuffix': ', {{count}} open comments', 'slides.openCommentSuffix_one': ', {{count}} open comment',
  'slides.openCommentSuffix_other': ', {{count}} open comments',
  'chrome.syncing': 'Syncing…', 'chrome.syncRetry': 'Couldn’t sync — click to retry',
  'chrome.allSynced': 'All changes synced',
  'chrome.commentPin': 'Comment {{count}}',
  'ds.previewThemeLabel': '{{name}}, Preview theme', 'ds.noFontFiles': 'No font files yet',
  'ds.coverPreviewTitle': 'Cover',
  'ds.storageUsage': 'Stored alongside the page: {{count}} files · {{used}} of {{limit}} used',
  'ds.storageUsage_one': 'Stored alongside the page: {{count}} file · {{used}} of {{limit}} used',
  'ds.storageUsage_other': 'Stored alongside the page: {{count}} files · {{used}} of {{limit}} used',
  'canvas.pagesLabel': '{{title}}, pages', 'canvas.pagesCountLabel': '{{title}}, {{count}} pages',
  'canvas.artboardPosition': 'Artboard {{index}} of {{count}}: {{title}}',
  'ds.previewNavigated': 'Live preview stopped — the preview navigated away.',
  'ds.previewScriptFailed': 'This preview could not run: a script it needs did not load, or threw while loading. Showing the static preview.',
  'chrome.sendToAgent': 'Send to agent', 'chrome.reply': 'Reply', 'chrome.comments': 'Comments',
  'chrome.comment': 'Comment', 'chrome.resolve': 'Resolve', 'chrome.reopen': 'Reopen',
  'chrome.resolved': 'Resolved', 'chrome.cancel': 'Cancel', 'chrome.delete': 'Delete',
  'chrome.close': 'Close', 'chrome.edit': 'Edit', 'chrome.dismiss': 'Dismiss', 'chrome.save': 'Save',
  'chrome.commentActions': 'Comment actions', 'chrome.moreOptions': 'More options',
  'chrome.editComment': 'Edit comment', 'chrome.deleteConfirmation': 'Delete this comment?',
  'chrome.addYourComment': 'Add your comment', 'chrome.send': 'Send',
  'chrome.doneCommenting': 'Done commenting', 'chrome.hideComments': 'Hide comments',
  'chrome.showAllComments': 'Show all comments', 'chrome.commentOptions': 'Comment options',
  'chrome.filter': 'Filter', 'chrome.showResolved': 'Show resolved', 'chrome.allComments': 'All comments',
  'chrome.noComments': 'No comments yet.', 'chrome.noCommentsShort': 'No comments.', 'chrome.noOpenComments': 'No open comments.',
  'chrome.deleteThread': 'Delete thread', 'chrome.sentToAgent': 'Sent to agent',
  'chrome.resolvedSuffix': ' · Resolved', 'chrome.oneReply': '1 reply',
  'chrome.waitingForAgent': 'Waiting for the agent', 'chrome.working': 'Working…', 'chrome.you': 'You',
  'chrome.newComment': 'New comment', 'chrome.resolvedComment': 'Resolved comment',
  'chrome.commentsUnavailable': 'Comments are not available',
  'chrome.restartEditor': 'Restart the editor server (artifact.mjs stop, then open).',
  'chrome.replies': '{{count}} replies',
  'chrome.replies_one': '{{count}} reply', 'chrome.replies_other': '{{count}} replies',
  'chrome.openComments': '{{count}} open comments', 'chrome.openComments_one': '{{count}} open comment',
  'chrome.openComments_other': '{{count}} open comments',
  'chrome.time.now': 'now', 'chrome.time.minutes': '{{count}}m',
  'chrome.time.hours': '{{count}}h', 'chrome.time.days': '{{count}}d',
  'chrome.time.yesterday': 'Yesterday, {{time}}',
  'dashboard.sources': 'Sources', 'dashboard.clickBehavior': 'What a click on the page does',
  'dashboard.usePage': 'Use the page', 'dashboard.editPage': 'Edit the page (Beta)',
  'dashboard.settings': 'Settings', 'dashboard.history': 'History', 'dashboard.remix': 'Remix',
  'dashboard.unsavedChanges': 'Unsaved changes', 'dashboard.undo': 'Undo', 'dashboard.redo': 'Redo',
  'dashboard.cannotUndoSaving': 'Can’t undo while saving', 'dashboard.nothingToUndo': 'Nothing to undo yet',
  'dashboard.cannotRedoSaving': 'Can’t redo while saving', 'dashboard.nothingToRedo': 'Nothing to redo',
  'dashboard.cancelDiscard': 'Cancel: discard ', 'dashboard.cannotCancelSaving': 'Can’t cancel while saving',
  'dashboard.publishOneChange': 'Make this change live for everyone with access',
  'dashboard.publishChanges': 'Make these changes live for everyone with access',
  'dashboard.savePrefix': 'Save ', 'dashboard.saving': 'Saving…', 'dashboard.nothingToSave': 'Nothing to save yet',
  'dashboard.saveOrCancelFirst': 'Save or cancel your changes first.', 'dashboard.saved': 'Saved',
  'dashboard.agentWorking': 'The agent is working', 'dashboard.editWhenDone': '. You can edit when it’s done.',
  'dashboard.readOnlyDraft': 'You can’t edit this dashboard right now, so the draft can’t be saved.',
  'dashboard.unreadableDraft': 'The draft couldn’t be read, so nothing was saved. Try again.',
  'dashboard.changedDraft': 'The draft changed since it was shown, so nothing was saved. Look it over and save again.',
  'dashboard.goneDraft': 'This draft was already saved or discarded.',
  'dashboard.versionFailed': 'The dashboard as it is now couldn’t be kept as a version, so nothing was saved. Try again.',
  'dashboard.partlySaved': 'Saving stopped part way, so the dashboard may be partly changed. Press Save again to finish.',
  'dashboard.discardFailed': 'Couldn’t discard the draft. Try again.',
  'dashboard.startFailed': 'Couldn’t start the draft, so the request in your chat won’t do anything. Try Remix again.',
  'dashboard.behindDraft': 'This dashboard changed after the draft was made. Save replaces that change with the draft. Cancel discards the draft and keeps the change.',
  'dashboard.shownDraft': 'Showing the draft. Only people who can edit can see it until you save.',
  'dashboard.hiddenDraft': 'Showing the dashboard as it is.', 'dashboard.discardedDraft': 'Draft discarded',
  'dashboard.readyDraft': 'The draft is ready to save or cancel.',
  'dashboard.changeCount': '{{count}} changes', 'dashboard.changeCount_one': '{{count}} change',
  'dashboard.changeCount_other': '{{count}} changes',
  'dashboard.unsavedCount': '{{count}} unsaved changes', 'dashboard.unsavedCount_one': '{{count}} unsaved change',
  'dashboard.unsavedCount_other': '{{count}} unsaved changes',
};

const CHROME_ZH = {
  'This canvas has no artboards yet. Add one, or let the agent add some.': '此画布尚无画板。请添加一个画板，或让代理添加。',
  'This page has no artboards yet. Add one, or let the agent add some.': '此页面尚无画板。请添加一个画板，或让代理添加。',
  'Slide {{number}}': '幻灯片 {{number}}', 'Slide {{number}} of {{count}}': '幻灯片 {{number}} / {{count}}',
  ' (skipped)': '（已跳过）', ' (thumbnail)': '（缩略图）', ': {{title}}': '：{{title}}',
  ', {{count}} open comments': '，{{count}} 条未解决批注', ', {{count}} open comment': '，{{count}} 条未解决批注',
  'Syncing…': '同步中…', 'Couldn’t sync — click to retry': '无法同步，单击以重试',
  'All changes synced': '所有修改均已同步',
  'Comment {{count}}': '批注 {{count}}', '{{name}}, Preview theme': '{{name}}，预览主题',
  'No font files yet': '尚无字体文件',
  'Stored alongside the page: {{count}} files · {{used}} of {{limit}} used': '随作品存储：{{count}} 个文件 · 已用 {{used}} / {{limit}}',
  'Stored alongside the page: {{count}} file · {{used}} of {{limit}} used': '随作品存储：{{count}} 个文件 · 已用 {{used}} / {{limit}}',
  '{{title}}, pages': '{{title}}，页面', '{{title}}, {{count}} pages': '{{title}}，{{count}} 个页面',
  'Artboard {{index}} of {{count}}: {{title}}': '画板 {{index}} / {{count}}：{{title}}',
  'Live preview stopped — the preview navigated away.': '实时预览已停止：预览跳转到了其他页面。',
  'This preview could not run: a script it needs did not load, or threw while loading. Showing the static preview.': '预览所需的脚本未能加载，或在加载时发生错误。当前显示静态预览。',
  'Comment actions': '批注操作', 'Delete this comment?': '删除此批注吗？', 'Add your comment': '添加你的批注',
  'Send': '发送', 'Done commenting': '结束批注', 'Hide comments': '隐藏批注', 'Show all comments': '显示全部批注',
  'Comment options': '批注选项', 'Filter': '筛选', 'Show resolved': '显示已解决的批注', 'All comments': '全部批注',
  'No comments yet.': '尚无批注。', 'No comments.': '暂无批注。', 'No open comments.': '没有未解决的批注。', 'Delete thread': '删除批注线程',
  'Sent to agent': '已发送给代理', ' · Resolved': ' · 已解决', '1 reply': '1 条回复',
  'Waiting for the agent': '正在等待代理', 'Working…': '正在处理…', 'You': '你', 'New comment': '新建批注',
  'Resolved comment': '已解决的批注', 'Comments are not available': '批注暂不可用',
  'Restart the editor server (artifact.mjs stop, then open).': '请重新启动编辑器服务（先停止，再打开）。',
  '{{count}} replies': '{{count}} 条回复',
  '{{count}} reply': '{{count}} 条回复', '{{count}} open comments': '{{count}} 条未解决批注',
  '{{count}} open comment': '{{count}} 条未解决批注', 'now': '刚刚',
  '{{count}}m': '{{count}} 分钟', '{{count}}h': '{{count}} 小时', '{{count}}d': '{{count}} 天',
  'Yesterday, {{time}}': '昨天 {{time}}',
  'Sources': '来源', 'What a click on the page does': '单击页面时的操作', 'Use the page': '使用页面',
  'Edit the page (Beta)': '编辑页面（测试版）', 'Settings': '设置', 'History': '历史记录', 'Remix': '重新设计',
  'Unsaved changes': '未保存的修改', 'Undo': '撤销', 'Redo': '重做',
  'Can’t undo while saving': '保存期间无法撤销', 'Nothing to undo yet': '暂无可撤销的操作',
  'Can’t redo while saving': '保存期间无法重做', 'Nothing to redo': '没有可重做的操作',
  'Cancel: discard ': '取消：丢弃 ', 'Can’t cancel while saving': '保存期间无法取消',
  'Make this change live for everyone with access': '向所有有权访问的人发布此次修改',
  'Make these changes live for everyone with access': '向所有有权访问的人发布这些修改',
  'Save ': '保存 ', 'Saving…': '正在保存…', 'Nothing to save yet': '暂无可保存的修改',
  'Save or cancel your changes first.': '请先保存或取消你的修改。', 'Saved': '已保存',
  'The agent is working': '代理正在处理', '. You can edit when it’s done.': '。完成后即可编辑。',
  'You can’t edit this dashboard right now, so the draft can’t be saved.': '你目前无法编辑此看板，因此无法保存草稿。',
  'The draft couldn’t be read, so nothing was saved. Try again.': '无法读取草稿，未保存任何内容，请重试。',
  'The draft changed since it was shown, so nothing was saved. Look it over and save again.': '草稿在显示后发生了变化，未保存任何内容，请检查后重新保存。',
  'This draft was already saved or discarded.': '此草稿已保存或丢弃。',
  'The dashboard as it is now couldn’t be kept as a version, so nothing was saved. Try again.': '无法将当前看板保存为历史版本，未保存任何内容，请重试。',
  'Saving stopped part way, so the dashboard may be partly changed. Press Save again to finish.': '保存中途停止，看板可能已部分更改，请再次保存以完成。',
  'Couldn’t discard the draft. Try again.': '无法丢弃草稿，请重试。',
  'Couldn’t start the draft, so the request in your chat won’t do anything. Try Remix again.': '无法启动草稿，聊天中的请求不会执行，请重新尝试重新设计。',
  'This dashboard changed after the draft was made. Save replaces that change with the draft. Cancel discards the draft and keeps the change.': '创建草稿后，看板发生了变化。保存将以草稿覆盖该修改；取消将丢弃草稿并保留该修改。',
  'Showing the draft. Only people who can edit can see it until you save.': '正在显示草稿。保存之前，仅有编辑权限的人可见。',
  'Showing the dashboard as it is.': '正在显示当前看板。', 'Draft discarded': '草稿已丢弃',
  'The draft is ready to save or cancel.': '草稿已就绪，可保存或取消。',
  '{{count}} changes': '{{count}} 项修改', '{{count}} change': '{{count}} 项修改',
  '{{count}} unsaved changes': '{{count}} 项未保存的修改', '{{count}} unsaved change': '{{count}} 项未保存的修改',
};

const ASSIGNED_DASHBOARD_CHROME = new Set([
  'Sources', 'Saved', 'Save or cancel your changes first.', 'The agent is working',
  'You can’t edit this dashboard right now, so the draft can’t be saved.',
  'The draft couldn’t be read, so nothing was saved. Try again.',
  'The draft changed since it was shown, so nothing was saved. Look it over and save again.',
  'This draft was already saved or discarded.',
  'The dashboard as it is now couldn’t be kept as a version, so nothing was saved. Try again.',
  'Saving stopped part way, so the dashboard may be partly changed. Press Save again to finish.',
  'Couldn’t discard the draft. Try again.',
  'Couldn’t start the draft, so the request in your chat won’t do anything. Try Remix again.',
  'This dashboard changed after the draft was made. Save replaces that change with the draft. Cancel discards the draft and keeps the change.',
  'Showing the draft. Only people who can edit can see it until you save.',
  'Showing the dashboard as it is.', 'Draft discarded', 'The draft is ready to save or cancel.',
]);

const CDS_MESSAGES = {
  back: 'Back', close: 'Close', loading: 'Loading', clear: 'Clear', dismiss: 'Dismiss',
  confirm: 'Confirm', cancel: 'Cancel', moreOptions: 'More options',
  scrollBack: 'Scroll back', scrollForward: 'Scroll forward', opensInNewTab: '(opens in new tab)',
  removeItem: 'Remove {item}', clearSelection: 'Clear selection', loadingOptions: 'Loading options',
  loadingMoreOptions: 'Loading more options', selectAll: 'Select all', sequenceThen: 'then',
  avatarGroup: '{count} {noun}', overflowCount: 'and {count} more',
};
const CDS_ZH = {
  'Scroll back': '向后滚动', 'Scroll forward': '向前滚动', '(opens in new tab)': '（在新标签页中打开）',
  'Remove {item}': '移除 {item}', 'Clear selection': '清除选择', 'Loading options': '正在加载选项',
  'Loading more options': '正在加载更多选项', 'then': '然后', '{count} {noun}': '{count} {noun}',
  'and {count} more': '以及其他 {count} 项',
};

export function extractNativeMessages(source) {
  const result = new Map();
  const literal = '"(?:\\\\.|[^"\\\\])*"';
  const patterns = [
    new RegExp('\\{defaultMessage:(' + literal + '),id:(' + literal + ')\\}', 'g'),
    new RegExp('\\{id:(' + literal + '),defaultMessage:(' + literal + ')\\}', 'g'),
  ];
  patterns.forEach((pattern, index) => {
    for (const match of source.matchAll(pattern)) {
      const message = JSON.parse(match[index === 0 ? 1 : 2]);
      const id = JSON.parse(match[index === 0 ? 2 : 1]);
      if (result.has(id) && result.get(id) !== message) throw new Error('Conflicting native editor message ID: ' + id);
      result.set(id, message);
    }
  });
  return result;
}

// A small, execution-free validation reader for the ICU constructs used by
// these editors. Branch braces are grammar, not additional argument names.
export function icuArguments(message) {
  const names = new Set();
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(message[cursor] || '') && cursor < message.length) cursor++; };
  const fail = () => { throw new Error('Invalid editor ICU message at ' + cursor + ': ' + message); };
  const word = () => {
    const start = cursor;
    while (cursor < message.length && !/[\s,{}]/.test(message[cursor])) cursor++;
    return message.slice(start, cursor);
  };
  const expect = character => { if (message[cursor] !== character) fail(); cursor++; };
  function nodes(nested = false) {
    while (cursor < message.length) {
      if (message[cursor] === '}') { if (!nested) fail(); return; }
      if (message[cursor] === "'") {
        if (message[cursor + 1] === "'") { cursor += 2; continue; }
        if (/[{}<>#]/.test(message[cursor + 1] || '')) {
          cursor++;
          while (cursor < message.length) {
            if (message[cursor] === "'") {
              if (message[cursor + 1] === "'") { cursor += 2; continue; }
              cursor++; break;
            }
            cursor++;
          }
          continue;
        }
      }
      if (message[cursor] !== '{') { cursor++; continue; }
      cursor++; whitespace();
      const name = word();
      if (!name) fail();
      names.add(name); whitespace();
      if (message[cursor] === '}') { cursor++; continue; }
      expect(','); whitespace();
      const type = word(); whitespace();
      if (type === 'number' || type === 'date' || type === 'time') {
        while (cursor < message.length && message[cursor] !== '}') cursor++;
        expect('}'); continue;
      }
      if (!['plural', 'selectordinal', 'select'].includes(type)) fail();
      expect(','); whitespace();
      if (message.startsWith('offset:', cursor)) { cursor += 7; whitespace(); if (!/^\d+$/.test(word())) fail(); whitespace(); }
      let hasOther = false;
      while (cursor < message.length && message[cursor] !== '}') {
        const selector = word();
        if (!selector) fail();
        hasOther ||= selector === 'other';
        whitespace(); expect('{'); nodes(true); expect('}'); whitespace();
      }
      if (!hasOther) fail();
      expect('}');
    }
    if (nested) fail();
  }
  nodes();
  return [...names].sort();
}

export function assertTranslationArguments(english, chinese) {
  const first = icuArguments(english);
  const second = icuArguments(chinese);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('Editor translation changed ICU arguments: ' + JSON.stringify({ english, chinese, first, second }));
  }
  const tags = text => [...new Set([...text.matchAll(/<\/?([A-Za-z][\w.-]*)(?:\s*\/)?>/g)].map(match => match[1]))].sort();
  if (JSON.stringify(tags(english)) !== JSON.stringify(tags(chinese))) throw new Error('Editor translation changed rich-text tags: ' + english);
}

export function createEditorCatalog(kind, sources, translations = EDITOR_UI_ZH) {
  const messages = new Map();
  for (const source of sources) for (const [id, text] of extractNativeMessages(source)) {
    if (messages.has(id) && messages.get(id) !== text) throw new Error('Conflicting editor message ID: ' + id);
    messages.set(id, text);
  }
  const english = Object.fromEntries(messages);
  const staticMessages = new Map();
  for (const source of sources) for (const [key, text] of extractStaticChromeMessages(source, translations)) staticMessages.set(key, text);
  for (const [key, text] of staticMessages) english[key] = text;
  for (const [key, text] of Object.entries(CDS_MESSAGES)) english['cds.' + key] = text;
  for (const [key, text] of Object.entries(CHROME_MESSAGES)) english[key] = text;
  const chinese = {};
  for (const [key, text] of Object.entries(english)) {
    const translated = key === 'ds.coverPreviewTitle' || kind === 'design-system' && key === 'M+FVeeY9De'
      ? '封面' : translations[text] || CHROME_ZH[text] || CDS_ZH[text];
    if (translated) {
      if (messages.has(key)) assertTranslationArguments(text, translated);
      chinese[key] = translated;
    }
  }
  return {
    kind,
    resources: { en: { editor: english }, zh: { editor: chinese } },
    coverage: { native: messages.size, translatedNative: [...messages.values()].filter(text => !!translations[text]).length,
      static: staticMessages.size, translatedStatic: [...staticMessages.values()].filter(text => !!translations[text]).length },
  };
}

// These are static chrome callsites in the compiled editor, not values loaded
// from a design. The native message pipeline handles the rest. No DOM rewriting.
export function adaptStaticCommentChrome(source) {
  const marker = '/* codex-design-editor-i18n:chrome */';
  if (source.startsWith(marker)) return source;
  const messageKeys = new Map(Object.entries(CHROME_MESSAGES).filter(([key]) => key !== 'ds.coverPreviewTitle').map(([key, text]) => [text, key]));
  const staticKeys = new Map([...extractStaticChromeMessages(source)].map(([key, text]) => [text, messageKeys.get(text) || key]));
  const changes = [];
  const captureLiteral = (match, group = 2, keys = messageKeys) => {
    const literal = match[group];
    let value;
    try { value = JSON.parse(literal); } catch { return; } // Non-UI JS escapes such as \0 are not dictionary keys.
    const key = keys.get(value);
    if (!key) return;
    const start = match.index + match[0].lastIndexOf(literal);
    changes.push({ start, end: start + literal.length,
      text: '(globalThis.codexDesignEditorI18n?.t(' + JSON.stringify(key) + ')??' + literal + ')' });
  };
  // Slides exposes separate UI formatters and native comment-label formatters.
  // Only the former are adapted; their stable slide ids/anchors remain data.
  const thumbnailFormatter = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=0\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.slideDisplayLabel\)\(\2\);(return"Slide "\+[^{}]{0,450})\}/g;
  for (const match of source.matchAll(thumbnailFormatter)) {
    const escapedCount = match[5].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const commentFormat = new RegExp('\\+([A-Za-z_$][\\w$]*)\\(' + escapedCount + '\\)$').exec(match[8]);
    if (!commentFormat) continue;
    const start = match.index + match[0].indexOf(match[8]);
    changes.push({ start, end: start, text: 'if(globalThis.codexDesignEditorI18n?.formatSlideLabel)return globalThis.codexDesignEditorI18n.formatSlideLabel({number:' + match[3] + '+1,title:' + match[6] + ',skipped:' + match[2] + '.skipped===!0,thumbnail:' + match[4] + ',comments:' + commentFormat[1] + '(' + match[5] + ')});' });
  }
  const presentationLabel = /return"Slide "\+String\(([A-Za-z_$][\w$]*)\+1\)\+" of "\+String\(([A-Za-z_$][\w$]*)\)\+\(([A-Za-z_$][\w$]*)!==""\?": "\+\3:""\)/g;
  for (const match of source.matchAll(presentationLabel)) changes.push({ start: match.index, end: match.index,
    text: 'if(globalThis.codexDesignEditorI18n?.formatSlideLabel)return globalThis.codexDesignEditorI18n.formatSlideLabel({number:' + match[1] + '+1,count:' + match[2] + ',title:' + match[3] + '});' });
  const thumbnailAria = /"aria-label":"Slide "\+String\(([A-Za-z_$][\w$]*)\.n\)\+\(\1\.id===([A-Za-z_$][\w$]*)\?" \(thumbnail\)":""\)\+\(([A-Za-z_$][\w$]*)!==""\?": "\+\3:""\)\+\(0,([A-Za-z_$][\w$]*)\.formatOpenCommentCount\)\(([A-Za-z_$][\w$]*)\?\.get\(\1\.id\)\?\?0\)/g;
  for (const match of source.matchAll(thumbnailAria)) {
    const original = match[0].slice('"aria-label":'.length);
    changes.push({ start: match.index, end: match.index + match[0].length,
      text: '"aria-label":(globalThis.codexDesignEditorI18n?.formatSlideLabel?.({number:' + match[1] + '.n,thumbnail:' + match[1] + '.id===' + match[2] + ',title:' + match[3] + ',comments:(0,' + match[4] + '.formatOpenCommentCount)(' + match[5] + '?.get(' + match[1] + '.id)??0)})??(' + original + '))' });
  }
  const openSlideComments = /return ([A-Za-z_$][\w$]*)>0\?", "\+String\(\1\)\+\(\1===1\?" open comment":" open comments"\):""/g;
  for (const match of source.matchAll(openSlideComments)) changes.push({ start: match.index, end: match.index + match[0].length,
    text: 'return ' + match[1] + '>0?(globalThis.codexDesignEditorI18n?.t("slides.openCommentSuffix",{count:' + match[1] + '})??(' + match[0].slice(7) + ')):""' });
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)===1\?"1 reply":`\$\{\1\} replies`/g)) {
    changes.push({ start: match.index, end: match.index + match[0].length,
      text: '(globalThis.codexDesignEditorI18n?.t("chrome.replies",{count:' + match[1] + '})??(' + match[0] + '))' });
  }
  for (const match of source.matchAll(/`\$\{([A-Za-z_$][\w$]*)\} open \$\{\1===1\?"comment":"comments"\}`/g)) {
    changes.push({ start: match.index, end: match.index + match[0].length,
      text: '(globalThis.codexDesignEditorI18n?.t("chrome.openComments",{count:' + match[1] + '})??' + match[0] + ')' });
  }
  for (const [label, key] of [['change', 'dashboard.changeCount'], ['unsaved change', 'dashboard.unsavedCount']]) {
    const pattern = new RegExp('([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)===1\\?"1 ' + label + '":String\\(\\1\\)\\+" ' + label + 's"', 'g');
    for (const match of source.matchAll(pattern)) changes.push({ start: match.index, end: match.index + match[0].length,
      text: '(globalThis.codexDesignEditorI18n?.t(' + JSON.stringify(key) + ',{count:' + match[1] + '})??(' + match[0] + '))' });
  }
  const pagesLabel = /([A-Za-z_$][\w$]*)\+", "\+\(([A-Za-z_$][\w$]*)>0\?String\(\2\)\+" pages":"pages"\)/g;
  for (const match of source.matchAll(pagesLabel)) changes.push({ start: match.index, end: match.index + match[0].length,
    text: '(globalThis.codexDesignEditorI18n?.t(' + match[2] + '>0?"canvas.pagesCountLabel":"canvas.pagesLabel",{title:' + match[1] + ',count:' + match[2] + '})??(' + match[0] + '))' });
  const emptyCanvas = /\(([A-Za-z_$][\w$]*)\.artboards\.length===0\?"This canvas":"This page"\)\+" has no artboards yet\. Add one, or let the agent add some\."/g;
  for (const match of source.matchAll(emptyCanvas)) changes.push({ start: match.index, end: match.index + match[0].length,
    text: '(globalThis.codexDesignEditorI18n?.t(' + match[1] + '.artboards.length===0?"canvas.emptyCanvasArtboards":"canvas.emptyPageArtboards")??(' + match[0] + '))' });
  const artboardPosition = /return"Artboard "\+String\(([A-Za-z_$][\w$]*)\+1\)\+" of "\+String\(([A-Za-z_$][\w$]*)\)\+": "\+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(artboardPosition)) changes.push({ start: match.index, end: match.index + match[0].length,
    text: 'return(globalThis.codexDesignEditorI18n?.t("canvas.artboardPosition",{index:' + match[1] + '+1,count:' + match[2] + ',title:' + match[3] + '})??(' + match[0].slice(6) + '))' });
  for (const match of source.matchAll(/label:([A-Za-z_$][\w$]*\.n)>0\?(`Comment \$\{\1\}`)/g)) {
    const start = match.index + match[0].indexOf(match[2]);
    changes.push({ start, end: start + match[2].length,
      text: '(globalThis.codexDesignEditorI18n?.t("chrome.commentPin",{count:' + match[1] + '})??' + match[2] + ')' });
  }
  for (const match of source.matchAll(/"aria-label":([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\+", Preview theme"/g)) changes.push({
    start: match.index, end: match.index + match[0].length,
    text: '"aria-label":(globalThis.codexDesignEditorI18n?.t("ds.previewThemeLabel",{name:' + match[1] + '})??(' + match[1] + '+", Preview theme"))',
  });
  const storageUsage = /"Stored alongside the page: "\+String\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)\+\(\1===1\?" file":" files"\)\+" · "\+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)\+" of "\+\2\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\)\+" used"/g;
  for (const match of source.matchAll(storageUsage)) changes.push({ start: match.index, end: match.index + match[0].length,
    text: '(globalThis.codexDesignEditorI18n?.t("ds.storageUsage",{count:' + match[1] + ',used:' + match[2] + '(' + match[3] + '),limit:' + match[2] + '(' + match[4] + ')})??(' + match[0] + '))' });
  const syncWidget = /[A-Za-z_$][\w$]*\.message\?\?\(([A-Za-z_$][\w$]*)==="pending"\?"Syncing…":\1==="error"\?"Couldn’t sync — click to retry":"All changes synced"\)/g;
  for (const match of source.matchAll(syncWidget)) {
    const next = match[0].replace(/"(?:Syncing…|Couldn’t sync — click to retry|All changes synced)"/g, literal => {
      const key = messageKeys.get(JSON.parse(literal));
      return '(globalThis.codexDesignEditorI18n?.t(' + JSON.stringify(key) + ')??' + literal + ')';
    });
    changes.push({ start: match.index, end: match.index + match[0].length, text: next });
  }
  for (const match of source.matchAll(/(\{status:"saving",message:)("Syncing…")/g)) captureLiteral(match);
  // The floating comment list has two complete conditional empty-state labels.
  // Keep these exact UI branches separate from comment status/data enums.
  for (const match of source.matchAll(/(children:[A-Za-z_$][\w$]*\?)("No comments(?: yet)?\.")(:)("No open comments\.")/g)) {
    captureLiteral(match, 2);
    captureLiteral(match, 4);
  }
  for (const match of source.matchAll(/(children:\[[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.at\),[A-Za-z_$][\w$]*&&)(" · Resolved")/g)) captureLiteral(match);
  // Empty list text and cover titles are semantic component props. Arbitrary
  // text fields and image-fit enums named Cover remain untouched.
  for (const match of source.matchAll(/(\b[A-Za-z_$][\w$]*\.jsx\([A-Za-z_$][\w$]*\.EmptyEditorList,\{text:)("No font files yet")/g)) captureLiteral(match);
  for (const match of source.matchAll(/(\b[A-Za-z_$][\w$]*\.jsx\([A-Za-z_$][\w$]*\.StaticPreviewFrame,\{[^{}]{0,500},title:)("Cover")/g)) captureLiteral(match, 2, new Map([['Cover', 'ds.coverPreviewTitle']]));
  // These two complete preview-error sentences are actual UI warning values,
  // not general conditional identifiers such as icon names or model enums.
  for (const key of ['ds.previewNavigated', 'ds.previewScriptFailed']) {
    const literal = JSON.stringify(CHROME_MESSAGES[key]);
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of source.matchAll(new RegExp('(\\?)(' + escaped + ')(?=:)', 'g'))) captureLiteral(match);
  }
  // The shared comment client has two tiny date-label functions. Route only
  // their UI formatting through the selected locale; authored dates/values
  // are not rewritten. Keep their original bodies as compatibility fallbacks.
  const dateHeader = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=new Date\)\{(?=(?:const|let) [^;]+new Date\(\2\);if\(Number\.isNaN)/g;
  for (const match of source.matchAll(dateHeader)) {
    const body = source.slice(match.index + match[0].length, match.index + match[0].length + 430);
    let formatter;
    if (body.includes('toLocaleTimeString("en-US"')) formatter = 'formatCommentTimestamp';
    else if (body.includes('Math.floor') && body.includes('return"now"') && body.includes('toLocaleDateString("en-US"')) formatter = 'formatCommentTime';
    if (!formatter) continue;
    const start = match.index + match[0].length;
    changes.push({ start, end: start,
      text: 'if(globalThis.codexDesignEditorI18n?.' + formatter + ')return globalThis.codexDesignEditorI18n.' + formatter + '(' + match[2] + ',' + match[3] + ');' });
  }
  // Conditional literals are handled only inside the explicit UI properties
  // below. Global `?:` replacement also changes icon names such as
  // name:filled?"CommentFilled":"Comment", breaking the icon-codepoint lookup.
  // Match exact static UI properties in the shipped bundle only. In
  // particular, never patch defaultMessage, name, value, or text properties.
  for (const match of source.matchAll(/(?<![\w$])((?:"aria-label"|label|title|placeholder|description|content|footnote|children|tooltip|tip|disabledTip|disabledReason|confirmLabel|cancelLabel|group|noUndo|noRedo|cancel|save|saves|noSave):)("(?:\\.|[^"\\])*")/g)) captureLiteral(match);
  // Keep conditional rewriting scoped to UI properties. Translating every
  // string named "Table" or "Text" would corrupt export roles and model data.
  for (const match of source.matchAll(new RegExp('(' + STATIC_UI_PROPERTIES + ':)("(?:\\\\.|[^"\\\\])*")', 'g'))) captureLiteral(match, 2, staticKeys);
  for (const match of source.matchAll(new RegExp(STATIC_UI_PROPERTIES + ':([^,;{}]{1,300})', 'g'))) {
    const expressionStart = match.index + match[0].indexOf(':') + 1;
    for (const literal of match[1].matchAll(/"(?:\\.|[^"\\])*"/g)) {
      const synthetic = [literal[0], '', literal[0]];
      synthetic.index = expressionStart + literal.index;
      captureLiteral(synthetic, 2, staticKeys);
    }
  }
  for (const match of source.matchAll(WELCOME_ARRAY)) {
    const expressionStart = match.index + match[0].indexOf('[') + 1;
    for (const literal of match[1].matchAll(/"(?:\\.|[^"\\])*"/g)) {
      const synthetic = [literal[0], '', literal[0]]; synthetic.index = expressionStart + literal.index;
      captureLiteral(synthetic, 2, staticKeys);
    }
  }
  for (const match of source.matchAll(CANVAS_TOOL_LABEL_MAP)) {
    for (const literal of match[0].matchAll(/:("(?:\\.|[^"\\])*")/g)) {
      const synthetic = [literal[1], '', literal[1]]; synthetic.index = match.index + literal.index + 1;
      captureLiteral(synthetic, 2, staticKeys);
    }
  }
  for (const match of source.matchAll(CANVAS_TOOL_BUTTON_LABEL)) captureLiteral(match, 1, staticKeys);
  for (const match of source.matchAll(/(\b(?:label|placeholder|title|description):[A-Za-z_$][\w$]*=)("(?:\\.|[^"\\])*")/g)) captureLiteral(match);
  for (const match of source.matchAll(/([,;]\s*[A-Za-z_$][\w$]*=)("Send to agent")/g)) captureLiteral(match);
  for (const match of source.matchAll(/([,;]\s*[A-Za-z_$][\w$]*=)("(?:\\.|[^"\\])*")/g)) {
    let text; try { text = JSON.parse(match[2]); } catch { continue; }
    if (ASSIGNED_DASHBOARD_CHROME.has(text)) captureLiteral(match);
  }
  const nonoverlapping = [];
  for (const change of changes.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (nonoverlapping.length && change.start < nonoverlapping.at(-1).end) continue;
    nonoverlapping.push(change);
  }
  for (const change of nonoverlapping.reverse()) source = source.slice(0, change.start) + change.text + source.slice(change.end);
  return changes.length === 0 ? source : marker + '\n' + source;
}

export async function adaptEditorLocalization(pluginRoot, { bundlePath } = {}) {
  if (!bundlePath) throw new Error('adaptEditorLocalization requires an already-bundled classic script bundlePath.');
  const bundle = await fs.readFile(bundlePath);
  const bundleDigest = createHash('sha256').update(bundle).digest('hex').slice(0, 16);
  const integrity = data => 'sha384-' + createHash('sha384').update(data).digest('base64');
  const report = {};
  for (const kind of EDITOR_KINDS) {
    const editor = path.join(pluginRoot, 'skills', 'codex-' + kind, 'scripts/editor');
    const assets = path.join(editor, 'assets');
    const sourceFiles = (await fs.readdir(assets)).filter(name => /^index-.*\.js$/.test(name)).map(name => path.join(assets, name));
    const comments = path.join(editor, 'comments.js');
    if (await fs.stat(comments).catch(() => null)) sourceFiles.push(comments);
    if (sourceFiles.length === 0) throw new Error('No compiled editor module found for ' + kind);
    const sources = await Promise.all(sourceFiles.map(file => fs.readFile(file, 'utf8')));
    const catalog = createEditorCatalog(kind, sources);
    if (catalog.coverage.native === 0) throw new Error('Native editor i18n pipeline changed for ' + kind);
    if (catalog.coverage.translatedNative !== catalog.coverage.native) {
      const missing = sources.flatMap(source => [...extractNativeMessages(source).values()]).filter(text => !EDITOR_UI_ZH[text]);
      throw new Error(`Incomplete Chinese UI catalog for ${kind}: ${catalog.coverage.translatedNative}/${catalog.coverage.native}; missing ${JSON.stringify([...new Set(missing)].slice(0, 8))}`);
    }
    const resourceSource = Buffer.from('globalThis.__CODEX_DESIGN_EDITOR_RESOURCES__=' + JSON.stringify(catalog).replaceAll('<', '\\u003c') + ';\n');
    const resourceDigest = createHash('sha256').update(resourceSource).digest('hex').slice(0, 16);
    const resourceName = 'codex-editor-resources-' + resourceDigest + '.js';
    const bundleName = 'codex-editor-localization-' + bundleDigest + '.js';
    for (const name of await fs.readdir(assets)) if (/^codex-editor-(?:resources|localization)-[a-f0-9]+\.js$/.test(name)) await fs.unlink(path.join(assets, name));
    await fs.writeFile(path.join(assets, resourceName), resourceSource);
    await fs.writeFile(path.join(assets, bundleName), bundle);
    const filename = path.join(editor, 'index.html');
    let html = await fs.readFile(filename, 'utf8');
    html = html.replace(/<script\b[^>]*\bdata-codex-editor-i18n(?:-resources)?\b[^>]*><\/script>\s*/g, '');
    const tags = `<script src="./assets/${resourceName}" integrity="${integrity(resourceSource)}" data-codex-editor-i18n-resources></script>\n<script src="./assets/${bundleName}" integrity="${integrity(bundle)}" data-codex-editor-i18n></script>\n`;
    if (!html.includes('<head>')) throw new Error('Missing editor head for ' + kind);
    html = html.replace(/<head>\s*/, '<head>\n' + tags);
    for (let i = 0; i < sourceFiles.length; i++) {
      const patched = repairEditorRuntime(adaptStaticCommentChrome(sources[i]));
      if (patched === sources[i]) continue;
      if (path.dirname(sourceFiles[i]) === assets) {
        // Editor assets are served immutable. A new chrome callsite must get a
        // new URL as well as new bytes, especially Dashboard's grant-free URL.
        const digest = createHash('sha256').update(patched).digest('hex').slice(0, 16);
        const nextName = 'index-codex-' + digest + '.js';
        await fs.writeFile(path.join(assets, nextName), patched);
        html = html.replaceAll('./assets/' + path.basename(sourceFiles[i]), './assets/' + nextName);
        if (path.basename(sourceFiles[i]) !== nextName) await fs.unlink(sourceFiles[i]);
      } else {
        await fs.writeFile(sourceFiles[i], patched);
      }
    }
    await fs.writeFile(filename, html);
    report[kind] = catalog.coverage;
  }
  return report;
}
