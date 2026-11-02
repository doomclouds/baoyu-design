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
  emit(name, event = {}) { for (const handler of this.listeners.get(name) || []) handler({ target: this, ...event }); }
}

async function start(t, { savedLanguage = 'zh', native = true, active = false, failSave = false, records: inputRecords, purgeResult, purgeError, canDraftComments = false, onCreate, onRename, onFlush, onDocument, onGet, onHistory } = {}) {
  const document = new Surface(), window = new Surface(), nodes = [], storageReads = [], actions = [], editorCalls = [], editorInstances = [], posted = [], timeline = [];
  document.documentElement = {}; document.hidden = false; document.activeElement = null;
  class Element extends Surface {
    attrs = new Map(); children = []; slots = new Map(); dataset = {}; _html = ''; style = {}; className = '';
    constructor(tagName = 'DIV', parent = null) { super(); this.tagName = tagName; this.parent = parent; nodes.push(this); }
    get innerHTML() { return this._html; }
    set innerHTML(value) {
      this._html = value;
      for (const child of new Set([...this.children, ...this.slots.values()])) child.parent = null;
      this.children = []; this.slots.clear();
      const historyId = /data-history-id="([^"]+)"/.exec(value)?.[1];
      if (historyId) { const form = new Element('SECTION', this); form.dataset.historyId = historyId; this.slots.set('[data-history-id]', form); }
    }
    classList = { add() {}, remove() {}, toggle() {}, contains: name => this.className.split(' ').includes(name) };
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) { return this.attrs.get(name); }
    removeAttribute(name) { this.attrs.delete(name); }
    querySelector(selector) {
      if (selector === '.design-editor-frame' || selector === 'iframe') return [...nodes].reverse().find(node => node.tagName === 'IFRAME' && node.className === 'design-editor-frame' && this.contains(node)) || null;
      if (selector.startsWith('button') && this === root.querySelector('.menu-layer') && this.innerHTML) return this.firstElementChild.querySelector(selector);
      if (!this.slots.has(selector)) this.slots.set(selector, new Element(selector.startsWith('button') ? 'BUTTON' : 'DIV', this));
      return this.slots.get(selector);
    }
    querySelectorAll() { return []; }
    get firstElementChild() { return this.innerHTML ? this.querySelector('.menu-panel') : null; }
    getBoundingClientRect() { return { left: 100, right: 140, top: 100, bottom: 140, width: 40, height: 40 }; }
    replaceChildren(...children) { this.innerHTML = ''; this.children = children; for (const child of children) child.parent = this; }
    append(child) { this.children.push(child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    contains(target) { for (; target; target = target.parent) if (target === this) return true; return false; }
    closest(selector) { if (selector === '[data-action]') return this.dataset.action ? this : null; if (selector === '.menu-panel') return this.parent?.className === 'menu-panel' ? this.parent : null; return null; }
    matches() { return false; }
    focus() {
      const previous = document.activeElement;
      if (previous && previous !== this) window.emit('blur', { target: previous, relatedTarget: this });
      document.activeElement = this;
      document.emit('focusin', { target: this });
    }
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    reportValidity() { return true; }
  }
  const root = new Element();
  document.createElement = tag => new Element(tag.toUpperCase());
  const record = { id, kind: 'design-system', title: '保留中文作品与批注原文', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contentStatus: 'ok' };
  const original = JSON.stringify(record);
  let libraryRecords = inputRecords || [record];
  let view = { version: 1, tabs: [{ id: 'library', type: 'library' }, { id, type: 'artifact', artifactId: id }], activeTabId: active ? id : 'library' };
  let subscribe;
  const bridge = { available: true, supportsInlineEditor: native, canDraftComments, language: 'zh-CN', initialState: { artifacts: libraryRecords, viewState: view },
    subscribe(handler) { subscribe = handler; return () => {}; },
    async invoke(action, payload) {
      actions.push({ action, payload }); timeline.push(action);
      if (action === 'library.list') return libraryRecords;
      if (action === 'library.get') {
        if (onGet) return onGet(payload);
        const found = libraryRecords.find(item => item.id === payload.id);
        if (!found) throw Object.assign(new Error('No such artwork.'), { code: 'NOT_FOUND' });
        return found;
      }
      if (action === 'library.create') {
        const created = onCreate ? await onCreate(payload) : { ...record, id: '33333333-3333-4333-8333-333333333333', kind: payload.kind, title: payload.title };
        libraryRecords = [...libraryRecords, created];
        return created;
      }
      if (action === 'library.rename') {
        const renamed = onRename ? await onRename(payload) : { ...libraryRecords.find(item => item.id === payload.id), title: payload.title };
        libraryRecords = libraryRecords.map(item => item.id === payload.id ? renamed : item);
        return renamed;
      }
      if (action === 'library.purge') {
        if (purgeError) throw purgeError;
        const result = typeof purgeResult === 'function' ? await purgeResult(payload) : purgeResult || { deleted: payload.ids, failed: [] };
        libraryRecords = libraryRecords.filter(item => !result.deleted.includes(item.id));
        return result;
      }
      if (action === 'view.get') return view;
      if (action === 'view.openTab') return view = { ...view, tabs: view.tabs.some(tab => tab.id === payload.id) ? view.tabs : [...view.tabs, { id: payload.id, artifactId: payload.id, type: 'artifact' }], activeTabId: payload.id };
      if (action === 'view.activateTab') return view = { ...view, activeTabId: payload.id };
      if (action === 'view.closeTab') return view = { ...view, tabs: view.tabs.filter(tab => tab.id !== payload.id), activeTabId: 'library' };
      if (action === 'editor.document') return onDocument ? onDocument(payload) : { html: '<html><body>' + libraryRecords.find(item => item.id === payload.id)?.title + '</body></html>' };
      if (action === 'editor.open') return { url: 'http://127.0.0.1:4321/editor/' };
      if (action === 'conversation.get') return { binding: null };
      throw new Error('Unexpected action: ' + action);
    },
  };
  const controllerContext = vm.createContext({ document, window, root, bridge, i18next, en, brandIcon: 'brand.svg', BridgeError, supports, unavailableBridge, menuPosition, createMenuDismissal, menuInputMode,
    matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800, crypto: webcrypto, URL, Intl, Date, AbortController, console: { warn() {} },
    navigator: { language: 'zh-CN' }, location: { href: 'http://127.0.0.1:4321/' }, localStorage: { getItem(key) { storageReads.push(key); return key.includes('language') ? savedLanguage : null; }, setItem() { throw new Error('No preference writes expected.'); } },
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.values?.[name] ?? ''; } },
    setTimeout: () => 1, clearTimeout() {},
    createLibraryTransfer: () => ({
      async exportArtifact() { timeline.push('transfer.export'); },
      async createSnapshot() { timeline.push('transfer.snapshot'); },
      async listSnapshots() { return []; },
      async restoreSnapshot() { timeline.push('transfer.restore'); },
    }),
    mountNativeEditor: ({ iframe, artifactId, document: editorDocument }) => {
      editorCalls.push('mount'); timeline.push('mount');
      const instance = { iframe, artifactId, document: editorDocument, disposed: false, url: 'data:editor', post: message => posted.push(message),
        flush: async () => { editorCalls.push('flush'); timeline.push('flush'); if (onFlush) await onFlush(instance); if (failSave) throw Object.assign(new Error('Unsaved'), { code: 'EDITOR_UNSAVED_CHANGES' }); editorCalls.push('saved'); timeline.push('saved'); },
        async openHistory({ signal } = {}) {
          await instance.flush();
          if (signal?.aborted) throw signal.reason;
          editorCalls.push('history'); timeline.push('history.open');
          return onHistory ? onHistory(instance, { signal }) : { opened: true };
        },
        dispose() { instance.disposed = true; editorCalls.push('dispose'); timeline.push('dispose'); } };
      editorInstances.push(instance);
      return instance;
    },
  });
  vm.runInContext(source + '\nglobalThis.controllerPromise=createUi({root,bridge});', controllerContext);
  const controller = await controllerContext.controllerPromise;
  await setImmediate();
  t.after(() => controller.destroy());
  return { controller, root, bridge, document, window, actions, editorCalls, editorInstances, posted, storageReads, record, original, timeline,
    records: () => libraryRecords,
    addExternalRecord(record) { libraryRecords = [...libraryRecords, record]; },
    notify: event => subscribe(event),
    node: selector => root.querySelector(selector),
    click(action, data = {}) { const button = new Element('BUTTON', root); button.dataset = { action, ...data }; button.focus(); root.emit('click', { target: button, detail: 1 }); return button; },
    check(action, checked, data = {}) { const input = new Element('INPUT', root); input.dataset = { action, ...data }; input.checked = checked; root.emit('click', { target: input, detail: 1 }); return input; },
    search(value) { const input = new Element('INPUT', root); input.value = value; input.matches = selector => selector === '.library-search'; root.emit('input', { target: input }); },
    submit(type, data = {}) { const form = new Element('FORM', root); form.dataset = { dialogType: type, ...data }; form.values = data; form.matches = selector => selector === '.dialog-form'; root.querySelector('dialog').slots.set('.dialog-form', form); root.emit('submit', { target: form, preventDefault() {} }); return form; },
    frame: () => root.querySelector('iframe'),
  };
}

