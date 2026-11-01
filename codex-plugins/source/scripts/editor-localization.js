import i18next from 'i18next';

// This boot adapter feeds the editors' existing message-ID/ICU pipeline. It
// deliberately never walks the DOM or reads a design, comment, or chat body.
export const LANGUAGE_STORAGE_KEY = 'codex-design.ui-language';
export const LANGUAGE_EVENT = 'codex-design:ui-language-changed';
export const PENDING_LANGUAGE_EVENT = 'codex-design:ui-language-pending';

export function normalizePreference(value) {
  return value === 'en' ? 'en' : null;
}

export function resolveLanguage() {
  return 'en';
}

export function initializeEditorLocalization(target = globalThis, engine = i18next.createInstance()) {
  const catalog = target.__CODEX_DESIGN_EDITOR_RESOURCES__;
  if (!catalog?.resources?.en?.editor) return null;
  const effectiveLanguage = 'en';
  // With in-memory resources i18next initializes synchronously. The classic
  // script is intentionally loaded before the editor's module and comments.
  engine.init({
    lng: effectiveLanguage,
    fallbackLng: 'en',
    supportedLngs: ['en'],
    resources: { en: catalog.resources.en },
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
    lang: 'en-US',
    settled,
  };
  if (target.document?.documentElement) target.document.documentElement.lang = 'en';

  function status() {
    return {
      kind: catalog.kind,
      language: effectiveLanguage,
      preference: 'en',
      pendingLanguage: 'en',
      requiresReload: false,
      coverage: catalog.coverage,
    };
  }
  function notify() {
    const state = status();
    if (typeof target.CustomEvent === 'function') target.dispatchEvent?.(new target.CustomEvent(PENDING_LANGUAGE_EVENT, { detail: state }));
    return state;
  }
  function setPreference() {
    // Compatibility callers may still send an old preference. It cannot change
    // this release's UI language or rewrite the user's stored preferences.
    return notify();
  }
  const locale = 'en-US';
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
    return shortDate(date, current) + ', ' + time;
  }
  const api = Object.freeze({
    getLanguage: () => effectiveLanguage,
    getPreference: () => 'en',
    getStatus: status,
    setPreference,
    t: (key, values) => engine.t(key, values),
    formatSlideLabel({ number, count, title, skipped = false, thumbnail = false, comments = '' }) {
      let label = engine.t(count === undefined ? 'slides.numberLabel' : 'slides.positionLabel', { number, count });
      if (skipped) label += engine.t('slides.skippedSuffix');
      if (thumbnail) label += engine.t('slides.thumbnailSuffix');
      if (typeof title === 'string' && title !== '') label += engine.t('slides.titleSuffix', { title });
      return label + comments;
    },
    formatCommentTime,
    formatCommentTimestamp,
  });
  target.codexDesignEditorI18n = api;
  return api;
}

if (typeof window !== 'undefined') initializeEditorLocalization(window);
