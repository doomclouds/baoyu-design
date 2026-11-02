import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adaptCommentDrafts, nativeCommentCanAdd, nativeCommentPresentation } from '../source/scripts/comment-draft-adapter.mjs';
import { readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const upstream = fileURLToPath(new URL('../../skills/', import.meta.url));
const nativeFlag = '__CODEX_DESIGN_EDITOR_TRANSPORT__';
const rowPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+),current:[\w$]+\}\)\{/;
const threadPattern = /function ([\w$]+)\(\{controller:([\w$]+),state:([\w$]+),thread:([\w$]+)\}\)\{/;
const composerPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,win:[\w$]+,pinSide:[\w$]+\}\)\{/;
const factoryPattern = /function ([\w$]+)\(\{base:[\w$]+,win:[\w$]+=window,modeShortcut:[\w$]+="C",launcher:[\w$]+,header:[\w$]+=!1,toolbar:[\w$]+=!1,pinSide:[\w$]+\}\)\{/;

async function code(kind) {
  const directory = path.join(upstream, 'claude-' + kind, 'scripts/editor');
  const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
  const entry = kind === 'dashboard' ? 'comments.js' : /<script type="module"[^>]*src="([^"]+)"/.exec(html)[1];
  return (await fs.readFile(path.join(directory, entry), 'utf8')).replaceAll('\r\n', '\n');
}

function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) { for (const child of tree) nodes(child, predicate, result); return result; }
  if (!tree || typeof tree !== 'object') return result;
  if (predicate(tree)) result.push(tree);
  if (tree.props) for (const value of Object.values(tree.props)) nodes(value, predicate, result);
  return result;
}

