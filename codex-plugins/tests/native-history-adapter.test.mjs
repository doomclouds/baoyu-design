import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adaptNativeHistoryUi } from '../source/scripts/native-history-adapter.mjs';

const sourceRoot = fileURLToPath(new URL('../../skills/', import.meta.url));
const readSource = kind => fs.readFile(path.join(sourceRoot, 'claude-' + kind, 'scripts/editor/share-ui.js'), 'utf8');
const drain = () => new Promise(resolve => setImmediate(resolve));

class Target {
  listeners = new Map();
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatch(name, extra = {}) {
    for (const handler of [...(this.listeners.get(name) || [])]) handler({ target: this, preventDefault() {}, stopPropagation() {}, composedPath: () => [this], ...extra });
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, entries) => count + entries.size, 0); }
}

class Element extends Target {
  children = []; attributes = new Map(); style = {}; parentElement = null; shadowRoot = null; hidden = false; scrollTop = 0;
  constructor(tagName, document) { super(); this.tagName = tagName.toUpperCase(); this.ownerDocument = document; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', String(value)); }
  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name), toggle: (name, enabled) => {
      const values = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled ?? !values.has(name)) values.add(name); else values.delete(name);
      this.className = [...values].join(' ');
    } };
  }
  append(...items) {
    for (const item of items) { if (item instanceof Element) { item.remove(); item.parentElement = this; } this.children.push(item); }
  }
  replaceChildren(...items) { for (const item of [...this.children]) if (item instanceof Element) item.remove(); this.children = []; this.append(...items); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; } }
  attachShadow() { this.shadowRoot = new Element('shadow-root', this.ownerDocument); return this.shadowRoot; }
  insertAdjacentHTML() { /* SVG markup has no behavior needed by these controller tests. */ }
  get textContent() { return this.children.map(item => item instanceof Element ? item.textContent : String(item)).join(''); }
  get childElementCount() { return this.children.filter(item => item instanceof Element).length; }
  get firstChild() { return this.children[0] ?? null; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[')) {
      const [, name, value] = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector) || [];
      return value === undefined ? this.hasAttribute(name) : this.getAttribute(name) === value;
    }
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector) {
    for (const child of this.children) if (child instanceof Element) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
  getBoundingClientRect() {
    if (this.style.position === 'fixed' && !this.hidden) {
      const width = Number.parseFloat(this.style.width) || 0, height = Number.parseFloat(this.style.height) || 0;
      const right = this.ownerDocument.defaultView.innerWidth - Number.parseFloat(this.style.right), top = Number.parseFloat(this.style.top);
      return { width, height, left: right - width, right, top, bottom: top + height };
    }
    return { x: 0, y: 0, width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 };
  }
  focus() { if (!this.hidden && this.style.visibility !== 'hidden') this.ownerDocument.activeElement = this; }
  click() { this.dispatch('click'); }
}

function nodes(root) {
  return [root, ...(root.shadowRoot ? nodes(root.shadowRoot) : []), ...root.children.flatMap(child => child instanceof Element ? nodes(child) : [])];
}

const version = { n: 1, at: '2026-11-02T01:00:00Z', first: '2026-11-02T01:00:00Z', by: 'agent', name: 'Agent',
  current: false, preview: 'https://codex-design.invalid/__history/1/preview/', files: [{ path: 'project/slides/cover.html', op: 'edited', label: { en: 'Cover', zh: '封面' } }] };
const list = { rows: [version], notices: [], canRestore: true, me: 'local' };

