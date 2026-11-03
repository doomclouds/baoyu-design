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

async function start(t, { savedLanguage = 'zh', native = true, active = false, failSave = false, records: inputRecords, purgeResult, purgeError, canDraftComments = false, onCreate, onRename, onFlush, onDocument, onGet, onHistory, onTrash, onRestore, onList, onViewGet } = {}) {
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
      // Parse only real rendered checkbox inputs. The controller can update
      // indeterminate on these nodes; absent selectors must not invent inputs.
      for (const match of value.matchAll(/<input\b[^>]*>/g)) {
        const attrs = new Map([...match[0].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map(attr => [attr[1], attr[2] ?? '']));
        if (attrs.get('type') !== 'checkbox') continue;
        const input = new Element('INPUT', this);
        input.attrs = attrs; input.className = attrs.get('class') || '';
        input.checked = attrs.has('checked'); input.disabled = attrs.has('disabled'); input.indeterminate = false;
        for (const [name, value] of attrs) if (name.startsWith('data-')) input.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
        this.children.push(input);
      }
    }
    classList = { add() {}, remove() {}, toggle() {}, contains: name => this.className.split(' ').includes(name) };
    setAttribute(name, value) { this.attrs.set(name, value); }
    getAttribute(name) { return this.attrs.get(name); }
    removeAttribute(name) { this.attrs.delete(name); }
    querySelector(selector) {
      if (selector === 'input' || selector.startsWith('input[') || /^\[data-(?:action|select-all)/.test(selector)) return this.querySelectorAll(selector)[0] || null;
      if (selector === '.trash-selection-bar' && /class="(?=[^"]*\blibrary-selection-bar\b)(?=[^"]*\btrash-selection-bar\b)[^"]*"/.test(this._html)) return this.querySelector('.library-selection-bar');
      if (selector === '.design-editor-frame' || selector === 'iframe') return [...nodes].reverse().find(node => node.tagName === 'IFRAME' && node.className === 'design-editor-frame' && this.contains(node)) || null;
      if (selector.startsWith('button') && this === root.querySelector('.menu-layer') && this.innerHTML) return this.firstElementChild.querySelector(selector);
      if (!this.slots.has(selector)) this.slots.set(selector, new Element(selector.startsWith('button') ? 'BUTTON' : 'DIV', this));
      return this.slots.get(selector);
    }
    querySelectorAll(selector = '') {
      const selectors = [...selector.matchAll(/\[([\w-]+)(?:([*$^]?=)["']([^"']*)["'])?\]/g)];
      const inputSelector = selector === 'input' || selector.startsWith('input[') || /^\[data-(?:action|select-all)/.test(selector);
      if (!inputSelector) return [];
      const found = [], visited = new Set();
      const visit = node => {
        if (visited.has(node)) return; visited.add(node);
        if (node.tagName === 'INPUT' && selectors.every(([, name, operator, value]) => {
          const actual = node.getAttribute(name);
          return operator === '=' ? actual === value : operator === '$=' ? actual?.endsWith(value) : operator === '^=' ? actual?.startsWith(value) : operator === '*=' ? actual?.includes(value) : actual !== undefined;
        })) found.push(node);
        for (const child of [...node.children, ...node.slots.values()]) visit(child);
      };
      for (const child of [...this.children, ...this.slots.values()]) visit(child);
      return found;
    }
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
      if (action === 'library.list') return onList ? onList(payload, libraryRecords) : libraryRecords;
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
      if (action === 'library.trash' || action === 'library.restore') {
        const apply = () => {
          const current = libraryRecords.find(item => item.id === payload.id);
          if (!current) throw Object.assign(new Error('No such artwork.'), { code: 'NOT_FOUND' });
          const deleted = action === 'library.trash';
          const next = { ...current, deleted, deletedAt: deleted ? new Date().toISOString() : null };
          libraryRecords = libraryRecords.map(item => item.id === payload.id ? next : item);
          if (deleted) view = { ...view, tabs: view.tabs.filter(tab => tab.id !== payload.id), activeTabId: view.activeTabId === payload.id ? 'library' : view.activeTabId };
          return next;
        };
        const hook = action === 'library.trash' ? onTrash : onRestore;
        return hook ? hook(payload, apply) : apply();
      }
      if (action === 'library.purge') {
        if (purgeError) throw purgeError;
        const result = typeof purgeResult === 'function' ? await purgeResult(payload) : purgeResult || { deleted: payload.ids, failed: [] };
        libraryRecords = libraryRecords.filter(item => !result.deleted.includes(item.id));
        return result;
      }
      if (action === 'view.get') return onViewGet ? onViewGet(view) : view;
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
    mountNativeEditor: ({ iframe, artifactId, document: editorDocument, onError, onReady }) => {
      editorCalls.push('mount'); timeline.push('mount');
      const instance = { iframe, artifactId, document: editorDocument, onError, onReady, disposed: false, url: 'data:editor', post: message => posted.push(message),
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
    view: () => view,
    setRecords(records) { libraryRecords = records; },
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

test('editor startup errors retain escaped collapsed details and a working retry without serializing error objects', async t => {
  const f = await start(t, { active: true });
  const editor = f.editorInstances[0];
  editor.onError({ code: 'EDITOR_RUNTIME_ERROR', message: '<img src="x" onerror="run()"> & <a href="https://invalid.example">details</a>', stack: 'PRIVATE_STACK', payload: { token: 'PRIVATE_PAYLOAD' } });
  const html = f.node('.workspace-panel').querySelector('.editor-frame-host').innerHTML;
  assert.match(html, /The editor encountered an error/);
  assert.match(html, /<details class="editor-error-details"><summary>Error details<\/summary><pre>EDITOR_RUNTIME_ERROR\n/);
  assert.match(html, /&lt;img src=&quot;x&quot; onerror=&quot;run\(\)&quot;&gt; &amp; &lt;a href=/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|<img|<a\s|<script|PRIVATE_STACK|PRIVATE_PAYLOAD/);
  assert.equal(editor.disposed, true);
  f.click('retry-editor', { id }); await setImmediate();
  assert.equal(f.editorInstances.length, 2);
  assert.equal(f.frame(), f.editorInstances[1].iframe);
});

test('editor document failures bound raw text and reject nontext or malformed diagnostic fields', async t => {
  const raw = '\u0000\u0080\u0085\u009f\u061c\u200e\u200f\u202eStart <failure>\n' + 'x'.repeat(4500) + 'PRIVATE_TAIL';
  const f = await start(t, { active: true, onDocument: () => { throw { code: 'BAD CODE <script>', message: raw, stack: 'PRIVATE_STACK', cause: 'PRIVATE_CAUSE' }; } });
  const html = f.node('.workspace-panel').querySelector('.editor-frame-host').innerHTML;
  const detail = /<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1];
  assert.ok(detail); assert.ok(detail.length < 4100);
  assert.match(detail, /^Start &lt;failure&gt;\n/); assert.match(detail, /…$/);
  assert.doesNotMatch(html, /BAD CODE|[\u0000\u0080-\u009f\u061c\u200e\u200f\u202e]|PRIVATE_TAIL|PRIVATE_STACK|PRIVATE_CAUSE/);
  for (const value of [null, {}, { message: { token: 'PRIVATE_TOKEN' }, code: 123 }, { message: ' \n\u0000', code: [] }]) {
    const f = await start(t, { active: true, onDocument: () => { throw value; } });
    const html = f.node('.workspace-panel').querySelector('.editor-frame-host').innerHTML;
    assert.doesNotMatch(html, /editor-error-details|PRIVATE_TOKEN/);
    assert.match(html, /data-action="retry-editor"/);
  }
});

test('raw string startup diagnostics stay collapsed and ready or stale callbacks do not replace an editor', async t => {
  const f = await start(t, { active: true });
  const editor = f.editorInstances[0];
  editor.onError('<b>Startup failed</b>');
  const host = f.node('.workspace-panel').querySelector('.editor-frame-host');
  assert.match(host.innerHTML, /The editor encountered an error/);
  assert.match(host.innerHTML, /<pre>&lt;b&gt;Startup failed&lt;\/b&gt;<\/pre>/);
  f.click('retry-editor', { id }); await setImmediate();
  const next = f.editorInstances[1];
  editor.onError({ code: 'EDITOR_RUNTIME_ERROR', message: 'STALE_DIAGNOSTIC' });
  assert.equal(f.frame(), next.iframe); assert.equal(next.disposed, false);
  next.onReady();
  next.onError({ code: 'EDITOR_RUNTIME_ERROR', message: 'READY_DIAGNOSTIC' });
  assert.equal(f.frame(), next.iframe); assert.equal(next.disposed, false);
  assert.doesNotMatch(host.innerHTML, /STALE_DIAGNOSTIC|READY_DIAGNOSTIC|editor-error-details/);
  assert.match(f.node('.toast-layer').innerHTML, /The editor encountered an error/);
  assert.doesNotMatch(f.node('.toast-layer').innerHTML, /READY_DIAGNOSTIC/);
});

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
const selectionControls = fixture => fixture.node('.workspace-panel').querySelector('.library-selection-bar').innerHTML;
const selectionFeedback = fixture => fixture.node('.workspace-panel').querySelector('.selection-feedback');
const selectAllInput = (fixture, trash = false) => fixture.node('.workspace-panel').querySelector('.records-container').querySelector('input[data-action="' + (trash ? 'trash' : 'library') + '-select-all"]');
const libraryRecord = (number, title, extra = {}) => trashRecord(number, title, { deleted: false, deletedAt: null, ...extra });
const selectionCalls = fixture => fixture.actions.filter(item => ['library.trash', 'library.restore'].includes(item.action));
const noSelectionActions = controls => assert.doesNotMatch(controls, /0 selected|data-action="(?:trash-selected|restore-selected|purge-selected|selection-clear)"/);

test('library and Trash put select-all in the leading table column and show no bulk actions at zero selection', async t => {
  const records = ['slides', 'design', 'design-system', 'dashboard'].map((kind, index) => libraryRecord(index + 1, kind + ' artwork', { kind }));
  records.push(trashRecord(9, 'Deleted artwork'));
  const f = await start(t, { records });
  for (const category of ['all', 'slides', 'design', 'design-system', 'dashboard', 'recent', 'trash']) {
    f.click('category', { category }); await setImmediate();
    const trash = category === 'trash', html = renderedRecords(f), count = ['all', 'recent'].includes(category) ? 4 : 1;
    assert.match(html, /<thead><tr><th[^>]*class="[^"]*selection-column/);
    const input = selectAllInput(f, trash);
    assert.ok(input, category + ' has a real rendered header input');
    assert.equal(input.getAttribute('aria-label'), 'Select all ' + count + ' visible');
    assert.equal(input.checked, false); assert.equal(input.indeterminate, false);
    noSelectionActions(trash ? trashControls(f) : selectionControls(f));
    assert.ok(html.indexOf('data-action="' + (trash ? 'trash' : 'library') + '-select"') < html.indexOf('class="record-type-icon"'), 'Each row checkbox precedes its type icon.');
  }
});

test('active selection is visible-only, reports mixed header state and survives layout and refresh without a bar select-all', async t => {
  const records = [libraryRecord(1, 'Alpha one'), libraryRecord(2, 'Alpha two'), libraryRecord(3, 'Beta hidden'), trashRecord(4, 'Alpha deleted')];
  const f = await start(t, { records });
  f.search('Alpha');
  f.check('library-select', true, { id: records[0].id });
  assert.match(selectionControls(f), /1 selected/);
  assert.equal(selectAllInput(f).checked, false); assert.equal(selectAllInput(f).indeterminate, true);
  f.check('library-select', true, { id: records[2].id });
  assert.match(selectionControls(f), /1 selected/);
  f.check('library-select-all', true);
  assert.match(selectionControls(f), /2 selected/);
  assert.doesNotMatch(selectionControls(f), /data-action="library-select-all"/);
  assert.equal(selectAllInput(f).checked, true); assert.equal(selectAllInput(f).indeterminate, false);
  f.click('layout', { layout: 'grid' });
  assert.match(renderedRecords(f), /design-grid/);
  assert.equal(f.node('.workspace-panel').querySelector('.records-container').querySelectorAll('input[data-action="library-select"]').length, 2);
  assert.ok(selectAllInput(f)); assert.equal(selectAllInput(f).checked, true);
  await f.controller.refresh(); assert.match(selectionControls(f), /2 selected/);
  f.setRecords(records.filter(record => record.id !== records[0].id));
  await f.controller.refresh();
  assert.match(selectionControls(f), /1 selected/);
  f.click('layout', { layout: 'list' }); assert.equal(selectAllInput(f).checked, true);
  f.click('selection-clear'); noSelectionActions(selectionControls(f));
});

test('active search, favorites and categories reset selection and cannot target hidden or deleted records', async t => {
  const records = [libraryRecord(1, 'One', { favorite: true }), libraryRecord(2, 'Two'), trashRecord(3, 'Deleted')];
  const f = await start(t, { records });
  f.check('library-select-all', true); f.search('Two'); noSelectionActions(selectionControls(f));
  f.check('library-select-all', true); assert.match(selectionControls(f), /1 selected/);
  f.click('clear-search'); noSelectionActions(selectionControls(f));
  f.check('library-select-all', true); f.click('filter', { value: 'favorites' }); noSelectionActions(selectionControls(f));
  assert.equal(selectAllInput(f).getAttribute('aria-label'), 'Select all 1 visible');
  f.check('library-select', true, { id: records[1].id });
  f.check('library-select', true, { id: records[2].id });
  noSelectionActions(selectionControls(f));
  f.check('library-select-all', true); f.click('category', { category: 'trash' }); await setImmediate(); noSelectionActions(trashControls(f));
  f.click('category', { category: 'all' }); await setImmediate(); noSelectionActions(selectionControls(f));
  f.click('trash-selected'); await setImmediate(); assert.equal(selectionCalls(f).length, 0);
});

test('batch trash is sequential, keeps failures selected by title and reason, and retries only confirmed remaining records', async t => {
  const records = [libraryRecord(1, 'Move first'), libraryRecord(2, 'Busy artwork'), libraryRecord(3, 'Move last')];
  let fail = true, pending = 0, maxPending = 0;
  const f = await start(t, { records, onTrash: async (payload, apply) => {
    maxPending = Math.max(maxPending, ++pending);
    await setImmediate(); pending--;
    if (payload.id === records[1].id && fail) throw Object.assign(new Error('Native editing is active.'), { code: 'ARTIFACT_BUSY' });
    return apply();
  } });
  f.check('library-select-all', true); f.click('trash-selected');
  for (let i = 0; i < 8; i++) await setImmediate();
  assert.equal(maxPending, 1);
  assert.deepEqual(selectionCalls(f).map(call => call.payload.id), records.map(record => record.id));
  assert.equal(f.records().filter(record => record.deleted).length, 2);
  assert.match(selectionControls(f), /1 selected/);
  assert.equal(selectionFeedback(f).hidden, false);
  assert.match(selectionFeedback(f).innerHTML, /Busy artwork/);
  assert.match(selectionFeedback(f).innerHTML, /active editing task/);
  assert.equal(f.actions.some(call => call.action === 'view.closeTab'), false);
  assert.equal(f.actions.at(-1).action, 'view.get');
  fail = false; f.click('trash-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.deepEqual(selectionCalls(f).slice(3).map(call => call.payload.id), [records[1].id]);
  noSelectionActions(selectionControls(f));
});

test('batch restore retains failed Trash selection and never opens restored artwork or permanently deletes it', async t => {
  const records = [trashRecord(1, 'Restore first'), trashRecord(2, 'Locked restore')];
  let fail = true;
  const f = await start(t, { records, onRestore: (payload, apply) => {
    if (payload.id === records[1].id && fail) throw Object.assign(new Error('Restore files locked.'), { code: 'EBUSY' });
    return apply();
  } });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select-all', true); f.click('restore-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.deepEqual(selectionCalls(f).map(call => call.payload.id), records.map(record => record.id));
  assert.equal(f.records()[0].deleted, false); assert.equal(f.records()[1].deletedAt !== null, true);
  assert.match(trashControls(f), /1 selected/);
  assert.equal(selectionFeedback(f).hidden, false);
  assert.match(selectionFeedback(f).innerHTML, /Locked restore/); assert.match(selectionFeedback(f).innerHTML, /files are in use/);
  assert.equal(f.actions.some(call => ['view.openTab', 'view.closeTab', 'library.purge'].includes(call.action)), false);
  fail = false; f.click('restore-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(selectionCalls(f).length, 3); noSelectionActions(trashControls(f));
});

test('batch selection is immutable while busy and duplicate or opposite actions cannot expand its target set', async t => {
  for (const trash of [false, true]) {
    const records = [trash ? trashRecord(1, 'First') : libraryRecord(1, 'First'), trash ? trashRecord(2, 'Second') : libraryRecord(2, 'Second')];
    let release, calls = 0;
    const hook = async (_payload, apply) => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); return apply(); };
    const f = await start(t, { records, ...(trash ? { onRestore: hook } : { onTrash: hook }) });
    if (trash) { f.click('category', { category: 'trash' }); await setImmediate(); }
    const action = trash ? 'restore-selected' : 'trash-selected', prefix = trash ? 'trash' : 'library';
    f.check(prefix + '-select-all', true); f.click(action); await setImmediate();
    f.click(action); f.click(trash ? 'trash-selected' : 'restore-selected'); f.click('selection-clear');
    f.check(prefix + '-select-all', false); f.check(prefix + '-select', false, { id: records[1].id });
    assert.equal(calls, 1); assert.match(trash ? trashControls(f) : selectionControls(f), /2 selected/);
    release(); for (let i = 0; i < 5; i++) await setImmediate();
    assert.deepEqual(selectionCalls(f).map(call => call.payload.id), records.map(record => record.id));
    assert.ok(selectionCalls(f).every(call => call.action === (trash ? 'library.restore' : 'library.trash')));
  }
});

test('unknown batch replies reconcile actual records and view instead of inventing success or losing failure selection', async t => {
  const records = [libraryRecord(1, 'Actually moved'), libraryRecord(2, 'Unconfirmed move')];
  const f = await start(t, { records, onTrash: (payload, apply) => { if (payload.id === records[0].id) apply(); return undefined; } });
  f.check('library-select-all', true); f.click('trash-selected'); for (let i = 0; i < 5; i++) await setImmediate();
  assert.equal(f.records()[0].deleted, true); assert.equal(f.records()[1].deleted, false);
  assert.match(selectionControls(f), /1 selected/);
  assert.equal(selectionFeedback(f).hidden, false);
  assert.match(selectionFeedback(f).innerHTML, /Unconfirmed move/);
  assert.equal(f.actions.some(call => call.action === 'view.closeTab'), false);
  assert.ok(f.actions.filter(call => call.action === 'library.list').length >= 2);
  assert.equal(f.actions.at(-1).action, 'view.get');
});

test('unacknowledged mutation read failures survive clear/reselect and require a fresh exact read before any retry', async t => {
  const record = libraryRecord(1, 'Unknown update');
  let allowRead = false, mutations = 0, reads = 0;
  const f = await start(t, { records: [record], onTrash: (_payload, apply) => ++mutations === 1 ? undefined : apply(),
    onGet: ({ id: requested }) => {
      reads++; assert.equal(requested, record.id);
      if (!allowRead) throw Object.assign(new Error('Read connection unavailable.'), { code: 'BRIDGE_UNAVAILABLE' });
      return f.records().find(record => record.id === requested);
    } });
  f.check('library-select-all', true); f.click('trash-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(mutations, 1); assert.equal(reads, 1);
  assert.match(selectionControls(f), /1 selected/);
  assert.match(selectionFeedback(f).innerHTML, /data-action="selection-refresh"/);
  f.click('selection-clear'); f.check('library-select-all', true); f.click('trash-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(mutations, 1, 'Unconfirmed mutations cannot be replayed because the user cleared the visible selection.');
  assert.equal(reads, 2); assert.match(selectionControls(f), /1 selected/);
  allowRead = true; f.click('trash-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(mutations, 2); assert.equal(reads, 3);
  assert.equal(f.records()[0].deleted, true); noSelectionActions(selectionControls(f));
});

test('a final invalid view reply is shown as a synchronization failure and Refresh never replays a confirmed mutation', async t => {
  const record = libraryRecord(1, 'Move once');
  let views = 0;
  const f = await start(t, { records: [record], onViewGet: view => ++views === 2 ? { tabs: [], activeTabId: 'missing' } : view });
  f.check('library-select-all', true); f.click('trash-selected'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(selectionCalls(f).length, 1); assert.equal(f.records()[0].deleted, true);
  assert.equal(selectionFeedback(f).hidden, false);
  assert.match(selectionFeedback(f).innerHTML, /data-action="selection-refresh"/);
  noSelectionActions(selectionControls(f));
  f.click('trash-selected'); f.click('selection-refresh'); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(selectionCalls(f).length, 1); assert.equal(views, 3);
  assert.equal(selectionFeedback(f).hidden, true);
});

test('trashing an unrelated persistent tab does not flush or replace the active editor', async t => {
  const other = libraryRecord(1, 'Other tab');
  const current = libraryRecord(2, 'Active editor', { id });
  const f = await start(t, { records: [current, other], active: true });
  await f.controller.activateArtifact(other.id); await f.controller.activateArtifact(id); await setImmediate();
  const editor = f.editorInstances.at(-1); f.actions.length = 0; f.editorCalls.length = 0;
  f.click('trash-dialog', { id: other.id }); f.submit('trash', { id: other.id }); for (let i = 0; i < 4; i++) await setImmediate();
  assert.equal(f.editorCalls.includes('flush'), false); assert.equal(editor.disposed, false); assert.equal(f.frame(), editor.iframe);
  assert.equal(f.view().activeTabId, id); assert.equal(f.view().tabs.some(tab => tab.id === other.id), false);
  assert.equal(f.actions.some(call => call.action === 'view.closeTab'), false);
  assert.ok(f.actions.some(call => call.action === 'view.get'));
});

test('trashing the active editor waits for its real save barrier and a refused save keeps the tab and content', async t => {
  for (const failSave of [false, true]) {
    const current = libraryRecord(1, 'Current artwork', { id });
    const f = await start(t, { records: [current], active: true, failSave });
    const editor = f.editorInstances[0]; f.actions.length = 0; f.timeline.length = 0;
    f.click('trash-dialog', { id }); f.submit('trash', { id }); for (let i = 0; i < 4; i++) await setImmediate();
    if (failSave) {
      assert.equal(selectionCalls(f).length, 0); assert.equal(f.view().activeTabId, id);
      assert.equal(editor.disposed, false); assert.equal(f.records()[0].deleted, false);
    } else {
      assert.ok(f.timeline.indexOf('saved') < f.timeline.indexOf('library.trash'));
      assert.equal(f.view().activeTabId, 'library'); assert.equal(f.view().tabs.some(tab => tab.id === id), false);
      assert.equal(f.records()[0].deleted, true);
      assert.equal(f.actions.some(call => call.action === 'view.closeTab'), false);
    }
  }
});

test('destroying during an active save or an uncertain preflight read starts no later mutation or reconciliation', async t => {
  {
    let releaseSave;
    const record = libraryRecord(1, 'Saving artwork', { id });
    const f = await start(t, { records: [record], active: true, onFlush: () => new Promise(resolve => { releaseSave = resolve; }) });
    f.click('trash-dialog', { id }); const form = f.submit('trash', { id }); await setImmediate();
    assert.equal(typeof releaseSave, 'function');
    const submit = form.querySelector('button[type="submit"]'), calls = f.actions.length;
    f.controller.destroy(); releaseSave(); for (let i = 0; i < 4; i++) await setImmediate();
    assert.equal(f.actions.length, calls, 'A completed save after teardown cannot start trash, readback or view refresh.');
    assert.equal(selectionCalls(f).length, 0); assert.equal(f.records()[0].deleted, false);
    assert.equal(form.getAttribute('aria-busy'), 'true'); assert.equal(submit.disabled, true, 'Teardown does not mutate detached dialog controls.');
    assert.equal(f.root.innerHTML, '');
  }
  {
    let releaseRead, reads = 0;
    const record = libraryRecord(1, 'Uncertain artwork');
    const f = await start(t, { records: [record], onTrash: () => undefined, onGet: () => {
      if (++reads === 1) throw Object.assign(new Error('Read unavailable.'), { code: 'BRIDGE_UNAVAILABLE' });
      return new Promise(resolve => { releaseRead = resolve; });
    } });
    f.check('library-select-all', true); f.click('trash-selected'); for (let i = 0; i < 4; i++) await setImmediate();
    assert.equal(selectionCalls(f).length, 1);
    f.click('trash-selected'); await setImmediate(); assert.equal(typeof releaseRead, 'function');
    const calls = f.actions.length;
    f.controller.destroy(); releaseRead(record); for (let i = 0; i < 4; i++) await setImmediate();
    assert.equal(f.actions.length, calls, 'An uncertain preflight completed after teardown cannot replay its mutation or refresh the view.');
    assert.equal(selectionCalls(f).length, 1); assert.equal(reads, 2); assert.equal(f.root.innerHTML, '');
  }
});

test('malformed raw active views cannot normalize away an unrelated live editor or hide invalid duplicate tabs', async t => {
  const current = libraryRecord(1, 'Keep editing', { id }), other = libraryRecord(2, 'Trash other');
  const library = { id: 'library', type: 'library' }, tab = { id, type: 'artifact', artifactId: id };
  const invalidViews = [
    { version: 1, tabs: [library, { id, type: 'artifact' }], activeTabId: id },
    { version: 1, tabs: [library, tab, { ...tab }], activeTabId: id },
    { version: 1, tabs: [library, { id, type: 'library', artifactId: id }], activeTabId: id },
  ];
  for (const invalid of invalidViews) {
    let views = 0;
    const f = await start(t, { records: [current, other], active: true, onViewGet: view => ++views === 1 ? view : invalid });
    const editor = f.editorInstances[0]; f.editorCalls.length = 0;
    f.click('trash-dialog', { id: other.id }); f.submit('trash', { id: other.id }); for (let i = 0; i < 4; i++) await setImmediate();
    assert.equal(selectionCalls(f).length, 1); assert.equal(f.records().find(record => record.id === other.id).deleted, true);
    assert.equal(editor.disposed, false); assert.equal(f.frame(), editor.iframe);
    assert.equal(f.editorCalls.includes('flush'), false);
    assert.match(f.node('.toast-layer').innerHTML, /is-error/);
    assert.ok(f.node('.toast-layer').innerHTML.includes(en.selectionSyncFailed), 'An invalid raw response must be reported rather than silently normalized/applied.');
  }
});

test('a late single Trash result cannot close or write into a replacement Rename dialog', async t => {
  for (const fail of [false, true]) {
    const first = libraryRecord(1, 'Trash A'), second = libraryRecord(2, 'Rename B');
    let finish;
    const f = await start(t, { records: [first, second], onTrash: (_payload, apply) => new Promise((resolve, reject) => {
      finish = () => fail ? reject(Object.assign(new Error('Trash refused.'), { code: 'ARTIFACT_BUSY' })) : resolve(apply());
    }) });
    f.click('trash-dialog', { id: first.id }); const original = f.submit('trash', { id: first.id }); await setImmediate();
    assert.equal(typeof finish, 'function');
    f.click('close-dialog'); f.click('rename', { id: second.id });
    const dialog = f.node('dialog'), replacement = dialog.querySelector('.dialog-form'), html = dialog.innerHTML;
    assert.notEqual(replacement, original); assert.equal(dialog.open, true); assert.match(html, /Rename B/);
    const replacementError = replacement.querySelector('.dialog-error');
    finish(); for (let i = 0; i < 4; i++) await setImmediate();
    assert.equal(dialog.open, true); assert.equal(dialog.innerHTML, html); assert.equal(dialog.querySelector('.dialog-form'), replacement);
    assert.equal(replacementError.textContent, undefined); assert.equal(replacementError.hidden, undefined);
    assert.equal(f.actions.some(call => call.action === 'library.rename'), false);
  }
});

test('destroying a 201-item purge while its first batch is pending never sends the second batch or touches detached controls', async t => {
  const records = Array.from({ length: 201 }, (_, index) => trashRecord(index + 1, 'Purge ' + (index + 1)));
  let finish;
  const f = await start(t, { records, purgeResult: payload => new Promise(resolve => { finish = () => resolve({ deleted: payload.ids, failed: [] }); }) });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select-all', true); f.click('purge-selected'); const form = f.submit('purge'); await setImmediate();
  assert.equal(typeof finish, 'function'); assert.deepEqual(purgeCalls(f).map(call => call.payload.ids.length), [200]);
  const submit = form.querySelector('button[type="submit"]'), calls = f.actions.length;
  f.controller.destroy(); finish(); for (let i = 0; i < 4; i++) await setImmediate();
  assert.deepEqual(purgeCalls(f).map(call => call.payload.ids.length), [200]);
  assert.equal(f.actions.length, calls, 'No later batch, list or view request is allowed after teardown.');
  assert.equal(f.records().length, 1, 'Only the already-issued backend batch may have completed.');
  assert.equal(form.getAttribute('aria-busy'), 'true'); assert.equal(submit.disabled, true);
  assert.equal(f.root.innerHTML, '');
});

test('Trash single delete requires an immutable titled native modal confirmation and Cancel or Escape never calls purge', async t => {
  const deleted = trashRecord(1, 'A <deleted> artwork');
  const active = trashRecord(2, 'Active artwork', { deletedAt: null });
  const f = await start(t, { records: [deleted, active] });
  assert.doesNotMatch(renderedRecords(f), /data-action="purge-dialog"|data-action="trash-select"/);
  f.click('purge-dialog', { id: active.id });
  assert.notEqual(f.node('dialog').open, true);
  f.click('category', { category: 'trash' }); await setImmediate();
  assert.match(renderedRecords(f), /data-action="purge-dialog"/);
  const purgeButton = /<button\b[^>]*data-action="purge-dialog"[^>]*>[\s\S]*?<\/button>/.exec(renderedRecords(f))?.[0];
  assert.ok(purgeButton); assert.match(purgeButton, /aria-label="[^"]+"/); assert.match(purgeButton, /title="[^"]+"/);
  assert.match(purgeButton, /<svg/); assert.equal(purgeButton.replace(/<[^>]*>/g, '').trim(), '', 'Permanent deletion is icon-only in the row.');
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
  assert.equal(selectAllInput(f, true).getAttribute('aria-label'), 'Select all 2 visible');
  assert.match(trashControls(f), /2 selected/);
  assert.match(renderedRecords(f), /class="[^"]*selection-column/);
  assert.doesNotMatch(renderedRecords(f), /Beta hidden|Alpha active/);
  f.click('layout', { layout: 'grid' });
  assert.match(renderedRecords(f), /trash-grid/);
  assert.equal(f.node('.workspace-panel').querySelector('.records-container').querySelectorAll('input[data-action="trash-select"]').length, 2);
  assert.equal(selectAllInput(f, true).checked, true);
  assert.match(trashControls(f), /2 selected/);
  f.click('purge-selected');
  assert.match(f.node('dialog').innerHTML, /Permanently delete 2 designs\?/);
  assert.match(f.node('dialog').innerHTML, /Alpha one/);
  assert.match(f.node('dialog').innerHTML, /Alpha two/);
  assert.doesNotMatch(f.node('dialog').innerHTML, /Beta hidden|Alpha active/);
  f.submit('purge'); await setImmediate();
  assert.deepEqual(Array.from(purgeCalls(f)[0].payload.ids).sort(), [records[0].id, records[1].id].sort());
  noSelectionActions(trashControls(f));
  assert.equal(f.records().length, 2);
  assert.match(f.node('.toast-layer').innerHTML, /2 designs permanently deleted/);
});

test('Trash clears selection when search, favorites or category changes and reconciles selections after refresh', async t => {
  const records = [trashRecord(1, 'One', { favorite: true }), trashRecord(2, 'Two')];
  const f = await start(t, { records });
  f.click('category', { category: 'trash' }); await setImmediate();
  f.check('trash-select', true, { id: records[0].id });
  assert.match(trashControls(f), /1 selected/);
  assert.equal(selectAllInput(f, true).checked, false); assert.equal(selectAllInput(f, true).indeterminate, true);
  await f.controller.refresh(); assert.match(trashControls(f), /1 selected/);
  f.search('Two'); noSelectionActions(trashControls(f));
  f.check('trash-select-all', true); assert.match(trashControls(f), /1 selected/);
  f.click('clear-search'); noSelectionActions(trashControls(f));
  f.check('trash-select-all', true); f.click('filter', { value: 'favorites' });
  noSelectionActions(trashControls(f)); assert.equal(selectAllInput(f, true).getAttribute('aria-label'), 'Select all 1 visible');
  f.check('trash-select-all', true);
  f.click('category', { category: 'all' }); await setImmediate();
  f.click('category', { category: 'trash' }); await setImmediate();
  noSelectionActions(trashControls(f));
  f.check('trash-select-all', true); f.check('trash-select-all', false);
  noSelectionActions(trashControls(f));
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
  noSelectionActions(trashControls(f));
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