test('Version history reuses its recovery-point dialog and opens detailed history in the same artwork after save', async t => {
  const f = await start(t);
  f.click('history', { id }); await setImmediate();
  const dialog = f.node('dialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /data-action="snapshot-create"/);
  assert.match(dialog.innerHTML, /data-action="edit-history"/);
  assert.match(dialog.innerHTML, /Saved recovery points contain artwork content only/);
  assert.doesNotMatch(f.node('.workspace-panel').innerHTML, /data-action="edit-history"/);
  f.click('edit-history', { id }); await setImmediate();
  assert.equal(dialog.open, false);
  assert.equal(f.actions.filter(item => item.action === 'view.openTab' && item.payload.id === id).length, 1);
  assert.equal(f.editorInstances.length, 1);
  assert.equal(f.editorInstances[0].artifactId, id);
  assert.ok(f.timeline.indexOf('saved') < f.timeline.indexOf('history.open'));
  assert.equal(f.actions.some(item => item.action === 'conversation.send'), false);
});

test('detailed history waits for an in-flight editor document and does not start it after the dialog was closed', async t => {
  let release;
  const f = await start(t, { onDocument: () => new Promise(resolve => { release = resolve; }) });
  f.click('history', { id }); await setImmediate();
  f.click('edit-history', { id }); await setImmediate();
  assert.equal(typeof release, 'function');
  assert.equal(f.editorCalls.includes('history'), false);
  f.click('close-dialog');
  release({ html: '<html><body>Ready after cancellation</body></html>' }); await setImmediate();
  assert.equal(f.node('dialog').open, false);
  assert.equal(f.editorCalls.includes('history'), false);
});

test('a deleted artwork or unsupported editor leaves a recoverable inline history error', async t => {
  for (const patch of [{ onGet: async () => ({ id, kind: 'design-system', title: 'Deleted', deleted: true }) },
    { onGet: async () => ({ id, kind: 'design-system', title: 'Missing', contentStatus: 'missing' }) }, { native: false },
    { onHistory: async () => { throw Object.assign(new Error('This editor cannot show detailed History.'), { code: 'NATIVE_HISTORY_UNAVAILABLE' }); } }]) {
    const f = await start(t, patch);
    f.click('history', { id }); await setImmediate();
    const button = f.click('edit-history', { id }); await setImmediate();
    const dialog = f.node('dialog');
    assert.equal(dialog.open, true);
    assert.equal(dialog.querySelector('.edit-history-error').hidden, false);
    assert.ok(dialog.querySelector('.edit-history-error').textContent.length > 0);
    assert.equal(button.disabled, patch.native === false);
    assert.equal(button.getAttribute('aria-busy'), undefined);
    if (patch.onGet || patch.native === false) assert.equal(f.editorCalls.includes('history'), false);
  }
});

test('navigation cancels a pending canonical History open and a late result cannot target the next artwork', async t => {
  let finishHistory, historySignal;
  const secondId = '22222222-2222-4222-8222-222222222222';
  const records = [id, secondId].map((value, index) => ({ id: value, kind: 'design', title: 'Artwork ' + index, contentStatus: 'ok' }));
  const f = await start(t, { active: true, records, onHistory: (_instance, { signal }) => {
    historySignal = signal; return new Promise(resolve => { finishHistory = resolve; });
  } });
  f.click('history', { id }); await setImmediate();
  f.click('edit-history', { id }); await setImmediate();
  assert.equal(historySignal.aborted, false);
  await f.controller.activateArtifact(secondId); await setImmediate();
  assert.equal(historySignal.aborted, true);
  assert.equal(f.editorInstances[0].disposed, true);
  assert.equal(f.node('dialog').open, false);
  finishHistory({ opened: true }); await setImmediate();
  assert.equal(f.node('dialog').open, false);
  assert.equal(f.editorInstances.at(-1).artifactId, secondId);
  assert.equal(f.timeline.filter(item => item === 'history.open').length, 1);
});

test('closing or replacing the history dialog aborts its pending operation without leaving controls busy', async t => {
  for (const action of ['close', 'replace']) {
    let finishHistory, historySignal;
    const f = await start(t, { active: true, onHistory: (_instance, { signal }) => {
      historySignal = signal; return new Promise(resolve => { finishHistory = resolve; });
    } });
    f.click('history', { id }); await setImmediate();
    f.click('edit-history', { id }); await setImmediate();
    const oldForm = f.node('dialog').querySelector('[data-history-id]');
    if (action === 'close') f.click('close-dialog');
    else { f.click('history', { id }); await setImmediate(); }
    assert.equal(historySignal.aborted, true);
    finishHistory({ opened: true }); await setImmediate();
    assert.equal(f.node('dialog').open, action === 'replace');
    if (action === 'replace') {
      assert.notEqual(f.node('dialog').querySelector('[data-history-id]'), oldForm);
      assert.match(f.node('dialog').innerHTML, /data-action="edit-history"/);
      assert.equal(f.node('dialog').querySelector('.edit-history-error').hidden, undefined);
    }
  }
});

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

test('Create, Sort and artwork menus survive trigger blur when their first item receives focus', async t => {
  for (const active of [false, true]) for (const action of ['create', 'sort-menu', 'item-menu']) {
    const f = await start(t, { active });
    const trigger = f.click(action, { id });
    await setImmediate();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', `${action} remains open after focusing its first item`);
    assert.match(f.node('.menu-layer').innerHTML, /role="menu"/);
    assert.notEqual(f.document.activeElement, trigger);
    f.window.emit('blur');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'actual window blur still dismisses the menu');
    assert.equal(f.node('.menu-layer').innerHTML, '');
  }
});

