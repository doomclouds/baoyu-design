import i18next from 'i18next';
import brandIcon from './assets/brand.svg';
import en from './locales/en.js';
import zh from './locales/zh.js';
import { BridgeError, supports, unavailableBridge } from './bridge.js';

const KINDS = ['slides', 'design', 'design-system', 'dashboard'];
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  library: '<path d="M4 5h4v14H4zM10 4h4v15h-4zM16 6l4-1 3 13-4 1z"/>',
  slides: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M7 4h10"/>',
  design: '<path d="M5 4h14l1 8c0 5-4 8-8 9-4-1-8-4-8-9z"/><circle cx="12" cy="11" r="2"/>',
  'design-system': '<path d="M12 3l9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9"/>',
  dashboard: '<rect x="3" y="5" width="6" height="15" rx="1"/><rect x="15" y="3" width="6" height="15" rx="1"/><path d="M10 8h3v13h-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  settings: '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M16 16l5 5"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  sort: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
  chat: '<path d="M5 3h14a2 2 0 012 2v12a2 2 0 01-2 2h-9l-5 3v-3a2 2 0 01-2-2V5a2 2 0 012-2zM7 8h10M7 12h7"/>',
  minus: '<path d="M5 12h14"/>',
  arrow: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  external: '<path d="M14 3h7v7M21 3L11 13M10 5H4v15h15v-6"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  restore: '<path d="M3 5v6h6M4 10a8 8 0 117 10M12 7v6l3 2"/>',
  rename: '<path d="M4 20l4-1L20 7l-3-3L5 16zM14 7l3 3"/>',
  refresh: '<path d="M20 4v6h-6M4 20v-6h6M5 9a8 8 0 0113-4l2 3M4 16l2 3a8 8 0 0013-4"/>',
  menu: '<path d="M4 5h16M4 12h16M4 19h16"/>',
  warning: '<path d="M12 3L2 21h20zM12 9v5M12 17v1"/>',
};
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = (name, className = '') => '<svg class="icon ' + className + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] ?? ICONS.design) + '</svg>';
const isRecord = (record) => record && typeof record.id === 'string' && KINDS.includes(record.kind) && typeof record.title === 'string';
const isDeleted = (record) => typeof record?.deleted === 'boolean' ? record.deleted : Boolean(record?.deletedAt);
const libraryTab = () => ({ id: 'library', type: 'library' });