function runtime(source, { flush = async () => true, fetcher, canRestore = true, preview, closePreview } = {}) {
  const document = new Target();
  document.body = new Element('body', document); document.hidden = false; document.activeElement = document.body;
  document.createElement = tag => new Element(tag, document);
  const target = new Target(), requests = [], intervals = new Map(), timeouts = new Map(), opens = [];
  document.defaultView = target;
  let sequence = 0;
  Object.assign(target, { document, innerWidth: 1200, innerHeight: 800, navigator: { language: 'zh-CN' }, Intl, Date, Set, Map, Object,
    CSS: { escape: value => String(value) }, __baoyuHistory: { base: 'https://codex-design.invalid/', canRestore, ...(preview ? { preview } : {}) },
    __CODEX_DESIGN_PREVIEW_CLOSE__: closePreview,
    __CODEX_DESIGN_EDITOR_FLUSH__: flush,
    setInterval: (fn, delay) => { const id = ++sequence; intervals.set(id, { fn, delay }); return id; },
    clearInterval: id => intervals.delete(id), setTimeout: (fn, delay) => { const id = ++sequence; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout: id => timeouts.delete(id), open: (...args) => opens.push(args), location: { href: 'https://codex-design.invalid/' },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      const answer = fetcher ? await fetcher(url, options) : url.endsWith('/notices') ? { notices: [] } : list;
      if (answer instanceof Response) return answer;
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  target.window = target; target.globalThis = target;
  const context = vm.createContext(target);
  const code = adaptNativeHistoryUi(source);
  vm.runInContext(code, context);
  const button = label => nodes(document.body).find(node => node.tagName === 'BUTTON' && node.textContent === label);
  const role = name => nodes(document.body).find(node => node.getAttribute('role') === name);
  return { target, document, code, requests, intervals, timeouts, opens, context, button, role, api: () => target.__CODEX_DESIGN_NATIVE_HISTORY__ };
}

test('all four actual upstream share resources yield English canonical History only', async () => {
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const source = await readSource(kind), actual = runtime(source);
    await drain();
    assert.doesNotMatch(actual.code, /__baoyuShare|__baoyuArchive|__baoyuSave|__baoyuPresence|\/__share\/|new re\(|new ie\(/);
    assert.match(actual.code, /var y=false,/);
    assert.match(actual.code, /class\{button=o\("button"/);
    assert.equal(nodes(actual.document.body).filter(node => node.hasAttribute('data-baoyu-history-layer')).length, 1);
    assert.equal(nodes(actual.document.body).filter(node => node.hasAttribute('data-baoyu-archive-layer') || node.hasAttribute('data-baoyu-save-layer')).length, 0);
    const anchor = nodes(actual.document.body).find(node => node.hasAttribute('data-codex-native-history-anchor'));
    assert.equal(anchor.hidden, false); assert.equal(anchor.style.visibility, 'hidden'); assert.equal(anchor.style.opacity, '0');
    assert.equal(anchor.tabIndex, -1); assert.equal(anchor.getAttribute('aria-hidden'), 'true');
    assert.equal(anchor.getBoundingClientRect().width, 1, 'An invisible anchor still contributes top-right geometry.');
    assert.equal(actual.requests.length, 1); assert.ok(actual.requests[0].url.endsWith('/__history/notices'));
    assert.equal(await actual.api().open(), true);
    assert.equal(actual.role('dialog').getAttribute('aria-label'), 'Version history', 'System Chinese locale must not translate the plugin UI.');
    assert.equal(actual.role('dialog').style.top, '27px');
    assert.equal(actual.intervals.size, 2);
    actual.api().dispose();
    assert.equal(actual.intervals.size, 0); assert.equal(actual.timeouts.size, 0);
    assert.equal(actual.document.body.children.length, 0);
    assert.equal(actual.document.listenerCount(), 0); assert.equal(actual.target.listenerCount(), 0);
  }
});

test('canonical diff and file-only restore retain the actual routes, confirmation and payload', async () => {
  const actual = runtime(await readSource('slides'), { fetcher: async (url, options) => {
    if (url.includes('/diff?')) return { lines: [['-', 'Old heading'], ['+', 'New heading']], added: 1, removed: 1 };
    if (options.method === 'POST') return { restored: true };
    return url.endsWith('/notices') ? { notices: [] } : list;
  } });
  assert.equal(await actual.api().open(), true);
  const row = nodes(actual.document.body).find(node => node.classList.contains('ver'));
  row.click();
  actual.button('Changes').click(); await drain();
  assert.ok(actual.requests.some(request => request.url.endsWith('/__history/1/diff?path=project%2Fslides%2Fcover.html')));
  const differences = nodes(actual.document.body).filter(node => node.classList.contains('dl')).map(node => node.textContent).join('\n');
  assert.match(differences, /Old heading/); assert.match(differences, /New heading/);
  actual.button('Restore just this').click();
  assert.equal(actual.role('alertdialog').getAttribute('aria-label'), 'Restore just this part?');
  assert.equal(actual.requests.filter(request => request.method === 'POST').length, 0);
  actual.button('Restore').click(); await drain();
  const post = actual.requests.find(request => request.method === 'POST');
  assert.equal(post.url, 'https://codex-design.invalid/__history/1/restore');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.body), { paths: ['project/slides/cover.html'] });
  actual.api().dispose(); assert.equal(actual.timeouts.size, 0); assert.equal(actual.intervals.size, 0);
});

test('canonical partial-recovery notices retain the compared base and require another choice after that base changes', async () => {
  const notice = { id: 'overwritten-1', kind: 'overwritten', by: 'human', name: 'Second author', lostBy: 'human', lostName: 'First author',
    at: '2026-11-02T01:00:00Z', part: true, label: { en: 'Cover', zh: '封面' } };
  let diffReads = 0, recoveries = 0;
  const actual = runtime(await readSource('slides'), { fetcher: async (url, options) => {
    if (url.endsWith('/notices')) return { notices: [notice] };
    if (url.endsWith('/notice/overwritten-1/diff')) {
      diffReads++;
      return { now: { 'project/slides/cover.html': String(diffReads).repeat(64) }, lines: [['-', 'Current heading'], ['+', 'Lost heading']], added: 1, removed: 1 };
    }
    if (url.endsWith('/notice/overwritten-1/recover') && options.method === 'POST') {
      recoveries++;
      return new Response(JSON.stringify({ code: 'changed', message: 'The artwork changed.' }), { status: 409 });
    }
    return { ...list, notices: [notice] };
  } });
  await actual.api().open();
  actual.button('Compare').click(); await drain();
  assert.equal(diffReads, 1);
  actual.button('Bring back').click();
  const confirmation = actual.role('alertdialog');
  assert.equal(confirmation.getAttribute('aria-label'), 'Bring back what was saved over?');
  nodes(confirmation).find(node => node.tagName === 'BUTTON' && node.textContent === 'Bring back').click();
  await drain();
  const posted = actual.requests.filter(request => request.method === 'POST');
  assert.equal(posted.length, 1); assert.equal(recoveries, 1);
  assert.equal(posted[0].url, 'https://codex-design.invalid/__history/notice/overwritten-1/recover');
  assert.deepEqual(JSON.parse(posted[0].body), { now: { 'project/slides/cover.html': '1'.repeat(64) } });
  assert.equal(diffReads, 2, 'The canonical changed-base branch refreshes the comparison.');
  assert.match(actual.role('dialog').textContent, /This changed while you were/);
  await drain();
  assert.equal(recoveries, 1, 'A new comparison must not silently retry the write.');
  actual.api().dispose(); assert.equal(actual.intervals.size, 0);
});

test('disposing a canonical restore confirmation cancels it without a write', async () => {
  const actual = runtime(await readSource('design'));
  await actual.api().open();
  nodes(actual.document.body).find(node => node.classList.contains('ver')).click();
  actual.button('Restore this version').click();
  assert.ok(actual.role('alertdialog'));
  actual.api().dispose(); await drain();
  assert.equal(actual.requests.filter(request => request.method === 'POST').length, 0);
  assert.equal(actual.intervals.size, 0); assert.equal(actual.timeouts.size, 0);
  assert.equal(actual.document.body.children.length, 0);
});

test('opening is single-flight, requires a successful available flush and close removes real global listeners', async () => {
  let finishFlush, flushes = 0;
  const actual = runtime(await readSource('design'), { flush: () => { flushes++; return new Promise(resolve => { finishFlush = resolve; }); } });
  const first = actual.api().open(), second = actual.api().open();
  assert.equal(first, second); assert.equal(flushes, 1); assert.equal(actual.role('dialog'), undefined);
  finishFlush(false);
  await assert.rejects(first, { code: 'EDITOR_UNSAVED_CHANGES' });
  assert.equal(actual.role('dialog'), undefined);
  assert.equal(actual.requests.filter(request => request.url.endsWith('/__history')).length, 0);
  actual.target.__CODEX_DESIGN_EDITOR_FLUSH__ = async () => true;
  assert.equal(await actual.api().open(), true);
  assert.equal(actual.document.listenerCount(), 1); assert.equal(actual.target.listenerCount(), 3);
  actual.api().close();
  assert.equal(actual.role('dialog'), undefined);
  assert.equal(actual.document.listenerCount(), 0); assert.equal(actual.target.listenerCount(), 0);
  assert.equal(actual.intervals.size, 1, 'Only the canonical passive history-notice watcher remains until dispose.');
  actual.api().dispose(); assert.equal(actual.intervals.size, 0);
});

test('dispose during the canonical asynchronous open clears late timers and does not leave dialog layers', async () => {
  let finish;
  const actual = runtime(await readSource('design-system'), { fetcher: async url => url.endsWith('/notices') ? { notices: [] } : new Promise(resolve => { finish = resolve; }) });
  const api = actual.api(), opening = api.open(); await drain();
  assert.ok(actual.role('dialog'));
  api.dispose(); assert.equal(actual.api(), undefined);
  finish(list);
  assert.equal(await opening, false);
  assert.equal(actual.intervals.size, 0); assert.equal(actual.timeouts.size, 0); assert.equal(actual.document.body.children.length, 0);
  assert.equal(actual.document.listenerCount(), 0); assert.equal(actual.target.listenerCount(), 0);
  assert.equal(await api.open(), false);
});

test('close/dispose while waiting for flush cancels opening without making a history-list request', async () => {
  for (const action of ['close', 'dispose']) {
    let finish;
    const actual = runtime(await readSource('dashboard'), { flush: () => new Promise(resolve => { finish = resolve; }) });
    const api = actual.api(), opening = api.open();
    api[action](); finish(true);
    assert.equal(await opening, false);
    assert.equal(actual.requests.filter(request => request.url.endsWith('/__history')).length, 0);
    api.dispose(); assert.equal(actual.intervals.size, 0); assert.equal(actual.document.body.children.length, 0);
  }
});

test('reinstall disposes the prior canonical controller and keeps one hidden anchor and notice timer', async () => {
  const actual = runtime(await readSource('slides'));
  const old = actual.api(); await old.open();
  vm.runInContext(actual.code, actual.context); await drain();
  assert.notEqual(actual.api(), old);
  assert.equal(await old.open(), false);
  assert.equal(actual.intervals.size, 1);
  assert.equal(nodes(actual.document.body).filter(node => node.hasAttribute('data-baoyu-history-layer')).length, 1);
  assert.equal(nodes(actual.document.body).filter(node => node.hasAttribute('data-codex-native-history-anchor')).length, 1);
  actual.api().dispose(); assert.equal(actual.document.body.children.length, 0); assert.equal(actual.intervals.size, 0);
});

test('the actual canonical historical banner closes its native preview rather than navigating to a virtual URL', async () => {
  let closed = 0;
  const actual = runtime(await readSource('slides'), { canRestore: false,
    preview: { n: 1, at: '2026-11-02T01:00:00Z', by: 'agent', name: 'Agent', current: false, current_url: 'https://codex-design.invalid/artifacts/current/' },
    closePreview: () => { closed++; } });
  const before = actual.target.location.href;
  const button = actual.button('Back to current');
  assert.ok(button);
  button.click();
  assert.equal(closed, 1);
  assert.equal(actual.target.location.href, before);
  assert.equal(actual.requests.length, 0);
  actual.api().dispose(); assert.equal(actual.document.body.children.length, 0);
});

test('source drift is refused before any Share/Archive code can execute', async () => {
  const source = await readSource('slides');
  const changes = [
    source.replace('var y=/^zh\\b/i.test(navigator.language),', 'var y=true,'),
    source.replace('var Oe="/__share/save"', 'var Oe="/__share/changed"'),
    source.replace('var l=y?{title:', 'var l=y?{heading:'),
    source.replace('function be(){', 'function changed(){'),
    source.replace('e(),window.setInterval(()=>void e(),5e3)', 'e(),window.setInterval(()=>void e(),6e3)'),
    source.replace('r.addEventListener("click",()=>location.href=e.current_url)', 'r.addEventListener("click",()=>location.assign(e.current_url))'),
    source + 'var C=window.__baoyuShare??{},M=C.role==="owner";ce(M);ge(M);',
    adaptNativeHistoryUi(source),
  ];
  for (const changed of changes) assert.throws(() => adaptNativeHistoryUi(changed), { code: 'NATIVE_HISTORY_ADAPTER_UNSUPPORTED' });
});
