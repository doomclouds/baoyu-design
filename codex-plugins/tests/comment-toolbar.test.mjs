import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adaptCommentToolbar, readCommentComponent } from '../source/scripts/comment-toolbar-adapter.mjs';

const upstream = fileURLToPath(new URL('../../skills/', import.meta.url));
const rootPattern = /function ([\w$]+)\(\{controller:[\w$]+,modeShortcut:[\w$]+="C",launcher:[\w$]+=\{bottom:16\},header:[\w$]+=!1,seats:[\w$]+,pinSide:[\w$]+\}\)\{/;
const listPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,dark:[\w$]+,top:[\w$]+,onClose:[\w$]+\}\)\{/;
const factoryPattern = /function ([\w$]+)\(\{base:[\w$]+,win:[\w$]+=window,modeShortcut:[\w$]+="C",launcher:[\w$]+,header:[\w$]+=!1,toolbar:[\w$]+=!1,pinSide:[\w$]+\}\)\{/;
const nativeFlag = '__CODEX_DESIGN_EDITOR_TRANSPORT__';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function code(kind, comments = false) {
  const directory = path.join(upstream, 'claude-' + kind, 'scripts/editor');
  const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
  return (await fs.readFile(path.join(directory, comments ? 'comments.js' : /<script type="module"[^>]*src="([^"]+)"/.exec(html)[1]), 'utf8')).replaceAll('\r\n', '\n');
}
function nodes(tree, predicate, result = []) {
  if (Array.isArray(tree)) { for (const child of tree) nodes(child, predicate, result); return result; }
  if (!tree || typeof tree !== 'object') return result;
  if (predicate(tree)) result.push(tree);
  if (tree.props) for (const value of Object.values(tree.props)) nodes(value, predicate, result);
  return result;
}
function render(definition, input, { native = false, toggle = true, aliases = {} } = {}) {
  let generic;
  generic = new Proxy(function () {}, { apply: () => undefined, get: (_, name) => name === Symbol.toPrimitive ? () => 0 : generic });
  const jsx = { Fragment: 'fragment', jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  const react = { useSyncExternalStore: (_, get) => get(), useState: initial => [initial === false ? toggle : typeof initial === 'function' ? initial() : initial, () => {}], useId: () => 'comment-row', useMemo: fn => fn(), useCallback: fn => fn, useRef: initial => ({ current: initial }) };
  const values = { input, [nativeFlag]: native ? {} : undefined, codexDesignEditorI18n: undefined, ...aliases };
  for (const name of new Set([...definition.text.matchAll(/([\w$]+)\.(?:jsx|jsxs)\b/g)].map(match => match[1]))) values[name] = jsx;
  for (const name of new Set([...definition.text.matchAll(/([\w$]+)\.(?:useSyncExternalStore|useState|useId|useMemo|useCallback|useRef)\b/g)].map(match => match[1]))) values[name] = react;
  const menuState = /\[[\w$]+,[\w$]+\]=([\w$]+)\(\)/.exec(definition.text)?.[1];
  if (menuState) values[menuState] = () => [false, () => {}];
  const namespace = /([\w$]+)\.reactSectionNavigation\./.exec(definition.text)?.[1];
  if (namespace) values[namespace] = new Proxy({ reactSectionNavigation: react, UNCOMMENTABLE_PROPS: {} }, { get: (object, name) => Object.hasOwn(object, name) ? object[name] : generic });
  const theme = /\{dark:[\w$]+,remScale:[\w$]+\}=([\w$]+)\(/.exec(definition.text)?.[1];
  if (theme) values[theme] = () => ({ dark: false, remScale: 1 });
  let context;
  context = new Proxy(values, { get: (object, name) => name === 'globalThis' ? context : Object.hasOwn(object, name) ? object[name] : generic });
  return vm.runInNewContext(definition.text + `;${definition.match[1]}(input);`, context);
}

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
  test(`${kind}: native canonical toolbar retains mode, list, resolved filter, reopen and replies without a bubble`, async () => {
    const source = await code(kind, kind === 'dashboard'), adapted = adaptCommentToolbar(source);
    assert.equal(adaptCommentToolbar(adapted), adapted);
    const factory = readCommentComponent(adapted, factoryPattern);
    assert.equal(factory.text, readCommentComponent(source, factoryPattern).text, 'The original controller, queue and reply API is unchanged.');
    assert.match(factory.text, /sendRequest:[\w$]+=>[\w$]+\.sendRequest\(/);
    const call = new RegExp(`${escape(factory.match[1])}\\(\\{base:([\\w$]+),(?:header:[^,}]+,)?toolbar:([^}]+)\\}\\)`).exec(adapted);
    assert.ok(call, 'Native creation enables canonical toolbar seats.');
    const options = native => vm.runInNewContext(call[0], { [nativeFlag]: native ? {} : undefined, [factory.match[1]]: value => value, [call[1]]: 'root' });
    assert.equal(options(true).toolbar, true);
    assert.notEqual(options(true).header, true, 'Do not add the legacy Updated/header bar.');
    assert.equal(options(false).toolbar, ['slides', 'design'].includes(kind));
    assert.equal(options(false).header, kind === 'design-system' ? true : undefined, 'retain the current canonical HTTP header choice');
    const root = readCommentComponent(adapted, rootPattern), list = readCommentComponent(adapted, listPattern);
    assert.equal(root.text, readCommentComponent(source, rootPattern).text, 'Toolbar mounting retains the complete canonical comment state machine.');
    assert.equal(list.text, readCommentComponent(source, listPattern).text);
    const state = { status: 'ready', mode: false, pins: { positions: {}, threads: [] }, busy: {}, drafts: {}, openId: null, toasts: [], snapshot: { threads: [] } };
    const reopened = [], modes = [], panels = [];
    const controller = { get: () => state, subscribe() {}, thread() {}, agentAvailable: () => false,
      canComment: () => true, canEdit: () => true, canDelete: () => true,
      win: { innerWidth: 1280 }, reopen: id => reopened.push(id), setMode: value => modes.push(value) };
    const tree = render(root, { controller, seats: {} }, { native: true, aliases: { [list.match[1]]: 'canonical-list' } });
    assert.equal(nodes(tree, node => node.type === 'canonical-list').length, 1);
    assert.equal(nodes(tree, node => node.props?.style?.padding === 4).length, 0, 'An initially empty toolbar seat set never falls back to a bubble.');
    const split = readCommentComponent(adapted, /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,modeShortcut:[\w$]+,panelOpen:[\w$]+,onPanel:[\w$]+\}\)\{/);
    const controls = render(split, { controller, state, panelOpen: false, onPanel: value => panels.push(value) });
    nodes(controls, node => node.props?.['aria-pressed'] === false && typeof node.props?.onClick === 'function')[0].props.onClick();
    assert.deepEqual(modes, [true]);
    const show = nodes(controls, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).find(item => item.label === 'Show all comments');
    assert.ok(show); show.onSelect(); assert.deepEqual(panels, [true]);
    const thread = (id, status) => ({ id, status, createdAt: '2026-11-01T00:00:00Z', messages: [{ id: id + '-message', text: id, at: '2026-11-01T00:00:00Z', author: { kind: 'user', name: 'User' } }, { text: 'A reply', author: { kind: 'agent' } }] });
    state.snapshot.threads = [thread('open-thread', 'open'), thread('resolved-thread', 'resolved')];
    assert.equal(nodes(render(list, { controller, state, dark: false, top: 48 }, { toggle: false }), node => node.props?.thread?.id === 'resolved-thread').length, 0);
    assert.equal(nodes(render(list, { controller, state, dark: false, top: 48 }), node => node.props?.thread?.id === 'resolved-thread').length, 1);
    const row = readCommentComponent(adapted, /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,thread:[\w$]+,current:[\w$]+\}\)\{/);
    const rowTree = render(row, { controller, state, thread: state.snapshot.threads[1], current: false }, { toggle: false });
    const reopen = nodes(rowTree, node => Array.isArray(node.props?.items)).flatMap(node => node.props.items).find(item => item.label === 'Reopen');
    assert.ok(reopen); reopen.onSelect(); assert.deepEqual(reopened, ['resolved-thread']);
    assert.equal(nodes(rowTree, node => node.props?.['data-cds-part'] === 'replies-toggle').length, 1);
    assert.doesNotMatch(adapted, /data-codex-comment-dock|codex-comment-dock-top|__codexFloatingCommentList/);
  });
}

test('design-system existing chapter pill and wide sidebar tool row each receive one native seat and retain existing status', async () => {
  const source = await code('design-system'), adapted = adaptCommentToolbar(source);
  const floating = readCommentComponent(adapted, /function ([\w$]+)\(\{sections:[\w$]+,tail:[\w$]+,current:[\w$]+,onJump:[\w$]+,footer:[\w$]+,status:[\w$]+,navRef:[\w$]+,edgeRef:[\w$]+,port:[\w$]+,marks:[\w$]+,search:[\w$]+,pending:[\w$]+\}\)\{/);
  const sidebar = readCommentComponent(adapted, /function ([\w$]+)\(\{sections:[\w$]+,tail:[\w$]+,current:[\w$]+,onJump:[\w$]+,dropProps:[\w$]+,footer:[\w$]+,navRef:[\w$]+,marks:[\w$]+,search:[\w$]+,pending:[\w$]+\}\)\{/);
  const search = /let [\w$]+=([\w$]+)\(/.exec(sidebar.text)[1];
  const status = { type: 'existing-status', props: { children: 'Saved' } };
  for (const component of [floating, sidebar]) for (const native of [false, true]) {
    const tree = render(component, { sections: [], status, footer: status }, { native, toggle: false, aliases: { [search]: () => ({ result: null }) } });
    assert.equal(nodes(tree, node => node.props?.['data-baoyu-comments-seat'] === '').length, native ? 1 : 0);
    assert.equal(nodes(tree, node => node.type === 'existing-status').length, 1);
  }
});

test('dashboard reuses its existing trailing toolbar span only in native mode', async () => {
  const adapted = adaptCommentToolbar(await code('dashboard'));
  const slot = /([\w$]+)\.jsx\("span",\{ref:([\w$]+)\.markToolbarUncommentable,hidden:!globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__[\s\S]*?\}\)/.exec(adapted);
  assert.ok(slot);
  for (const native of [false, true]) {
    const element = vm.runInNewContext(slot[0], { [nativeFlag]: native ? {} : undefined,
      [slot[1]]: { jsx: (type, props) => ({ type, props }) }, [slot[2]]: { markToolbarUncommentable() {} } });
    assert.equal(element.props.hidden, !native);
    assert.equal(element.props['data-baoyu-comments-seat'], native ? '' : undefined);
    assert.equal(element.props.style?.display, native ? 'contents' : undefined);
  }
  assert.equal((adapted.match(/"data-codex-comment-toolbar"/g) || []).length, 1);
});

test('canonical native comment list anchors remain visible for lower sidebar tools while ordinary HTTP anchors stay unchanged', async () => {
  const source = adaptCommentToolbar(await code('design-system'));
  const name = /function ([\w$]+)\([\w$]+\)\{for\(const [\w$]+ of [\w$]+\)\{const ([\w$]+)=\([\w$]+\.el\.closest\([\w$]+\)\?\?[\w$]+\.el\.parentElement\)\?\.getBoundingClientRect\(\);if\(!\(!\2\|\|\2\.height===0\)\)return Math\.round\(globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__/.exec(source)?.[1];
  assert.ok(name);
  const definition = readCommentComponent(source, new RegExp(`function (${escape(name)})\\([\\w$]+\\)\\{`));
  const margin = /\.bottom\+([\w$]+)/.exec(definition.text)[1];
  const seat = { el: { closest: () => ({ getBoundingClientRect: () => ({ bottom: 780, height: 40 }) }) } };
  for (const native of [false, true]) {
    const globals = new Proxy({ input: [seat], Math, [margin]: 16, innerHeight: 800, [nativeFlag]: native ? {} : undefined }, { get: (object, key) => key === 'globalThis' ? object : Object.hasOwn(object, key) ? object[key] : undefined });
    const value = vm.runInNewContext(definition.text + `;${name}(input)`, globals);
    assert.equal(value, native ? 400 : 796);
  }
});