export function normalizeViewState(value) {
  const seen = new Set(['library']);
  const tabs = [libraryTab()];
  for (const item of Array.isArray(value?.tabs) ? value.tabs : []) {
    const id = item?.artifactId;
    if (item.type !== 'artifact' || typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    tabs.push({ id, type: 'artifact', artifactId: id });
  }
  return { version: 1, tabs, activeTabId: seen.has(value?.activeTabId) ? value.activeTabId : 'library' };
}

/** Host contract: invoke(action,payload), subscribe(handler), language?, capabilities?. */
export async function createUi({ root, bridge = unavailableBridge() } = {}) {
  if (!root) throw new TypeError('A mount root is required.');
  const i18n = i18next.createInstance();
  let preference = 'system';
  try { preference = localStorage.getItem('codex-design.ui-language') || localStorage.getItem('codexDesign.ui.language') || 'system'; } catch {}
  const systemLanguage = () => String(bridge.language || navigator.language || 'en').startsWith('zh') ? 'zh' : 'en';
  await i18n.init({ lng: preference === 'system' ? systemLanguage() : preference, fallbackLng: 'en', resources: { en: { translation: en }, zh: { translation: zh } }, interpolation: { escapeValue: false } });
  const t = (key, values) => i18n.t(key, values);
  const state = {
    records: [], view: normalizeViewState(), category: 'all', favorites: false,
    query: '', sort: 'updated', layout: 'list', loading: true, error: null,
    menu: null, toast: null, mobileSidebar: false, destroyed: false,
    busy: new Set(), chat: new Map(), drafts: new Map(), minimized: new Set(),
  };
  let recordsSequence = 0;
  let editorSequence = 0;
  let conversationSequence = 0;
  let currentSurface = null;
  let currentEditorUrl = null;
  let currentEditorLanguage = null;
  const thumbnailCache = new Map();
  const thumbnailPending = new Set();
  let viewQueue = Promise.resolve();
  let toastTimer;
  let conversationTimer;
  const abort = new AbortController();
  root.classList.add('codex-design-ui');
  root.innerHTML = '<div class="design-shell"><aside class="design-sidebar"></aside><section class="design-workspace"><div class="workspace-tabs"></div><main id="design-workspace-panel" class="workspace-panel" role="tabpanel"></main></section><div class="sidebar-scrim" hidden></div><div class="floating-layer"></div><div class="menu-layer"></div><div class="toast-layer" aria-live="polite" aria-atomic="true"></div><dialog class="design-dialog"></dialog><span class="sr-only live-status" role="status"></span></div>';
  const elements = {
    shell: root.querySelector('.design-shell'), sidebar: root.querySelector('.design-sidebar'),
    tabs: root.querySelector('.workspace-tabs'), panel: root.querySelector('.workspace-panel'),
    floating: root.querySelector('.floating-layer'), menus: root.querySelector('.menu-layer'),
    toast: root.querySelector('.toast-layer'), dialog: root.querySelector('dialog'),
    live: root.querySelector('.live-status'), scrim: root.querySelector('.sidebar-scrim'),
  };
  const recordFor = (id) => state.records.find((record) => record.id === id);
  const activeRecord = () => recordFor(state.view.activeTabId);
  function upsertRecord(record) {
    if (!isRecord(record)) return;
    ++recordsSequence;
    state.records = [...state.records.filter((item) => item.id !== record.id), record];
  }
  const enabled = (action) => supports(bridge, action);
  const disabled = (action) => enabled(action) ? '' : ' disabled';
  const busy = (key) => state.busy.has(key);
  const focusKey = () => document.activeElement?.getAttribute('data-focus-key');
  function restoreFocus(key) {
    if (!key) return;
    Array.from(root.querySelectorAll('[data-focus-key]')).find((element) => element.getAttribute('data-focus-key') === key)?.focus();
  }
  function announce(message) { elements.live.textContent = message; }
  function toast(message, error = false) {
    state.toast = { message, error };
    clearTimeout(toastTimer);
    elements.toast.innerHTML = '<div class="toast ' + (error ? 'is-error' : '') + '"><span>' + escape(message) + '</span><button type="button" class="icon-button" data-action="dismiss-toast" aria-label="' + escape(t('dismiss')) + '">' + icon('close') + '</button></div>';
    toastTimer = setTimeout(() => { state.toast = null; elements.toast.replaceChildren(); }, error ? 10000 : 4500);
  }
  function errorMessage(error) {
    if (['UNSUPPORTED', 'NOT_SUPPORTED', 'NATIVE_EDIT_CHAT_UNAVAILABLE'].includes(error?.code)) return t('unsupported');
    return error?.message || t('actionFailed');
  }
  async function invoke(action, payload = {}) {
    if (!enabled(action)) throw new BridgeError(t('unsupported'), 'UNSUPPORTED');
    return bridge.invoke(action, payload);
  }
  async function runAction(key, action) {
    if (busy(key)) return;
    state.busy.add(key);
    try { return await action(); }
    catch (error) { toast(errorMessage(error), true); return undefined; }
    finally { state.busy.delete(key); }
  }
  function formatTime(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return t('unknownDate');
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    if (Math.abs(seconds) < 60) return t('justNow');
    if (Math.abs(seconds) < 86400 * 7) {
      const unit = Math.abs(seconds) < 3600 ? 'minute' : Math.abs(seconds) < 86400 ? 'hour' : 'day';
      return new Intl.RelativeTimeFormat(i18n.language, { numeric: 'auto' }).format(Math.round(seconds / ({ minute: 60, hour: 3600, day: 86400 }[unit])), unit);
    }
    return new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }).format(timestamp);
  }
  function rowProject(record) { return record.projectName || record.project?.name || t('noProject'); }
  function visibleRecords() {
    let records = state.records.filter((record) => state.category === 'trash' ? isDeleted(record) : !isDeleted(record));
    if (KINDS.includes(state.category)) records = records.filter((record) => record.kind === state.category);
    if (state.favorites) records = records.filter((record) => record.favorite);
    const query = state.query.trim().toLocaleLowerCase(i18n.language);
    if (query) records = records.filter((record) => record.title.toLocaleLowerCase(i18n.language).includes(query));
    return records.slice().sort((a, b) => state.sort === 'name'
      ? a.title.localeCompare(b.title, i18n.language, { numeric: true })
      : (Date.parse(state.sort === 'created' ? b.createdAt : b.updatedAt) || 0) - (Date.parse(state.sort === 'created' ? a.createdAt : a.updatedAt) || 0));
  }
  function thumbnail(record) {
    const candidate = record.thumbnailUrl || record.thumbnail?.url || (typeof record.thumbnail === 'string' ? record.thumbnail : null);
    if (candidate) {
      try {
        const url = new URL(candidate, location.href);
        if (['http:', 'https:', 'blob:'].includes(url.protocol)) return '<img class="design-thumbnail" src="' + escape(url.href) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
      } catch {}
    }
    return '<span class="design-thumbnail thumbnail-empty" data-thumbnail-id="' + escape(record.id) + '" aria-hidden="true">' + icon(record.kind) + '</span>';
  }
  function hydrateThumbnails() {
    if (!enabled('thumbnail.get') || state.destroyed || state.view.activeTabId !== 'library') return;
    const slots = Array.from(elements.panel.querySelectorAll('[data-thumbnail-id]'));
    for (const slot of slots) {
      const id = slot.dataset.thumbnailId, record = recordFor(id);
      if (!record || isDeleted(record) || record.contentStatus !== 'ok') continue;
      const cached = thumbnailCache.get(id);
      if (cached && cached.stamp === record.updatedAt) {
        if (cached.result?.srcdoc && !slot.querySelector('iframe')) {
          const frame = document.createElement('iframe');
          frame.className = 'thumbnail-frame';
          frame.setAttribute('sandbox', '');
          frame.referrerPolicy = 'no-referrer';
          frame.tabIndex = -1;
          frame.title = record.title;
          frame.srcdoc = cached.result.srcdoc;
          slot.classList.remove('thumbnail-empty');
          slot.replaceChildren(frame);
          slot.dataset.fidelity = cached.result.fidelity || '';
          if (cached.result.fidelity === 'content-reference') slot.title = t('thumbnailContentReference');
        }
        continue;
      }
      if (thumbnailPending.has(id) || thumbnailPending.size >= 4) continue;
      thumbnailPending.add(id);
      invoke('thumbnail.get', { id }).then((result) => {
        thumbnailCache.set(id, { stamp: record.updatedAt, revision: result.cacheKey || result.revision, result });
      }).catch(() => thumbnailCache.set(id, { stamp: record.updatedAt, result: null })).finally(() => {
        thumbnailPending.delete(id);
        if (!state.destroyed) hydrateThumbnails();
      });
    }
  }
  function renderSidebar() {
    const focused = focusKey();
    const recents = state.records.filter((record) => !isDeleted(record)).slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 5);
    const navItem = (category, symbol = category) => '<button type="button" class="sidebar-item ' + (state.category === category ? 'is-selected' : '') + '" data-action="category" data-category="' + category + '" data-focus-key="nav-' + category + '" aria-current="' + (state.category === category ? 'page' : 'false') + '">' + icon(symbol) + '<span>' + escape(t(category)) + '</span></button>';
    elements.sidebar.setAttribute('aria-label', t('libraryNavigation'));
    elements.sidebar.innerHTML = '<div class="sidebar-heading"><span class="wordmark">Codex Design</span><button type="button" class="icon-button sidebar-search" data-action="focus-search" aria-label="' + escape(t('search')) + '">' + icon('search') + '</button></div>'
      + '<button type="button" class="sidebar-item sidebar-create" data-action="create"' + disabled('library.create') + '>' + icon('plus') + '<span>' + escape(t('create')) + '</span></button>'
      + '<nav class="category-navigation" aria-label="' + escape(t('libraryNavigation')) + '">' + navItem('all', 'library') + KINDS.map((kind) => navItem(kind)).join('') + '</nav>'
      + '<div class="recent-section"><button type="button" class="section-label recent-heading" data-action="category" data-category="recent">' + escape(t('recent')) + '</button><div class="recent-items">'
      + recents.map((record) => '<button type="button" class="sidebar-item recent-item" data-action="open" data-id="' + escape(record.id) + '" title="' + escape(record.title) + '" aria-label="' + escape(t('openDesign', { title: record.title })) + '">' + icon(record.kind) + '<span>' + escape(record.title) + '</span></button>').join('') + '</div></div>'
      + '<div class="sidebar-bottom">' + navItem('trash') + '<button type="button" class="icon-button" data-action="settings" aria-label="' + escape(t('settings')) + '">' + icon('settings') + '</button></div>';
    elements.shell.classList.toggle('sidebar-open', state.mobileSidebar);
    elements.scrim.hidden = !state.mobileSidebar;
    restoreFocus(focused);
  }
  function renderTabs() {
    const focused = focusKey();
    elements.tabs.setAttribute('role', 'tablist');
    elements.tabs.setAttribute('aria-label', t('workspaceTabs'));
    elements.tabs.setAttribute('aria-description', t('tabKeyboardHelp'));
    elements.tabs.innerHTML = state.view.tabs.map((tab) => {
      const selected = tab.id === state.view.activeTabId;
      const record = recordFor(tab.id);
      const title = tab.type === 'library' ? t('library') : record?.title || t('restoredTabMissing');
      return '<div class="workspace-tab ' + (selected ? 'is-active' : '') + '" role="presentation"' + (tab.type === 'artifact' ? ' draggable="true"' : '') + ' data-tab-id="' + escape(tab.id) + '">'
        + '<button type="button" id="tab-' + escape(tab.id) + '" class="tab-select" role="tab" data-action="activate-tab" data-id="' + escape(tab.id) + '" data-focus-key="tab-' + escape(tab.id) + '" aria-selected="' + selected + '" aria-controls="design-workspace-panel" tabindex="' + (selected ? '0' : '-1') + '" title="' + escape(title) + '">' + (tab.type === 'library' ? icon('slides') : '') + '<span>' + escape(title) + '</span></button>'
        + (tab.type === 'artifact' ? '<button type="button" class="tab-close" data-action="close-tab" data-id="' + escape(tab.id) + '" aria-label="' + escape(t('closeDesign', { title })) + '" title="' + escape(t('closeKeepsRunning')) + '">' + icon('close') + '</button>' : '') + '</div>';
    }).join('');
    elements.panel.setAttribute('aria-labelledby', 'tab-' + state.view.activeTabId);
    restoreFocus(focused);
  }
  function renderEmpty(records) {
    let heading = 'emptyTitle', body = 'emptyBody', symbol = 'library';
    if (state.error) { heading = 'libraryUnavailable'; body = 'bridgeUnavailable'; symbol = 'warning'; }
    else if (state.query) { heading = 'emptySearch'; body = 'emptySearchBody'; symbol = 'search'; }
    else if (state.category === 'trash') { heading = 'emptyTrash'; body = 'emptyTrashBody'; symbol = 'trash'; }
    else if (state.favorites) { heading = 'emptyFavorites'; body = 'emptyFavoritesBody'; symbol = 'star'; }
    return '<section class="library-empty"><div class="empty-symbol">' + icon(symbol) + '</div><h2>' + escape(t(heading)) + '</h2><p>' + escape(t(body)) + '</p>'
      + (state.query ? '<button type="button" class="button secondary" data-action="clear-search">' + escape(t('clearSearch')) + '</button>'
        : state.error ? '<button type="button" class="button secondary" data-action="refresh"' + disabled('library.list') + '>' + icon('refresh') + escape(t('retry')) + '</button>'
          : state.category !== 'trash' && !state.favorites ? '<button type="button" class="button primary" data-action="create"' + disabled('library.create') + '>' + icon('plus') + escape(t('newDesign')) + '</button>' : '') + '</section>';
  }
  function recordActions(record) {
    if (isDeleted(record)) return '<button type="button" class="button secondary restore-button" data-action="restore" data-id="' + escape(record.id) + '"' + disabled('library.restore') + '>' + icon('restore') + escape(t('restore')) + '</button>';
    return '<button type="button" class="icon-button favorite-button ' + (record.favorite ? 'is-favorite' : '') + '" data-action="favorite" data-id="' + escape(record.id) + '" data-focus-key="favorite-' + escape(record.id) + '" aria-label="' + escape(t(record.favorite ? 'unfavoriteDesign' : 'favoriteDesign', { title: record.title })) + '" aria-pressed="' + Boolean(record.favorite) + '"' + disabled('library.setFavorite') + '>' + icon('star') + '</button>'
      + '<button type="button" class="icon-button" data-action="item-menu" data-menu-trigger="true" data-id="' + escape(record.id) + '" aria-haspopup="menu" aria-label="' + escape(t('moreActions', { title: record.title })) + '">' + icon('more') + '</button>';
  }
  function recordStatus(record) {
    return record.contentStatus && record.contentStatus !== 'ok' ? '<span class="record-status">' + icon('warning') + escape(t(record.contentStatus === 'missing' ? 'missing' : 'invalid')) + '</span>' : '<span class="record-kind">' + escape(t(record.kind)) + '</span>';
  }
  function recordOpen(record, className = '') {
    const cannotOpen = isDeleted(record) || (record.contentStatus && record.contentStatus !== 'ok') || !enabled('view.openTab');
    return '<button type="button" class="record-open ' + className + '" data-action="open" data-id="' + escape(record.id) + '" aria-label="' + escape(t('openDesign', { title: record.title })) + '"' + (cannotOpen ? ' disabled' : '') + '>' + thumbnail(record) + '<span class="record-copy"><span class="record-title">' + escape(record.title) + '</span>' + recordStatus(record) + '</span></button>';
  }
  function renderRecords() {
    const container = elements.panel.querySelector('.records-container');
    if (!container) return;
    const focused = focusKey();
    const records = visibleRecords();
    const counter = elements.panel.querySelector('.design-count');
    if (counter) counter.textContent = t('count', { count: records.length });
    container.className = 'records-container ' + (state.layout === 'grid' ? 'is-grid' : 'is-list');
    if (state.loading) container.innerHTML = '<div class="library-empty loading-state" role="status"><span class="spinner"></span><p>' + escape(t('loadingLibrary')) + '</p></div>';
    else if (!records.length || state.error) container.innerHTML = renderEmpty(records);
    else if (state.layout === 'grid') container.innerHTML = '<div class="design-grid">' + records.map((record) => '<article class="design-card">' + recordOpen(record, 'card-open') + '<div class="card-bottom"><span>' + escape(formatTime(record.updatedAt)) + '</span><div class="record-actions">' + recordActions(record) + '</div></div></article>').join('') + '</div>';
    else container.innerHTML = '<table class="design-table"><thead><tr><th scope="col">' + escape(t('name')) + '</th><th scope="col" class="project-column">' + escape(t('project')) + '</th><th scope="col" class="edited-column">' + escape(t('lastEdited')) + '</th><th scope="col"><span class="sr-only">' + escape(t('moreActions', { title: '' })) + '</span></th></tr></thead><tbody>'
      + records.map((record) => '<tr><th scope="row">' + recordOpen(record) + '</th><td class="project-column">' + escape(rowProject(record)) + '</td><td class="edited-column"><time datetime="' + escape(record.updatedAt) + '">' + escape(formatTime(record.updatedAt)) + '</time></td><td><div class="record-actions">' + recordActions(record) + '</div></td></tr>').join('') + '</tbody></table>';
    restoreFocus(focused);
    hydrateThumbnails();
  }
  function renderLibrary() {
    const categoryTitle = t(state.category);
    elements.panel.classList.add('library-panel');
    elements.panel.innerHTML = '<section class="library-content"><header class="library-heading"><div class="heading-copy"><button type="button" class="icon-button mobile-menu" data-action="toggle-sidebar" aria-label="' + escape(t('libraryNavigation')) + '" aria-expanded="' + state.mobileSidebar + '">' + icon('menu') + '</button><div><h1>' + escape(categoryTitle) + '</h1><p class="design-count"></p></div></div><div class="library-heading-actions"><label class="search-field">' + icon('search') + '<span class="sr-only">' + escape(t('search')) + '</span><input type="search" class="library-search" placeholder="' + escape(t('searchKind', { kind: categoryTitle })) + '" value="' + escape(state.query) + '" autocomplete="off"></label>'
      + (state.category !== 'trash' ? '<button type="button" class="button primary" data-action="create"' + disabled('library.create') + '>' + icon('plus') + escape(KINDS.includes(state.category) ? t('newKind', { kind: categoryTitle }) : t('newDesign')) + '</button>' : '') + '</div></header>'
      + '<div class="library-controls"><div class="filter-tabs" role="group" aria-label="' + escape(t('favorites')) + '"><button type="button" class="filter-tab ' + (!state.favorites ? 'is-selected' : '') + '" data-action="filter" data-value="all" aria-pressed="' + !state.favorites + '">' + escape(t('all')) + '</button><button type="button" class="filter-tab ' + (state.favorites ? 'is-selected' : '') + '" data-action="filter" data-value="favorites" aria-pressed="' + state.favorites + '">' + escape(t('favorites')) + '</button></div><div class="view-controls"><button type="button" class="icon-button" data-action="sort-menu" data-menu-trigger="true" aria-haspopup="menu" aria-label="' + escape(t('sort')) + '">' + icon('sort') + '</button><span class="control-divider"></span><button type="button" class="icon-button ' + (state.layout === 'grid' ? 'is-selected' : '') + '" data-action="layout" data-layout="grid" aria-pressed="' + (state.layout === 'grid') + '" aria-label="' + escape(t('gridView')) + '">' + icon('grid') + '</button><button type="button" class="icon-button ' + (state.layout === 'list' ? 'is-selected' : '') + '" data-action="layout" data-layout="list" aria-pressed="' + (state.layout === 'list') + '" aria-label="' + escape(t('listView')) + '">' + icon('list') + '</button></div></div><div class="records-container"></div></section>';
    renderRecords();
  }
  async function openEditor(id, force = false) {
    const record = recordFor(id);
    if (!record || isDeleted(record)) { renderEditorFailure(t('restoredTabMissing'), id); return; }
    if (record.contentStatus && record.contentStatus !== 'ok') { renderEditorFailure(t(record.contentStatus === 'missing' ? 'missingBody' : 'invalidBody'), id); return; }
    const sequence = ++editorSequence;
    currentEditorUrl = null;
    const host = elements.panel.querySelector('.editor-frame-host');
    if (!host) return;
    host.innerHTML = '<div class="editor-loading" role="status"><span class="spinner"></span><p>' + escape(t('loadingEditor')) + '</p></div>';
    try {
      const result = await invoke('editor.open', { id, force });
      if (state.destroyed || sequence !== editorSequence || state.view.activeTabId !== id) return;
      if (typeof result?.url !== 'string' || !result.url.trim()) throw new BridgeError('The editor did not return a URL.', 'INVALID_EDITOR_URL');
      const url = new URL(result.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new BridgeError('The editor returned an unsupported URL.', 'INVALID_EDITOR_URL');
      url.searchParams.set('codexDesignLanguage', i18n.language.startsWith('zh') ? 'zh' : 'en');
      currentEditorUrl = url.href;
      currentEditorLanguage = i18n.language;
      const iframe = document.createElement('iframe');
      iframe.className = 'design-editor-frame';
      iframe.title = t('editorFrame', { title: record.title });
      iframe.src = url.href;
      iframe.allow = 'clipboard-read; clipboard-write; fullscreen';
      iframe.referrerPolicy = 'no-referrer';
      iframe.setAttribute('allowfullscreen', '');
      iframe.addEventListener('load', postEditorLanguage);
      host.replaceChildren(iframe);
      updateLanguageNotice();
      const external = elements.panel.querySelector('.editor-external');
      if (external) { external.href = url.href; external.hidden = false; }
    } catch (error) {
      if (sequence === editorSequence && state.view.activeTabId === id) renderEditorFailure(errorMessage(error), id);
    }
  }
  function renderEditorFailure(message, id) {
    const host = elements.panel.querySelector('.editor-frame-host');
    if (!host) return;
    host.innerHTML = '<div class="editor-loading"><div class="empty-symbol">' + icon('warning') + '</div><h2>' + escape(t('editorUnavailable')) + '</h2><p>' + escape(message) + '</p><button type="button" class="button secondary" data-action="retry-editor" data-id="' + escape(id) + '"' + disabled('editor.open') + '>' + escape(t('openEditorAgain')) + '</button></div>';
  }
  function postEditorLanguage() {
    const frame = elements.panel.querySelector('.design-editor-frame');
    if (!frame || !currentEditorUrl) return;
    frame.contentWindow?.postMessage({ type: 'codex-design:ui-language-changed', preference: i18n.language.startsWith('zh') ? 'zh' : 'en', systemLocale: bridge.language || navigator.language }, new URL(currentEditorUrl).origin);
  }
  function updateLanguageNotice() {
    const workspace = elements.panel.querySelector('.editor-workspace');
    if (!workspace) return;
    let notice = workspace.querySelector('.editor-language-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'editor-language-notice';
      workspace.insertBefore(notice, workspace.querySelector('.editor-frame-host'));
    }
    notice.hidden = !currentEditorLanguage || currentEditorLanguage === i18n.language;
    notice.innerHTML = '<span>' + escape(t('editorLanguagePending')) + '</span><button type="button" class="button secondary" data-action="reload-language">' + escape(t('reopenEditorLanguage')) + '</button>';
  }
  function renderWorkspace() {
    const id = state.view.activeTabId;
    if (id === 'library') {
      ++editorSequence;
      currentEditorUrl = null;
      currentEditorLanguage = null;
      if (currentSurface !== 'library') thumbnailCache.clear();
      if (currentSurface !== 'library') renderLibrary();
      else renderRecords();
      currentSurface = 'library';
      elements.floating.replaceChildren();
      clearTimeout(conversationTimer);
      return;
    }
    const record = recordFor(id);
    const title = record?.title || t('restoredTabMissing');
    elements.panel.classList.remove('library-panel');
    if (currentSurface !== id) {
      elements.panel.innerHTML = '<section class="editor-workspace"><header class="editor-workspace-heading"><div class="editor-title-group"><button type="button" class="icon-button mobile-menu" data-action="toggle-sidebar" aria-label="' + escape(t('libraryNavigation')) + '">' + icon('menu') + '</button><h1 class="editor-design-title">' + escape(title) + '</h1><span class="autosave-note">' + escape(t('savedByEditor')) + '</span></div><a class="icon-button editor-external" target="_blank" rel="noopener noreferrer" aria-label="' + escape(t('editorExternal')) + '" hidden>' + icon('external') + '</a></header><div class="editor-frame-host"></div></section>';
      currentSurface = id;
      openEditor(id);
      refreshConversation(id);
    } else {
      const heading = elements.panel.querySelector('.editor-design-title');
      if (heading) heading.textContent = title;
      const frame = elements.panel.querySelector('iframe');
      if (frame) frame.title = t('editorFrame', { title });
    }
    renderConversation();
  }
  function renderConversation() {
    const id = state.view.activeTabId;
    if (id === 'library') { elements.floating.replaceChildren(); return; }
    const record = recordFor(id);
    const title = record?.title || t('restoredTabMissing');
    const model = state.chat.get(id);
    if (!model?.binding || model.capabilities?.sendMessage !== true || !enabled('conversation.send')) {
      elements.floating.replaceChildren();
      return;
    }
    const minimized = state.minimized.has(id);
    const composer = elements.floating.querySelector('textarea');
    const hadFocus = document.activeElement === composer;
    const selection = hadFocus ? [composer.selectionStart, composer.selectionEnd] : null;
    const canSend = Boolean(model?.binding && model?.capabilities?.sendMessage === true && enabled('conversation.send'));
    const processing = ['active', 'pending', 'running', 'sending'].includes(model?.status);
    const messages = (Array.isArray(model?.messages) ? model.messages : []).filter((message) => typeof message.text === 'string');
    const draft = state.drafts.get(id) || '';
    if (minimized) {
      elements.floating.innerHTML = '<button type="button" class="conversation-collapsed" data-action="toggle-conversation" aria-label="' + escape(t('expandConversation')) + '">' + icon('chat') + '<span>' + escape(title) + '</span>' + (processing ? '<span class="activity-dot"></span>' : '') + '</button>';
      return;
    }
    let body;
    if (!model || model.status === 'loading') body = '<div class="conversation-empty" role="status"><span class="spinner"></span><p>' + escape(t('conversationLoading')) + '</p></div>';
    else if (!model.binding || model.status === 'unavailable' || model.status === 'unsupported') body = '<div class="conversation-empty"><div class="conversation-empty-icon">' + icon('chat') + '</div><h2>' + escape(t('conversationUnavailable')) + '</h2><p>' + escape(model.reasonKey ? t(model.reasonKey) : model.reason || (model.binding === null ? t('conversationUnbound') : t('conversationUnavailableBody'))) + '</p></div>';
    else if (!messages.length) body = '<div class="conversation-empty"><p>' + escape(t('noMessages')) + '</p></div>';
    else body = messages.map((message) => {
      const from = message.role || message.from || message.author?.kind;
      const user = from === 'user';
      return '<article class="conversation-message ' + (user ? 'from-user' : 'from-assistant') + '">' + (!user ? '<img class="assistant-avatar" src="' + escape(brandIcon) + '" alt="Codex Design">' : '') + '<div class="message-content"><p class="message-text">' + escape(message.text) + '</p>' + (message.createdAt || message.at ? '<time datetime="' + escape(message.createdAt || message.at) + '">' + escape(formatTime(message.createdAt || message.at)) + '</time>' : '') + '</div></article>';
    }).join('');
    const status = busy('send-' + id) ? t('sending') : processing ? t('thinking') : model?.status === 'failed' ? t('conversationFailed') : model?.binding ? t('conversationIdle') : '';
    elements.floating.innerHTML = '<section class="editing-conversation" aria-label="' + escape(t('conversationFor', { title })) + '"><header class="conversation-heading"><div class="conversation-title">' + icon('chat') + '<span>' + escape(title) + '</span></div><button type="button" class="icon-button" data-action="toggle-conversation" aria-label="' + escape(t('minimizeConversation')) + '">' + icon('minus') + '</button></header>'
      + (model?.binding && (model.binding.projectName || record?.projectName) ? '<p class="conversation-project">' + icon('slides') + escape(model.binding.projectName || record.projectName) + '</p>' : '')
      + '<div class="conversation-messages" role="log" aria-live="polite" aria-relevant="additions text">' + body + '</div>'
      + '<div class="conversation-status" role="status">' + (processing ? '<span class="activity-dot"></span>' : '') + escape(status) + '</div>'
      + '<form class="conversation-composer"><div class="conversation-scope">' + icon(record?.kind || 'design') + '<span>' + escape(title) + '</span></div><div class="composer-row"><label class="sr-only" for="design-message">' + escape(t('continueDesign')) + '</label><textarea id="design-message" rows="1" maxlength="20000" placeholder="' + escape(canSend ? t('continueDesign') : t('noSendCapability')) + '"' + (!canSend || busy('send-' + id) ? ' disabled' : '') + '>' + escape(draft) + '</textarea><button type="submit" class="send-button" aria-label="' + escape(t('send')) + '"' + (!canSend || !draft.trim() || busy('send-' + id) ? ' disabled' : '') + '>' + icon('arrow') + '</button></div></form></section>';
    const messageLog = elements.floating.querySelector('.conversation-messages');
    if (messageLog) messageLog.scrollTop = messageLog.scrollHeight;
    if (hadFocus) {
      const input = elements.floating.querySelector('textarea');
      input?.focus();
      if (selection) input?.setSelectionRange(...selection);
    }
  }
  async function refreshConversation(id = state.view.activeTabId) {
    if (id === 'library' || state.destroyed) return;
    clearTimeout(conversationTimer);
    const sequence = ++conversationSequence;
    if (!state.chat.has(id)) state.chat.set(id, { status: 'loading' });
    renderConversation();
    try {
      const result = await invoke('conversation.get', { id });
      if (state.destroyed || sequence !== conversationSequence) return;
      const model = result && typeof result === 'object' ? result : { status: 'unavailable' };
      if (model.reasonCode === 'NATIVE_EDIT_CHAT_UNAVAILABLE') model.reasonKey = 'conversationUnavailableBody';
      state.chat.set(id, model);
    } catch (error) {
      if (sequence !== conversationSequence) return;
      state.chat.set(id, { status: 'unavailable', capabilities: { sendMessage: false }, ...(['UNSUPPORTED', 'NATIVE_EDIT_CHAT_UNAVAILABLE', 'BRIDGE_UNAVAILABLE'].includes(error.code) ? { reasonKey: 'conversationUnavailableBody' } : { reason: errorMessage(error) }) });
    }
    if (state.view.activeTabId === id) {
      renderConversation();
      if (['active', 'pending', 'running', 'sending'].includes(state.chat.get(id)?.status)) conversationTimer = setTimeout(() => refreshConversation(id), 3000);
    }
  }
  async function sendConversation() {
    const id = state.view.activeTabId;
    const model = state.chat.get(id);
    const text = (state.drafts.get(id) || '').trim();
    if (!text || !model?.binding || model.capabilities?.sendMessage !== true) return;
    await runAction('send-' + id, async () => {
      renderConversation();
      await invoke('conversation.send', { id, text });
      state.drafts.delete(id);
      await refreshConversation(id);
    });
    renderConversation();
  }
  function applyView(value) {
    state.view = normalizeViewState(value?.viewState || value);
    renderTabs();
    renderSidebar();
    renderWorkspace();
  }
  function changeView(action, payload) {
    viewQueue = viewQueue.catch(() => {}).then(async () => {
      try { applyView(await invoke('view.' + action, payload)); }
      catch (error) { toast(errorMessage(error), true); }
    });
    return viewQueue;
  }
  async function refreshRecords(quiet = false) {
    const sequence = ++recordsSequence;
    if (!quiet) { state.loading = true; renderWorkspace(); }
    try {
      const result = await invoke('library.list', { includeDeleted: true });
      if (sequence !== recordsSequence || state.destroyed) return;
      const records = Array.isArray(result) ? result : result?.artifacts;
      if (!Array.isArray(records)) throw new BridgeError('The library returned an invalid list.', 'INVALID_RESPONSE');
      state.records = records.filter(isRecord);
      state.error = null;
    } catch (error) {
      if (sequence !== recordsSequence) return;
      state.error = error;
    } finally {
      if (sequence === recordsSequence) {
        state.loading = false;
        renderSidebar();
        renderTabs();
        renderWorkspace();
      }
    }
  }
  function setCategory(category) {
    if (!['all', 'recent', 'trash', ...KINDS].includes(category)) return;
    state.category = category;
    state.favorites = false;
    state.query = '';
    state.mobileSidebar = false;
    if (category === 'recent') state.sort = 'updated';
    if (state.view.activeTabId !== 'library') changeView('activateTab', { id: 'library' });
    else { renderSidebar(); renderLibrary(); }
  }
  function closeMenu(returnFocus = false) {
    const origin = state.menu?.origin;
    state.menu = null;
    elements.menus.replaceChildren();
    if (returnFocus) origin?.focus();
  }
  function openMenu(type, origin, id) {
    if (state.menu?.type === type && state.menu?.id === id) { closeMenu(); return; }
    const record = recordFor(id);
    const items = type === 'sort' ? [
      ['sort-value', 'sortUpdated', 'updated', state.sort === 'updated'],
      ['sort-value', 'sortCreated', 'created', state.sort === 'created'],
      ['sort-value', 'sortName', 'name', state.sort === 'name'],
    ] : [['rename', 'rename', '', false], ['copy', 'copy', '', false], ['trash-dialog', 'trashAction', '', false]];
    state.menu = { type, id, origin };
    const rectangle = origin.getBoundingClientRect();
    elements.menus.innerHTML = '<div class="menu-panel" role="menu" style="top:' + Math.min(rectangle.bottom + 8, innerHeight - 180) + 'px;left:' + Math.max(8, Math.min(rectangle.right - 220, innerWidth - 228)) + 'px">'
      + items.map(([action, label, value, checked]) => {
        const method = { rename: 'library.rename', copy: 'library.duplicate', 'trash-dialog': 'library.trash' }[action];
        return '<button type="button" role="' + (type === 'sort' ? 'menuitemradio' : 'menuitem') + '"' + (type === 'sort' ? ' aria-checked="' + checked + '"' : '') + ' class="menu-item ' + (action === 'trash-dialog' ? 'danger' : '') + '" data-action="' + action + '" data-id="' + escape(record?.id || '') + '" data-value="' + value + '"' + (method ? disabled(method) : '') + '>' + icon(action === 'sort-value' ? checked ? 'check' : 'sort' : action === 'trash-dialog' ? 'trash' : action) + escape(t(label)) + '</button>';
      }).join('') + '</div>';
    elements.menus.querySelector('button:not(:disabled)')?.focus();
  }
  function openDialog(type, record) {
    closeMenu();
    const dialog = elements.dialog;
    let title, fields = '', submit;
    if (type === 'settings') {
      title = t('settings');
      fields = '<label class="field-label" for="ui-language">' + escape(t('language')) + '</label><select id="ui-language" name="language">' + [['system', 'languageSystem'], ['zh', 'languageChinese'], ['en', 'languageEnglish']].map(([value, label]) => '<option value="' + value + '"' + (preference === value ? ' selected' : '') + '>' + escape(t(label)) + '</option>').join('') + '</select><p class="field-hint">' + escape(t('languageHelp')) + '</p>';
      submit = t('done');
    } else if (type === 'reload-language') {
      title = t('reopenEditorLanguage');
      fields = '<p class="dialog-description">' + escape(t('editorLanguageConfirm')) + '</p><label class="reload-saved-check"><input type="checkbox" name="saved" required><span>' + escape(t('editorLanguageSaved')) + '</span></label>';
      submit = t('reopenEditorLanguage');
    } else if (type === 'trash') {
      title = t('trashTitle'); fields = '<p class="dialog-description">' + escape(t('trashBody', { title: record.title })) + '</p>'; submit = t('trashAction');
    } else {
      title = t(type === 'create' ? 'newDesign' : type === 'rename' ? 'renameTitle' : 'copyTitle');
      if (type === 'create') fields += '<fieldset class="kind-picker"><legend>' + escape(t('kindLabel')) + '</legend>' + KINDS.map((kind) => '<label class="kind-option"><input type="radio" name="kind" value="' + kind + '"' + ((KINDS.includes(state.category) ? state.category : 'slides') === kind ? ' checked' : '') + '>' + icon(kind) + '<span>' + escape(t(kind)) + '</span></label>').join('') + '</fieldset>';
      const value = type === 'create' ? '' : type === 'copy' ? t('copyName', { title: record.title }) : record.title;
      fields += '<label class="field-label" for="design-title">' + escape(t('titleLabel')) + '</label><input id="design-title" name="title" type="text" required maxlength="200" autocomplete="off" value="' + escape(value) + '" placeholder="' + escape(t('titlePlaceholder')) + '">';
      submit = t(type === 'create' ? 'createDesign' : type === 'rename' ? 'renameSubmit' : 'copySubmit');
    }
    dialog.innerHTML = '<form class="dialog-form" data-dialog-type="' + type + '" data-id="' + escape(record?.id || '') + '"><header><h2 id="design-dialog-title">' + escape(title) + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="' + escape(t('closeDialog')) + '">' + icon('close') + '</button></header><div class="dialog-fields">' + fields + '</div><p class="dialog-error" role="alert" hidden></p><footer>' + (type !== 'settings' ? '<button type="button" class="button secondary" data-action="close-dialog">' + escape(t('cancel')) + '</button>' : '') + '<button type="submit" class="button ' + (type === 'trash' ? 'destructive' : 'primary') + '">' + escape(submit) + '</button></footer></form>';
    dialog.setAttribute('aria-labelledby', 'design-dialog-title');
    dialog.showModal();
    const input = dialog.querySelector('input[name="title"]');
    if (input) { input.focus(); input.select(); }
  }
  async function submitDialog(form) {
    const type = form.dataset.dialogType;
    const id = form.dataset.id;
    if (type === 'reload-language') {
      if (!form.reportValidity()) return;
      elements.dialog.close();
      await openEditor(state.view.activeTabId, true);
      return;
    }
    if (type === 'settings') {
      const value = new FormData(form).get('language');
      elements.dialog.close();
      await setLanguage(value);
      return;
    }
    if (!form.reportValidity() || form.getAttribute('aria-busy') === 'true') return;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    if (type !== 'trash' && !title) { form.elements.title.focus(); return; }
    const action = { create: 'library.create', rename: 'library.rename', copy: 'library.duplicate', trash: 'library.trash' }[type];
    const payload = type === 'create' ? { kind: data.get('kind'), title } : type === 'trash' ? { id } : { id, title };
    form.setAttribute('aria-busy', 'true');
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      const result = await invoke(action, payload);
      const returnedRecord = result?.artifact || result;
      upsertRecord(returnedRecord);
      elements.dialog.close();
      toast(t({ create: 'created', rename: 'renamed', copy: 'copied', trash: 'trashed' }[type]));
      if (type === 'trash' && state.view.tabs.some((tab) => tab.id === id)) await changeView('closeTab', { id });
      if (type === 'create' || type === 'copy') {
        const newRecord = result?.artifact || result;
        if (newRecord?.id) await changeView('openTab', { id: newRecord.id });
      }
      await refreshRecords(true);
    } catch (error) {
      const errorNode = form.querySelector('.dialog-error');
      errorNode.hidden = false;
      errorNode.textContent = errorMessage(error);
      form.querySelector('button[type="submit"]').disabled = false;
    } finally { form.removeAttribute('aria-busy'); }
  }
  async function favoriteRecord(id) {
    const record = recordFor(id);
    if (!record) return;
    await runAction('favorite-' + id, async () => {
      await invoke('library.setFavorite', { id, favorite: !record.favorite });
      await refreshRecords(true);
      announce(t('favoriteSaved'));
    });
  }
  async function restoreRecord(id) {
    await runAction('restore-' + id, async () => {
      await invoke('library.restore', { id });
      await refreshRecords(true);
      toast(t('restored'));
    });
  }
  async function setLanguage(value) {
    preference = ['system', 'en', 'zh'].includes(value) ? value : 'system';
    try { localStorage.setItem('codex-design.ui-language', preference); localStorage.setItem('codexDesign.ui.language', preference); } catch {}
    await i18n.changeLanguage(preference === 'system' ? systemLanguage() : preference);
    root.dispatchEvent(new CustomEvent('codex-design:languagechange', { bubbles: true, detail: { language: i18n.language, preference } }));
  }
  function renderLocalized() {
    if (state.destroyed) return;
    document.documentElement.lang = i18n.language;
    document.title = t('appName');
    renderSidebar();
    renderTabs();
    if (state.view.activeTabId === 'library') renderLibrary();
    else {
      const saved = elements.panel.querySelector('.autosave-note');
      if (saved) saved.textContent = t('savedByEditor');
      renderWorkspace();
      const external = elements.panel.querySelector('.editor-external');
      if (external) external.setAttribute('aria-label', t('editorExternal'));
      postEditorLanguage();
      updateLanguageNotice();
    }
    closeMenu();
  }
  async function handleAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    if (action !== 'item-menu' && action !== 'sort-menu') closeMenu();
    if (action === 'create') openDialog('create');
    else if (action === 'reload-language') openDialog('reload-language');
    else if (action === 'settings') openDialog('settings');
    else if (action === 'rename' || action === 'copy' || action === 'trash-dialog') {
      const record = recordFor(id);
      if (record) openDialog(action === 'trash-dialog' ? 'trash' : action, record);
    } else if (action === 'close-dialog') elements.dialog.close();
    else if (action === 'category') setCategory(button.dataset.category);
    else if (action === 'filter') { state.favorites = button.dataset.value === 'favorites'; renderLibrary(); }
    else if (action === 'layout') { state.layout = button.dataset.layout; renderLibrary(); }
    else if (action === 'sort-menu') openMenu('sort', button);
    else if (action === 'item-menu') openMenu('item', button, id);
    else if (action === 'sort-value') { state.sort = button.dataset.value; renderRecords(); }
    else if (action === 'open') { state.mobileSidebar = false; await changeView('openTab', { id }); }
    else if (action === 'activate-tab') await changeView('activateTab', { id });
    else if (action === 'close-tab') await changeView('closeTab', { id });
    else if (action === 'favorite') await favoriteRecord(id);
    else if (action === 'restore') await restoreRecord(id);
    else if (action === 'refresh') await refreshRecords();
    else if (action === 'clear-search') { state.query = ''; renderLibrary(); elements.panel.querySelector('.library-search')?.focus(); }
    else if (action === 'retry-editor') await openEditor(id, true);
    else if (action === 'toggle-conversation') {
      const artifactId = state.view.activeTabId;
      if (state.minimized.has(artifactId)) { state.minimized.delete(artifactId); refreshConversation(artifactId); }
      else state.minimized.add(artifactId);
      renderConversation();
    } else if (action === 'focus-search') {
      if (state.view.activeTabId !== 'library') await changeView('activateTab', { id: 'library' });
      elements.panel.querySelector('.library-search')?.focus();
    } else if (action === 'toggle-sidebar') { state.mobileSidebar = !state.mobileSidebar; renderSidebar(); }
    else if (action === 'dismiss-toast') { clearTimeout(toastTimer); elements.toast.replaceChildren(); }
  }
  root.addEventListener('click', (event) => { handleAction(event).catch((error) => toast(errorMessage(error), true)); }, { signal: abort.signal });
  root.addEventListener('input', (event) => {
    if (event.target.matches('.library-search')) { state.query = event.target.value; renderRecords(); }
    if (event.target.matches('.conversation-composer textarea')) {
      state.drafts.set(state.view.activeTabId, event.target.value);
      const submit = elements.floating.querySelector('.send-button');
      if (submit) submit.disabled = !event.target.value.trim() || busy('send-' + state.view.activeTabId);
    }
  }, { signal: abort.signal });
  root.addEventListener('submit', (event) => {
    if (event.target.matches('.dialog-form')) { event.preventDefault(); submitDialog(event.target); }
    if (event.target.matches('.conversation-composer')) { event.preventDefault(); sendConversation(); }
  }, { signal: abort.signal });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeMenu(true); state.mobileSidebar = false; renderSidebar(); }
    if (event.target.matches('.conversation-composer textarea') && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendConversation(); }
    if (event.target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = state.view.tabs;
      const index = tabs.findIndex((tab) => tab.id === event.target.dataset.id);
      if (event.altKey && event.shiftKey && index > 0 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const destination = index + (event.key === 'ArrowLeft' ? -1 : 1);
        if (destination > 0 && destination < tabs.length) {
          const order = tabs.map((tab) => tab.id);
          [order[index], order[destination]] = [order[destination], order[index]];
          changeView('reorderTabs', { ids: order });
        }
      } else {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        changeView('activateTab', { id: tabs[next].id }).then(() => restoreFocus('tab-' + tabs[next].id));
      }
    }
    if (event.target.closest('.menu-panel') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from(elements.menus.querySelectorAll('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }, { signal: abort.signal });
  let draggedTab;
  elements.tabs.addEventListener('dragstart', (event) => {
    draggedTab = event.target.closest('[data-tab-id]')?.dataset.tabId;
    if (draggedTab === 'library') { event.preventDefault(); return; }
    event.dataTransfer.setData('text/plain', draggedTab);
    event.dataTransfer.effectAllowed = 'move';
  }, { signal: abort.signal });
  elements.tabs.addEventListener('dragover', (event) => {
    if (draggedTab && event.target.closest('[data-tab-id]')?.dataset.tabId !== 'library') event.preventDefault();
  }, { signal: abort.signal });
  elements.tabs.addEventListener('drop', (event) => {
    event.preventDefault();
    const destination = event.target.closest('[data-tab-id]')?.dataset.tabId;
    if (!draggedTab || !destination || destination === 'library' || destination === draggedTab) return;
    const ids = state.view.tabs.map((tab) => tab.id).filter((id) => id !== draggedTab);
    ids.splice(ids.indexOf(destination), 0, draggedTab);
    changeView('reorderTabs', { ids });
    draggedTab = undefined;
  }, { signal: abort.signal });
  document.addEventListener('pointerdown', (event) => {
    if (state.menu && !elements.menus.contains(event.target) && !event.target.closest('[data-menu-trigger]')) closeMenu();
  }, { signal: abort.signal });
  elements.scrim.addEventListener('click', () => { state.mobileSidebar = false; renderSidebar(); }, { signal: abort.signal });
  const onSystemLanguage = () => { if (preference === 'system') i18n.changeLanguage(systemLanguage()); };
  window.addEventListener('languagechange', onSystemLanguage, { signal: abort.signal });
  i18n.on('languageChanged', renderLocalized);
  let refreshTimer;
  const unsubscribe = typeof bridge.subscribe === 'function' ? bridge.subscribe((event) => {
    if (state.destroyed) return;
    const type = event?.type || '';
    if (type === 'initial-state') {
      const initial = event.result;
      if (Array.isArray(initial?.artifacts)) { state.records = initial.artifacts.filter(isRecord); state.loading = false; state.error = null; }
      if (initial?.viewState) applyView(initial.viewState);
      else { renderSidebar(); renderTabs(); renderWorkspace(); }
      return;
    }
    if (type === 'bridge.error') { toast(errorMessage(event.error), true); return; }
    if (event?.viewState) applyView(event.viewState);
    else if (type === 'view.changed') invoke('view.get').then(applyView).catch((error) => toast(errorMessage(error), true));
    if (type === 'language.changed' || type === 'languagechange') { if (event.language) bridge.language = event.language; onSystemLanguage(); return; }
    if (type.startsWith('conversation.') || type === 'worker.changed') { if (!event.artifactId || event.artifactId === state.view.activeTabId) refreshConversation(); return; }
    if (type === 'capabilities.changed') { renderLocalized(); refreshConversation(); return; }
    if (type.startsWith('library.') || type.startsWith('artifact.') || type === 'changed') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refreshRecords(true), 100);
    }
  }) : null;
  renderLocalized();
  renderWorkspace();
  const initial = bridge.initialState;
  if (initial?.artifacts) state.records = initial.artifacts.filter(isRecord);
  if (initial?.viewState) applyView(initial.viewState);
  const results = await Promise.allSettled([refreshRecords(), invoke('view.get')]);
  if (results[1].status === 'fulfilled') applyView(results[1].value);
  else if (bridge.available !== false) toast(errorMessage(results[1].reason), true);
  return {
    refresh: () => refreshRecords(true),
    setLanguage,
    activateArtifact: (id) => changeView('openTab', { id }),
    destroy() {
      state.destroyed = true;
      ++editorSequence;
      ++conversationSequence;
      clearTimeout(toastTimer);
      clearTimeout(conversationTimer);
      clearTimeout(refreshTimer);
      abort.abort();
      if (typeof unsubscribe === 'function') unsubscribe();
      i18n.off('languageChanged', renderLocalized);
      root.replaceChildren();
    },
  };
}
