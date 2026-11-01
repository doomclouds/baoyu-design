import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { webcrypto } from 'node:crypto';
import i18next from 'i18next';
import en from '../source/ui/locales/en.js';
import { BridgeError, supports, unavailableBridge } from '../source/ui/bridge.js';
import { menuPosition } from '../source/ui/layout.mjs';
import { createMenuDismissal, menuInputMode } from '../source/ui/menu-dismissal.mjs';

// Run the actual controller with a small inert DOM at its rendering boundary.
// Editor persistence is acknowledged only by the explicit flush stub below.
const source = (await fs.readFile(new URL('../source/ui/library-ui.js', import.meta.url), 'utf8'))
  .replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
const id = '11111111-1111-4111-8111-111111111111';

class Surface {
  listeners = new Map();
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name, event = {}) { for (const handler of this.listeners.get(name) || []) handler(event); }
}

async function start(t, { savedLanguage = 'zh', native = true, active = false, failSave = false } = {}) {
  const document = new Surface(), window = new Surface(), nodes = [], storageReads = [], actions = [], editorCalls = [], posted = [], timeline = [];
  document.documentElement = {}; document.hidden = false; document.activeElement = null;
  class Element extends Surface {
    attrs = new Map(); children = []; slots = new Map(); dataset = {}; innerHTML = ''; style = {}; className = '';
    constructor(tagName = 'DIV', parent = null) { super(); this.tagName = tagName; this.parent = parent; nodes.push(this); }
    classList = { add() {}, remove() {}, toggle() {}, contains: name => this.className.split(' ').includes(name) };
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) { return this.attrs.get(name); }
    removeAttribute(name) { this.attrs.delete(name); }
    querySelector(selector) {
      if (selector === '.design-editor-frame' || selector === 'iframe') return nodes.find(node => node.tagName === 'IFRAME' && node.className === 'design-editor-frame') || null;
      if (selector.startsWith('button') && this === root.querySelector('.menu-layer') && this.innerHTML) return this.firstElementChild.querySelector(selector);
      if (!this.slots.has(selector)) this.slots.set(selector, new Element(selector.startsWith('button') ? 'BUTTON' : 'DIV', this));
      return this.slots.get(selector);
    }
    querySelectorAll() { return []; }
    get firstElementChild() { return this.innerHTML ? this.querySelector('.menu-panel') : null; }
    getBoundingClientRect() { return { left: 100, right: 140, top: 100, bottom: 140, width: 40, height: 40 }; }
    replaceChildren(...children) { this.children = children; this.innerHTML = ''; for (const child of children) child.parent = this; }
    append(child) { this.children.push(child); child.parent = this; }
    remove() {}
    contains(target) { for (; target; target = target.parent) if (target === this) return true; return false; }
    closest(selector) { if (selector === '[data-action]') return this.dataset.action ? this : null; if (selector === '.menu-panel') return this.parent?.className === 'menu-panel' ? this.parent : null; return null; }
    matches() { return false; }
    focus() { document.activeElement = this; document.emit('focusin', { target: this }); }
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    reportValidity() { return true; }
  }
  const root = new Element();
  document.createElement = tag => new Element(tag.toUpperCase());
  const record = { id, kind: 'design-system', title: '保留中文作品与批注原文', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contentStatus: 'ok' };
  const original = JSON.stringify(record);
  let view = { version: 1, tabs: [{ id: 'library', type: 'library' }, { id, type: 'artifact', artifactId: id }], activeTabId: active ? id : 'library' };
  let subscribe;
  const bridge = { available: true, supportsInlineEditor: native, language: 'zh-CN', initialState: { artifacts: [record], viewState: view },
    subscribe(handler) { subscribe = handler; return () => {}; },
    async invoke(action, payload) {
      actions.push({ action, payload }); timeline.push(action);
      if (action === 'library.list') return [record];
      if (action === 'view.get') return view;
      if (action === 'view.activateTab' || action === 'view.openTab') return view = { ...view, activeTabId: payload.id };
      if (action === 'view.closeTab') return view = { ...view, tabs: view.tabs.filter(tab => tab.id !== payload.id), activeTabId: 'library' };
      if (action === 'editor.document') return { html: '<html><body>editor</body></html>' };
      if (action === 'editor.open') return { url: 'http://127.0.0.1:4321/editor/' };
      if (action === 'conversation.get') return { binding: null };
      throw new Error('Unexpected action: ' + action);
    },
  };
  const controllerContext = vm.createContext({ document, window, root, bridge, i18next, en, brandIcon: 'brand.svg', BridgeError, supports, unavailableBridge, menuPosition, createMenuDismissal, menuInputMode,
    matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800, crypto: webcrypto, URL, Intl, Date, AbortController, console: { warn() {} },
    navigator: { language: 'zh-CN' }, location: { href: 'http://127.0.0.1:4321/' }, localStorage: { getItem(key) { storageReads.push(key); return key.includes('language') ? savedLanguage : null; }, setItem() { throw new Error('No preference writes expected.'); } },
    setTimeout: () => 1, clearTimeout() {},
    createLibraryTransfer: () => ({
      async exportArtifact() { timeline.push('transfer.export'); },
      async createSnapshot() { timeline.push('transfer.snapshot'); },
      async listSnapshots() { return []; },
      async restoreSnapshot() { timeline.push('transfer.restore'); },
    }),
    mountNativeEditor: ({ iframe }) => {
      editorCalls.push('mount'); timeline.push('mount');
      return { url: 'data:editor', post: message => posted.push(message), flush: async () => { editorCalls.push('flush'); timeline.push('flush'); if (failSave) throw Object.assign(new Error('Unsaved'), { code: 'EDITOR_UNSAVED_CHANGES' }); editorCalls.push('saved'); timeline.push('saved'); }, dispose() { editorCalls.push('dispose'); timeline.push('dispose'); } };
    },
  });
  vm.runInContext(source + '\nglobalThis.controllerPromise=createUi({root,bridge});', controllerContext);
  const controller = await controllerContext.controllerPromise;
  await setImmediate();
  t.after(() => controller.destroy());
  return { controller, root, bridge, document, window, actions, editorCalls, posted, storageReads, record, original, timeline,
    notify: event => subscribe(event),
    node: selector => root.querySelector(selector),
    click(action, data = {}) { const button = new Element('BUTTON', root); button.dataset = { action, ...data }; root.emit('click', { target: button, detail: 1 }); return button; },
    submit(type, data = {}) { const form = new Element('FORM', root); form.dataset = { dialogType: type, ...data }; form.matches = selector => selector === '.dialog-form'; root.emit('submit', { target: form, preventDefault() {} }); return form; },
    frame: () => nodes.find(node => node.tagName === 'IFRAME'),
  };
}

