import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-comment-drafts */';
const rowPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+),current:[\w$]+\}\)\{/;
const threadPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+)\}\)\{/;
const composerPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,win:[\w$]+,pinSide:[\w$]+\}\)\{/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A delivered transport envelope does not prove that an agent started work. */
export function nativeCommentPresentation(thread) {
  const request = thread?.agent?.nativeRequest;
  const replied = thread?.messages?.at(-1)?.author?.kind === 'agent';
  if (!request) {
    if (!thread?.agent) return null;
    if (replied) return { status: 'completed', label: 'Completed', activity: false };
    return { status: 'needs_attention', label: 'Needs attention', activity: thread.status === 'open',
      message: 'This comment has no confirmed native chat request. Add it to chat to continue.' };
  }
  const status = request.status;
  const message = typeof request.message === 'string' ? request.message.trim() : '';
  const activity = thread.status === 'open';
  switch (status) {
    case 'draft_ready': return { status, label: 'Ready to add to chat', message, activity };
    case 'prepared': return { status, label: 'Added to chat', message, activity };
    case 'accepted': return { status, label: 'Waiting for the agent', message, activity };
    case 'queued': return { status, label: 'Queued', message, activity };
    case 'working': return { status, label: 'Working…', message: message || request.phase || '', working: 'working', activity };
    case 'completed': return replied ? { status, label: 'Completed', activity: false }
      : { status: 'needs_attention', label: 'Needs attention', activity,
        message: message || 'The completed request has no saved agent reply.' };
    case 'failed': return { status, label: 'Failed', activity,
      message: message || 'The request failed. Add the comment to chat again to retry.' };
    case 'superseded': return { status, label: 'Draft replaced', activity,
      message: message || 'A newer draft replaced this request.' };
    default: return { status: 'needs_attention', label: 'Needs attention', activity,
      message: message || 'The request needs attention. Add the comment to chat again to retry.' };
  }
}

/** Match normal comment eligibility while allowing a failed native draft to retry. */
export function nativeCommentCanAdd(thread) {
  const last = thread?.messages?.at(-1);
  if (thread?.status !== 'open' || last?.author?.kind !== 'user') return false;
  const request = thread.agent?.nativeRequest;
  const status = nativeCommentPresentation(thread)?.status;
  if (!request || ['draft_ready', 'prepared', 'failed', 'needs_attention', 'superseded'].includes(status)) return true;
  const sentAt = thread.agent.sentAt ?? request.sentAt;
  return typeof sentAt === 'string' && (last.editedAt ?? last.at) > sentAt;
}

export function nativeCommentActions(controller, thread, state) {
  if (!controller.agentAvailable() || state.busy[thread.id] || !nativeCommentCanAdd(thread)) return [];
  const presentation = nativeCommentPresentation(thread);
  const retry = ['failed', 'needs_attention'].includes(presentation?.status);
  return [{ label: retry ? 'Retry add to chat' : presentation?.status === 'prepared' ? 'Add again to chat' : 'Add to chat', icon: 'ArrowUp',
    onSelect: () => controller.act(thread.id, () => controller.request('/' + encodeURIComponent(thread.id) + '/send', 'POST')) }];
}

function replaceRequired(source, pattern, replacement, count, label) {
  let changed = 0;
  const result = source.replace(pattern, (...args) => { changed++; return typeof replacement === 'function' ? replacement(...args) : replacement; });
  if (changed !== count) throw new Error(`The canonical ${label} anchor changed; native comment adaptation was refused.`);
  return result;
}

function addActions(text, component) {
  const [, , controller, state, thread] = component.match;
  return replaceRequired(text, /items:([\w$]+)(?=\})/g,
    (_, items) => `items:${native}?[...${items},...__codexNativeCommentActions(${controller},${thread},${state})]:${items}`, 1, 'comment action menu');
}

function addPresentation(text, component) {
  return text.replace(component.match[0], component.match[0] + `const __codexComment=${native}?__codexNativeCommentPresentation(${component.match[4]}):null;`);
}