const renameKinds = ['slides', 'design', 'design-system', 'dashboard'];
for (const kind of renameKinds) test(`active ${kind} Rename retires the saved frame before rewriting the index and mounts its new base in the same tab`, async t => {
  const original = { id, kind, title: 'Before rename', contentStatus: 'ok' };
  let f;
  f = await start(t, { active: true, records: [original], onRename: payload => {
    assert.equal(f.editorInstances[0].disposed, true);
    assert.equal(f.frame(), null, 'the old frame cannot autosave during the index mutation');
    return { ...original, title: payload.title };
  } });
  const previousFrame = f.frame();
  f.actions.length = 0; f.timeline.length = 0; f.editorCalls.length = 0;
  f.click('rename', { id });
  const form = f.submit('rename', { id, title: 'After rename' });
  await setImmediate();
  assert.deepEqual(f.editorCalls, ['flush', 'saved', 'dispose', 'mount']);
  assert.ok(f.timeline.indexOf('saved') < f.timeline.indexOf('dispose'));
  assert.ok(f.timeline.indexOf('dispose') < f.timeline.indexOf('library.rename'));
  assert.ok(f.timeline.indexOf('library.rename') < f.timeline.indexOf('editor.document'));
  assert.equal(f.editorInstances.length, 2);
  assert.notEqual(f.frame(), previousFrame);
  assert.equal(previousFrame.parent, null);
  assert.match(f.editorInstances[1].document.html, /After rename/);
  assert.equal(f.actions.filter(call => call.action === 'editor.document').length, 1);
  assert.equal(f.actions.find(call => call.action === 'editor.document').payload.force, true);
  assert.equal(f.actions.some(call => call.action.startsWith('view.') || /conversation\.(?:create|bind)|worker|stop/.test(call.action)), false);
  assert.equal(form.getAttribute('aria-busy'), undefined);
  assert.equal(f.node('dialog').open, false);
});

test('active Rename with a refused flush preserves the exact dirty frame and never renames or rebuilds it', async t => {
  let finishFlush;
  const f = await start(t, { active: true, failSave: true, onFlush: () => new Promise(resolve => { finishFlush = resolve; }) });
  const previous = f.editorInstances[0], frame = f.frame();
  f.actions.length = 0; f.editorCalls.length = 0;
  f.click('rename', { id });
  const form = f.submit('rename', { id, title: 'Must not write' });
  await setImmediate();
  await f.controller.refresh();
  assert.equal(f.frame(), frame); assert.equal(previous.disposed, false);
  finishFlush(); await setImmediate();
  assert.deepEqual(f.editorCalls, ['flush']);
  assert.equal(f.editorInstances.length, 1); assert.equal(previous.disposed, false);
  assert.equal(f.frame(), frame); assert.notEqual(frame.parent, null);
  assert.equal(f.actions.some(call => ['library.rename', 'editor.document'].includes(call.action)), false);
  assert.equal(form.querySelector('.dialog-error').textContent, en.editorSaveFailed);
  assert.equal(f.node('dialog').open, true);
});

test('failed Rename restores the saved disk editor without altering its tab and leaves the error available', async t => {
  const failure = Object.assign(new Error('Rename was refused.'), { code: 'RENAME_REFUSED' });
  const f = await start(t, { active: true, onRename: () => { throw failure; } });
  const previousFrame = f.frame();
  f.actions.length = 0; f.editorCalls.length = 0; f.timeline.length = 0;
  f.click('rename', { id });
  const form = f.submit('rename', { id, title: 'Not written' });
  await setImmediate();
  assert.deepEqual(f.editorCalls, ['flush', 'saved', 'dispose', 'mount']);
  assert.equal(previousFrame.parent, null);
  assert.match(f.editorInstances[1].document.html, /保留中文作品与批注原文/);
  assert.doesNotMatch(f.editorInstances[1].document.html, /Not written/);
  assert.equal(form.querySelector('.dialog-error').textContent, en.actionFailed);
  assert.equal(f.node('dialog').open, true);
  assert.equal(f.actions.filter(call => call.action === 'library.rename').length, 1);
  assert.equal(f.actions.some(call => call.action.startsWith('view.')), false);
});

