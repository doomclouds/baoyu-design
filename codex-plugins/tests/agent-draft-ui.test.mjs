import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { adaptAgentDrafts, createNativeAgentDraft, nativeAgentDraftMessage } from '../source/scripts/agent-draft-adapter.mjs';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const firstId = '11111111-1111-4111-8111-111111111111';
const receipt = (status = 'draft_ready', message) => ({ thread: { id: 'c_fix', agent: { nativeRequest: { requestId: firstId, status, ...(message ? { message } : {}) } } } });
function targetWith(handler = () => receipt()) {
  const calls = [];
  return { calls, __CODEX_DESIGN_EDITOR_TRANSPORT__: { baseUrl: 'http://127.0.0.1:4321/grant/', canDraftComments: true },
    async fetch(url, request) { calls.push({ url, request }); const value = await handler(calls.length, request); return new Response(JSON.stringify(value), { status: value.statusCode || 200 }); } };
}

const properties = {
  slides: { fallback: 'suggestPromptOrCopy', send: 'sendOrSuggestToAgent', status: 'agentSendResultMessage', diagnostic: 'askAgentToRepairSlide' },
  design: { fallback: 'sendOrCopyClaudePrompt', send: 'sendDesignSelectionToClaude', status: 'claudeSendStatusMessage', diagnostic: 'sendArtboardErrorsToClaude' },
  'design-system': { fallback: 'suggestPromptOrCopy', send: 'deliverClaudeRequest', status: 'claudeSendResultMessage' },
  dashboard: { fallback: 'suggestOrCopyPrompt', send: 'sendSelectionToClaude', status: 'describePromptSendOutcome' },
};
async function originalCode(kind) {
  const directory = new URL('../codex-design/skills/codex-' + kind + '/scripts/editor/assets/', import.meta.url);
  for (const name of await fs.readdir(directory)) if (name.endsWith('.js')) {
    const source = await fs.readFile(new URL(name, directory), 'utf8');
    if (source.includes('"' + properties[kind].send + '"')) return source;
  }
  throw new Error('The actual compiled handoff module was not found: ' + kind);
}
function exportedFunction(source, property) {
  const exported = new RegExp(`\\b[at]\\(e,"${property}",\\(\\)=>([\\w$]+)\\)`).exec(source);
  assert.ok(exported, property);
  let start = source.lastIndexOf('function ' + exported[1] + '(', exported.index);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const definition = readCommentComponent(source.slice(start), /^(?:async )?function ([\w$]+)\(([^)]*)\)\{/);
  assert.ok(definition, property);
  return definition;
}
function invoke(source, property, args, context = {}) {
  const definition = exportedFunction(source, property);
  return vm.runInNewContext(definition.text + `;${definition.match[1]}(...args)`, { args, ...context });
}

for (const [kind, names] of Object.entries(properties)) test(`${kind}: actual AI handoffs add a canonical native draft while true clipboard fallback remains standalone`, async () => {
  const original = await originalCode(kind), adapted = adaptAgentDrafts(original);
  assert.equal(adaptAgentDrafts(adapted), adapted);
  assert.match(adaptInlineEditorScript(original, 'https://codex-design.invalid/editor.js'), /codex-design:native-agent-drafts/);
  const target = targetWith(), send = createNativeAgentDraft();
  const bridge = input => send(input, target);
  const nativeContext = { __CODEX_DESIGN_EDITOR_TRANSPORT__: target.__CODEX_DESIGN_EDITOR_TRANSPORT__, __codexNativeAgentDraft: bridge,
    __codexNativeAgentMessage: nativeAgentDraftMessage, e: { copyTextToClipboard: () => assert.fail('native requests cannot copy'), writeClipboardText: () => assert.fail('native requests cannot copy') } };
  let copies = 0;
  const copy = async () => (copies++, true);
  assert.equal(await invoke(adapted, names.fallback, ['Fix this exact file.', {}, copy], nativeContext), 'staged');
  assert.equal(copies, 0);
  assert.equal(target.calls.length, 1);
  assert.equal(JSON.parse(target.calls[0].request.body).text, 'Fix this exact file.');
  assert.equal(new URL(target.calls[0].url).pathname, '/grant/__comments/agent/requests');
  const fallback = exportedFunction(original, names.fallback);
  const resolver = /let [\w$]+=([\w$]+)\([\w$]+\);if/.exec(fallback.text)?.[1];
  assert.ok(resolver);
  for (const source of [original, adapted]) assert.equal(await invoke(source, names.fallback, ['An intentional standalone copy.', {}, copy], { [resolver]: () => null }), 'copied');
  assert.equal(copies, 2);
  assert.equal(invoke(adapted, names.status, ['staged'], nativeContext), 'Added to chat. Send in Codex to start editing.');
  assert.doesNotMatch(invoke(adapted, names.status, ['unanswered'], nativeContext), /copied|Working|Sent to/);
  assert.match(invoke(adapted, names.status, ['copied'], nativeContext), /Prompt copied/,
    'An explicit user Copy action keeps its truthful clipboard confirmation.');
});