/** Adapt the verified shared components in all four shipped editors, leaving HTTP previews canonical. */
export function adaptCommentDrafts(source) {
  if (source.includes(marker)) return source;
  const row = readCommentComponent(source, rowPattern);
  const thread = readCommentComponent(source, threadPattern);
  const composer = readCommentComponent(source, composerPattern);
  if (!row && !thread && !composer) {
    if (/agentAvailable\(\)\{return this\.state\.status===/.test(source)) {
      throw new Error('The canonical comment components changed; native comment adaptation was refused.');
    }
    return source;
  }
  if (!row || !thread || !composer) throw new Error('The canonical comment components are incomplete; native comment adaptation was refused.');
  const label = /label:([\w$]+),checked:/.exec(thread.text)?.[1];
  if (!label || !new RegExp(`\\b${escape(label)}="Send to agent"`).test(source)) {
    throw new Error('The canonical send-to-agent label changed; native comment adaptation was refused.');
  }
  let rowText = addActions(addPresentation(row.text, row), row);
  rowText = replaceRequired(rowText, /label:"Send to agent"/g, `label:${native}?"Add to chat":"Send to agent"`, 1, 'comment edit label');
  rowText = replaceRequired(rowText, /"aria-label":"Sent to agent"/g,
    `"aria-label":${native}?(__codexComment?.label??"Added to chat"):"Sent to agent"`, 1, 'comment sent indicator');
  const jsx = /((?:[\w$]+\.jsx|\(0,[\w$]+\.jsx\)))\(/.exec(row.text)?.[1];
  if (!jsx) throw new Error('The canonical comment JSX runtime changed; native comment adaptation was refused.');
  rowText = replaceRequired(rowText, /,([\w$]+)>0&&!([\w$]+)&&!([\w$]+)&&/g,
    (_, replies, editing, deleting) => `,${native}&&__codexComment&&${jsx}("span",{role:"status","data-codex-comment-status":__codexComment.status,className:"text-caption text-muted",children:__codexComment.label+(__codexComment.message?": "+__codexComment.message:"")}),${replies}>0&&!${editing}&&!${deleting}&&`, 1, 'comment list status');
  let threadText = addActions(addPresentation(thread.text, thread), thread);
  const labels = new RegExp(`label:${escape(label)},checked:`, 'g');
  threadText = replaceRequired(threadText, labels, `label:${native}?"Add to chat":${label},checked:`, 2, 'comment reply/edit labels');
  const pending = /([\w$]+)=([\w$]+)==="pending"\?"queued":\2==="delivered"\?"working":void 0/.exec(threadText);
  if (!pending) throw new Error('The canonical comment delivery state changed; native comment adaptation was refused.');
  const activity = pending[1];
  threadText = threadText.replace(pending[0], `${activity}=${native}?(__codexComment?.activity?__codexComment:void 0):(${pending[0].slice(activity.length + 1)})`);
  threadText = replaceRequired(threadText, new RegExp(`working:${escape(activity)},footnote:(${escape(activity)}==="queued"\\?"Waiting for the agent":"Working(?:…|\\\\u2026)")`, 'g'),
    (_, footnote) => `working:${native}?__codexComment.working:${activity},footnote:${native}?__codexComment.label+(__codexComment.message?": "+__codexComment.message:""):${footnote}`, 1, 'comment activity label');
  const composerText = replaceRequired(composer.text, labels, `label:${native}?"Add to chat":${label},checked:`, 1, 'new comment label');
  for (const part of [{ ...row, replacement: rowText }, { ...thread, replacement: threadText }, { ...composer, replacement: composerText }].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  }
  source = replaceRequired(source, /agentAvailable\(\)\{return /g,
    `agentAvailable(){if(${native}?.canDraftComments===false)return false;return `, 1, 'native draft capability');
  // Names are deliberately private to this adapted bundle, not window state.
  const helpers = [nativeCommentPresentation, nativeCommentCanAdd, nativeCommentActions].map(fn => fn.toString()
    .replace(/\bnativeCommentPresentation\b/g, '__codexNativeCommentPresentation')
    .replace(/\bnativeCommentCanAdd\b/g, '__codexNativeCommentCanAdd')
    .replace(/\bnativeCommentActions\b/g, '__codexNativeCommentActions')).join('\n');
  return marker + '\n' + helpers + '\n' + source;
}
