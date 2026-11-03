import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { repairEditorRuntime } from './source/scripts/editor-runtime-adapter.mjs';
import { readCommentComponent } from './source/scripts/comment-toolbar-adapter.mjs';
import { adaptNativeHostErrors } from './source/scripts/native-editor-language-adapter.mjs';

export const EDITOR_KINDS = ['slides', 'design', 'design-system', 'dashboard', 'motion'];

// Keep canonical English chrome and compatibility keys. Artwork, comments,
// fonts, and locale-sensitive document code are never rewritten.
const CHROME_MESSAGES = {
  'canvas.emptyCanvasArtboards': 'This canvas has no artboards yet. Add one, or let the agent add some.',
  'canvas.emptyPageArtboards': 'This page has no artboards yet. Add one, or let the agent add some.',
  'canvas.inspectorEmptyTitle': 'Nothing selected',
  'canvas.inspectorEmptyHint': 'Click any element in the design to edit it here.',
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

const CDS_MESSAGES = {
  back: 'Back', close: 'Close', loading: 'Loading', clear: 'Clear', dismiss: 'Dismiss',
  confirm: 'Confirm', cancel: 'Cancel', moreOptions: 'More options',
  scrollBack: 'Scroll back', scrollForward: 'Scroll forward', opensInNewTab: '(opens in new tab)',
  removeItem: 'Remove {item}', clearSelection: 'Clear selection', loadingOptions: 'Loading options',
  loadingMoreOptions: 'Loading more options', selectAll: 'Select all', sequenceThen: 'then',
  avatarGroup: '{count} {noun}', overflowCount: 'and {count} more',
};

// Upstream 2.7.1 includes both old Export and new Share wording under these
// exact two IDs. Native Codex retains its Export menu; other conflicts must
// still stop the build instead of choosing an arbitrary translation.
const REVIEWED_MESSAGE_VARIANTS = {
  j5PBn2aWFZ: [
    'No artboard was chosen in time, so the export was cancelled. Open Export to export again.',
    'No artboard was chosen in time, so the export was cancelled. Open Share to export again.',
  ],
  pYPDbUJ2RQ: [
    'Leaving that view cancelled the export. Open Export to export again.',
    'Leaving that view cancelled the export. Open Share to export again.',
  ],
};

// Adapt only reviewed host-operation messages; keep IDs, original defaults,
// protocol names, brand examples and authored artwork bytes unchanged.
export const NATIVE_HOST_MESSAGE_OVERRIDES = Object.freeze({
  BNC1wrrvvB: {
    sources: [
      'Sign in to Claude to see this content, then reload the page. If you’re already signed in, you might not have access to it.',
      'Sign in to see this content, then reload the page. If you’re already signed in, you might not have access to it.',
      'You might not have access to this content. Reload the page to try again.',
    ],
    message: 'This artwork could not be loaded. Reopen it in Codex Design and check that its local files are available.',
  },
  oeBy29hnwL: {
    sources: ['claude', 'slidesHost', 'designHost', 'designSystemHost'].map(host => `This view’s runtime does not offer self-publish (window.${host}.self is absent) — content can be viewed but not saved from here.`),
    message: 'Saving is unavailable in this view. Reopen the artwork in Codex Design to reconnect local editing.',
  },
  aKvb9N4RA6: {
    sources: ['Couldn’t prepare this design to send: the design contains what looks like a live Claude Design access link, which cannot be sent.'],
    message: 'Couldn’t prepare this design to send: the design contains what looks like a private editor access link, which cannot be sent.',
  },
  OcwDW1DfuT: {
    sources: ['This copy of Claude is out of date. Reload or reopen it, then export again.'],
    message: 'This view could not save the requested video format. Reopen the artwork in Codex Design and try the export again.',
  },
  W1u6GkazZ0: {
    sources: ['Press Save video. If that fails, reload Claude and export again.'],
    message: 'Press Save video to choose a local destination. If that fails, reopen this artwork in Codex Design and export again.',
  },
  WQZQZTd1Yn: {
    sources: ['If it keeps failing, reload Claude and export again, which renders the video from the start. If that fails too, try again later.'],
    message: 'If saving keeps failing, reopen this artwork in Codex Design and export again. The export renders the video from the start.',
  },
  'RcLB4R+/kt': {
    sources: ['Content credentials record that a video was made with Claude, and a MOV can’t be saved without them.'],
    message: 'Transparent MOV export is unavailable in this local editor. Choose MP4 or GIF instead.',
  },
});

function localHostMessage(id, original) {
  const reviewed = NATIVE_HOST_MESSAGE_OVERRIDES[id];
  if (!reviewed) return original;
  if (!reviewed.sources.includes(original)) throw new Error('Unreviewed native host message variant: ' + id);
  return reviewed.message;
}

function compatibleMessage(id, previous, message) {
  if (previous === undefined || previous === message) return message;
  const reviewed = REVIEWED_MESSAGE_VARIANTS[id];
  if (!reviewed || !reviewed.includes(previous) || !reviewed.includes(message)) throw new Error('Conflicting native editor message ID: ' + id);
  return reviewed[0];
}

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
      result.set(id, compatibleMessage(id, result.get(id), message));
    }
  });
  return result;
}