test('English library ignores old Chinese/system preferences and host/browser language changes without rewriting titles', async t => {
  for (const savedLanguage of ['zh', 'system']) {
    const f = await start(t, { savedLanguage });
    assert.equal(f.document.documentElement.lang, 'en');
    assert.equal('setLanguage' in f.controller, false);
    assert.equal(f.storageReads.some(key => key.includes('language')), false);
    const sidebar = f.node('.design-sidebar').innerHTML;
    assert.match(sidebar, />All</);
    assert.doesNotMatch(sidebar, /data-action="settings"|Follow system|简体中文/);
    const records = f.node('.workspace-panel').querySelector('.records-container').innerHTML;
    assert.match(records, /保留中文作品与批注原文/);
    assert.match(records, />Design systems</);
    f.notify({ type: 'language.changed', language: 'zh-CN' });
    f.window.emit('languagechange', {});
    assert.equal(f.document.documentElement.lang, 'en');
    assert.equal(JSON.stringify(f.record), f.original);
    assert.deepEqual(f.actions.map(value => value.action), ['library.list', 'view.get']);
  }
});

test('native editor boot and forwarded interface messages always use English while artwork text stays unchanged', async t => {
  const f = await start(t, { active: true });
  const boot = f.actions.find(value => value.action === 'editor.document');
  assert.equal(boot.payload.language, 'en');
  assert.ok(boot.payload.channel);
  f.frame().emit('load');
  assert.equal(f.posted.at(-1).preference, 'en');
  assert.equal(f.posted.at(-1).systemLocale, 'en');
  assert.equal(JSON.stringify(f.record), f.original);
});