function render(source, pattern, input, { native = true, stateValues = [] } = {}) {
  const definition = readCommentComponent(source, pattern);
  let generic;
  generic = new Proxy(function () {}, { apply: () => undefined, get: (_, name) => name === Symbol.toPrimitive ? () => 0 : generic });
  const jsx = { Fragment: 'fragment', jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  let index = 0;
  const react = { useState: initial => [index < stateValues.length ? stateValues[index++] : (index++, initial), () => {}],
    useId: () => 'comment-row', useRef: initial => ({ current: initial }), useEffect() {} };
  const values = { input, [nativeFlag]: native ? {} : undefined, encodeURIComponent };
  const label = /label:(?:globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__\?"Add to chat":)?([\w$]+),checked:/.exec(definition.text)?.[1];
  if (label) values[label] = new RegExp(`\\b${label}="(Send to [Aa]gent)"`).exec(source)?.[1] ?? 'Send to agent';
  for (const name of new Set([...definition.text.matchAll(/([\w$]+)\.(?:jsx|jsxs)\b/g)].map(match => match[1]))) values[name] = jsx;
  for (const name of new Set([...definition.text.matchAll(/([\w$]+)\.(?:useState|useId|useRef|useEffect)\b/g)].map(match => match[1]))) values[name] = react;
  let context;
  context = new Proxy(values, { get: (object, name) => name === 'globalThis' ? context : Object.hasOwn(object, name) ? object[name] : generic });
  const helpers = ['Presentation', 'CanAdd', 'Actions'].map(name => readCommentComponent(source,
    new RegExp(`function (__codexNativeComment${name})\\([^)]*\\) \\{`))?.text ?? '').join('\n');
  return vm.runInNewContext(helpers + '\n' + definition.text + `;${definition.match[1]}(input);`, context);
}

function fixture(status, { reply = false, legacy = false } = {}) {
  const thread = { id: 'thread-1', label: 'Title', status: 'open', createdAt: '2026-11-01T00:00:00Z',
    messages: [{ id: 'message-1', text: 'Make the title larger', at: '2026-11-01T00:00:00Z', author: { kind: 'user', name: 'You' } }],
    agent: { status: 'delivered', sentAt: '2026-11-01T00:01:00Z',
      ...legacy ? {} : { nativeRequest: { requestId: 'request-1', status, message: ['failed', 'needs_attention'].includes(status) ? 'Host chat is unavailable.' : '' } } } };
  if (reply) thread.messages.push({ id: 'agent-reply', text: 'The title is now larger.', at: '2026-11-01T00:02:00Z', author: { kind: 'agent', name: 'agent' } });
  const calls = [];
  const state = { busy: {}, drafts: {}, snapshot: { threads: [thread], me: { name: 'You' } } };
  const controller = { agentAvailable: () => true, setDraft: (...args) => calls.push(['draft', ...args]),
    canComment: () => true, canEdit: () => true, canDelete: () => true,
    reply: (...args) => calls.push(['reply', ...args]), editMessage: (...args) => (calls.push(['edit', ...args]), Promise.resolve(true)),
    resolve: (...args) => (calls.push(['resolve', ...args]), Promise.resolve()), reopen: (...args) => calls.push(['reopen', ...args]),
    remove: (...args) => calls.push(['remove', ...args]), openThread: (...args) => calls.push(['open', ...args]),
    showThread: (...args) => calls.push(['show', ...args]), act: (_, callback) => callback(),
    request: (...args) => calls.push(['request', ...args]), updateComposer() {}, submitComposer() {}, closeComposer() {} };
  return { thread, state, controller, calls };
}

const cases = [
  ['draft_ready', 'Ready to add to chat'], ['prepared', 'Added to chat'], ['accepted', 'Waiting for the agent'],
  ['queued', 'Queued'], ['working', 'Working…'], ['failed', 'Failed'], ['needs_attention', 'Needs attention'], ['superseded', 'Draft replaced'],
];

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
  test(`${kind}: actual compiled comments show native draft truth and preserve HTTP delivery behavior`, async () => {
    const original = await code(kind), adapted = adaptCommentDrafts(original);
    assert.equal(adaptCommentDrafts(adapted), adapted);
    assert.equal(readCommentComponent(adapted, factoryPattern).text, readCommentComponent(original, factoryPattern).text,
      'The canonical controller, pins and mounting lifecycle stay intact.');
    assert.match(adaptInlineEditorScript(original, 'https://codex-design.invalid/editor.js'), /codex-design:native-comment-drafts/);
    for (const [status, label] of cases) {
      const model = fixture(status);
      const row = render(adapted, rowPattern, model);
      const badge = nodes(row, node => node.props?.['data-codex-comment-status'])[0];
      assert.ok(badge, status);
      assert.ok(badge.props.children.startsWith(label), status);
      const expanded = render(adapted, threadPattern, model);
      const activity = nodes(expanded, node => node.props?.footnote?.startsWith?.(label))[0];
      assert.ok(activity, status);
      assert.equal(activity.props.working, status === 'working' ? 'working' : undefined, status);
      if (status !== 'working') assert.doesNotMatch(activity.props.footnote, /Working/);
      const reply = nodes(expanded, node => node.props?.label === 'Reply')[0];
      assert.equal(reply.props.sendBox.label, 'Add to chat');
      if (['failed', 'needs_attention'].includes(status)) {
        assert.match(badge.props.children, /Host chat is unavailable/);
        const retry = nodes(row, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).find(item => item.label === 'Retry add to chat');
        assert.ok(retry, status); retry.onSelect();
        assert.deepEqual(model.calls.at(-1), ['request', '/thread-1/send', 'POST']);
      }
    }
    const legacy = fixture('delivered', { legacy: true });
    const nativeLegacy = render(adapted, threadPattern, legacy);
    assert.equal(nodes(nativeLegacy, node => node.props?.working === 'working').length, 0);
    assert.ok(nodes(nativeLegacy, node => node.props?.footnote?.startsWith?.('Needs attention')).length);
    const httpOriginal = render(original, threadPattern, legacy, { native: false });
    const httpAdapted = render(adapted, threadPattern, legacy, { native: false });
    assert.equal(nodes(httpOriginal, node => node.props?.working === 'working').length, 1);
    assert.equal(nodes(httpAdapted, node => node.props?.working === 'working').length, 1);
    assert.equal(nodes(httpAdapted, node => node.props?.label === 'Reply')[0].props.sendBox.label,
      nodes(httpOriginal, node => node.props?.label === 'Reply')[0].props.sendBox.label);
    const httpRow = render(adapted, rowPattern, legacy, { native: false, stateValues: [true] });
    assert.equal(nodes(httpRow, node => node.props?.savedValue)[0].props.sendBox.label, 'Send to Agent');
    assert.equal(nodes(httpRow, node => node.props?.['data-codex-comment-status']).length, 0);
  });

  test(`${kind}: native draft labels retain canonical create, reply, edit, resolve, reopen and actual agent replies`, async () => {
    const adapted = adaptCommentDrafts(await code(kind));
    const model = fixture('completed', { reply: true });
    const expanded = render(adapted, threadPattern, model);
    assert.equal(nodes(expanded, node => node.props?.children === 'The title is now larger.').length, 1);
    assert.equal(nodes(expanded, node => typeof node.props?.footnote === 'string').length, 0,
      'Completion is the saved agent reply, not another synthetic working bubble.');
    const reply = nodes(expanded, node => node.props?.label === 'Reply')[0];
    reply.props.onSubmit('A follow-up comment', { send: false });
    assert.deepEqual(model.calls.at(-1), ['reply', 'thread-1', 'A follow-up comment', false]);
    reply.props.onSubmit('Revise it again', { send: true });
    assert.deepEqual(model.calls.at(-1), ['reply', 'thread-1', 'Revise it again', true]);
    const resolve = nodes(expanded, node => typeof node.props?.onResolve === 'function')[0];
    resolve.props.onResolve(); assert.deepEqual(model.calls.at(-1), ['resolve', 'thread-1']);
    model.thread.status = 'resolved';
    const row = render(adapted, rowPattern, model, { stateValues: [true] });
    const reopen = nodes(row, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).find(item => item.label === 'Reopen');
    assert.ok(reopen); reopen.onSelect(); assert.deepEqual(model.calls.at(-1), ['reopen', 'thread-1']);
    assert.equal(nodes(row, node => node.props?.savedValue)[0].props.sendBox.label, 'Add to chat');
    const edit = nodes(row, node => node.props?.savedValue)[0];
    await edit.props.onSave('A revised title');
    assert.deepEqual(model.calls.at(-1), ['edit', 'thread-1', 'message-1', 'A revised title', false]);
    model.state.composer = { message: { requestId: 'selection-1', anchor: 'title', label: 'Title' }, at: { x: 1, y: 1 }, text: 'New comment', send: false, busy: false };
    const composer = render(adapted, composerPattern, { ...model, win: {} });
    assert.equal(nodes(composer, node => node.props?.sendBox)[0].props.sendBox.label, 'Add to chat');
    const noReply = fixture('completed');
    const missingReply = render(adapted, threadPattern, noReply);
    assert.ok(nodes(missingReply, node => node.props?.footnote?.includes?.('no saved agent reply')).length);
    assert.equal(nodes(missingReply, node => node.props?.working === 'working').length, 0);
    assert.ok(nodes(missingReply, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).find(item => item.label === 'Retry add to chat'));
  });

  test(`${kind}: changed canonical anchors refuse adaptation`, async () => {
    const original = await code(kind);
    assert.throws(() => adaptCommentDrafts(original.replace('"Send to Agent"', '"Changed native label"')), /adaptation was refused/);
    assert.throws(() => adaptCommentDrafts(original.replace(/==="delivered"\?"working"/, '==="delivered"?"unknown"')), /adaptation was refused/);
  });

  test(`${kind}: native drafting retains the new canonical viewer and commenter permissions`, async () => {
    const adapted = adaptCommentDrafts(await code(kind));
    const viewer = fixture('prepared');
    Object.assign(viewer.controller, { agentAvailable: () => false, canComment: () => false, canEdit: () => false, canDelete: () => false });
    const view = render(adapted, threadPattern, viewer);
    assert.equal(nodes(view, node => node.props?.label === 'Reply').length, 0);
    assert.equal(nodes(view, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).length, 0);
    const commenter = fixture('prepared');
    Object.assign(commenter.controller, { agentAvailable: () => false, canEdit: () => false, canDelete: () => false });
    const comment = render(adapted, threadPattern, commenter);
    const reply = nodes(comment, node => node.props?.label === 'Reply')[0];
    assert.ok(reply, 'a permitted commenter can still write a normal local reply');
    assert.equal(reply.props.sendBox, undefined, 'native mode does not grant the host-owner Send capability');
    assert.equal(nodes(comment, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).some(item => /Add.*chat/.test(item.label)), false);
  });
}

test('native comment eligibility permits failed retries and a revised latest user message', () => {
  for (const status of ['failed', 'needs_attention', 'draft_ready', 'prepared', 'superseded']) assert.equal(nativeCommentCanAdd(fixture(status).thread), true);
  for (const status of ['accepted', 'queued', 'working']) {
    const { thread } = fixture(status);
    assert.equal(nativeCommentCanAdd(thread), false);
    thread.messages[0].editedAt = '2026-11-01T00:03:00Z';
    assert.equal(nativeCommentCanAdd(thread), true);
    thread.status = 'resolved'; assert.equal(nativeCommentCanAdd(thread), false);
  }
  assert.equal(nativeCommentCanAdd(fixture('completed', { reply: true }).thread), false);
  assert.equal(nativeCommentPresentation(fixture('working').thread).working, 'working');
  assert.equal(adaptCommentDrafts('console.log("ordinary editor dependency")'), 'console.log("ordinary editor dependency")');
});