export function createEditorCatalog(kind, sources) {
  const messages = new Map();
  for (const source of sources) for (const [id, text] of extractNativeMessages(source)) {
    messages.set(id, compatibleMessage(id, messages.get(id), text));
  }
  const english = Object.fromEntries([...messages].map(([id, original]) => [id, localHostMessage(id, original)]));
  for (const [key, text] of Object.entries(CDS_MESSAGES)) english['cds.' + key] = text;
  Object.assign(english, CHROME_MESSAGES);
  return { kind, language: 'en', resources: { en: { editor: english } },
    coverage: { native: messages.size, englishNative: messages.size } };
}

// Retained as an explicit compatibility no-op: English-only releases do not
// replace literal UI text, conditional icon identities, or authored strings.
export const adaptStaticCommentChrome = source => source;

const fontDecoderMarker = '/* codex-design:standalone-font-decoder-v1 */';
const fontDecoderInterop = Object.freeze({
  // Exact pure Rollup interop helpers exported by the reviewed 2.7.1 editor.
  // Copy their actual bytes; a different implementation needs fresh review.
  g: '72fdb259328cfca8d59ecef46cdfb3a2c777d1e0d2e22a4eba30961e13ec1b2f',
  a: '2bca1e2d80cc6cdc51ed51364489f97bff8149646a2943ce798ca34d7bacd8d7',
});

