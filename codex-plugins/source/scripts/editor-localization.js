import i18next from 'i18next';

// This boot adapter feeds the editors' existing message-ID/ICU pipeline. It
// deliberately never walks the DOM or reads a design, comment, or chat body.
export const LANGUAGE_STORAGE_KEY = 'codex-design.ui-language';
export const LANGUAGE_EVENT = 'codex-design:ui-language-changed';
export const PENDING_LANGUAGE_EVENT = 'codex-design:ui-language-pending';

export function normalizePreference(value) {
  return value === 'en' || value === 'zh' || value === 'system' ? value : null;
}

export function resolveLanguage(preference, { systemLocale, navigator: browserNavigator = {} } = {}) {
  if (preference === 'en' || preference === 'zh') return preference;
  const locale = typeof systemLocale === 'string' && systemLocale
    ? systemLocale
    : browserNavigator.language || browserNavigator.languages?.[0] || 'en';
  return /^zh(?:-|_|$)/i.test(locale) ? 'zh' : 'en';
}

export function initializeEditorLocalization(target = globalThis, engine = i18next.createInstance()) {
  const configuration = target.__CODEX_DESIGN_EDITOR_I18N__ || {};
  const catalog = target.__CODEX_DESIGN_EDITOR_RESOURCES__;
  if (!catalog?.resources?.en?.editor || !catalog?.resources?.zh?.editor) return null;
  let savedPreference;
  try { savedPreference = target.localStorage?.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Storage can be disabled. */ }
  let queryPreference;
  try { queryPreference = new URL(target.location.href).searchParams.get('codexDesignLanguage'); } catch { /* No location in a non-browser consumer. */ }
  let preference = normalizePreference(queryPreference) || normalizePreference(configuration.preference)
    || normalizePreference(savedPreference) || 'system';
  let systemLocale = configuration.systemLocale;
  const effectiveLanguage = resolveLanguage(preference, { systemLocale, navigator: target.navigator });
  // With in-memory resources i18next initializes synchronously. The classic
  // script is intentionally loaded before the editor's module and comments.
  engine.init({
    lng: effectiveLanguage,
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh'],
    resources: catalog.resources,
    ns: ['editor'],
    defaultNS: 'editor',
    keySeparator: false,
    nsSeparator: false,
    initAsync: false,
    initImmediate: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  const settled = Object.create(null);
  for (const key of Object.keys(catalog.resources.en.editor)) settled[key] = engine.t(key);
  target.__appifact_i18n = {
    lang: effectiveLanguage === 'zh' ? 'zh-CN' : 'en-US',
    settled,
  };
  if (target.document?.documentElement) target.document.documentElement.lang = effectiveLanguage === 'zh' ? 'zh-CN' : 'en';

  function status() {
    const pendingLanguage = resolveLanguage(preference, { systemLocale, navigator: target.navigator });
    return {
      kind: catalog.kind,
      language: effectiveLanguage,
      preference,
      pendingLanguage,
      requiresReload: pendingLanguage !== effectiveLanguage,
      coverage: catalog.coverage,
    };
  }
  function notify() {
    const state = status();
    if (typeof target.CustomEvent === 'function') target.dispatchEvent?.(new target.CustomEvent(PENDING_LANGUAGE_EVENT, { detail: state }));
    return state;
  }
  function setPreference(value, options = {}) {
    const next = normalizePreference(value);
    if (!next) throw new TypeError('Expected UI language preference: system, en, or zh.');
    preference = next;
    if (typeof options.systemLocale === 'string') systemLocale = options.systemLocale;
    if (options.persist !== false) {
      try { target.localStorage?.setItem(LANGUAGE_STORAGE_KEY, preference); } catch { /* A host can own persistence instead. */ }
    }
    // Native editors initialize some labels once. Do not partially translate
    // an open editor, mutate React-owned nodes, or discard unsaved edits by
    // reloading automatically. The owner can safely reopen when it is ready.
    return notify();
  }
  const locale = effectiveLanguage === 'zh' ? 'zh-CN' : 'en-US';
  function commentDate(value, now) {
    const date = new Date(value);
    const current = new Date(now);
    return Number.isNaN(date.getTime()) || Number.isNaN(current.getTime()) ? null : { date, current };
  }
  function shortDate(date, current) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(date.getFullYear() !== current.getFullYear() ? { year: 'numeric' } : {}) });
  }
  function formatCommentTime(value, now = new Date()) {
    const parsed = commentDate(value, now);
    if (!parsed) return '';
    const { date, current } = parsed;
    const minutes = Math.floor((current.getTime() - date.getTime()) / 60_000);
    if (minutes < 1) return engine.t('chrome.time.now');
    if (minutes < 60) return engine.t('chrome.time.minutes', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return engine.t('chrome.time.hours', { count: hours });
    const days = Math.floor(hours / 24);
    return days < 7 ? engine.t('chrome.time.days', { count: days }) : shortDate(date, current);
  }
  function formatCommentTimestamp(value, now = new Date()) {
    const parsed = commentDate(value, now);
    if (!parsed) return '';
    const { date, current } = parsed;
    if (current.getTime() - date.getTime() < 60_000) return engine.t('chrome.time.now');
    const time = date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((dayStart(current) - dayStart(date)) / 86_400_000);
    if (days === 0) return time;
    if (days === 1) return engine.t('chrome.time.yesterday', { time });
    return shortDate(date, current) + (effectiveLanguage === 'zh' ? '，' : ', ') + time;
  }
  const api = Object.freeze({
    getLanguage: () => effectiveLanguage,
    getPreference: () => preference,
    getStatus: status,
    setPreference,
    t: (key, values) => engine.t(key, values),
    formatCommentTime,
    formatCommentTimestamp,
  });
  target.codexDesignEditorI18n = api;
  target.addEventListener?.(LANGUAGE_EVENT, (event) => {
    const detail = event.detail;
    const next = normalizePreference(detail?.preference ?? detail?.language);
    if (next) setPreference(next, { systemLocale: detail.systemLocale, persist: false });
  });
  target.addEventListener?.('storage', (event) => {
    if (event.key === LANGUAGE_STORAGE_KEY) {
      const next = normalizePreference(event.newValue);
      if (next) setPreference(next, { persist: false });
    }
  });
  target.addEventListener?.('languagechange', () => { if (preference === 'system') notify(); });
  target.addEventListener?.('message', (event) => {
    if (!target.parent || target.parent === target || event.source !== target.parent) return;
    if (configuration.parentOrigin && event.origin !== configuration.parentOrigin) return;
    if (event.data?.type !== LANGUAGE_EVENT) return;
    const next = normalizePreference(event.data.preference);
    if (!next) return;
    const state = setPreference(next, { systemLocale: event.data.systemLocale, persist: false });
    event.source.postMessage({ type: PENDING_LANGUAGE_EVENT, ...state }, event.origin === 'null' ? '*' : event.origin);
  });
  return api;
}

if (typeof window !== 'undefined') initializeEditorLocalization(window);