test('standalone editor URL uses English even with a Chinese host and stored preference', async t => {
  const f = await start(t, { native: false, active: true });
  assert.equal(new URL(f.frame().src).searchParams.get('codexDesignLanguage'), 'en');
  assert.equal(JSON.stringify(f.record), f.original);
});

test('English-only controller still waits for save before switching tabs and closing an active artwork', async t => {
  for (const action of ['activate-tab', 'close-tab']) {
    const f = await start(t, { active: true });
    f.editorCalls.length = 0; f.actions.length = 0;
    f.click(action, { id: action === 'activate-tab' ? 'library' : id });
    await setImmediate();
    assert.deepEqual(f.editorCalls.slice(0, 3), ['flush', 'saved', 'dispose']);
    const viewAction = action === 'activate-tab' ? 'view.activateTab' : 'view.closeTab';
    assert.equal(f.actions.find(value => value.action.startsWith('view.')).action, viewAction);
    assert.ok(f.timeline.lastIndexOf('saved') < f.timeline.lastIndexOf(viewAction));
    assert.equal(f.actions.some(value => /worker|stop/.test(value.action)), false);
  }
});

test('a rejected save keeps the artwork mounted and prevents navigation, including host teardown', async t => {
  const f = await start(t, { active: true, failSave: true });
  f.editorCalls.length = 0; f.actions.length = 0;
  f.click('close-tab', { id }); await setImmediate();
  assert.deepEqual(f.editorCalls, ['flush']);
  assert.equal(f.actions.some(value => value.action.startsWith('view.')), false);
  await assert.rejects(f.bridge.beforeNavigate({ action: 'teardown' }), { code: 'EDITOR_UNSAVED_CHANGES' });
  assert.equal(f.editorCalls.includes('dispose'), false);
});

test('reopen, export, recovery-point creation and restore retain their real save barriers', async t => {
  for (const [action, expected] of [['retry-editor', 'editor.document'], ['export', 'transfer.export'], ['snapshot-create', 'transfer.snapshot'], ['restore', 'transfer.restore']]) {
    const f = await start(t, { active: true }); f.timeline.length = 0;
    if (action === 'restore') f.submit('restore-snapshot', { id, snapshotId: 'existing-recovery-point' });
    else f.click(action, { id });
    await setImmediate();
    assert.ok(f.timeline.indexOf('saved') >= 0, action + ' waits for saved acknowledgement');
    assert.ok(f.timeline.indexOf(expected) > f.timeline.indexOf('saved'), action + ' changes content only after acknowledgement');
  }
  const f = await start(t, { active: true }); f.timeline.length = 0;
  await f.bridge.beforeNavigate({ action: 'openTab', id: 'another-artwork' });
  await f.bridge.beforeNavigate({ action: 'teardown' });
  assert.deepEqual(f.timeline, ['flush', 'saved', 'flush', 'saved']);
});

test('dropdown dismissal after choosing Rename cannot close the modal dialog', async t => {
  const f = await start(t);
  const trigger = f.click('item-menu', { id }); await setImmediate();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.match(f.node('.menu-layer').innerHTML, /role="menu"/);
  f.click('rename', { id }); await setImmediate();
  const dialog = f.node('dialog');
  assert.equal(dialog.open, true);
  assert.equal(f.node('.menu-layer').innerHTML, '');
  f.window.emit('blur');
  f.document.emit('pointerdown', { target: trigger, pointerType: 'mouse' });
  assert.equal(dialog.open, true);
});
