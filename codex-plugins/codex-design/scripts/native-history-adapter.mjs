const marker = '/* codex-design:native-history-v1 */';
const language = String.raw`var y=/^zh\b/i.test(navigator.language),`;
const saveBoundary = 'var Oe="/__share/save"';
const historyBoundary = 'var l=y?{title:';
const factory = 'function be(){let t=window.__baoyuHistory;return t&&typeof t.base=="string"?new Z(t):null}';
const sharingBoundary = 'var C=window.__baoyuShare??{},M=C.role==="owner";ce(M);ge(M);';
const noticeTimer = 'e(),window.setInterval(()=>void e(),5e3)';
const bannerNavigation = 'r.addEventListener("click",()=>location.href=e.current_url)';

function unsupported(detail) {
  return Object.assign(new Error('The upstream History interface changed; review its native adapter before loading it. ' + detail), {
    code: 'NATIVE_HISTORY_ADAPTER_UNSUPPORTED',
  });
}

function once(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || at !== source.lastIndexOf(needle)) throw unsupported('Expected one ' + needle.slice(0, 64));
  return at;
}

// Serialized beside the actual canonical History controller. The parent owns
// message validation, the full flush barrier and artifact-scoped HTTP access.
function installNativeHistory(controller) {
  const target = globalThis;
  if (!controller) throw Object.assign(new Error('History is unavailable for this artwork.'), { code: 'NATIVE_HISTORY_UNAVAILABLE' });
  target.__CODEX_DESIGN_NATIVE_HISTORY__?.dispose?.();
  let disposed = false, generation = 0, opening;
  const anchor = controller.button;
  anchor.tabIndex = -1;
  anchor.setAttribute('tabindex', '-1');
  anchor.setAttribute('aria-hidden', 'true');
  anchor.setAttribute('data-codex-native-history-anchor', '');
  Object.assign(anchor.style, { position: 'fixed', top: '16px', right: '16px', width: '1px', height: '1px', opacity: '0', visibility: 'hidden', pointerEvents: 'none' });
  document.body.append(anchor);
  const closeController = () => {
    controller.asking?.();
    controller.close();
    controller.hideToast();
  };
  const release = () => {
    closeController();
    target.clearInterval(controller.__codexNoticeTimer);
    target.clearInterval(controller.timer);
    target.clearTimeout(controller.toastTimer);
    anchor.remove();
    controller.layer.remove();
  };
  const api = Object.freeze({
    open() {
      if (disposed) return Promise.resolve(false);
      if (opening) return opening;
      if (controller.pop) return Promise.resolve(true);
      const ticket = ++generation;
      let tracked;
      tracked = (async () => {
        const flush = target.__CODEX_DESIGN_EDITOR_FLUSH__;
        if (typeof flush === 'function' && await flush() !== true) {
          throw Object.assign(new Error('Save the artwork before opening History.'), { code: 'EDITOR_UNSAVED_CHANGES' });
        }
        if (disposed || ticket !== generation) return false;
        await controller.open();
        if (disposed || ticket !== generation) {
          if (disposed) release();
          else closeController();
          return false;
        }
        return true;
      })().finally(() => { if (opening === tracked) opening = undefined; });
      opening = tracked;
      return tracked;
    },
    close() {
      if (disposed) return false;
      generation++;
      closeController();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      release();
      if (target.__CODEX_DESIGN_NATIVE_HISTORY__ === api) delete target.__CODEX_DESIGN_NATIVE_HISTORY__;
    },
  });
  target.__CODEX_DESIGN_NATIVE_HISTORY__ = api;
}

/** Retain the shipped History controller without starting Share, Archive or Presence. */
export function adaptNativeHistoryUi(original) {
  if (typeof original !== 'string' || original.length > 2 * 1024 * 1024 || original.includes(marker)) throw unsupported('Expected the unmodified packaged share UI.');
  const source = original.replaceAll('\r\n', '\n');
  const languageAt = once(source, language), saveAt = once(source, saveBoundary);
  const historyAt = once(source, historyBoundary), factoryAt = once(source, factory), sharingAt = once(source, sharingBoundary);
  const noticeAt = once(source, noticeTimer);
  const bannerAt = once(source, bannerNavigation);
  if (languageAt !== 0 || !(saveAt < historyAt && historyAt < noticeAt && noticeAt < factoryAt && factoryAt + factory.length < sharingAt)
    || !(historyAt < bannerAt && bannerAt < factoryAt)
    || !source.slice(historyAt, factoryAt).includes('var Z=class{button=o("button"')) {
    throw unsupported('The History/common-code boundaries are inconsistent.');
  }
  // The prefix also contains eager archive-layer allocation and save helpers.
  // Exclude that whole region, as well as all presence and Share definitions.
  const common = source.slice(0, saveAt).replace(language, 'var y=false,');
  const history = source.slice(historyAt, factoryAt + factory.length)
    .replace(noticeTimer, 'e(),this.__codexNoticeTimer=window.setInterval(()=>void e(),5e3)')
    .replace(bannerNavigation, 'r.addEventListener("click",()=>globalThis.__CODEX_DESIGN_PREVIEW_CLOSE__?.())');
  return `${marker}\n(()=>{\n'use strict';\n${common}\n${history}\n(${installNativeHistory.toString()})(be());\n})();\n`;
}
