// Browser Annotation API adapter. Runs only on the top-level local editor.
// request() opens the native composer; the person still reviews and sends it.
(() => {
  'use strict';
  if (window.top !== window || window.__baoyuCodexAnnotations) return;
  const api = document.oai?.annotation;
  if (typeof api?.request !== 'function') return;
  const endpoint = new URL('annotation-context', document.currentScript.src);
  let context = null;
  let selection = null;
  let panel, select, status, container, originalContainer;
  let disposed = false;
  let queued = false;
  const marked = new Map();
  const selector = '[data-mega-artboard], [data-slide-id], [data-slide-surface], [data-card-key], [data-path], [data-comment-target], .dash-page';
  const readable = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  const visible = element => {
    if (!element?.isConnected || element.ownerDocument !== document) return false;
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };

  function metadata(object, target) {
    const result = {skill: context.skill, file: object.file, objectId: object.id};
    if (readable(context.projectRoot)) result.projectRoot = context.projectRoot;
    if (typeof object.page === 'number' || readable(object.page)) result.page = object.page;
    const node = target?.getAttribute('data-node-path') || target?.getAttribute('data-id');
    if (readable(node)) result.nodePath = node;
    // Keep exact file/object identities; omit optional context when long Unicode
    // paths would exceed the browser's 2,048-byte metadata limit.
    const bytes = () => new TextEncoder().encode(JSON.stringify(result)).byteLength;
    for (const key of ['nodePath', 'projectRoot', 'page']) if (bytes() > 2048) delete result[key];
    return result;
  }

  function objectFor(element) {
    if (!context || !element) return null;
    const closest = attribute => element.closest('[' + attribute + ']')?.getAttribute(attribute);
    const keys = [closest('data-mega-artboard'), closest('data-slide-id'), closest('data-path'), closest('data-card-key')].filter(Boolean);
    const found = context.objects.find(object => object.keys.some(key => keys.includes(key)));
    if (found) return found;
    if (context.skill === 'codex-slides' && element.closest('[data-slide-surface]')) {
      // The rendered main surface has no id; the editor's current thumbnail does.
      const current = document.querySelector('[data-slide-id][aria-current="true"]');
      return context.objects.find(object => object.id === current?.getAttribute('data-slide-id')) || null;
    }
    if (context.skill === 'codex-design-system' && element.closest('[data-comment-target], [data-card-key]')) {
      // Token/asset cards can span several files. Report the real index rather
      // than guess a component source path from the visible title.
      const holder = element.closest('[data-id], [data-card-key]');
      const id = holder?.getAttribute('data-id') || holder?.getAttribute('data-card-key');
      if (readable(id)) return {id, file: context.indexFile, name: element.getAttribute('data-comment-name') || id, keys: [id]};
    }
    if (context.skill === 'codex-dashboard' && element.closest('.dash-page')) {
      return context.objects.find(object => object.id === 'index.html') || null;
    }
    return null;
  }

  function choose(element) {
    const target = element?.closest(selector);
    const object = objectFor(target);
    if (!target || !object || !visible(target)) return;
    selection = {element: target, object};
    select.value = object.id;
    status.textContent = object.name;
  }

  function mark(element) {
    const object = objectFor(element);
    if (!object) { unmark(element); return; }
    if (!marked.has(element)) marked.set(element, [element.getAttribute('oai-annotatable'), element.getAttribute('oai-annotation-metadata')]);
    // Iframe contents are represented
    // by their real top-level artboard/card; no API calls enter the child frame.
    element.setAttribute('oai-annotatable', String(object.name).slice(0, 256));
    element.setAttribute('oai-annotation-metadata', JSON.stringify(metadata(object, element)));
  }

  function unmark(element) {
    const values = marked.get(element);
    if (!values) return;
    ['oai-annotatable', 'oai-annotation-metadata'].forEach((key, i) => values[i] === null ? element.removeAttribute(key) : element.setAttribute(key, values[i]));
    marked.delete(element);
  }

  function refreshTargets() {
    if (!context || disposed) return;
    for (const element of document.querySelectorAll(selector)) mark(element);
    for (const [element] of marked) if (!element.isConnected || !element.matches(selector) || !objectFor(element)) unmark(element);
    if (selection && (!visible(selection.element) || !objectFor(selection.element))) selection = null;
  }

  function schedule() {
    if (queued || disposed) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshTargets(); });
  }

  async function refresh() {
    try {
      const response = await fetch(endpoint, {cache: 'no-store'});
      if (!response.ok) return;
      const next = await response.json();
      if (!Array.isArray(next.objects) || typeof next.skill !== 'string') return;
      context = next;
      const old = select.value;
      select.replaceChildren();
      const blank = document.createElement('option');
      blank.value = ''; blank.textContent = '选择要批注的对象'; select.append(blank);
      for (const object of context.objects) {
        const option = document.createElement('option');
        option.value = object.id; option.textContent = object.name; select.append(option);
      }
      select.value = old;
      refreshTargets();
    } catch { status.textContent = '本地编辑器上下文暂不可用'; }
  }

  function onPointer(event) { if (!panel.contains(event.target)) choose(event.target); }
  function onRequest() {
    if (!context) return;
    const selected = select.value;
    // Resolve again immediately before request; route/slide changes can replace
    // nodes and a cached element must never send the previous object's identity.
    if (selected && (!selection || selection.object.id !== selected || !visible(selection.element))) {
      const element = [...document.querySelectorAll(selector)].find(element => visible(element) && objectFor(element)?.id === selected);
      selection = element ? {element, object: objectFor(element)} : null;
    }
    if (!selection || !visible(selection.element)) { status.textContent = '请先在编辑器中显示并选择这个对象'; return; }
    const current = objectFor(selection.element);
    if (!current || current.id !== selection.object.id) { selection = null; status.textContent = '对象已变化，请重新选择'; return; }
    try {
      const result = api.request(selection.element, {metadata: metadata(current, selection.element), initialComment: '请修改这个对象：'});
      status.textContent = result?.accepted ? '请在浏览器批注中填写意见并发送给 Codex' : '浏览器未接受批注，请检查网站的批注权限';
    } catch { status.textContent = '浏览器未打开批注，请稍后重试'; }
  }

  function start() {
    if (disposed || !document.body) return;
    panel = document.createElement('aside');
    panel.id = 'baoyu-codex-annotations';
    panel.setAttribute('aria-label', 'Codex 浏览器批注');
    panel.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:2147483000;display:flex;flex-direction:column;gap:6px;max-width:310px;padding:10px;border:1px solid #8886;border-radius:10px;background:Canvas;color:CanvasText;font:12px system-ui;box-shadow:0 4px 20px #0002;';
    select = document.createElement('select');
    select.setAttribute('aria-label', '批注对象');
    select.style.cssText = 'max-width:285px;color:inherit;background:inherit;';
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = '向 Codex 批注'; button.addEventListener('click', onRequest);
    button.title = '打开浏览器原生批注；由你填写、保存并发送';
    status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = '点选对象，再打开浏览器批注';
    panel.append(select, button, status); document.body.append(panel);
    container = document.getElementById('root') || document.body;
    originalContainer = container.getAttribute('oai-annotation-container');
    container.setAttribute('oai-annotation-container', '');
    document.addEventListener('pointerdown', onPointer, true);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-slide-id', 'data-slide-surface', 'aria-current', 'data-mega-artboard', 'data-card-key', 'data-path', 'data-comment-target', 'data-comment-name', 'data-id', 'data-node-path', 'class']});
    // Poll only project data, never API readiness. New files/ordering can arrive
    // through the agent while the editor remains open.
    const timer = setInterval(refresh, 10000);
    const dispose = () => {
      disposed = true; clearInterval(timer); observer.disconnect();
      document.removeEventListener('pointerdown', onPointer, true);
      for (const [element] of marked) unmark(element);
      if (originalContainer === null) container.removeAttribute('oai-annotation-container'); else container.setAttribute('oai-annotation-container', originalContainer);
      panel.remove(); marked.clear();
    };
    window.__baoyuCodexAnnotations = Object.freeze({refresh, dispose});
    window.addEventListener('pagehide', dispose, {once: true});
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