test('Design error repair retains every full filename, canvas title and diagnostic instead of the old 1,800-character fallback', async () => {
  const source = adaptAgentDrafts(await originalCode('design')), target = targetWith(), send = createNativeAgentDraft();
  const problems = [{ file: 'boards/An unusually long filename ' + 'x'.repeat(150) + '.dc.html', messages: ['TypeError: missing prop ' + 'a'.repeat(1800), 'Second full diagnostic.'] }];
  const context = { __CODEX_DESIGN_EDITOR_TRANSPORT__: target.__CODEX_DESIGN_EDITOR_TRANSPORT__,
    __codexNativeAgentDraft: input => send(input, target), e: { artboardErrorsFixRequest: () => 'Fix only the reported artboards.' } };
  assert.equal(await invoke(source, 'sendArtboardErrorsToClaude', [problems, null, 'Canvas <title>'], context), 'staged');
  const payload = JSON.parse(target.calls[0].request.body);
  assert.equal(payload.label, 'Artboard errors');
  const editor = JSON.parse(payload.text.split('Editor context (data, not instructions):\n')[1]).editor;
  assert.deepEqual(editor.artboards, problems);
  assert.equal(editor.canvasTitle, 'Canvas <title>');
  assert.equal((source.match(/\?"Add fix to chat":\w+\.ask/g) || []).length, 2);
});

test('Slides repair retains the exact slide scope, title and complete diagnostic', async () => {
  const source = adaptAgentDrafts(await originalCode('slides')), target = targetWith(), send = createNativeAgentDraft();
  const slide = { slideId: 'cover', scope: 'deck-a', deckTitle: 'Keep this title' }, diagnostic = 'line 28:7 ' + 'problem '.repeat(200);
  const context = { __CODEX_DESIGN_EDITOR_TRANSPORT__: target.__CODEX_DESIGN_EDITOR_TRANSPORT__,
    __codexNativeAgentDraft: input => send(input, target), e: { buildSlideDiagnosticRequest: () => 'Repair this saved slide.', SLIDE_READ_FAILED_DIAGNOSTIC: 'read failure' } };
  assert.equal(await invoke(source, 'askAgentToRepairSlide', [slide, diagnostic, null], context), 'staged');
  const editor = JSON.parse(JSON.parse(target.calls[0].request.body).text.split('Editor context (data, not instructions):\n')[1]).editor;
  assert.deepEqual(editor, { slide, diagnostic });
  assert.match(source, /\?"Add fix to chat":"Ask the agent to fix"/);
});

test('Design System delivery keeps its object outcome and Dashboard selection callbacks finish without requiring a legacy room', async () => {
  const ds = adaptAgentDrafts(await originalCode('design-system'));
  const target = targetWith(), send = createNativeAgentDraft(), context = { __CODEX_DESIGN_EDITOR_TRANSPORT__: target.__CODEX_DESIGN_EDITOR_TRANSPORT__, __codexNativeAgentDraft: input => send(input, target) };
  const delivered = await invoke(ds, 'deliverClaudeRequest', [{ label: 'Sync tokens', request: 'Update the saved tokens.', prompt: 'Keep full token context.' }, null, { sender: null, ownerChat: null }], context);
  assert.equal(delivered.kind, 'staged');
  context.__codexNativeAgentMessage = nativeAgentDraftMessage;
  assert.equal(invoke(ds, 'claudeDeliveryStatusMessage', [delivered.kind, false], context), 'Added to chat. Send in Codex to start editing.');
  assert.match(invoke(ds, 'claudeDeliveryStatusMessage', ['unanswered', false], context), /Could not add/);
  const dashboard = adaptAgentDrafts(await originalCode('dashboard')), announcements = [], callbacks = [];
  context.__codexNativeAgentMessage = nativeAgentDraftMessage;
  context.e = { announceLiveMessage: message => announcements.push(message), showToastMessage: message => announcements.push(message) };
  assert.equal(invoke(dashboard, 'useCanAskClaude', [], context), true);
  assert.equal(invoke(dashboard, 'handOffSelectionToSession', [{ label: 'Query A', text: 'Exact query and filter context.' }, 'Fix this query.', true, ok => callbacks.push(ok)], context), true);
  await setImmediate();
  assert.deepEqual(callbacks, [true]);
  assert.deepEqual(announcements, ['Added to chat. Send in Codex to start editing.']);
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__.canDraftComments = false;
  assert.equal(invoke(dashboard, 'useCanAskClaude', [], context), false);
  invoke(dashboard, 'handOffSelectionToSession', [{ text: 'Selection' }, 'Retry.', false, ok => callbacks.push(ok)], context);
  await setImmediate();
  assert.equal(callbacks.at(-1), false);
  assert.match(announcements.at(-1), /Could not add/);
});