/** Remove only the reviewed decoder's circular import of two pure helpers. */
export function standaloneFontDecoder(editorSource, decoderSource, entryName) {
  if (typeof decoderSource !== 'string') throw new Error('The packaged font decoder is not text.');
  if (decoderSource.startsWith(fontDecoderMarker)) return decoderSource;
  if (typeof editorSource !== 'string' || !/^index-[A-Za-z0-9_-]+\.js$/.test(entryName)) throw new Error('The font decoder editor entry changed.');
  const decoder = decoderSource.replaceAll('\r\n', '\n');
  const entry = editorSource.replaceAll('\r\n', '\n');
  const imported = /^import\{g as ([\w$]+),a as ([\w$]+)\}from"(\.\/[^"\\]+)";/.exec(decoder);
  const exports = /\bexport\{([^}]+)\};?\s*$/.exec(entry);
  if (!imported || imported[3] !== './' + entryName || !exports) throw new Error('The canonical font decoder dependency changed; adaptation was refused.');
  const bindings = new Map(exports[1].split(',').map(part => {
    const match = /^([\w$]+) as ([\w$]+)$/.exec(part.trim());
    if (!match) throw new Error('The font decoder interop export changed.');
    return [match[2], match[1]];
  }));
  if (bindings.size !== 2 || [...bindings.keys()].some(name => !Object.hasOwn(fontDecoderInterop, name))) throw new Error('The font decoder interop exports changed.');
  const helpers = ['g', 'a'].map((name, index) => {
    const symbol = bindings.get(name)?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const definition = symbol && readCommentComponent(entry, new RegExp(`function (${symbol})\\([^)]*\\)\\{`));
    if (!definition || createHash('sha256').update(definition.text).digest('hex') !== fontDecoderInterop[name]) throw new Error('The reviewed font decoder interop helper changed: ' + name);
    return `const ${imported[index + 1]}=(${definition.text});`;
  });
  const body = decoder.slice(imported[0].length);
  if (/\bimport\s*(?:[({"']|\.)/.test(body)) throw new Error('The font decoder acquired another module dependency.');
  return fontDecoderMarker + '\n' + helpers.join('\n') + '\n' + body;
}

async function adaptFontDecoderAssets(assets, sourceFiles, sources) {
  const decoders = (await fs.readdir(assets)).filter(name => /^woff2-decoder-[A-Za-z0-9_-]+\.js$/.test(name));
  const replacements = [];
  for (const name of decoders) {
    const original = await fs.readFile(path.join(assets, name), 'utf8');
    if (original.startsWith(fontDecoderMarker)) continue;
    const imported = /^import\{g as [\w$]+,a as [\w$]+\}from"\.\/([^"\\]+)";/.exec(original);
    const at = imported ? sourceFiles.findIndex(file => path.basename(file) === imported[1]) : -1;
    if (at < 0) throw new Error('The packaged font decoder entry is missing or changed.');
    const standalone = standaloneFontDecoder(sources[at], original, imported[1]);
    const next = 'woff2-decoder-codex-' + createHash('sha256').update(standalone).digest('hex').slice(0, 16) + '.js';
    const dependency = `import("./${name}")`;
    if (sources[at].split(dependency).length !== 2) throw new Error('The canonical font decoder loader changed; adaptation was refused.');
    sources[at] = sources[at].replace(dependency, `import("./${next}")`);
    await fs.writeFile(path.join(assets, next), standalone);
    if (next !== name) await fs.unlink(path.join(assets, name));
    replacements.push([name, next]);
  }
  if (!decoders.length && sources.some(source => /import\(["']\.\/woff2-decoder-/.test(source))) throw new Error('The packaged font decoder file is missing.');
  return replacements;
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
    if (kind === 'motion') await fs.mkdir(assets, { recursive: true });
    const sourceFiles = kind === 'motion'
      ? [path.join(editor, 'artifact-type/app.js'), path.join(editor, 'local-host.js')]
      : (await fs.readdir(assets)).filter(name => /^index-.*\.js$/.test(name)).map(name => path.join(assets, name));
    const comments = path.join(editor, 'comments.js');
    if (await fs.stat(comments).catch(() => null)) sourceFiles.push(comments);
    if (sourceFiles.length === 0) throw new Error('No compiled editor module found for ' + kind);
    const originalSources = await Promise.all(sourceFiles.map(file => fs.readFile(file, 'utf8')));
    const sources = [...originalSources];
    const decoderReplacements = await adaptFontDecoderAssets(assets, sourceFiles, sources);
    const catalog = createEditorCatalog(kind, sources);
    if (catalog.coverage.native === 0) throw new Error('Native editor i18n pipeline changed for ' + kind);
    const resourceSource = Buffer.from('globalThis.__CODEX_DESIGN_EDITOR_RESOURCES__=' + JSON.stringify(catalog).replaceAll('<', '\\u003c') + ';\n');
    const resourceDigest = createHash('sha256').update(resourceSource).digest('hex').slice(0, 16);
    const resourceName = 'codex-editor-resources-' + resourceDigest + '.js';
    const bundleName = 'codex-editor-localization-' + bundleDigest + '.js';
    for (const name of await fs.readdir(assets)) if (/^codex-editor-(?:resources|localization)-[a-f0-9]+\.js$/.test(name)) await fs.unlink(path.join(assets, name));
    await fs.writeFile(path.join(assets, resourceName), resourceSource);
    await fs.writeFile(path.join(assets, bundleName), bundle);
    const filename = path.join(editor, 'index.html');
    let html = await fs.readFile(filename, 'utf8');
    for (const [previous, next] of decoderReplacements) html = html.replaceAll('./assets/' + previous, './assets/' + next);
    html = html.replace(/<script\b[^>]*\bdata-codex-editor-i18n(?:-resources)?\b[^>]*><\/script>\s*/g, '');
    const tags = `<script src="./assets/${resourceName}" integrity="${integrity(resourceSource)}" data-codex-editor-i18n-resources></script>\n<script src="./assets/${bundleName}" integrity="${integrity(bundle)}" data-codex-editor-i18n></script>\n`;
    if (!html.includes('<head>')) throw new Error('Missing editor head for ' + kind);
    html = html.replace(/<head>\s*/, '<head>\n' + tags);
    for (let i = 0; i < sourceFiles.length; i++) {
      const patched = repairEditorRuntime(adaptNativeHostErrors(sources[i]));
      if (patched === originalSources[i]) continue;
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