test('renaming a different artwork leaves the mounted editor and current tab untouched', async t => {
  const other = { id: '22222222-2222-4222-8222-222222222222', kind: 'slides', title: 'Other', contentStatus: 'ok' };
  const current = { id, kind: 'design', title: 'Current', contentStatus: 'ok' };
  const f = await start(t, { active: true, records: [current, other] });
  const frame = f.frame();
  f.actions.length = 0; f.editorCalls.length = 0;
  f.submit('rename', { id: other.id, title: 'Other renamed' });
  await setImmediate();
  assert.deepEqual(f.editorCalls, []); assert.equal(f.frame(), frame);
  assert.equal(f.editorInstances[0].disposed, false); assert.equal(f.editorInstances.length, 1);
  assert.equal(f.actions.some(call => call.action === 'editor.document' || call.action.startsWith('view.')), false);
  assert.equal(f.records().find(record => record.id === other.id).title, 'Other renamed');
});

test('Rename remains single-flight across new forms, refresh and Reopen while the index write is pending', async t => {
  let finish;
  const f = await start(t, { active: true, onRename: payload => new Promise(resolve => {
    finish = () => resolve({ ...f.record, title: payload.title });
  }) });
  f.actions.length = 0;
  f.click('rename', { id });
  f.submit('rename', { id, title: 'First rename' });
  await setImmediate();
  assert.equal(f.frame(), null); assert.equal(f.editorInstances.length, 1);
  await f.controller.refresh();
  f.click('retry-editor', { id });
  const secondForm = f.submit('rename', { id, title: 'Duplicate rename' });
  await setImmediate();
  assert.equal(f.actions.filter(call => call.action === 'library.rename').length, 1);
  assert.equal(f.actions.some(call => call.action === 'editor.document'), false);
  assert.equal(f.frame(), null);
  finish(); await setImmediate();
  assert.equal(f.editorInstances.length, 2);
  assert.match(f.editorInstances[1].document.html, /First rename/);
  assert.equal(secondForm.getAttribute('aria-busy'), undefined);
  assert.equal(f.node('dialog').open, true, 'completion cannot close a replacement dialog/form');
});

test('an editor.document response already in flight cannot remount the old base during Rename', async t => {
  let finishRename, finishOldDocument, documents = 0;
  const f = await start(t, { active: true,
    onDocument: () => ++documents === 1 ? new Promise(resolve => { finishOldDocument = () => resolve({ html: 'Old index base' }); }) : { html: 'Renamed index base' },
    onRename: payload => new Promise(resolve => { finishRename = () => resolve({ ...f.record, title: payload.title }); }),
  });
  assert.equal(f.editorInstances.length, 0);
  f.submit('rename', { id, title: 'New title' }); await setImmediate();
  finishOldDocument(); await setImmediate();
  assert.equal(f.editorInstances.length, 0); assert.equal(f.frame(), null);
  finishRename(); await setImmediate();
  assert.equal(f.editorInstances.length, 1); assert.equal(documents, 2);
  assert.equal(f.editorInstances[0].document.html, 'Renamed index base');
});

test('Rename completion after navigation never reopens its target over the newly active artwork', async t => {
  let finish;
  const other = { id: '22222222-2222-4222-8222-222222222222', kind: 'slides', title: 'Other', contentStatus: 'ok' };
  const original = { id, kind: 'design', title: 'Current', contentStatus: 'ok' };
  const f = await start(t, { active: true, records: [original, other], onRename: payload => new Promise(resolve => { finish = () => resolve({ ...original, title: payload.title }); }) });
  f.submit('rename', { id, title: 'Renamed' }); await setImmediate();
  await f.controller.activateArtifact(other.id); await setImmediate();
  const activeEditor = f.editorInstances.at(-1);
  assert.equal(activeEditor.artifactId, other.id);
  const mounts = f.editorInstances.length;
  finish(); await setImmediate();
  assert.equal(f.editorInstances.length, mounts); assert.equal(activeEditor.disposed, false);
  assert.equal(f.frame(), activeEditor.iframe);
});

test('switching A to B and back during Rename retires B before mounting A from its renamed base', async t => {
  let finish;
  const other = { id: '22222222-2222-4222-8222-222222222222', kind: 'slides', title: 'Other', contentStatus: 'ok' };
  const original = { id, kind: 'design', title: 'Current', contentStatus: 'ok' };
  const f = await start(t, { active: true, records: [original, other], onRename: payload => new Promise(resolve => { finish = () => resolve({ ...original, title: payload.title }); }) });
  f.submit('rename', { id, title: 'New base' }); await setImmediate();
  await f.controller.activateArtifact(other.id); await setImmediate();
  const otherEditor = f.editorInstances.at(-1);
  await f.controller.activateArtifact(id); await setImmediate();
  assert.equal(otherEditor.disposed, true); assert.equal(f.frame(), null);
  const mounts = f.editorInstances.length;
  finish(); await setImmediate();
  assert.equal(f.editorInstances.length, mounts + 1);
  assert.equal(f.editorInstances.at(-1).artifactId, id);
  assert.match(f.editorInstances.at(-1).document.html, /New base/);
  assert.equal(f.frame(), f.editorInstances.at(-1).iframe);
});

test('a view change during the Rename flush cannot dispose the newly active editor', async t => {
  let finishFlush, firstFlush = true;
  const other = { id: '22222222-2222-4222-8222-222222222222', kind: 'slides', title: 'Other', contentStatus: 'ok' };
  const original = { id, kind: 'design', title: 'Current', contentStatus: 'ok' };
  const f = await start(t, { active: true, records: [original, other], onFlush: () => firstFlush ? (firstFlush = false, new Promise(resolve => { finishFlush = resolve; })) : undefined });
  f.submit('rename', { id, title: 'Renamed inactive' }); await setImmediate();
  f.notify({ viewState: { version: 1, tabs: [{ id: 'library', type: 'library' }, { type: 'artifact', artifactId: id }, { type: 'artifact', artifactId: other.id }], activeTabId: other.id } });
  await setImmediate();
  const activeEditor = f.editorInstances.at(-1);
  assert.equal(activeEditor.artifactId, other.id);
  finishFlush(); await setImmediate();
  assert.equal(activeEditor.disposed, false); assert.equal(f.frame(), activeEditor.iframe);
  assert.equal(f.records().find(record => record.id === id).title, 'Renamed inactive');
});

