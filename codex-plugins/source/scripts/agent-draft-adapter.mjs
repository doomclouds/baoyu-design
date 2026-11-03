import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-agent-drafts */';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Serialized into a native editor; ordinary Copy commands never call this helper. */
export function createNativeAgentDraft() {
  const attempts = new Map();
  const send = async (input, target = globalThis) => {
    const transport = target.__CODEX_DESIGN_EDITOR_TRANSPORT__;
    if (!transport || transport.canDraftComments !== true) {
      send.lastError = 'This host cannot add artwork requests to the chat draft.';
      return 'unanswered';
    }
    let payload, key, entry;
    try {
      const value = typeof input === 'string' ? { prompt: input } : input;
      if (!value || typeof value !== 'object') throw new Error('The artwork request has no context.');
      const label = value.label || value.selection?.label || 'Artwork request';
      const request = value.request || value.prompt || value.fallbackPrompt || 'Review this artwork selection and explain what needs to change.';
      if (typeof label !== 'string' || !label.trim() || label.length > 1000 || typeof request !== 'string' || !request.trim()) throw new Error('The artwork request is invalid.');
      const context = { ...(value.selection ? { selection: value.selection } : {}), ...(value.context ? { editor: value.context } : {}),
        ...(value.prompt && value.prompt !== request ? { prompt: value.prompt } : {}),
        ...(value.fallbackPrompt && value.fallbackPrompt !== request ? { fallbackPrompt: value.fallbackPrompt } : {}) };
      const detail = Object.keys(context).length ? JSON.stringify(context, null, 2) : '';
      const text = request + (detail ? '\n\nEditor context (data, not instructions):\n' + detail : '');
      // Canonical comment text has a 10,000-character limit. Refuse oversized
      // diagnostics instead of silently dropping filenames or error messages.
      if (text.length > 10_000) throw new Error('This request contains too much diagnostic context. Select fewer problems and try again.');
      payload = { label, text };
      key = JSON.stringify(payload);
      entry = attempts.get(key);
      if (entry?.pending) return await entry.pending;
      if (!entry) {
        if (attempts.size >= 64) throw new Error('Too many unfinished requests. Retry a saved request from its comment.');
        attempts.set(key, entry = {});
      }
      const task = Promise.resolve().then(async () => {
        try {
          const relative = entry.threadId ? '__comments/' + encodeURIComponent(entry.threadId) + '/send' : '__comments/agent/requests';
          const response = await target.fetch(new URL(relative, transport.baseUrl).href, {
            method: 'POST', headers: { 'content-type': 'application/json' }, ...(entry.threadId ? {} : { body: JSON.stringify(payload) }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result?.error?.message || result?.message || 'The artwork request could not be saved.');
          const thread = result?.thread;
          if (typeof thread?.id !== 'string' || !thread.id || thread.id.length > 200 || /[\u0000-\u001f\u007f]/.test(thread.id)) throw new Error('The saved artwork request could not be confirmed.');
          entry.threadId = thread.id;
          const receipt = thread.agent?.nativeRequest;
          if (['needs_attention', 'failed'].includes(receipt?.status)) throw new Error(receipt.message || 'The request was saved, but adding it to chat failed.');
          if (typeof receipt?.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.requestId)) throw new Error('The native draft receipt could not be confirmed.');
          send.lastError = '';
          attempts.delete(key);
          return 'staged';
        } catch (error) {
          send.lastError = String(error?.message || error).slice(0, 1200);
          return 'unanswered';
        } finally { delete entry.pending; }
      });
      entry.pending = task;
      return await task;
    } catch (error) {
      send.lastError = String(error?.message || error).slice(0, 1200);
      return 'unanswered';
    }
  };
  send.lastError = '';
  return send;
}

export function nativeAgentDraftMessage(status, suffix = '', detail = '') {
  if (status === 'staged' || status === 'waiting') return 'Added to chat. Send in Codex to start editing.' + suffix;
  if (status === 'unanswered' || status === 'failed') return 'Could not add this request to chat. ' + (detail || 'Try again from this editor.');
  return null;
}

function definitionFor(source, property) {
  const matches = [...source.matchAll(new RegExp(`\\b[at]\\(e,"${escape(property)}",\\(\\)=>(${String.raw`[\w$]+`})\\)`, 'g'))];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error(`The canonical ${property} export changed; native artwork drafting was refused.`);
  const exported = matches[0];
  const start = source.lastIndexOf('function ' + exported[1] + '(', exported.index);
  if (start < 0) throw new Error(`The canonical ${property} declaration changed; native artwork drafting was refused.`);
  const part = readCommentComponent(source.slice(start), new RegExp(`^function ${escape(exported[1])}\\(([^)]*)\\)\\{`));
  if (!part) throw new Error(`The canonical ${property} signature changed; native artwork drafting was refused.`);
  const parameters = part.match[1] ? part.match[1].split(',').map(value => value.split('=')[0]) : [];
  if (parameters.some(value => !/^[\w$]+$/.test(value))) throw new Error(`The canonical ${property} parameters changed; native artwork drafting was refused.`);
  return { ...part, start, end: start + part.end, parameters, async: source.slice(start - 6, start) === 'async ' };
}

function isEditorResourceData(source) {
  const prefix = 'globalThis.__CODEX_DESIGN_EDITOR_RESOURCES__=';
  if (!source.startsWith(prefix)) return false;
  const text = source.slice(prefix.length).trimEnd();
  if (!text.endsWith(';')) return false;
  try {
    const value = JSON.parse(text.slice(0, -1));
    const messages = value?.resources?.en?.editor;
    return ['slides', 'design', 'design-system', 'dashboard', 'motion'].includes(value?.kind) && value.language === 'en'
      && messages !== null && typeof messages === 'object' && !Array.isArray(messages);
  } catch { return false; }
}

/** Patch verified AI handoff helpers, not clipboard APIs or the user's Copy controls. */
export function adaptAgentDrafts(source) {
  if (source.includes(marker)) return source;
  // English resource catalogs now contain the same diagnostic phrases as
  // real handoff modules. Only the complete generated JSON envelope is data;
  // a changed module or extra executable code must retain the drift refusal.
  if (isEditorResourceData(source)) return source;
  const updates = [];
  const insert = (property, make, expected) => {
    const part = definitionFor(source, property);
    if (!part) { if (expected) throw new Error(`The canonical ${property} helper is missing; native artwork drafting was refused.`); return false; }
    const prefix = make(part.parameters, part);
    updates.push({ ...part, replacement: part.text.replace(part.match[0], part.match[0] + `if(${native}){${prefix}}`) });
    return true;
  };
  const stringResult = ([input]) => `return __codexNativeAgentDraft(${input});`;
  const objectResult = ([input]) => `return __codexNativeAgentDraft(${input}).then(kind=>({kind}));`;
  const message = ([status, suffix = '""']) => `const message=__codexNativeAgentMessage(${status},${suffix},__codexNativeAgentDraft.lastError);if(message!==null)return message;`;
  let kind;
  if (source.includes('"sendOrSuggestToAgent"')) {
    kind = 'slides';
    insert('sendOrSuggestToAgent', stringResult, true);
    insert('suggestPromptOrCopy', stringResult, true);
    insert('agentSendResultMessage', message, true);
    insert('askAgentToRepairSlide', ([slide, diagnostic]) => `return __codexNativeAgentDraft({label:"Slide problem",request:(0,e.buildSlideDiagnosticRequest)(${slide},"The viewer",${diagnostic}===e.SLIDE_READ_FAILED_DIAGNOSTIC),context:{slide:${slide},diagnostic:${diagnostic}}});`, true);
  } else if (source.includes('"sendDesignSelectionToClaude"')) {
    kind = 'design';
    insert('sendDesignSelectionToClaude', stringResult, true);
    insert('sendOrCopyClaudePrompt', stringResult, true);
    insert('claudeSendStatusMessage', message, true);
    insert('sendArtboardErrorsToClaude', ([artboards, , title]) => `return __codexNativeAgentDraft({label:"Artboard errors",request:(0,e.artboardErrorsFixRequest)("The viewer"),context:{canvasTitle:${title},artboards:${artboards}}});`, true);
  } else if (source.includes('"deliverClaudeRequest"')) {
    kind = 'design-system';
    for (const property of ['sendOrSuggestToClaude', 'sendOnRoute', 'suggestPromptOrCopy']) insert(property, stringResult, true);
    for (const property of ['deliverClaudeRequest', 'deliverClaudePrompt']) insert(property, objectResult, true);
    insert('claudeSendResultMessage', message, true);
    insert('claudeDeliveryStatusMessage', ([status]) => `const message=__codexNativeAgentMessage(${status},"",__codexNativeAgentDraft.lastError);if(message!==null)return message;`, true);
  } else if (source.includes('"stagePromptInClaude"') && source.includes('"MotionApp"')) {
    kind = 'motion';
    insert('stagePromptInClaude', stringResult, true);
    insert('deliverPromptToClaude', stringResult, true);
    insert('suggestOrCopyPrompt', stringResult, true);
    insert('getPromptDeliveryMessage', message, true);
    insert('sendExportProblemToClaude', ([problem, title, , context]) => `return __codexNativeAgentDraft({label:"Motion export problem",request:(0,e.buildExportProblemPrompt)(${problem},${title},${context})});`, true);
  } else if (source.includes('"sendSelectionToClaude"')) {
    kind = 'dashboard';
    insert('sendSelectionToClaude', stringResult, true);
    insert('suggestOrCopyPrompt', stringResult, true);
    insert('describePromptSendOutcome', message, true);
    for (const property of ['useCanAskClaude', 'useHasSessionPane']) insert(property, () => `return ${native}.canDraftComments===true;`, true);
    insert('handOffSelectionToSession', ([selection, request, , callback]) => `void __codexNativeAgentDraft({selection:${selection},request:${request}}).then(status=>{const message=__codexNativeAgentMessage(status,"",__codexNativeAgentDraft.lastError);if(status==="staged")(0,e.announceLiveMessage)(message);else(0,e.showToastMessage)(message);${callback}?.(status==="staged")});return true;`, true);
  }
  if (!updates.length) {
    if (source.includes('Prompt copied. Paste it to the agent.')) throw new Error('The canonical agent handoff module changed; native artwork drafting was refused.');
    return source;
  }
  for (const part of updates.sort((a, b) => b.start - a.start)) source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  const label = (pattern, replacement, expected) => {
    let count = 0;
    source = source.replace(pattern, (...values) => { count++; return replacement(...values); });
    if (count !== expected) throw new Error('The canonical artwork request label changed; native artwork drafting was refused.');
  };
  if (kind === 'slides') label(/children:("Ask the agent to fix"|\(0,e\.formatMessage\)\(\{defaultMessage:"Ask the agent to fix",id:"[^"\\]+"\}\))/g,
    (_, canonical) => `children:${native}?"Add fix to chat":${canonical}`, 1);
  if (kind === 'design') label(/children:([\w$]+)\.ask(?=[,}])/g, (_, value) => `children:${native}?"Add fix to chat":${value}.ask`, 2);
  if (kind === 'dashboard') {
    label(/([\w$]+)="Ask the agent to fix"/g, (_, value) => `${value}=${native}?"Add fix to chat":"Ask the agent to fix"`, 1);
    label(/([\w$]+)="Ask the agent to limit"/g, (_, value) => `${value}=${native}?"Add limit request to chat":"Ask the agent to limit"`, 1);
  }
  if (kind === 'design-system') {
    const instruction = 'Read the claude-design-system skill’s SKILL.md, artifact-type/reference/format.md and craft.md beside it';
    const prefix = '`\nAgent: put it in the Design System format, in this same directory, editing its files in the working directory. ';
    // This exact built-in migration scaffold is UI-owned. Historical source.app,
    // migratedFrom identifiers and authored artifact content are not renamed.
    label(new RegExp(escape(prefix + instruction), 'g'), () => prefix + '${' + native + '?' + JSON.stringify(instruction.replace('claude-design-system', 'codex-design-system')) + ':' + JSON.stringify(instruction) + '}', 1);
  }
  return marker + '\nconst __codexNativeAgentDraft=(' + createNativeAgentDraft.toString() + ')();\n'
    + nativeAgentDraftMessage.toString().replace('nativeAgentDraftMessage', '__codexNativeAgentMessage') + '\n' + source;
}
