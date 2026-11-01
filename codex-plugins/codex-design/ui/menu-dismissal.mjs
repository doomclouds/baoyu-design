/** Distinguish actual keyboard activation from mouse/touch-generated clicks. */
export function menuInputMode(event) {
  if (event?.pointerType === 'touch' || event?.pointerType === 'pen') return 'touch';
  return event?.detail === 0 && !event.pointerType ? 'keyboard' : 'pointer';
}

/** Dismiss only transient menus; no access to editor or host frame contents. */
export function createMenuDismissal({ document, window, onDismiss, delayMs = 220,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  let current;
  let timer;
  const listeners = [];
  const contains = (region, target) => {
    if (!region || !target) return false;
    if (region === target) return true;
    try { return Boolean(region.contains?.(target)); } catch { return false; }
  };
  const inside = target => contains(current?.trigger, target) || contains(current?.menu, target);
  const stopTimer = () => { if (timer !== undefined) cancel(timer); timer = undefined; };
  function clear() { stopTimer(); current = undefined; }
  function dismiss(returnFocus = false) {
    if (!current) return;
    clear();
    onDismiss?.(returnFocus);
  }
  function deferDismiss() {
    if (!current || timer !== undefined) return;
    const opened = current;
    timer = schedule(() => { timer = undefined; if (current === opened) dismiss(); }, delayMs);
  }
  function leave(event) {
    if (!current || event.pointerType !== 'mouse' || current.mode !== 'pointer'
      || !inside(event.target) || inside(event.relatedTarget)) return;
    deferDismiss();
  }
  function enter(event) {
    if (!current) return;
    if (inside(event.target)) { stopTimer(); return; }
    // Events inside an opaque iframe do not bubble to this document. Its outer
    // boundary uses the same cancellable gap grace; actual focus/press still
    // closes immediately, without inspecting its browsing context.
    if (event.pointerType === 'mouse' && current.mode === 'pointer'
      && event.target?.tagName === 'IFRAME') deferDismiss();
  }
  const listen = (surface, name, handler) => {
    surface.addEventListener(name, handler, true);
    listeners.push(() => surface.removeEventListener(name, handler, true));
  };
  listen(document, 'pointerout', leave);
  listen(document, 'pointerover', enter);
  listen(document, 'pointerenter', enter);
  listen(document, 'pointermove', event => {
    if (current && event.pointerType === 'mouse' && inside(event.target)) {
      current.mode = 'pointer'; stopTimer();
    }
  });
  listen(document, 'pointerdown', event => {
    if (!current) return;
    if (!inside(event.target)) { dismiss(); return; }
    current.mode = event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : 'pointer';
    stopTimer();
  });
  listen(document, 'keydown', event => {
    if (!current) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); dismiss(true); return;
    }
    if (inside(event.target)) { current.mode = 'keyboard'; stopTimer(); }
  });
  listen(document, 'focusin', event => { if (current && !inside(event.target)) dismiss(); });
  listen(window, 'blur', () => dismiss());
  return {
    open({ trigger, menu, mode = 'pointer' }) { clear(); current = { trigger, menu, mode }; },
    clear,
    dispose() { clear(); for (const remove of listeners.splice(0)) remove(); },
  };
}