test('Rename completion after workspace disposal cannot mount another iframe', async t => {
  let finish;
  const f = await start(t, { active: true, onRename: payload => new Promise(resolve => { finish = () => resolve({ ...f.record, title: payload.title }); }) });
  f.submit('rename', { id, title: 'Renamed' }); await setImmediate();
  f.controller.destroy();
  finish(); await setImmediate();
  assert.equal(f.editorInstances.length, 1); assert.equal(f.editorInstances[0].disposed, true);
  assert.equal(f.actions.filter(call => call.action === 'editor.document').length, 1, 'only the initial document was requested');
});

const externalId = '22222222-2222-4222-8222-222222222222';
const secondExternalId = '33333333-3333-4333-8333-333333333333';
const externalView = activeTabId => ({ version: 1, tabs: [{ id: 'library', type: 'library' },
  ...[id, externalId, secondExternalId].map(artifactId => ({ id: artifactId, type: 'artifact', artifactId }))], activeTabId });

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) test(`an external ${kind} absent from cached records resolves its exact identity before mounting`, async t => {
  const f = await start(t);
  const external = { id: externalId, kind, title: 'CLI-created artwork', contentStatus: 'ok' };
  f.addExternalRecord(external); f.actions.length = 0;
  f.notify({ type: 'view.changed', viewState: externalView(externalId) });
  await setImmediate();
  const reads = f.actions.filter(call => call.action === 'library.get');
  assert.equal(reads.length, 1); assert.equal(reads[0].payload.id, externalId);
  assert.equal(f.editorInstances.length, 1); assert.equal(f.editorInstances[0].artifactId, externalId);
  assert.match(f.editorInstances[0].document.html, /CLI-created artwork/);
  assert.match(f.node('.workspace-tabs').innerHTML, /CLI-created artwork/);
  assert.equal(f.actions.some(call => call.action.startsWith('view.') || call.action === 'library.create'), false);
});

test('duplicate external views and Reopen share one metadata request and mount once without a false missing state', async t => {
  let finish;
  const external = { id: externalId, kind: 'design', title: 'New external', contentStatus: 'ok' };
  const f = await start(t, { onGet: () => new Promise(resolve => { finish = resolve; }) });
  f.addExternalRecord(external); f.actions.length = 0;
  const event = { type: 'view.changed', viewState: externalView(externalId) };
  f.notify(event); f.notify(event); f.click('retry-editor', { id: externalId }); f.click('retry-editor', { id: externalId });
  await setImmediate();
  assert.equal(f.actions.filter(call => call.action === 'library.get').length, 1);
  assert.equal(f.editorInstances.length, 0);
  const host = f.node('.workspace-panel').querySelector('.editor-frame-host');
  assert.ok(host.innerHTML.includes(en.loadingEditor));
  assert.equal(host.innerHTML.includes(en.restoredTabMissing), false);
  finish(external); await setImmediate();
  assert.equal(f.editorInstances.length, 1);
  assert.equal(f.actions.filter(call => call.action === 'editor.document').length, 1);
  assert.equal(f.actions.some(call => call.action.startsWith('view.') || call.action === 'library.create'), false);
});

test('initial external view and late initial-state metadata share the same pending identity lookup', async t => {
  let finish;
  const external = { id, kind: 'slides', title: 'Initial external artwork', contentStatus: 'ok' };
  const f = await start(t, { records: [], active: true,
    onGet: () => new Promise(resolve => { finish = resolve; }), onDocument: () => ({ html: 'Initial external artwork' }) });
  f.notify({ type: 'initial-state', result: { artifacts: [], viewState: externalView(id) } });
  f.click('retry-editor', { id }); await setImmediate();
  assert.equal(f.actions.filter(call => call.action === 'library.get').length, 1);
  finish(external); await setImmediate();
  assert.equal(f.editorInstances.length, 1); assert.equal(f.editorInstances[0].artifactId, id);
  assert.match(f.node('.workspace-tabs').innerHTML, /Initial external artwork/);
});

test('unknown identity loading distinguishes confirmed missing from transport and permission failures', async t => {
  for (const [code, message] of [['NOT_FOUND', en.restoredTabMissing], ['EACCES', en.fileAccessFailed], ['BRIDGE_UNAVAILABLE', en.bridgeUnavailable]]) {
    const f = await start(t, { onGet: () => { throw Object.assign(new Error('Read failed.'), { code }); } });
    f.actions.length = 0;
    f.notify({ type: 'view.changed', viewState: externalView(externalId) }); await setImmediate();
    const html = f.node('.workspace-panel').querySelector('.editor-frame-host').innerHTML;
    assert.ok(html.includes(message), code + ' retains its actual error meaning');
    if (code !== 'NOT_FOUND') assert.equal(html.includes(en.restoredTabMissing), false);
    assert.equal(f.editorInstances.length, 0);
    assert.equal(f.actions.some(call => call.action === 'editor.document' || call.action === 'library.create'), false);
  }
});

test('invalid metadata responses cannot replace an authored record or mount an arbitrary identity', async t => {
  const valid = { id: externalId, kind: 'design', title: 'Rejected response', contentStatus: 'ok' };
  for (const value of [null, [], { artifact: valid }, { ...valid, id }, { ...valid, kind: 'unknown' }, { ...valid, title: '' }]) {
    const f = await start(t, { onGet: () => value });
    f.notify({ type: 'view.changed', viewState: externalView(externalId) }); await setImmediate();
    const html = f.node('.workspace-panel').querySelector('.editor-frame-host').innerHTML;
    assert.ok(html.includes(en.actionFailed)); assert.equal(html.includes(en.restoredTabMissing), false);
    assert.equal(f.editorInstances.length, 0);
    assert.equal(JSON.stringify(f.record), f.original);
    assert.equal(f.node('.workspace-tabs').innerHTML.includes('Rejected response'), false);
  }
});

test('a late unknown-artwork lookup cannot overwrite the editor subsequently opened for B', async t => {
  let finish;
  const external = { id: externalId, kind: 'design', title: 'Late A', contentStatus: 'ok' };
  const f = await start(t, { onGet: () => new Promise(resolve => { finish = resolve; }) });
  f.addExternalRecord(external);
  f.notify({ type: 'view.changed', viewState: externalView(externalId) }); await setImmediate();
  await f.controller.activateArtifact(id); await setImmediate();
  const editor = f.editorInstances.at(-1);
  assert.equal(editor.artifactId, id);
  const count = f.editorInstances.length;
  finish(external); await setImmediate();
  assert.equal(f.editorInstances.length, count); assert.equal(editor.disposed, false);
  assert.equal(f.frame(), editor.iframe);
});

