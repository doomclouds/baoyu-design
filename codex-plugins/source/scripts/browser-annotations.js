// Browser annotation metadata only. Use the browser's existing annotation UI.
// Runs only on the top-level local editor and adds no page controls.
(() => {
  'use strict';
  if (window.top !== window || window.__baoyuCodexAnnotations) return;
  if (!document.oai?.annotation) return;
  const endpoint = new URL('annotation-context', document.currentScript.src);
  let context = null;
  let container, originalContainer;
  let disposed = false;
  let queued = false;
  const marked = new Map();
  const selector = '[data-mega-artboard], [data-slide-id], [data-slide-surface], [data-card-key], [data-path], [data-comment-target], [data-id], [data-testid="ds-readme-rendered"], [data-testid="files-browser-text"], #dash-root, .dash-page';
  const readable = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

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
    if (context.skill === 'codex-design-system') {
      const readme = element.closest('[data-testid="ds-readme-rendered"]');
      if (readme) {
        const source = context.objects.find(object => object.file === 'project/README.md');
        return source ? {...source, id: 'ds-readme-rendered', name: 'README'} : null;
      }
      const preview = element.closest('[data-testid="files-browser-text"]');
      if (preview) {
        const browser = preview.closest('[data-testid="files-browser"]');
        const row = browser?.querySelector('[data-testid="files-browser-row"][aria-selected="true"][data-path]');
        const file = row?.getAttribute('data-path');
        const label = (preview.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent?.trim() || '').join(' ');
        // Tree selection can update before an asynchronous preview finishes.
        // Never assign the selected file to a preview still labelled for another.
        if (!file || label !== file) return null;
        const source = context.objects.find(object => object.file === 'project/' + file);
        return source ? {...source, id: 'file:' + file, name: file} : null;
      }
    }
    const closest = attribute => element.closest('[' + attribute + ']')?.getAttribute(attribute);
    const keys = [closest('data-mega-artboard'), closest('data-slide-id'), closest('data-path'), closest('data-card-key')].filter(Boolean);
    const found = context.objects.find(object => object.keys.some(key => keys.includes(key)));
    if (found) return found;
    if (context.skill === 'codex-slides' && element.closest('[data-slide-surface]')) {
      // The rendered main surface has no id; the editor's current thumbnail does.
      const current = document.querySelector('[data-slide-id][aria-current="true"]');
      return context.objects.find(object => object.id === current?.getAttribute('data-slide-id')) || null;
    }
    if (context.skill === 'codex-design-system' && element.closest('[data-id], [data-card-key]')) {
      const holder = element.closest('[data-id], [data-card-key]');
      const id = holder?.getAttribute('data-id') || holder?.getAttribute('data-card-key');
      // These are the editor's observed stable semantic ids, not file names.
      // Preserve the exact selected token/style identity while naming its real
      // backing document from the server's verified file inventory.
      let file;
      if (/^(?:token-|style-|tset-|cgroup-)/.test(id || '') || /^type:/.test(holder?.getAttribute('data-card-key') || '') || ['page-colors', 'page-type', 'page-spacing', 'page-corners', 'page-shadows'].includes(id)) file = 'project/tokens.json';
      else if (id === 'ds-cover') file = 'project/components/Cover/preview.html';
      const source = context.objects.find(object => object.file === file);
      if (source && readable(id)) return {...source, id, name: element.getAttribute('data-comment-name') || element.getAttribute('aria-label') || id};
      // Other multi-file groups can honestly identify the index; don't infer
      // a component source file from the visible title.
      if (readable(id) && (element.closest('[data-comment-target], [data-card-key]') || ['page-components', 'page-assets'].includes(id))) return {id, file: context.indexFile, name: element.getAttribute('data-comment-name') || id, keys: [id]};
    }
    if (context.skill === 'codex-dashboard' && element.closest('#dash-root, .dash-page')) {
      const source = context.objects.find(object => object.id === 'index.html');
      return source ? {...source, name: context.title || 'Dashboard'} : null;
    }
    return null;
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
      refreshTargets();
    } catch { /* Native browser annotations remain usable without extra context. */ }
  }

  function start() {
    if (disposed || !document.body) return;
    container = document.getElementById('root') || document.body;
    originalContainer = container.getAttribute('oai-annotation-container');
    container.setAttribute('oai-annotation-container', '');
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-slide-id', 'data-slide-surface', 'aria-current', 'aria-selected', 'aria-labelledby', 'aria-label', 'data-mega-artboard', 'data-card-key', 'data-path', 'data-comment-target', 'data-comment-name', 'data-testid', 'data-id', 'data-node-path', 'id', 'class']});
    // Poll only project data, never API readiness. New files/ordering can arrive
    // through the agent while the editor remains open.
    const timer = setInterval(refresh, 10000);
    const dispose = () => {
      disposed = true; clearInterval(timer); observer.disconnect();
      for (const [element] of marked) unmark(element);
      if (originalContainer === null) container.removeAttribute('oai-annotation-container'); else container.setAttribute('oai-annotation-container', originalContainer);
      marked.clear();
    };
    window.__baoyuCodexAnnotations = Object.freeze({refresh, dispose});
    window.addEventListener('pagehide', dispose, {once: true});
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
