import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adaptFloatingCommentAccess, readCommentComponent } from '../source/scripts/comment-floating-adapter.mjs';

const plugin = fileURLToPath(new URL('../codex-design/', import.meta.url));
const rootPattern = /function ([\w$]+)\(\{controller:[\w$]+,modeShortcut:[\w$]+="C",launcher:[\w$]+=\{bottom:16\},header:[\w$]+=!1,seats:[\w$]+,pinSide:[\w$]+\}\)\{/;
const listPattern = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,dark:[\w$]+,top:[\w$]+,onClose:[\w$]+(?:,__codexFloatingCommentList:__cfx=!1,__codexFloatBottom:__cfb=16)?\}\)\{/;

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
  const react = { useSyncExternalStore: (_, get) => get(), useState: initial => [initial === false ? toggle : typeof initial === 'function' ? initial() : initial, () => {}], useId: () => 'comment-row', useMemo: fn => fn(), useCallback: fn => fn };
  const values = { input, __CODEX_DESIGN_EDITOR_TRANSPORT__: native ? {} : undefined, codexDesignEditorI18n: undefined, ...aliases };
  for (const name of new Set([...definition.text.matchAll(/([\w$]+)\.(?:jsx|jsxs)\b/g)].map(match => match[1]))) values[name] = jsx;
  for (const name of new Set([...definition.text.matchAll(/([\w$]+)\.(?:useSyncExternalStore|useState|useId|useMemo|useCallback)\b/g)].map(match => match[1]))) values[name] = react;
  const theme = /\{dark:[\w$]+,remScale:[\w$]+\}=([\w$]+)\(/.exec(definition.text)?.[1];
  if (theme) values[theme] = () => ({ dark: false, remScale: 1 });
  let context;
  context = new Proxy(values, { get: (object, name) => name === 'globalThis' ? context : Object.hasOwn(object, name) ? object[name] : generic });
  return vm.runInNewContext(definition.text + `;${definition.match[1]}(input);`, context);
}

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
  test(`${kind}: native floating dock retains canonical list, resolved filter and reopen; legacy modes stay intact`, async () => {
    const directory = path.join(plugin, 'skills', 'codex-' + kind, 'scripts/editor');
    const html = await fs.readFile(path.join(directory, 'index.html'), 'utf8');
    const filename = kind === 'dashboard' ? path.join(directory, 'comments.js') : path.join(directory, /<script type="module"[^>]*src="([^"]+)"/.exec(html)[1]);
    const source = await fs.readFile(filename, 'utf8');
    const adapted = adaptFloatingCommentAccess(source);
    assert.equal(adaptFloatingCommentAccess(adapted), adapted, 'The source adapter is idempotent.');
    const root = readCommentComponent(adapted, rootPattern);
    const list = readCommentComponent(adapted, listPattern);
    const split = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,modeShortcut:[\w$]+,panelOpen:[\w$]+,onPanel:[\w$]+\}\)/.exec(source)[1];
    const state = { status: 'ready', mode: false, pins: { positions: {}, threads: [] }, busy: {}, drafts: {}, openId: null, toasts: [], snapshot: { threads: [] } };
    const reopened = [];
    const controller = { get: () => state, subscribe() {}, thread() {}, agentAvailable: () => false, win: { innerWidth: 1280 }, reopen: id => reopened.push(id) };
    const aliases = { [split]: 'canonical-split', [list.match[1]]: 'canonical-list' };
    const native = render(root, { controller }, { native: true, aliases });
    assert.equal(nodes(native, node => node.type === 'canonical-split').length, 1);
    const panel = nodes(native, node => node.type === 'canonical-list');
    assert.equal(panel.length, 1);
    assert.equal(panel[0].props.__codexFloatingCommentList, true);
    const legacyFloating = render(root, { controller }, { aliases });
    assert.equal(nodes(legacyFloating, node => node.type === 'canonical-split').length, 0);
    assert.equal(nodes(legacyFloating, node => node.type === 'canonical-list').length, 0);
    const legacyToolbar = render(root, { controller, seats: {} }, { aliases });
    assert.equal(nodes(legacyToolbar, node => node.type === 'canonical-list').length, 1);
    const thread = (id, status) => ({ id, status, createdAt: '2026-11-01T00:00:00Z', messages: [{ id: id + '-message', text: id, at: '2026-11-01T00:00:00Z', author: { kind: 'user', name: 'User' } }] });
    state.snapshot.threads = [thread('open-thread', 'open'), thread('resolved-thread', 'resolved')];
    const filtered = render(list, { controller, state, dark: false, top: 0 }, { toggle: false });
    assert.equal(nodes(filtered, node => node.props?.thread?.id === 'resolved-thread').length, 0);
    const all = render(list, { controller, state, dark: false, top: 0, __codexFloatingCommentList: true, __codexFloatBottom: 16 });
    assert.equal(nodes(all, node => node.props?.thread?.id === 'resolved-thread').length, 1);
    assert.equal(all.props.style.position, 'absolute');
    assert.equal(all.props.style.bottom, 'calc(100% + 8px)');
    const row = readCommentComponent(adapted, /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,thread:[\w$]+,current:[\w$]+\}\)\{/);
    const rowTree = render(row, { controller, state, thread: state.snapshot.threads[1], current: false }, { toggle: false });
    const menus = nodes(rowTree, node => Array.isArray(node.props?.items));
    const reopen = menus.flatMap(node => node.props.items).find(item => item.label === 'Reopen');
    assert.ok(reopen, 'The original resolved-thread action remains reachable.');
    reopen.onSelect();
    assert.deepEqual(reopened, ['resolved-thread']);
  });
}