test('A to B to A identity loading reuses each lookup while only the newest active epoch mounts', async t => {
  const callbacks = new Map();
  const a = { id: externalId, kind: 'design', title: 'External A', contentStatus: 'ok' };
  const b = { id: secondExternalId, kind: 'slides', title: 'External B', contentStatus: 'ok' };
  const f = await start(t, { onGet: ({ id }) => new Promise(resolve => callbacks.set(id, resolve)) });
  f.addExternalRecord(a); f.addExternalRecord(b); f.actions.length = 0;
  f.notify({ type: 'view.changed', viewState: externalView(a.id) });
  f.notify({ type: 'view.changed', viewState: externalView(b.id) });
  f.notify({ type: 'view.changed', viewState: externalView(a.id) }); await setImmediate();
  assert.deepEqual(f.actions.filter(call => call.action === 'library.get').map(call => call.payload.id), [a.id, b.id]);
  callbacks.get(a.id)(a); await setImmediate();
  callbacks.get(b.id)(b); await setImmediate();
  assert.equal(f.editorInstances.length, 1); assert.equal(f.editorInstances[0].artifactId, a.id);
  assert.equal(f.actions.filter(call => call.action === 'editor.document').length, 1);
});

test('workspace disposal invalidates an unfinished identity lookup without mounting or navigating', async t => {
  let finish;
  const external = { id: externalId, kind: 'design', title: 'Late record', contentStatus: 'ok' };
  const f = await start(t, { onGet: () => new Promise(resolve => { finish = resolve; }) });
  f.notify({ type: 'view.changed', viewState: externalView(externalId) }); await setImmediate();
  f.controller.destroy(); f.actions.length = 0;
  finish(external); await setImmediate();
  assert.equal(f.editorInstances.length, 0); assert.deepEqual(f.actions, []);
});

test('an old identity lookup cannot replace a newly renamed artwork record or its mounted base', async t => {
  let finish;
  const external = { id: externalId, kind: 'design', title: 'Before rename', contentStatus: 'ok' };
  const f = await start(t, { onGet: () => new Promise(resolve => { finish = resolve; }) });
  f.addExternalRecord(external);
  f.notify({ type: 'view.changed', viewState: externalView(externalId) }); await setImmediate();
  f.submit('rename', { id: externalId, title: 'After rename' }); await setImmediate();
  assert.equal(f.editorInstances.length, 1);
  const editor = f.editorInstances[0];
  assert.match(editor.document.html, /After rename/);
  finish(external); await setImmediate();
  assert.equal(f.editorInstances.length, 1); assert.equal(editor.disposed, false);
  assert.equal(f.node('.workspace-panel').querySelector('.editor-title-button').textContent, 'After rename');
});

test('a refused dirty navigation guard prevents even metadata lookup for an external target', async t => {
  const f = await start(t, { active: true, failSave: true });
  f.addExternalRecord({ id: externalId, kind: 'design', title: 'External', contentStatus: 'ok' });
  const frame = f.frame(); f.actions.length = 0;
  assert.equal(await f.controller.activateArtifact(externalId), false);
  assert.equal(f.frame(), frame); assert.equal(f.editorInstances[0].disposed, false);
  assert.equal(f.actions.some(call => call.action === 'library.get' || call.action.startsWith('view.')), false);
});

const creationKinds = ['slides', 'design', 'design-system', 'dashboard'];
function primaryCreationButton(html) {
  const markup = html.match(/<button\b[^>]*class="button primary"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(markup, 'a primary creation control is rendered');
  return { markup, action: markup.match(/data-action="([^"]+)"/)?.[1], value: markup.match(/data-value="([^"]+)"/)?.[1] };
}

for (const kind of creationKinds) test(`${kind} category heading and empty action create that kind directly`, async t => {
  for (const surface of ['heading', 'empty']) {
    const f = await start(t, { records: [] });
    f.click('category', { category: kind }); await setImmediate();
    const empty = renderedRecords(f);
    assert.ok(empty.includes(en.emptyCategory[kind].title));
    assert.ok(empty.includes(en.emptyCategory[kind].body));
    assert.doesNotMatch(empty, /Create your first artwork|Start with slides/);
    const control = primaryCreationButton(surface === 'heading' ? f.node('.workspace-panel').innerHTML : empty);
    assert.equal(control.action, 'create-kind');
    assert.equal(control.value, kind);
    assert.ok(control.markup.includes(en.newArtwork[kind]));
    assert.doesNotMatch(control.markup, /aria-haspopup|data-menu-trigger|M6 9l6 6 6-6/);
    f.click(control.action, { value: control.value }); await setImmediate();
    assert.equal(f.node('.menu-layer').innerHTML, '');
    const calls = f.actions.filter(call => call.action === 'library.create');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.kind, kind);
    assert.equal(calls[0].payload.title, en.untitled[kind]);
    const created = f.records().find(record => record.kind === kind);
    assert.equal(f.actions.find(call => call.action === 'view.openTab')?.payload.id, created.id);
    assert.equal(f.actions.find(call => call.action === 'editor.document')?.payload.id, created.id);
  }
});

test('All heading, All empty action and the global sidebar retain the universal creation picker', async t => {
  for (const surface of ['heading', 'empty', 'sidebar']) {
    const f = await start(t, { records: [] });
    if (surface === 'sidebar') { f.click('category', { category: 'dashboard' }); await setImmediate(); }
    const markup = surface === 'sidebar'
      ? f.node('.design-sidebar').innerHTML.match(/<button\b[^>]*class="sidebar-item sidebar-create"[^>]*>[\s\S]*?<\/button>/)?.[0]
      : primaryCreationButton(surface === 'heading' ? f.node('.workspace-panel').innerHTML : renderedRecords(f)).markup;
    assert.ok(markup);
    assert.match(markup, /data-action="create"/);
    assert.match(markup, /aria-haspopup="menu"/);
    f.click('create'); await setImmediate();
    const menu = f.node('.menu-layer').innerHTML;
    for (const kind of creationKinds) assert.ok(menu.includes(`data-value="${kind}"`));
    assert.match(menu, /Import artwork/);
    assert.equal(f.actions.some(call => call.action === 'library.create'), false);
  }
});