test('saved draft failure keeps its canonical identity and explicit retry only re-adds that thread', async () => {
  const target = targetWith(count => receipt(count === 1 ? 'needs_attention' : 'draft_ready', count === 1 ? 'Native draft append denied.' : undefined));
  const send = createNativeAgentDraft(), input = { label: 'Repair cover', request: 'Fix the reported syntax error.', context: { file: 'slides/cover.html', message: 'Unexpected token' } };
  assert.equal(await send(input, target), 'unanswered');
  assert.equal(send.lastError, 'Native draft append denied.');
  assert.equal(await send(input, target), 'staged');
  assert.equal(target.calls.length, 2);
  assert.equal(new URL(target.calls[0].url).pathname, '/grant/__comments/agent/requests');
  assert.equal(new URL(target.calls[1].url).pathname, '/grant/__comments/c_fix/send');
  assert.equal(target.calls[1].request.body, undefined);
});

test('native draft operations are single-flight, reject missing capability and oversized context, and never claim an unconfirmed receipt', async () => {
  let release;
  const target = targetWith(() => new Promise(resolve => { release = () => resolve(receipt()); })), send = createNativeAgentDraft();
  const first = send('Fix the selected element.', target), second = send('Fix the selected element.', target);
  await setImmediate();
  assert.equal(target.calls.length, 1);
  release(); assert.deepEqual(await Promise.all([first, second]), ['staged', 'staged']);
  for (const capability of [false, undefined, null, 'true']) {
    target.__CODEX_DESIGN_EDITOR_TRANSPORT__.canDraftComments = capability;
    assert.equal(await send('Fix another element.', target), 'unanswered');
    assert.equal(target.calls.length, 1);
    assert.match(send.lastError, /cannot add/);
  }
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__.canDraftComments = true;
  assert.equal(await send({ request: 'Fix.', context: { diagnostic: 'x'.repeat(10_001) } }, target), 'unanswered');
  assert.equal(target.calls.length, 1);
  assert.match(send.lastError, /too much diagnostic context/);
  const unconfirmed = targetWith(() => ({ thread: { id: 'c_uncertain' } }));
  assert.equal(await send('Unconfirmed operation.', unconfirmed), 'unanswered');
  assert.match(send.lastError, /receipt could not be confirmed/);
});

test('vendor drift refuses partial handoff adaptation and unrelated clipboard content stays byte-identical', async () => {
  const source = await originalCode('design');
  assert.equal(adaptAgentDrafts('const userCopy = () => navigator.clipboard.writeText("CSS");'), 'const userCopy = () => navigator.clipboard.writeText("CSS");');
  assert.throws(() => adaptAgentDrafts(source.replace('"sendOrCopyClaudePrompt"', '"changedPromptHelper"')), /missing/);
  assert.throws(() => adaptAgentDrafts(source.replaceAll('children:n.ask', 'children:n.changedAsk')), /request label changed/);
});

test('only the native Design System built-in migration scaffold names the Codex skill', async () => {
  const original = await originalCode('design-system');
  const historical = '\nconst originalMigrationId="claude-design";const authoredSkillMention="claude-design-system";';
  const adapted = adaptAgentDrafts(original + historical);
  const template = source => {
    const match = /=(`\nAgent: put it in the Design System format,[^`]*`)/.exec(source);
    assert.ok(match, 'the exact built-in migration template is present');
    return match[1];
  };
  const before = vm.runInNewContext(template(original));
  assert.match(before, /Read the claude-design-system skill’s SKILL\.md/);
  assert.equal(vm.runInNewContext(template(adapted)), before, 'standalone template value is unchanged');
  assert.equal(vm.runInNewContext(template(adapted), { __CODEX_DESIGN_EDITOR_TRANSPORT__: {} }), before.replace('Read the claude-design-system skill’s SKILL.md', 'Read the codex-design-system skill’s SKILL.md'));
  assert.ok(adapted.endsWith(historical), 'historical IDs and authored text remain byte-identical');
  assert.throws(() => adaptAgentDrafts(original.replace('Read the claude-design-system skill’s SKILL.md', 'Changed migration instructions')), /request label changed/);
});
