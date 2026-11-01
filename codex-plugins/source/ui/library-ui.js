import i18next from 'i18next';
import brandIcon from './assets/brand.svg';
import en from './locales/en.js';
import { BridgeError, supports, unavailableBridge } from './bridge.js';
import { menuPosition } from './layout.mjs';
import { createMenuDismissal, menuInputMode } from './menu-dismissal.mjs';
import { createLibraryTransfer } from './library-transfer.mjs';
import { mountNativeEditor } from './native-editor.mjs';

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
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  upload: '<path d="M12 16V3M7 8l5-5 5 5M4 16v5h16v-5"/>',
  download: '<path d="M12 3v13M7 11l5 5 5-5M4 17v4h16v-4"/>',
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

/** Host contract: invoke(action,payload), subscribe(handler), capabilities?. */
export async function createUi({ root, bridge = unavailableBridge() } = {}) {
  if (!root) throw new TypeError('A mount root is required.');
  const i18n = i18next.createInstance();
  // Interface language is fixed; stored preferences never change authored text.
  await i18n.init({ lng: 'en', supportedLngs: ['en'], fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const t = (key, values) => i18n.t(key, values);
  const state = {
    records: [], view: normalizeViewState(), category: 'all', favorites: false,
    query: '', sort: 'updated', layout: 'list', loading: true, error: null,
    menu: null, toast: null, mobileSidebar: false, sidebarCollapsed: false, destroyed: false,
    busy: new Set(), chat: new Map(), drafts: new Map(), minimized: new Set(), trashSelection: new Set(),
  };
  try { state.sidebarCollapsed = localStorage.getItem('codex-design.sidebar-collapsed') === 'true'; } catch {}
  let recordsSequence = 0;
  let editorSequence = 0;
  let conversationSequence = 0;
  let currentSurface = null;
  let currentEditorUrl = null;
  let currentNativeEditor = null;
  const thumbnailCache = new Map();
  const thumbnailPending = new Set();
  let viewQueue = Promise.resolve();
  let toastTimer;
  let conversationTimer;
  let purgeConfirmation = null;
  const abort = new AbortController();
  root.classList.add('codex-design-ui');
  root.innerHTML = '<div class="design-shell"><aside class="design-sidebar" id="design-category-navigation"></aside><section class="design-workspace"><div class="workspace-tabbar"><button type="button" class="icon-button sidebar-toggle" data-action="toggle-sidebar" aria-controls="design-category-navigation"></button><div class="workspace-tabs"></div></div><main id="design-workspace-panel" class="workspace-panel" role="tabpanel"></main></section><div class="sidebar-scrim" hidden></div><div class="floating-layer"></div><div class="menu-layer"></div><div class="toast-layer" aria-live="polite" aria-atomic="true"></div><dialog class="design-dialog"></dialog><span class="sr-only live-status" role="status"></span></div>';
  const elements = {
    shell: root.querySelector('.design-shell'), sidebar: root.querySelector('.design-sidebar'),
    tabs: root.querySelector('.workspace-tabs'), panel: root.querySelector('.workspace-panel'),
    floating: root.querySelector('.floating-layer'), menus: root.querySelector('.menu-layer'),
    toast: root.querySelector('.toast-layer'), dialog: root.querySelector('dialog'),
    live: root.querySelector('.live-status'), scrim: root.querySelector('.sidebar-scrim'),
    sidebarToggle: root.querySelector('.sidebar-toggle'),
  };
  const menuDismissal = createMenuDismissal({ document, window, onDismiss: closeMenu });
  const recordFor = (id) => state.records.find((record) => record.id === id);
  const activeRecord = () => recordFor(state.view.activeTabId);
  async function flushCurrentEditor() {
    const editor = currentNativeEditor;
    if (typeof editor?.flush !== 'function') return;
    announce(t('savingChanges'));
    try { await editor.flush(); announce(t('changesSaved')); }
    catch (error) { announce(t('editorSaveFailed')); throw error; }
  }
  const previousNavigationGuard = bridge.beforeNavigate;
  const navigationGuard = async request => {
    await previousNavigationGuard?.(request);
    if (state.view.activeTabId !== 'library' && (request?.action === 'teardown' || request?.id !== state.view.activeTabId)) await flushCurrentEditor();
  };
  bridge.beforeNavigate = navigationGuard;
  function upsertRecord(record) {
    if (!isRecord(record)) return;
    ++recordsSequence;
    state.records = [...state.records.filter((item) => item.id !== record.id), record];
  }
  const enabled = (action) => supports(bridge, action);
  const transfer = createLibraryTransfer({
    invoke: (action, payload) => invoke(action, payload),
    ...(typeof bridge.downloadArtifact === 'function' ? { download: bridge.downloadArtifact.bind(bridge) } : {}),
    onImported: async record => {
      upsertRecord(record);
      await changeView('openTab', { id: record.id });
      await refreshRecords(true);
    },
    onRestored: async record => {
      upsertRecord(record);
      if (state.view.activeTabId === record.id) { currentSurface = null; renderWorkspace(); }
      await refreshRecords(true);
    },
  });
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
    const key = {
      INVALID_TITLE: 'invalidTitle', ARTIFACT_BUSY: 'artifactBusy', LIBRARY_BUSY: 'libraryBusy', BRIDGE_BUSY: 'libraryBusy',
      NOT_FOUND: 'artifactNotFound', ARTIFACT_UNAVAILABLE: 'artifactNotFound',
      MISSING_CONTENT: 'missingBody', ARTIFACT_CONTENT_UNAVAILABLE: 'invalidBody', INVALID_CONTENT: 'invalidBody', INVALID_MANIFEST: 'invalidBody',
      BRIDGE_UNAVAILABLE: 'bridgeUnavailable', EACCES: 'fileAccessFailed', EPERM: 'fileAccessFailed', EBUSY: 'artifactFilesBusy',
      LIMIT_EXCEEDED: 'limitExceeded', REQUEST_TOO_LARGE: 'transferTooLarge', INVALID_IMPORT: 'invalidBundle', UNSUPPORTED_FORMAT: 'invalidBundle',
      EDITOR_RUNTIME_ERROR: 'editorRuntimeFailed', EDITOR_START_TIMEOUT: 'editorStartTimeout', EDITOR_TIMEOUT: 'editorStartTimeout',
      EDITOR_DOCUMENT_TOO_LARGE: 'editorTooLarge', EDITOR_RESPONSE_TOO_LARGE: 'editorTooLarge',
      EDITOR_FLUSH_FAILED: 'editorSaveFailed', EDITOR_FLUSH_TIMEOUT: 'editorSaveFailed', EDITOR_UNSAVED_CHANGES: 'editorSaveFailed',
      TRANSFER_TOO_LARGE: 'transferTooLarge', INVALID_BUNDLE: 'invalidBundle', FILE_READ_FAILED: 'fileReadFailed', DOWNLOAD_UNAVAILABLE: 'downloadUnavailable',
    }[error?.code];
    // Keep implementation diagnostics in the console, outside localized product copy.
    if (error?.message) console.warn('[Codex Design] ' + (error.code || 'UI_ERROR') + ': ' + String(error.message).slice(0, 2000));
    if (key) return t(key);
    return String(error?.code || '').startsWith('EDITOR_') ? t('editorUnavailable') : t('actionFailed');
  }
  async function invoke(action, payload = {}) {
    if (!enabled(action)) throw new BridgeError(t('unsupported'), 'UNSUPPORTED');
    return bridge.invoke(action, payload);
  }
  async function runAction(key, action) {
    if (busy(key)) return;
    state.busy.add(key);
    try { return await action(); }
    catch (error) { if (error?.code !== 'DOWNLOAD_CANCELLED') toast(errorMessage(error), true); return undefined; }
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
    elements.sidebar.innerHTML = '<div class="sidebar-heading"><span class="wordmark">Codex Design</span><div class="sidebar-heading-actions"><button type="button" class="icon-button sidebar-search" data-action="focus-search" aria-label="' + escape(t('search')) + '">' + icon('search') + '</button><button type="button" class="icon-button sidebar-collapse" data-action="toggle-sidebar" aria-label="' + escape(t('collapseSidebar')) + '" title="' + escape(t('collapseSidebar')) + '">' + icon('sidebar') + '</button></div></div>'
      + '<button type="button" class="sidebar-item sidebar-create" data-action="create" data-menu-trigger="true" aria-haspopup="menu" aria-expanded="false"' + disabled('library.create') + '>' + icon('plus') + '<span>' + escape(t('create')) + '</span></button>'
      + '<nav class="category-navigation" aria-label="' + escape(t('libraryNavigation')) + '">' + navItem('all', 'library') + KINDS.map((kind) => navItem(kind)).join('') + '</nav>'
      + '<div class="recent-section"><button type="button" class="section-label recent-heading" data-action="category" data-category="recent">' + escape(t('recent')) + '</button><div class="recent-items">'
      + recents.map((record) => '<button type="button" class="sidebar-item recent-item" data-action="open" data-id="' + escape(record.id) + '" title="' + escape(record.title) + '" aria-label="' + escape(t('openDesign', { title: record.title })) + '">' + icon(record.kind) + '<span>' + escape(record.title) + '</span></button>').join('') + '</div></div>'
      + '<div class="sidebar-bottom">' + navItem('trash') + '</div>';
    elements.shell.classList.toggle('sidebar-open', state.mobileSidebar);
    elements.shell.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    elements.scrim.hidden = !state.mobileSidebar;
    elements.sidebarToggle.innerHTML = icon('sidebar');
    const navigationExpanded = matchMedia('(max-width: 700px)').matches ? state.mobileSidebar : !state.sidebarCollapsed;
    elements.sidebarToggle.setAttribute('aria-label', t(navigationExpanded ? 'collapseSidebar' : 'expandSidebar'));
    elements.sidebarToggle.setAttribute('title', t(navigationExpanded ? 'collapseSidebar' : 'expandSidebar'));
    elements.sidebarToggle.setAttribute('aria-expanded', String(navigationExpanded));
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
  function createButton(empty = false) {
    const kind = KINDS.includes(state.category) ? state.category : null;
    return '<button type="button" class="button primary" data-action="' + (kind ? 'create-kind' : 'create') + '"'
      + (kind ? ' data-value="' + kind + '"' : ' data-menu-trigger="true" aria-haspopup="menu" aria-expanded="false"')
      + disabled('library.create') + '>' + (kind ? icon(kind) : empty ? icon('plus') : '')
      + escape(t(kind ? 'newArtwork.' + kind : empty ? 'createArtwork' : 'create')) + (!kind && !empty ? icon('chevron') : '') + '</button>';
  }
  function renderEmpty(records) {
    let heading = 'emptyTitle', body = 'emptyBody', symbol = 'library';
    if (state.error) { heading = 'libraryUnavailable'; body = 'bridgeUnavailable'; symbol = 'warning'; }
    else if (state.query) { heading = 'emptySearch'; body = 'emptySearchBody'; symbol = 'search'; }
    else if (state.category === 'trash') { heading = 'emptyTrash'; body = 'emptyTrashBody'; symbol = 'trash'; }
    else if (state.favorites) { heading = 'emptyFavorites'; body = 'emptyFavoritesBody'; symbol = 'star'; }
    else if (KINDS.includes(state.category)) { heading = 'emptyCategory.' + state.category + '.title'; body = 'emptyCategory.' + state.category + '.body'; symbol = state.category; }
    return '<section class="library-empty"><div class="empty-symbol">' + icon(symbol) + '</div><h2>' + escape(t(heading)) + '</h2><p>' + escape(t(body)) + '</p>'
      + (state.query ? '<button type="button" class="button secondary" data-action="clear-search">' + escape(t('clearSearch')) + '</button>'
        : state.error ? '<button type="button" class="button secondary" data-action="refresh"' + disabled('library.list') + '>' + icon('refresh') + escape(t('retry')) + '</button>'
          : state.category !== 'trash' && !state.favorites ? createButton(true) : '') + '</section>';
  }
  function recordActions(record) {
    if (isDeleted(record)) return '<button type="button" class="button secondary restore-button" data-action="restore" data-id="' + escape(record.id) + '"' + (busy('purge-trash') ? ' disabled' : disabled('library.restore')) + '>' + icon('restore') + escape(t('restore')) + '</button>'
      + '<button type="button" class="button trash-delete-button" data-action="purge-dialog" data-id="' + escape(record.id) + '" aria-label="' + escape(t('deletePermanentlyTitle', { title: record.title })) + '"' + (busy('purge-trash') ? ' disabled' : disabled('library.purge')) + '>' + escape(t('deletePermanently')) + '</button>';
    return '<button type="button" class="icon-button favorite-button ' + (record.favorite ? 'is-favorite' : '') + '" data-action="favorite" data-id="' + escape(record.id) + '" data-focus-key="favorite-' + escape(record.id) + '" aria-label="' + escape(t(record.favorite ? 'unfavoriteDesign' : 'favoriteDesign', { title: record.title })) + '" aria-pressed="' + Boolean(record.favorite) + '"' + disabled('library.setFavorite') + '>' + icon('star') + '</button>'
      + '<button type="button" class="icon-button" data-action="item-menu" data-menu-trigger="true" data-id="' + escape(record.id) + '" aria-haspopup="menu" aria-label="' + escape(t('moreActions', { title: record.title })) + '">' + icon('more') + '</button>';
  }
  function recordStatus(record) {
    return record.contentStatus && record.contentStatus !== 'ok' ? '<span class="record-status">' + icon('warning') + escape(t(record.contentStatus === 'missing' ? 'missing' : 'invalid')) + '</span>' : '<span class="record-kind">' + escape(t(record.kind)) + '</span>';
  }
  function recordOpen(record, className = '') {
    const cannotOpen = isDeleted(record) || (record.contentStatus && record.contentStatus !== 'ok') || !enabled('view.openTab');
    const visual = className === 'card-open' ? thumbnail(record) : '<span class="record-type-icon" title="' + escape(t(record.kind)) + '" aria-hidden="true">' + icon(record.kind) + '</span>';
    return '<button type="button" class="record-open ' + className + '" data-action="open" data-id="' + escape(record.id) + '" aria-label="' + escape(t('openDesign', { title: record.title })) + '"' + (cannotOpen ? ' disabled' : '') + '>' + visual + '<span class="record-copy"><span class="record-title">' + escape(record.title) + '</span>' + recordStatus(record) + '</span></button>';
  }
  function selectedTrashRecords(records = visibleRecords()) {
    return state.category === 'trash' ? records.filter(record => isDeleted(record) && state.trashSelection.has(record.id)) : [];
  }
  function trashCheckbox(record, className = '') {
    return '<label class="trash-checkbox ' + className + '"><input type="checkbox" data-action="trash-select" data-id="' + escape(record.id) + '" data-focus-key="trash-select-' + escape(record.id) + '" aria-label="' + escape(t('selectTrashDesign', { title: record.title })) + '"' + (state.trashSelection.has(record.id) ? ' checked' : '') + (busy('purge-trash') ? ' disabled' : '') + '></label>';
  }
  function renderTrashSelection(records) {
    if (state.category !== 'trash') return;
    const visible = new Set(records.map(record => record.id));
    state.trashSelection = new Set([...state.trashSelection].filter(id => visible.has(id)));
    const selected = selectedTrashRecords(records).length;
    const controls = elements.panel.querySelector('.trash-selection-bar');
    if (!controls) return;
    controls.innerHTML = '<label class="trash-select-all"><input type="checkbox" data-action="trash-select-all" data-focus-key="trash-select-all"' + (records.length && selected === records.length ? ' checked' : '') + (!records.length || busy('purge-trash') ? ' disabled' : '') + '><span>' + escape(t('selectVisibleTrash', { count: records.length })) + '</span></label>'
      + '<span class="trash-selection-count" role="status">' + escape(t('trashSelected', { count: selected })) + '</span><button type="button" class="button trash-delete-button" data-action="purge-selected"' + (!selected || busy('purge-trash') ? ' disabled' : disabled('library.purge')) + '>' + escape(t('deleteSelected')) + '</button>';
    const checkbox = controls.querySelector('input');
    if (checkbox) checkbox.indeterminate = selected > 0 && selected < records.length;
  }
  function renderRecords() {
    const container = elements.panel.querySelector('.records-container');
    if (!container) return;
    const focused = focusKey();
    const records = visibleRecords();
    const trash = state.category === 'trash';
    renderTrashSelection(records);
    const counter = elements.panel.querySelector('.design-count');
    if (counter) counter.textContent = t('count', { count: records.length });
    container.className = 'records-container ' + (state.layout === 'grid' ? 'is-grid' : 'is-list');
    if (state.loading) container.innerHTML = '<div class="library-empty loading-state" role="status"><span class="spinner"></span><p>' + escape(t('loadingLibrary')) + '</p></div>';
    else if (!records.length || state.error) container.innerHTML = renderEmpty(records);
    else if (state.layout === 'grid') container.innerHTML = '<div class="design-grid' + (trash ? ' trash-grid' : '') + '">' + records.map((record) => '<article class="design-card' + (trash && state.trashSelection.has(record.id) ? ' is-selected' : '') + '">' + (trash ? trashCheckbox(record, 'trash-card-selection') : '') + recordOpen(record, 'card-open') + '<div class="card-bottom"><span>' + escape(formatTime(record.updatedAt)) + '</span><div class="record-actions">' + recordActions(record) + '</div></div></article>').join('') + '</div>';
    else container.innerHTML = '<table class="design-table' + (trash ? ' trash-table' : '') + '"><thead><tr>' + (trash ? '<th scope="col" class="trash-selection-column"><span class="sr-only">' + escape(t('selectDesigns')) + '</span></th>' : '') + '<th scope="col">' + escape(t('name')) + '</th><th scope="col" class="kind-column">' + escape(t('kindColumn')) + '</th><th scope="col" class="edited-column">' + escape(t('lastEdited')) + '</th><th scope="col"><span class="sr-only">' + escape(t('actions')) + '</span></th></tr></thead><tbody>'
      + records.map((record) => '<tr' + (trash && state.trashSelection.has(record.id) ? ' class="is-selected"' : '') + '>' + (trash ? '<td class="trash-selection-column">' + trashCheckbox(record) + '</td>' : '') + '<th scope="row">' + recordOpen(record) + '</th><td class="kind-column">' + escape(t(record.kind)) + '</td><td class="edited-column"><time datetime="' + escape(record.updatedAt) + '">' + escape(formatTime(record.updatedAt)) + '</time></td><td><div class="record-actions">' + recordActions(record) + '</div></td></tr>').join('') + '</tbody></table>';
    restoreFocus(focused);
    hydrateThumbnails();
  }
  function renderLibrary() {
    const categoryTitle = t(state.category);
    elements.panel.classList.add('library-panel');
    elements.panel.innerHTML = '<section class="library-content"><header class="library-heading"><div class="heading-copy"><button type="button" class="icon-button mobile-menu" data-action="toggle-sidebar" aria-label="' + escape(t('libraryNavigation')) + '" aria-expanded="' + state.mobileSidebar + '">' + icon('menu') + '</button><div><h1>' + escape(categoryTitle) + '</h1><p class="design-count"></p></div></div><div class="library-heading-actions"><label class="search-field">' + icon('search') + '<span class="sr-only">' + escape(t('search')) + '</span><input type="search" class="library-search" placeholder="' + escape(t('searchKind', { kind: categoryTitle })) + '" value="' + escape(state.query) + '" autocomplete="off"></label>'
      + (state.category !== 'trash' ? createButton() : '') + '</div></header>'
      + '<div class="library-controls"><div class="filter-tabs" role="group" aria-label="' + escape(t('favorites')) + '"><button type="button" class="filter-tab ' + (!state.favorites ? 'is-selected' : '') + '" data-action="filter" data-value="all" aria-pressed="' + !state.favorites + '">' + escape(t('all')) + '</button><button type="button" class="filter-tab ' + (state.favorites ? 'is-selected' : '') + '" data-action="filter" data-value="favorites" aria-pressed="' + state.favorites + '">' + escape(t('favorites')) + '</button></div><div class="view-controls"><button type="button" class="icon-button" data-action="sort-menu" data-menu-trigger="true" aria-haspopup="menu" aria-label="' + escape(t('sort')) + '">' + icon('sort') + '</button><span class="control-divider"></span><button type="button" class="icon-button ' + (state.layout === 'grid' ? 'is-selected' : '') + '" data-action="layout" data-layout="grid" aria-pressed="' + (state.layout === 'grid') + '" aria-label="' + escape(t('gridView')) + '">' + icon('grid') + '</button><button type="button" class="icon-button ' + (state.layout === 'list' ? 'is-selected' : '') + '" data-action="layout" data-layout="list" aria-pressed="' + (state.layout === 'list') + '" aria-label="' + escape(t('listView')) + '">' + icon('list') + '</button></div></div>' + (state.category === 'trash' ? '<div class="trash-selection-bar"></div>' : '') + '<div class="records-container"></div></section>';
    renderRecords();
  }
  async function openEditor(id, force = false) {
    const record = recordFor(id);
    if (!record || isDeleted(record)) { renderEditorFailure(t('restoredTabMissing'), id); return; }
    if (record.contentStatus && record.contentStatus !== 'ok') { renderEditorFailure(t(record.contentStatus === 'missing' ? 'missingBody' : 'invalidBody'), id); return; }
    if (currentNativeEditor && state.view.activeTabId === id) {
      try { await flushCurrentEditor(); }
      catch (error) { toast(errorMessage(error), true); return; }
    }
    const sequence = ++editorSequence;
    currentNativeEditor?.dispose();
    currentNativeEditor = null;
    currentEditorUrl = null;
    const host = elements.panel.querySelector('.editor-frame-host');
    if (!host) return;
    host.innerHTML = '<div class="editor-loading" role="status"><span class="spinner"></span><p>' + escape(t('loadingEditor')) + '</p></div>';
    try {
      const native = bridge.supportsInlineEditor === true;
      const channel = native ? crypto.randomUUID() : null;
      const result = await invoke(native ? 'editor.document' : 'editor.open', { id, force, ...(native ? { language: 'en', channel, canDraftComments: bridge.canDraftComments === true } : {}) });
      if (state.destroyed || sequence !== editorSequence || state.view.activeTabId !== id) return;
      const iframe = document.createElement('iframe');
      iframe.className = 'design-editor-frame';
      iframe.title = t('editorFrame', { title: record.title });
      iframe.allow = 'clipboard-read; clipboard-write; fullscreen';
      iframe.referrerPolicy = 'no-referrer';
      iframe.setAttribute('allowfullscreen', '');
      iframe.addEventListener('load', postEditorLanguage);
      let url;
      if (native) {
        let editorReady = false;
        currentNativeEditor = mountNativeEditor({ iframe, bridge, artifactId: id, channel, document: result,
          onReady: () => { editorReady = true; host.querySelector('.editor-boot-overlay')?.remove(); },
          onError: error => {
            if (state.view.activeTabId !== id || sequence !== editorSequence) return;
            const message = typeof error === 'string' ? error : errorMessage(error);
            if (!editorReady) renderEditorFailure(message || t('editorUnavailable'), id);
            else toast(message || t('editorUnavailable'), true);
          } });
        currentEditorUrl = currentNativeEditor.url;
      } else {
        if (typeof result?.url !== 'string' || !result.url.trim()) throw new BridgeError('The editor did not return a URL.', 'INVALID_EDITOR_URL');
        url = new URL(result.url, location.href);
        if (!['http:', 'https:'].includes(url.protocol)) throw new BridgeError('The editor returned an unsupported URL.', 'INVALID_EDITOR_URL');
        url.searchParams.set('codexDesignLanguage', 'en');
        currentEditorUrl = url.href;
        iframe.src = url.href;
      }
      host.replaceChildren(iframe);
      if (native) {
        const loading = document.createElement('div');
        loading.className = 'editor-boot-overlay';
        loading.setAttribute('role', 'status');
        loading.innerHTML = '<span class="spinner"></span><p>' + escape(t('loadingEditor')) + '</p>';
        host.append(loading);
      }
      const external = elements.panel.querySelector('.editor-external');
      if (external) { external.hidden = native; if (url) external.href = url.href; }
    } catch (error) {
      if (sequence === editorSequence && state.view.activeTabId === id) renderEditorFailure(errorMessage(error), id);
    }
  }
  function renderEditorFailure(message, id) {
    currentNativeEditor?.dispose();
    currentNativeEditor = null;
    const host = elements.panel.querySelector('.editor-frame-host');
    if (!host) return;
    host.innerHTML = '<div class="editor-loading"><div class="empty-symbol">' + icon('warning') + '</div><h2>' + escape(t('editorUnavailable')) + '</h2><p>' + escape(message) + '</p><button type="button" class="button secondary" data-action="retry-editor" data-id="' + escape(id) + '"' + disabled(bridge.supportsInlineEditor === true ? 'editor.document' : 'editor.open') + '>' + escape(t('openEditorAgain')) + '</button></div>';
  }
  function postEditorLanguage() {
    const frame = elements.panel.querySelector('.design-editor-frame');
    if (!frame || !currentEditorUrl) return;
    const message = { type: 'codex-design:ui-language-changed', preference: 'en', systemLocale: 'en' };
    if (currentNativeEditor?.post) currentNativeEditor.post(message);
    else frame.contentWindow?.postMessage(message, currentNativeEditor ? '*' : new URL(currentEditorUrl).origin);
  }
  function renderWorkspace() {
    const id = state.view.activeTabId;
    if (id === 'library') {
      ++editorSequence;
      currentNativeEditor?.dispose();
      currentNativeEditor = null;
      currentEditorUrl = null;
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
      currentNativeEditor?.dispose();
      currentNativeEditor = null;
      elements.panel.innerHTML = '<section class="editor-workspace"><header class="editor-workspace-heading"><div class="editor-title-group"><h1 class="editor-design-title"><button type="button" class="editor-title-button" data-action="rename" data-id="' + escape(id) + '" title="' + escape(t('rename')) + '">' + escape(title) + '</button></h1></div><div class="editor-heading-actions"><a class="icon-button editor-external" target="_blank" rel="noopener noreferrer" aria-label="' + escape(t('editorExternal')) + '" hidden>' + icon('external') + '</a><button type="button" class="icon-button" data-action="item-menu" data-menu-trigger="true" data-id="' + escape(id) + '" aria-haspopup="menu" aria-label="' + escape(t('moreActions', { title })) + '">' + icon('more') + '</button></div></header><div class="editor-frame-host"></div></section>';
      currentSurface = id;
      openEditor(id);
      refreshConversation(id);
    } else {
      const heading = elements.panel.querySelector('.editor-title-button');
      if (heading) heading.textContent = title;
      const frame = elements.panel.querySelector('iframe');
      if (frame) frame.title = t('editorFrame', { title });
      const menuLabel = t('moreActions', { title });
      const trigger = elements.panel.querySelector('.editor-heading-actions [data-action="item-menu"]');
      if (trigger) trigger.setAttribute('aria-label', menuLabel);
      if (state.menu?.type === 'item' && state.menu.id === id) elements.menus.querySelector('.menu-panel')?.setAttribute('aria-label', menuLabel);
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
      try {
        const current = state.view.activeTabId;
        const leavesCurrent = current !== 'library' && (action === 'closeTab' && payload.id === current || ['openTab', 'activateTab'].includes(action) && payload.id !== current);
        if (leavesCurrent) await flushCurrentEditor();
        applyView(await invoke('view.' + action, payload));
        return true;
      }
      catch (error) { toast(errorMessage(error), true); return false; }
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
  async function setCategory(category) {
    if (!['all', 'recent', 'trash', ...KINDS].includes(category)) return;
    const previous = { category: state.category, favorites: state.favorites, query: state.query, sort: state.sort };
    state.category = category;
    state.trashSelection.clear();
    state.favorites = false;
    state.query = '';
    state.mobileSidebar = false;
    if (category === 'recent') state.sort = 'updated';
    if (state.view.activeTabId !== 'library') {
      if (!await changeView('activateTab', { id: 'library' })) { Object.assign(state, previous); renderSidebar(); return; }
    }
    else { renderSidebar(); renderLibrary(); }
    await refreshRecords(true);
  }
  function closeMenu(returnFocus = false) {
    const origin = state.menu?.origin;
    menuDismissal.clear();
    state.menu = null;
    elements.menus.replaceChildren();
    origin?.setAttribute('aria-expanded', 'false');
    if (returnFocus) origin?.focus();
  }
  function openMenu(type, origin, id, mode = 'pointer') {
    if (state.menu?.type === type && state.menu?.id === id) { closeMenu(); return; }
    closeMenu();
    const record = recordFor(id);
    const items = type === 'sort' ? [
      ['sort-value', 'sortUpdated', 'updated', state.sort === 'updated'],
      ['sort-value', 'sortCreated', 'created', state.sort === 'created'],
      ['sort-value', 'sortName', 'name', state.sort === 'name'],
    ] : type === 'create' ? [...KINDS.map(kind => ['create-kind', kind, kind, false]), ['import', 'importArtwork', '', false]]
      : [['rename', 'rename', '', false], ['copy', 'copy', '', false], ['export', 'exportArtwork', '', false], ['history', 'versionHistory', '', false], ['trash-dialog', 'trashAction', '', false]];
    state.menu = { type, id, origin };
    const rectangle = origin.getBoundingClientRect();
    const position = menuPosition(rectangle, { width: type === 'create' ? 252 : 220, height: type === 'create' ? 294 : type === 'sort' ? 158 : 236, viewportWidth: innerWidth, viewportHeight: innerHeight, align: origin.classList.contains('sidebar-create') ? 'start' : 'end' });
    origin.setAttribute('aria-expanded', 'true');
    elements.menus.innerHTML = '<div class="menu-panel ' + (type === 'create' ? 'create-menu' : '') + '" role="menu" aria-label="' + escape(t(type === 'create' ? 'createContent' : type === 'sort' ? 'sort' : 'moreActions', { title: record?.title || '' })) + '" style="top:' + position.top + 'px;left:' + position.left + 'px;width:' + position.width + 'px;max-height:' + position.maxHeight + 'px">'
      + (type === 'create' ? '<div class="menu-heading">' + escape(t('createContent')) + '</div>' : '')
      + items.map(([action, label, value, checked]) => {
        const method = { 'create-kind': 'library.create', import: 'library.importArtifact', export: 'library.exportArtifact', history: 'library.listSnapshots', rename: 'library.rename', copy: 'library.duplicate', 'trash-dialog': 'library.trash' }[action];
        return (['import', 'trash-dialog'].includes(action) ? '<div class="menu-separator" role="separator"></div>' : '') + '<button type="button" role="' + (type === 'sort' ? 'menuitemradio' : 'menuitem') + '"' + (type === 'sort' ? ' aria-checked="' + checked + '"' : '') + ' class="menu-item ' + (action === 'trash-dialog' ? 'danger' : '') + '" data-action="' + action + '" data-id="' + escape(record?.id || '') + '" data-value="' + value + '"' + (method ? disabled(method) : '') + '>' + icon(action === 'create-kind' ? value : action === 'import' ? 'upload' : action === 'export' ? 'download' : action === 'history' ? 'clock' : action === 'sort-value' ? checked ? 'check' : 'sort' : action === 'trash-dialog' ? 'trash' : action) + '<span>' + escape(t(label)) + '</span></button>';
      }).join('') + '</div>';
    const panel = elements.menus.firstElementChild;
    const measured = menuPosition(rectangle, { width: position.width, height: panel.getBoundingClientRect().height, viewportWidth: innerWidth, viewportHeight: innerHeight, align: origin.classList.contains('sidebar-create') ? 'start' : 'end' });
    panel.style.top = measured.top + 'px';
    panel.style.left = measured.left + 'px';
    menuDismissal.open({ trigger: origin, menu: panel, mode });
    elements.menus.querySelector('button:not(:disabled)')?.focus();
  }
  async function createArtifact(kind) {
    if (!KINDS.includes(kind)) return;
    await runAction('create', async () => {
      root.setAttribute('aria-busy', 'true');
      try {
        const result = await invoke('library.create', { kind, title: t('untitled.' + kind) });
        const record = result?.artifact || result;
        if (!isRecord(record)) throw new BridgeError(t('actionFailed'), 'INVALID_RESPONSE');
        // Publish the persisted record before opening its tab, avoiding an initial list race.
        upsertRecord(record);
        state.mobileSidebar = false;
        await changeView('openTab', { id: record.id });
        await refreshRecords(true);
        announce(t('created'));
      } finally { root.removeAttribute('aria-busy'); }
    });
  }
  async function openHistory(id) {
    const record = recordFor(id);
    if (!record || isDeleted(record)) return;
    closeMenu();
    const dialog = elements.dialog;
    dialog.innerHTML = '<section class="dialog-form history-dialog" data-history-id="' + escape(id) + '"><header><h2 id="design-dialog-title">' + escape(t('versionHistory')) + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="' + escape(t('closeDialog')) + '">' + icon('close') + '</button></header><p class="dialog-description">' + escape(t('historyDescription')) + '</p><button type="button" class="button secondary" data-action="snapshot-create" data-id="' + escape(id) + '"' + disabled('library.snapshot') + '>' + icon('plus') + escape(t('createSnapshot')) + '</button><div class="snapshot-list" aria-live="polite"><p class="field-hint">' + escape(t('loadingHistory')) + '</p></div><footer><button type="button" class="button secondary" data-action="close-dialog">' + escape(t('done')) + '</button></footer></section>';
    dialog.setAttribute('aria-labelledby', 'design-dialog-title');
    if (!dialog.open) dialog.showModal();
    try {
      const snapshots = await transfer.listSnapshots(id);
      if (state.destroyed || !dialog.open || dialog.querySelector('[data-history-id]')?.dataset.historyId !== id) return;
      const automaticLabels = { Snapshot: 'manualSnapshot', 'Before restore': 'beforeRestoreSnapshot', 'Before AI edit': 'beforeAiSnapshot', 'Before resumed AI edit': 'beforeResumedAiSnapshot' };
      dialog.querySelector('.snapshot-list').innerHTML = snapshots.length ? snapshots.map(snapshot => '<article class="snapshot-row"><div><strong>' + escape(Object.hasOwn(automaticLabels, snapshot.label) ? t(automaticLabels[snapshot.label]) : snapshot.label || t('manualSnapshot')) + '</strong><time datetime="' + escape(snapshot.createdAt) + '">' + escape(new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(snapshot.createdAt))) + '</time></div><button type="button" class="button secondary" data-action="snapshot-restore" data-id="' + escape(id) + '" data-snapshot-id="' + escape(snapshot.id) + '"' + disabled('library.restoreSnapshot') + '>' + escape(t('restoreVersion')) + '</button></article>').join('') : '<p class="field-hint">' + escape(t('historyEmpty')) + '</p>';
    } catch (error) {
      if (dialog.querySelector('[data-history-id]')?.dataset.historyId === id) dialog.querySelector('.snapshot-list').innerHTML = '<p class="dialog-error">' + escape(errorMessage(error)) + '</p>';
    }
  }
  function openPurgeDialog(records) {
    if (busy('purge-trash') || !enabled('library.purge')) return;
    const eligible = records.filter(record => record && isDeleted(record));
    if (!eligible.length) return;
    closeMenu();
    purgeConfirmation = eligible.map(record => ({ id: record.id, title: record.title }));
    elements.dialog.innerHTML = '<form class="dialog-form" data-dialog-type="purge"><header><h2 id="design-dialog-title">' + escape(t('purgeTitle', { count: eligible.length })) + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="' + escape(t('closeDialog')) + '">' + icon('close') + '</button></header><div class="dialog-fields"><p class="dialog-description">' + escape(t('purgeBody', { count: eligible.length })) + '</p><ul class="purge-title-list">' + eligible.map(record => '<li>' + escape(record.title) + '</li>').join('') + '</ul><p class="purge-warning">' + escape(t('purgeIrreversible')) + '</p></div><p class="dialog-error purge-error" role="alert" hidden></p><footer><button type="button" class="button secondary" data-action="close-dialog">' + escape(t('cancel')) + '</button><button type="submit" class="button destructive">' + escape(t('deletePermanently')) + '</button></footer></form>';
    elements.dialog.setAttribute('aria-labelledby', 'design-dialog-title');
    if (!elements.dialog.open) elements.dialog.showModal();
    // Keep the initial focus on the reversible choice in a destructive dialog.
    elements.dialog.querySelector('footer [data-action="close-dialog"]')?.focus();
  }
  async function submitPurge(form) {
    if (!purgeConfirmation?.length || !elements.dialog.open || busy('purge-trash')) return;
    const confirmed = purgeConfirmation.map(record => ({ ...record }));
    const deleted = new Set(), failed = [];
    state.busy.add('purge-trash');
    form.setAttribute('aria-busy', 'true');
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      // The service limit applies to a request, not to a user's visible selection.
      for (let offset = 0; offset < confirmed.length; offset += 200) {
        const batch = confirmed.slice(offset, offset + 200);
        try {
          const result = await invoke('library.purge', { ids: batch.map(record => record.id) });
          if (!Array.isArray(result?.deleted) || !Array.isArray(result?.failed)) throw new BridgeError('The library returned an invalid deletion result.', 'INVALID_RESPONSE');
          const expected = new Set(batch.map(record => record.id));
          if (result.deleted.some(id => !expected.has(id)) || result.failed.some(item => !expected.has(item?.id))) throw new BridgeError('The library returned unrelated deletion results.', 'INVALID_RESPONSE');
          const failures = new Map(result.failed.map(item => [item.id, item]));
          for (const record of batch) {
            if (result.deleted.includes(record.id) && !failures.has(record.id)) deleted.add(record.id);
            else failed.push({ ...record, error: failures.get(record.id)?.error || { code: 'PURGE_UNCONFIRMED' }, removed: failures.get(record.id)?.removed });
          }
        } catch (error) {
          for (const record of confirmed.slice(offset)) failed.push({ ...record, error });
          break;
        }
      }
      if (deleted.size) {
        ++recordsSequence;
        state.records = state.records.filter(record => !deleted.has(record.id));
        for (const id of deleted) { state.trashSelection.delete(id); thumbnailCache.delete(id); }
      }
      await refreshRecords(true);
      const summary = [deleted.size ? t('purgeDeleted', { count: deleted.size }) : '', failed.length ? t('purgeFailed', { count: failed.length }) : ''].filter(Boolean).join(' ');
      if (failed.length) {
        // Reconfirm only the remaining items before a retry; successful deletions
        // never re-enter the next request or its confirmation count.
        state.busy.delete('purge-trash');
        openPurgeDialog(failed.map(record => ({ ...record, deleted: true })));
        const errorNode = elements.dialog.querySelector('.dialog-error');
        errorNode.hidden = false;
        errorNode.textContent = summary + '\n' + failed.map(record => record.title + ': ' + (record.removed?.length ? t('purgePartiallyRemoved') + ' ' : '') + (record.error?.code === 'PURGE_UNCONFIRMED' ? t('purgeUnconfirmed') : errorMessage(record.error))).join('\n');
      } else { purgeConfirmation = null; elements.dialog.close(); }
      toast(summary, failed.length > 0);
    } finally {
      state.busy.delete('purge-trash');
      form.removeAttribute('aria-busy');
      elements.dialog.querySelector('button[type="submit"]').disabled = false;
      if (state.view.activeTabId === 'library') renderRecords();
    }
  }
  function openDialog(type, record, details = {}) {
    closeMenu();
    const dialog = elements.dialog;
    let title, fields = '', submit;
    if (type === 'restore-snapshot') {
      title = t('restoreVersionTitle');
      fields = '<p class="dialog-description">' + escape(t('restoreVersionBody')) + '</p><label class="reload-saved-check"><input type="checkbox" name="saved" required><span>' + escape(t('editorChangesSaved')) + '</span></label>';
      submit = t('restoreVersion');
    } else if (type === 'trash') {
      title = t('trashTitle'); fields = '<p class="dialog-description">' + escape(t('trashBody', { title: record.title })) + '</p>'; submit = t('trashAction');
    } else {
      title = t(type === 'rename' ? 'renameTitle' : 'copyTitle');
      const value = type === 'copy' ? t('copyName', { title: record.title }) : record.title;
      fields += '<label class="field-label" for="design-title">' + escape(t('titleLabel')) + '</label><input id="design-title" name="title" type="text" required maxlength="200" autocomplete="off" value="' + escape(value) + '" placeholder="' + escape(t('titlePlaceholder')) + '">';
      submit = t(type === 'rename' ? 'renameSubmit' : 'copySubmit');
    }
    dialog.innerHTML = '<form class="dialog-form" data-dialog-type="' + type + '" data-id="' + escape(record?.id || '') + '" data-snapshot-id="' + escape(details.snapshotId || '') + '"><header><h2 id="design-dialog-title">' + escape(title) + '</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="' + escape(t('closeDialog')) + '">' + icon('close') + '</button></header><div class="dialog-fields">' + fields + '</div><p class="dialog-error" role="alert" hidden></p><footer><button type="button" class="button secondary" data-action="close-dialog">' + escape(t('cancel')) + '</button><button type="submit" class="button ' + (type === 'trash' ? 'destructive' : 'primary') + '">' + escape(submit) + '</button></footer></form>';
    dialog.setAttribute('aria-labelledby', 'design-dialog-title');
    if (!dialog.open) dialog.showModal();
    const input = dialog.querySelector('input[name="title"]');
    if (input) { input.focus(); input.select(); }
  }
  async function submitDialog(form) {
    const type = form.dataset.dialogType;
    const id = form.dataset.id;
    if (type === 'purge') { await submitPurge(form); return; }
    if (type === 'restore-snapshot') {
      if (!form.reportValidity() || form.getAttribute('aria-busy') === 'true') return;
      form.setAttribute('aria-busy', 'true');
      form.querySelector('button[type="submit"]').disabled = true;
      try {
        if (state.view.activeTabId === id) {
          await flushCurrentEditor();
          // Stop this iframe's autosave before replacing its source files.
          ++editorSequence; currentNativeEditor?.dispose(); currentNativeEditor = null; elements.panel.querySelector('.design-editor-frame')?.remove();
        }
        await transfer.restoreSnapshot(id, form.dataset.snapshotId);
        elements.dialog.close();
        toast(t('versionRestored'));
      } catch (error) {
        const errorNode = form.querySelector('.dialog-error');
        errorNode.hidden = false; errorNode.textContent = errorMessage(error);
        form.querySelector('button[type="submit"]').disabled = false;
        if (state.view.activeTabId === id) await openEditor(id, true);
      } finally { form.removeAttribute('aria-busy'); }
      return;
    }
    if (!form.reportValidity() || form.getAttribute('aria-busy') === 'true') return;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    if (type !== 'trash' && !title) { form.elements.title.focus(); return; }
    const action = { rename: 'library.rename', copy: 'library.duplicate', trash: 'library.trash' }[type];
    const payload = type === 'trash' ? { id } : { id, title };
    form.setAttribute('aria-busy', 'true');
    form.querySelector('button[type="submit"]').disabled = true;
    try {
      if (state.view.activeTabId === id) await flushCurrentEditor();
      const result = await invoke(action, payload);
      const returnedRecord = result?.artifact || result;
      upsertRecord(returnedRecord);
      elements.dialog.close();
      toast(t({ rename: 'renamed', copy: 'copied', trash: 'trashed' }[type]));
      if (type === 'trash' && state.view.tabs.some((tab) => tab.id === id)) await changeView('closeTab', { id });
      if (type === 'copy') {
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
  function renderInterface() {
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
      const rename = elements.panel.querySelector('.editor-title-button');
      if (rename) rename.title = t('rename');
      const menu = elements.panel.querySelector('.editor-heading-actions [data-action="item-menu"]');
      if (menu) menu.setAttribute('aria-label', t('moreActions', { title: activeRecord()?.title || '' }));
      postEditorLanguage();
    }
    closeMenu();
  }
  async function handleAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const { action, id } = button.dataset;
    if (!['item-menu', 'sort-menu', 'create'].includes(action)) closeMenu();
    if (action === 'create') openMenu('create', button, undefined, menuInputMode(event));
    else if (action === 'create-kind') await createArtifact(button.dataset.value);
    else if (action === 'import') {
      const task = transfer.importArtifact();
      await runAction('import', async () => { if (await task) toast(t('imported')); });
    } else if (action === 'export') await runAction('export-' + id, async () => { if (state.view.activeTabId === id) await flushCurrentEditor(); await transfer.exportArtifact(id, recordFor(id)?.title); toast(t('exported')); });
    else if (action === 'history') await openHistory(id);
    else if (action === 'snapshot-create') await runAction('snapshot-' + id, async () => { if (state.view.activeTabId === id) await flushCurrentEditor(); await transfer.createSnapshot(id, t('manualSnapshot')); await openHistory(id); });
    else if (action === 'snapshot-restore') { const record = recordFor(id); if (record) openDialog('restore-snapshot', record, { snapshotId: button.dataset.snapshotId }); }
    else if (action === 'rename' || action === 'copy' || action === 'trash-dialog') {
      const record = recordFor(id);
      if (record) openDialog(action === 'trash-dialog' ? 'trash' : action, record);
    } else if (action === 'purge-dialog') openPurgeDialog([recordFor(id)]);
    else if (action === 'purge-selected') openPurgeDialog(selectedTrashRecords());
    else if (action === 'trash-select' && !busy('purge-trash') && state.category === 'trash') {
      if (visibleRecords().some(record => record.id === id && isDeleted(record))) {
        if (button.checked) state.trashSelection.add(id); else state.trashSelection.delete(id);
        renderRecords();
      }
    } else if (action === 'trash-select-all' && !busy('purge-trash') && state.category === 'trash') {
      for (const record of visibleRecords()) { if (button.checked) state.trashSelection.add(record.id); else state.trashSelection.delete(record.id); }
      renderRecords();
    } else if (action === 'close-dialog') { if (!busy('purge-trash')) { purgeConfirmation = null; elements.dialog.close(); } }
    else if (action === 'category') await setCategory(button.dataset.category);
    else if (action === 'filter') { state.favorites = button.dataset.value === 'favorites'; state.trashSelection.clear(); renderLibrary(); }
    else if (action === 'layout') { state.layout = button.dataset.layout; renderLibrary(); }
    else if (action === 'sort-menu') openMenu('sort', button, undefined, menuInputMode(event));
    else if (action === 'item-menu') openMenu('item', button, id, menuInputMode(event));
    else if (action === 'sort-value') { state.sort = button.dataset.value; renderRecords(); }
    else if (action === 'open') { state.mobileSidebar = false; await changeView('openTab', { id }); }
    else if (action === 'activate-tab') { await changeView('activateTab', { id }); if (id === 'library') await refreshRecords(true); }
    else if (action === 'close-tab') await changeView('closeTab', { id });
    else if (action === 'favorite') await favoriteRecord(id);
    else if (action === 'restore') await restoreRecord(id);
    else if (action === 'refresh') await refreshRecords();
    else if (action === 'clear-search') { state.query = ''; state.trashSelection.clear(); renderLibrary(); elements.panel.querySelector('.library-search')?.focus(); }
    else if (action === 'retry-editor') await openEditor(id, true);
    else if (action === 'toggle-conversation') {
      const artifactId = state.view.activeTabId;
      if (state.minimized.has(artifactId)) { state.minimized.delete(artifactId); refreshConversation(artifactId); }
      else state.minimized.add(artifactId);
      renderConversation();
    } else if (action === 'focus-search') {
      if (state.view.activeTabId !== 'library') await changeView('activateTab', { id: 'library' });
      elements.panel.querySelector('.library-search')?.focus();
    } else if (action === 'toggle-sidebar') {
      if (matchMedia('(max-width: 700px)').matches) state.mobileSidebar = !state.mobileSidebar;
      else {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        try { localStorage.setItem('codex-design.sidebar-collapsed', String(state.sidebarCollapsed)); } catch {}
      }
      renderSidebar();
    }
    else if (action === 'dismiss-toast') { clearTimeout(toastTimer); elements.toast.replaceChildren(); }
  }
  root.addEventListener('click', (event) => { handleAction(event).catch((error) => toast(errorMessage(error), true)); }, { signal: abort.signal });
  root.addEventListener('input', (event) => {
    if (event.target.matches('.library-search')) { state.query = event.target.value; state.trashSelection.clear(); renderRecords(); }
    if (event.target.matches('.conversation-composer textarea')) {
      state.drafts.set(state.view.activeTabId, event.target.value);
      const submit = elements.floating.querySelector('.send-button');
      if (submit) submit.disabled = !event.target.value.trim() || busy('send-' + state.view.activeTabId);
    }
  }, { signal: abort.signal });
  root.addEventListener('contextmenu', event => {
    const row = event.target.closest('.design-table tbody tr, .design-card');
    const origin = row?.querySelector('[data-action="item-menu"]');
    if (!origin) return;
    event.preventDefault();
    const mode = event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : event.clientX || event.clientY ? 'pointer' : 'keyboard';
    openMenu('item', origin, origin.dataset.id, mode);
  }, { signal: abort.signal });
  root.addEventListener('submit', (event) => {
    if (event.target.matches('.dialog-form')) { event.preventDefault(); submitDialog(event.target); }
    if (event.target.matches('.conversation-composer')) { event.preventDefault(); sendConversation(); }
  }, { signal: abort.signal });
  elements.dialog.addEventListener('cancel', event => { if (busy('purge-trash')) event.preventDefault(); else purgeConfirmation = null; }, { signal: abort.signal });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.mobileSidebar) { state.mobileSidebar = false; renderSidebar(); }
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
        changeView('activateTab', { id: tabs[next].id }).then(changed => { if (changed) restoreFocus('tab-' + tabs[next].id); });
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
  window.addEventListener('resize', () => closeMenu(), { signal: abort.signal });
  elements.scrim.addEventListener('click', () => { state.mobileSidebar = false; renderSidebar(); }, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view.activeTabId === 'library') void refreshRecords(true); }, { signal: abort.signal });
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
    if (type === 'language.changed' || type === 'languagechange') return;
    if (type.startsWith('conversation.') || type === 'worker.changed') { if (!event.artifactId || event.artifactId === state.view.activeTabId) refreshConversation(); return; }
    if (type === 'capabilities.changed') { renderInterface(); refreshConversation(); return; }
    if (type.startsWith('library.') || type.startsWith('artifact.') || type === 'changed') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refreshRecords(true), 100);
    }
  }) : null;
  renderInterface();
  renderWorkspace();
  const initial = bridge.initialState;
  if (initial?.artifacts) state.records = initial.artifacts.filter(isRecord);
  if (initial?.viewState) applyView(initial.viewState);
  const results = await Promise.allSettled([refreshRecords(), invoke('view.get')]);
  if (results[1].status === 'fulfilled') applyView(results[1].value);
  else if (bridge.available !== false) toast(errorMessage(results[1].reason), true);
  return {
    refresh: () => refreshRecords(true),
    activateArtifact: (id) => changeView('openTab', { id }),
    destroy() {
      state.destroyed = true;
      if (bridge.beforeNavigate === navigationGuard) bridge.beforeNavigate = previousNavigationGuard;
      currentNativeEditor?.dispose();
      currentNativeEditor = null;
      ++editorSequence;
      ++conversationSequence;
      clearTimeout(toastTimer);
      clearTimeout(conversationTimer);
      clearTimeout(refreshTimer);
      menuDismissal.dispose();
      abort.abort();
      if (typeof unsubscribe === 'function') unsubscribe();
      root.replaceChildren();
    },
  };
}