test('direct category creation remains single-flight and preserves search and favorites on return', async t => {
  let release;
  const f = await start(t, { records: [], onCreate: payload => new Promise(resolve => { release = () => resolve({ id: '33333333-3333-4333-8333-333333333333', kind: payload.kind, title: payload.title, contentStatus: 'ok' }); }) });
  f.click('category', { category: 'dashboard' }); await setImmediate();
  f.search('needle'); f.click('filter', { value: 'favorites' });
  assert.match(renderedRecords(f), /No matching designs/);
  assert.doesNotMatch(renderedRecords(f), /data-action="create-kind"/);
  const control = primaryCreationButton(f.node('.workspace-panel').innerHTML);
  f.click(control.action, { value: control.value }); f.click(control.action, { value: control.value });
  await setImmediate();
  assert.equal(f.actions.filter(call => call.action === 'library.create').length, 1);
  assert.equal(f.actions.some(call => call.action === 'view.openTab'), false);
  release(); await setImmediate();
  f.click('activate-tab', { id: 'library' }); await setImmediate();
  const panel = f.node('.workspace-panel').innerHTML;
  assert.match(panel, /<h1>Dashboards<\/h1>/);
  assert.match(panel, /value="needle"/);
  assert.match(panel, /class="filter-tab is-selected" data-action="filter" data-value="favorites"/);
});

test('creation from the global picker keeps the current editor save barrier before navigation', async t => {
  for (const failSave of [false, true]) {
    const f = await start(t, { active: true, failSave });
    f.timeline.length = 0; f.actions.length = 0; f.editorCalls.length = 0;
    f.click('create'); f.click('create-kind', { value: 'dashboard' }); await setImmediate();
    assert.equal(f.actions.filter(call => call.action === 'library.create').length, 1);
    assert.ok(f.editorCalls.includes('flush'));
    if (failSave) {
      assert.equal(f.actions.some(call => call.action === 'view.openTab'), false);
      assert.equal(f.editorCalls.includes('dispose'), false);
    } else {
      assert.ok(f.timeline.indexOf('saved') < f.timeline.indexOf('view.openTab'));
      assert.ok(f.editorCalls.includes('dispose'));
    }
  }
});

