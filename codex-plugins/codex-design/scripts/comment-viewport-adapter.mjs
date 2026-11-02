import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-comment-viewport */';
const viewportEvent = 'codex-design:comment-viewport-changed';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const popoverPattern = /function ([\w$]+)\(\{pin:[\w$]+,win:([\w$]+),onEscape:[\w$]+,children:[\w$]+\}\)\{/;
const listPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:[\w$]+,dark:[\w$]+,top:([\w$]+),onClose:[\w$]+\}\)\{/;

// These helpers are serialized with the canonical comment bundle. They only
// calculate UI geometry; they never inspect a preview or alter a saved anchor.
export function nativeCommentBottom(win) {
  const bottom = win.__CODEX_DESIGN_EDITOR_TRANSPORT__?.commentViewport?.bottom;
  return typeof bottom === 'number' && Number.isFinite(bottom) && bottom >= 0 ? bottom : 72;
}

export function nativeCommentPopoverStyle(win, top, margin, height) {
  const available = Math.max(0, win.innerHeight - nativeCommentBottom(win) - margin * 2);
  const visibleHeight = Math.min(height, available);
  return {
    top: Math.max(win.scrollY + margin, Math.min(top, win.scrollY + win.innerHeight - nativeCommentBottom(win) - margin - visibleHeight)),
    maxHeight: available,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  };
}

export function nativeCommentListStyle(win, top, margin) {
  return { maxHeight: Math.max(0, win.innerHeight - nativeCommentBottom(win) - top - margin) };
}

/** Limit only native comment cards/lists; retain canonical pins and HTTP UI. */
export function adaptCommentViewport(source) {
  if (source.includes(marker)) return source;
  const popover = readCommentComponent(source, popoverPattern);
  const list = readCommentComponent(source, listPattern);
  if (!popover && !list) return source;
  if (!popover || !list) throw new Error('The canonical comment viewport components are incomplete; adaptation was refused.');
  const win = popover.match[2];
  const clamp = new RegExp(`([\\w$]+)=Math\\.max\\(([\\w$]+)\\+([\\w$]+),Math\\.min\\(\\1,\\2\\+${escape(win)}\\.innerHeight-\\3-([\\w$]+)\\)\\)`);
  const bounds = clamp.exec(popover.text);
  if (!bounds) throw new Error('The canonical comment card clamp changed; adaptation was refused.');
  const [_, top, scrollY, margin, height] = bounds;
  const style = new RegExp(`top:${escape(top)},width:([\\w$]+),`);
  let changed = 0;
  const popoverText = popover.text.replace(style, match => {
    changed++;
    return `${match}...${native}?__codexCommentPopoverStyle(${win},${top},${margin},${height}):{},`;
  }).replace(/ref:([\w$]+),style:/, `"data-codex-comment-popover":${native}?"":void 0,ref:$1,style:`);
  if (changed !== 1 || !popoverText.includes('"data-codex-comment-popover"')) throw new Error('The canonical comment card style changed; adaptation was refused.');
  const listHeight = /maxHeight:`calc\(100dvh - \$\{([\w$]+)\+([\w$]+)\}px\)`/;
  const listBounds = listHeight.exec(list.text);
  if (!listBounds || listBounds[1] !== list.match[3]) throw new Error('The canonical comment list height changed; adaptation was refused.');
  const listText = list.text.replace(listHeight, match => `${match},...${native}?__codexCommentListStyle(${list.match[2]}.win,${listBounds[1]},${listBounds[2]}):{}`)
    .replace('"data-baoyu-comments-panel":""', `"data-baoyu-comments-panel":"","data-codex-comment-list-viewport":${native}?"":void 0`);

  // Reuse the root's existing batched scroll/resize subscription and cleanup.
  // A private UI event requests the same render without fabricating a resize.
  const candidates = [...source.matchAll(/function ([\w$]+)\(([\w$]+)\)\{(?:const|let)\[,[\w$]+\]=(?:(?:[\w$]+\.useState)|(?:\(0,[\w$]+\.useState\)))\(0\);/g)];
  const listeners = candidates.map(match => readCommentComponent(source, new RegExp(`function (${escape(match[1])})\\([\\w$]+\\)\\{`)))
    .filter(part => part.text.includes('addEventListener("scroll"') && part.text.includes('addEventListener("resize"'));
  if (listeners.length !== 1) throw new Error('The canonical comment viewport subscription changed; adaptation was refused.');
  const listener = listeners[0];
  let added = 0, removed = 0;
  const listenerText = listener.text.replace(/([\w$]+)\.addEventListener\("resize",([\w$]+)\)/g, (match, target, callback) => {
    added++;
    return `${match},${native}&&${target}.addEventListener("${viewportEvent}",${callback})`;
  }).replace(/([\w$]+)\.removeEventListener\("resize",([\w$]+)\)/g, (match, target, callback) => {
    removed++;
    return `${match},${native}&&${target}.removeEventListener("${viewportEvent}",${callback})`;
  });
  if (added !== 1 || removed !== 1) throw new Error('The canonical comment viewport lifecycle changed; adaptation was refused.');
  for (const part of [{ ...popover, replacement: popoverText }, { ...list, replacement: listText }, { ...listener, replacement: listenerText }].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  }
  const helpers = [nativeCommentBottom, nativeCommentPopoverStyle, nativeCommentListStyle].map(fn => fn.toString()
    .replace(/\bnativeCommentBottom\b/g, '__codexCommentBottom')
    .replace(/\bnativeCommentPopoverStyle\b/g, '__codexCommentPopoverStyle')
    .replace(/\bnativeCommentListStyle\b/g, '__codexCommentListStyle')).join('\n');
  return marker + '\n' + helpers + '\n' + source;
}