function trashRecord(number, title, extra = {}) {
  return { id: '22222222-2222-4222-8222-' + String(number).padStart(12, '0'), kind: 'design', title, deletedAt: '2026-11-01T00:00:00Z',
    createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', contentStatus: 'ok', ...extra };
}
const purgeCalls = fixture => fixture.actions.filter(item => item.action === 'library.purge');
const trashControls = fixture => fixture.node('.workspace-panel').querySelector('.trash-selection-bar').innerHTML;
const renderedRecords = fixture => fixture.node('.workspace-panel').querySelector('.records-container').innerHTML;

test('Trash single delete requires an immutable titled native modal confirmation and Cancel or Escape never calls purge', async t => {
  const deleted = trashRecord(1, 'A <deleted> artwork');
  const active = trashRecord(2, 'Active artwork', { deletedAt: null });
  const f = await start(t, { records: [deleted, active] });
  assert.doesNotMatch(renderedRecords(f), /data-action="purge-dialog"|data-action="trash-select"/);
  f.click('purge-dialog', { id: active.id });
  assert.notEqual(f.node('dialog').open, true);
  f.click('category', { category: 'trash' }); await setImmediate();
  assert.match(renderedRecords(f), /data-action="purge-dialog"/);
  assert.match(renderedRecords(f), />Delete permanently</);
  f.click('purge-dialog', { id: deleted.id });
  assert.equal(f.node('dialog').open, true);
  assert.match(f.node('dialog').innerHTML, /Permanently delete 1 design\?/);
  assert.match(f.node('dialog').innerHTML, /A &lt;deleted&gt; artwork/);
  assert.match(f.node('dialog').innerHTML, /This cannot be undone/);
  assert.equal(purgeCalls(f).length, 0);
  f.click('close-dialog'); f.submit('purge'); await setImmediate();
  assert.equal(f.node('dialog').open, false);
  assert.equal(purgeCalls(f).length, 0);
  f.click('purge-dialog', { id: deleted.id });
  f.node('dialog').emit('cancel', { preventDefault() { throw new Error('Idle Escape should close normally.'); } });
  f.submit('purge'); await setImmediate();
  assert.equal(purgeCalls(f).length, 0);
  f.click('purge-dialog', { id: deleted.id }); f.submit('purge'); await setImmediate();
  assert.deepEqual(Array.from(purgeCalls(f)[0].payload.ids), [deleted.id]);
  assert.equal(f.node('dialog').open, false);
  assert.match(f.node('.toast-layer').innerHTML, /1 design permanently deleted/);
  assert.equal(f.records().some(record => record.id === active.id), true);
});

test('Trash selection and select-all follow the filtered visible list and survive changing to cards', async t => {
  const records = [trashRecord(1, 'Alpha one'), trashRecord(2, 'Alpha two'), trashRecord(3, 'Beta hidden'), trashRecord(4, 'Alpha active', { deletedAt: null })];
  const f = await start(t, { records });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.search('Alpha'); f.check('trash-select-all', true);
  assert.match(trashControls(f), /Select all 2 visible/);
  assert.match(trashControls(f), /2 selected/);
  assert.match(renderedRecords(f), /trash-selection-column/);
  assert.doesNotMatch(renderedRecords(f), /Beta hidden|Alpha active/);
  f.click('layout', { layout: 'grid' });
  assert.match(renderedRecords(f), /trash-grid/);
  assert.equal((renderedRecords(f).match(/trash-card-selection/g) || []).length, 2);
  assert.match(trashControls(f), /2 selected/);
  f.click('purge-selected');
  assert.match(f.node('dialog').innerHTML, /Permanently delete 2 designs\?/);
  assert.match(f.node('dialog').innerHTML, /Alpha one/);
  assert.match(f.node('dialog').innerHTML, /Alpha two/);
  assert.doesNotMatch(f.node('dialog').innerHTML, /Beta hidden|Alpha active/);
  f.submit('purge'); await setImmediate();
  assert.deepEqual(Array.from(purgeCalls(f)[0].payload.ids).sort(), [records[0].id, records[1].id].sort());
  assert.match(trashControls(f), /0 selected/);
  assert.equal(f.records().length, 2);
  assert.match(f.node('.toast-layer').innerHTML, /2 designs permanently deleted/);
});

test('Trash clears selection when search, favorites or category changes and reconciles selections after refresh', async t => {
  const records = [trashRecord(1, 'One', { favorite: true }), trashRecord(2, 'Two')];
  const f = await start(t, { records });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select', true, { id: records[0].id });
  assert.match(trashControls(f), /1 selected/);
  await f.controller.refresh(); assert.match(trashControls(f), /1 selected/);
  f.search('Two'); assert.match(trashControls(f), /0 selected/);
  f.check('trash-select-all', true); assert.match(trashControls(f), /1 selected/);
  f.click('clear-search'); assert.match(trashControls(f), /0 selected/);
  f.check('trash-select-all', true); f.click('filter', { value: 'favorites' });
  assert.match(trashControls(f), /0 selected/); assert.match(trashControls(f), /Select all 1 visible/);
  f.check('trash-select-all', true);
  f.click('category', { category: 'all' }); await setImmediate();
  f.click('category', { category: 'trash' }); await setImmediate();
  assert.match(trashControls(f), /0 selected/);
  f.check('trash-select-all', true); f.check('trash-select-all', false);
  assert.match(trashControls(f), /0 selected/);
  f.click('purge-selected'); assert.equal(purgeCalls(f).length, 0);
});

test('Trash partial deletion removes only confirmed successes, retains failed items and selection, and retries only remaining titles', async t => {
  const records = [trashRecord(1, 'Delete me'), trashRecord(2, 'Busy artwork')];
  let attempt = 0;
  const f = await start(t, { records, purgeResult: payload => ++attempt === 1
    ? { deleted: [records[0].id], failed: [{ id: records[1].id, error: { code: 'ARTIFACT_BUSY', message: 'Native task is running.' } }] }
    : { deleted: payload.ids, failed: [] } });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select-all', true); f.click('purge-selected'); f.submit('purge'); await setImmediate();
  assert.doesNotMatch(renderedRecords(f), /Delete me/);
  assert.match(renderedRecords(f), /Busy artwork/);
  assert.match(trashControls(f), /1 selected/);
  assert.equal(f.node('dialog').open, true);
  assert.match(f.node('dialog').innerHTML, /Permanently delete 1 design\?/);
  assert.doesNotMatch(f.node('dialog').innerHTML, /Delete me/);
  assert.match(f.node('dialog').querySelector('.dialog-error').textContent, /1 design permanently deleted\. Permanent deletion did not finish for 1 design/);
  assert.match(f.node('dialog').querySelector('.dialog-error').textContent, /Busy artwork: This artwork has an active editing task/);
  assert.match(f.node('.toast-layer').innerHTML, /is-error/);
  f.submit('purge'); await setImmediate();
  assert.deepEqual(Array.from(purgeCalls(f)[1].payload.ids), [records[1].id]);
  assert.equal(f.node('dialog').open, false);
  assert.match(trashControls(f), /0 selected/);
});

test('Trash preflight errors keep every item and selection and show failure without a success claim', async t => {
  const records = [trashRecord(1, 'Keep one'), trashRecord(2, 'Keep two')];
  const f = await start(t, { records, purgeError: Object.assign(new Error('Another writer owns the library.'), { code: 'LIBRARY_BUSY' }) });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select-all', true); f.click('purge-selected'); f.submit('purge'); await setImmediate();
  assert.equal(f.records().length, 2);
  assert.match(trashControls(f), /2 selected/);
  assert.equal(f.node('dialog').open, true);
  assert.match(f.node('dialog').querySelector('.dialog-error').textContent, /Permanent deletion did not finish for 2 designs/);
  assert.match(f.node('dialog').querySelector('.dialog-error').textContent, /The library is busy/);
  assert.doesNotMatch(f.node('.toast-layer').innerHTML, /permanently deleted/);
});

test('Trash reports a failed deletion that already removed some content without implying rollback or full success', async t => {
  const record = trashRecord(1, 'Partly removed');
  const f = await start(t, { records: [record], purgeResult: { deleted: [], failed: [{ id: record.id, removed: ['artwork'], error: { code: 'EBUSY', message: 'Snapshot directory is locked.' } }] } });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select-all', true); f.click('purge-selected'); f.submit('purge'); await setImmediate();
  assert.equal(f.records().length, 1);
  assert.match(trashControls(f), /1 selected/);
  const message = f.node('dialog').querySelector('.dialog-error').textContent;
  assert.match(message, /Permanent deletion did not finish/);
  assert.match(message, /Some saved content was removed\. Retry to finish/);
  assert.match(message, /The artwork files are in use/);
  assert.doesNotMatch(f.node('.toast-layer').innerHTML, /permanently deleted/);
});

test('Trash keeps a confirmed selection immutable during an in-flight deletion and blocks duplicate submits or dismissal', async t => {
  const record = trashRecord(1, 'One');
  let release;
  const f = await start(t, { records: [record], purgeResult: () => new Promise(resolve => { release = resolve; }) });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.click('purge-dialog', { id: record.id }); f.submit('purge'); await setImmediate();
  f.submit('purge'); f.click('close-dialog'); f.check('trash-select-all', false);
  let prevented = false;
  f.node('dialog').emit('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.node('dialog').open, true);
  assert.equal(purgeCalls(f).length, 1);
  release({ deleted: [record.id], failed: [] }); await setImmediate();
  assert.equal(f.node('dialog').open, false);
});

test('Trash selections larger than one service request are confirmed once and deleted in bounded batches', async t => {
  const records = Array.from({ length: 201 }, (_, index) => trashRecord(index + 1, 'Artwork ' + (index + 1)));
  const f = await start(t, { records });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select-all', true); f.click('purge-selected');
  assert.match(f.node('dialog').innerHTML, /Permanently delete 201 designs\?/);
  f.submit('purge'); await setImmediate();
  assert.deepEqual(purgeCalls(f).map(call => call.payload.ids.length), [200, 1]);
  assert.equal(f.records().length, 0);
  assert.match(f.node('.toast-layer').innerHTML, /201 designs permanently deleted/);
});

test('native comment draft capability is forwarded only from the host boolean', async t => {
  for (const canDraftComments of [false, true]) {
    const f = await start(t, { active: true, canDraftComments });
    assert.equal(f.actions.find(call => call.action === 'editor.document').payload.canDraftComments, canDraftComments);
  }
});
