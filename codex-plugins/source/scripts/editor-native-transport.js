// This function is serialized into the editor document before its original UI.
// Its only authority is the artwork-scoped message broker in the parent app.
export function installNativeEditorTransport(configuration, target) {
  'use strict';
  target ??= window;
  const base = new URL(configuration.baseUrl);
  const channel = configuration.channel;
  if (target.document) {
    const host = configuration.hostDepth === 2 ? target.parent.parent : target.parent;
    let blocked = 0;
    for (const property of ['document', 'codexDesignBridge']) {
      try { void host[property]; }
      catch (error) { if (error?.name === 'SecurityError') blocked++; else throw error; }
    }
    const isolated = blocked === 2;
    if (!isolated) {
      target.parent.postMessage({ type: 'codex-design:editor-diagnostic', channel, message: 'The editor origin is not isolated from its host. Opening was refused.' }, '*');
      throw new DOMException('The editor must remain isolated from its MCP host.', 'SecurityError');
    }
    target.document.documentElement?.setAttribute('data-codex-parent-isolation', 'blocked');
    target.document.documentElement?.setAttribute('data-codex-editor-origin', target.location?.origin || 'null');
  }
  if (target.document && target.location?.origin === 'null') {
    let temporary = false;
    for (const name of ['localStorage', 'sessionStorage']) {
      try {
        const existing = target[name];
        if (existing && typeof existing.getItem === 'function' && typeof existing.setItem === 'function') continue;
      } catch { /* Opaque documents cannot access Web Storage. */ }
      const values = new Map();
      const storage = {
        get length() { return values.size; },
        key(index) { return [...values.keys()][index >>> 0] ?? null; },
        getItem(key) { return values.get(String(key)) ?? null; },
        setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); },
        clear() { values.clear(); },
      };
      try {
        Object.defineProperty(target, name, { configurable: true, enumerable: true, value: storage });
        temporary = true;
      } catch {
        target.parent.postMessage({ type: 'codex-design:editor-diagnostic', channel,
          message: 'Temporary editor UI preferences could not be initialized.' }, '*');
      }
    }
    // This state belongs to this document only. Artwork still saves through MCP.
    if (temporary) target.document.documentElement?.setAttribute('data-codex-ui-storage', 'memory');
  }
  const pending = new Map();
  const pendingWrites = new Set();
  const sources = new Set();
  const assetCache = new Map();
  const assetAliases = new Map();
  const assetIds = new Set();
  let assetBytes = 0;
  if (target.crypto && typeof target.crypto.randomUUID !== 'function' && typeof target.crypto.getRandomValues === 'function') {
    const randomUUID = () => {
      const bytes = target.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      return Array.from(bytes, (value, index) => ([4, 6, 8, 10].includes(index) ? '-' : '') + (value + 256).toString(16).slice(1)).join('');
    };
    Object.defineProperty(target.crypto, 'randomUUID', { value: randomUUID, configurable: true });
  }
  const originalFetch = target.fetch.bind(target);
  let sequence = 0;
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__ = { baseUrl: base.href, artifactId: configuration.artifactId };
  target.__CODEX_DESIGN_EDITOR_I18N__ = { preference: configuration.language || 'system', systemLocale: configuration.locale };
  const bytesToBase64 = bytes => {
    let value = '';
    for (let offset = 0; offset < bytes.length; offset += 16_384) value += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    return target.btoa(value);
  };
  const base64ToBytes = text => Uint8Array.from(target.atob(text), character => character.charCodeAt(0));
  const rpc = (action, payload = {}, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
    const requestId = String(++sequence);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(requestId); };
    const abort = () => { cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('The artwork editor connection timed out.'), { code: 'EDITOR_TRANSPORT_TIMEOUT' })); }, 45_000);
    pending.set(requestId, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
    signal?.addEventListener('abort', abort, { once: true });
    target.parent.postMessage({ type: 'codex-design:editor-request', channel, requestId, action, payload }, '*');
  });
  if (target.crypto && !target.crypto.subtle) {
    Object.defineProperty(target.crypto, 'subtle', { configurable: true, value: {
      async digest(algorithm, data) {
        if (String(typeof algorithm === 'object' ? algorithm?.name : algorithm).toUpperCase() !== 'SHA-256') throw new DOMException('Only SHA-256 is available in this isolated editor.', 'NotSupportedError');
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        if (bytes.byteLength > 32 * 1024 * 1024) throw new DOMException('The digest input exceeds the transfer limit.', 'OperationError');
        const result = await rpc('editor.digest', { algorithm: 'SHA-256', base64: bytesToBase64(bytes) });
        return base64ToBytes(result.base64).buffer;
      },
    } });
  }
  const downloads = { async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    try {
      return await rpc('editor.download', { filename: filename || 'download', mimeType: blob.type || 'application/octet-stream', base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
    } catch (error) {
      if (error.code === 'DOWNLOAD_CANCELLED') error.code = 'declined';
      throw error;
    }
  } };
  for (const name of ['slidesHost', 'designHost', 'designSystemHost', 'codex', 'claude']) {
    const current = Object.getOwnPropertyDescriptor(target, name);
    if (current && !current.configurable) continue;
    let host = current?.value;
    const wrap = value => {
      if (!value || typeof value !== 'object') return value;
      const originalUse = typeof value.use === 'function' ? value.use.bind(value) : null;
      value.downloads = downloads;
      if (originalUse) value.use = (capability, ...args) => capability === 'downloads' ? Promise.resolve(downloads) : originalUse(capability, ...args);
      return value;
    };
    host = wrap(host);
    Object.defineProperty(target, name, { configurable: true, enumerable: true, get: () => host, set: value => { host = wrap(value); } });
  }
  target.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== target.parent || message?.channel !== channel) return;
    if (message.type === 'codex-design:editor-flush') {
      void (async () => {
        try {
          target.document?.activeElement?.blur?.();
          if (typeof target.__CODEX_DESIGN_EDITOR_FLUSH__ === 'function') {
            const saved = await target.__CODEX_DESIGN_EDITOR_FLUSH__();
            if (saved !== true) throw new Error('The editor still has unsaved changes.');
          } else {
            // Dashboard uses its own beforeunload guard, whose flushNow path
            // starts pending debounced writes. Query that guard until it clears.
            const deadline = Date.now() + 8_000;
            while (!target.dispatchEvent(new Event('beforeunload', { cancelable: true }))) {
              if (Date.now() >= deadline) throw new Error('The editor still has unsaved changes.');
              if (pendingWrites.size) await Promise.all([...pendingWrites]);
              else await new Promise(resolve => setTimeout(resolve, 20));
            }
          }
          await Promise.all([...pendingWrites]);
          target.parent.postMessage({ type: 'codex-design:editor-flushed', channel, requestId: message.requestId, saved: true }, '*');
        } catch (error) {
          target.parent.postMessage({ type: 'codex-design:editor-flushed', channel, requestId: message.requestId, saved: false,
            error: { code: 'EDITOR_UNSAVED_CHANGES', message: String(error.message || error) } }, '*');
        }
      })();
      return;
    }
    if (message.type === 'codex-design:host-context-changed') {
      const root = target.document?.documentElement;
      const context = message.context;
      if (!root || !context || typeof context !== 'object') return;
      if (context.theme === 'dark' || context.theme === 'light') root.setAttribute('data-theme', context.theme);
      const variables = context.styles?.variables || {};
      // These variables belong to editor chrome. Authored artwork is rendered
      // by the original editor in its own document and keeps its design fonts.
      if (typeof variables['--font-sans'] === 'string') {
        root.style.setProperty('--cds-font-sans', variables['--font-sans']);
        root.style.setProperty('--cds-font-sans-display', variables['--font-sans']);
      }
      if (typeof variables['--font-mono'] === 'string') root.style.setProperty('--cds-font-mono-ui', variables['--font-mono']);
      const size = Number.parseFloat(variables['--font-text-md-size']);
      if (Number.isFinite(size) && size >= 10 && size <= 32) root.style.setProperty('--cds-rem-scale', String(size / 16));
      if (typeof context.styles?.css?.fonts === 'string') {
        let style = target.document.getElementById('codex-native-host-fonts');
        if (!style) { style = target.document.createElement('style'); style.id = 'codex-native-host-fonts'; target.document.head.appendChild(style); }
        style.textContent = context.styles.css.fonts;
      }
      return;
    }
    if (message.type !== 'codex-design:editor-response') return;
    const call = pending.get(message.requestId);
    if (!call) return;
    message.error ? call.reject(Object.assign(new Error(message.error.message || 'The editor request failed.'), { code: message.error.code })) : call.resolve(message.result);
  });
  const relative = value => {
    const url = new URL(value, base);
    if (url.origin !== base.origin) return null;
    if (!url.pathname.startsWith(base.pathname)) {
      if (!/^\/(?:_api(?:\/|$)|_blob\/|_files\.json$|__comments(?:\/|$)|__deck\/|__design(?:-system)?\/|project\/|db\/)/.test(url.pathname)) return null;
      return url.pathname.slice(1) + url.search;
    }
    return url.pathname.slice(base.pathname.length) + url.search;
  };
  const originalAssets = async text => {
    if (!text.includes('data:')) return text;
    for (const [embedded, reference] of assetAliases) if (text.includes(embedded)) text = text.split(embedded).join(reference);
    // Evicted preview URLs remain recoverable without retaining their large
    // strings: upload ids are the first 32 hex digits of their SHA-256 content.
    for (const embedded of new Set(text.match(/data:[a-z0-9.+\/-]+;base64,[A-Za-z0-9+/]+={0,2}/gi) || [])) {
      const base64 = embedded.slice(embedded.indexOf(',') + 1);
      if (base64.length > 44_739_244) continue;
      const digest = await rpc('editor.digest', { algorithm: 'SHA-256', base64 });
      const id = Array.from(base64ToBytes(digest.base64), value => (value + 256).toString(16).slice(1)).join('').slice(0, 32);
      if (assetIds.has(id)) text = text.split(embedded).join('/_blob/' + id);
    }
    return text;
  };
  const preserveAssetReferences = async bytes => {
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return bytes; }
    const walk = async value => {
      if (typeof value === 'string') return originalAssets(value);
      if (Array.isArray(value)) return await Promise.all(value.map(walk));
      if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = await walk(value[key]);
      return value;
    };
    await walk(body);
    if (body.files && typeof body.files === 'object') for (const [file, content] of Object.entries(body.files)) {
      if (!/\.(?:html?|css|js|mjs|json|svg|md)$/i.test(file) || typeof content?.base64 !== 'string') continue;
      try {
        const original = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(content.base64));
        const restored = await originalAssets(original);
        if (restored !== original) content.base64 = bytesToBase64(new TextEncoder().encode(restored));
      } catch { /* Binary content is never rewritten. */ }
    }
    return new TextEncoder().encode(JSON.stringify(body));
  };
  target.fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? new URL(String(input), base).href : input.url;
    const path = relative(url);
    if (path === null) return originalFetch(input, init);
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    const headers = {};
    for (const name of ['content-type', 'accept', 'if-match', 'if-none-match', 'last-event-id', 'x-filename']) if (request.headers.has(name)) headers[name] = request.headers.get(name);
    let requestBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (requestBytes && /(?:^|\/)(?:__deck\/publish|_api\/write)$/.test(path.split('?')[0]) && request.headers.get('content-type')?.includes('application/json')) requestBytes = await preserveAssetReferences(requestBytes);
    const body = requestBytes ? bytesToBase64(requestBytes) : undefined;
    const responseTask = rpc('editor.request', { request: { path, method: request.method, headers, ...(body === undefined ? {} : { body }) } }, init?.signal || request.signal);
    const writing = !['GET', 'HEAD'].includes(request.method);
    if (writing) pendingWrites.add(responseTask);
    let response;
    try { response = await responseTask; }
    finally { if (writing) pendingWrites.delete(responseTask); }
    const result = new Response([101, 204, 205, 304].includes(response.status) || request.method === 'HEAD' ? null : base64ToBytes(response.body), { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(result, 'url', { value: url });
    return result;
  };
  target.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__ = async reference => {
    const id = /(?:^|\/)\_blob\/([0-9a-f]{32})(?:[?#].*)?$/.exec(String(reference))?.[1];
    if (!id) throw new TypeError('Only artwork upload references can be embedded.');
    const key = '_blob/' + id;
    if (!assetCache.has(key)) {
      const entry = { size: 0 };
      entry.promise = (async () => {
        const response = await target.fetch(key);
        if (!response.ok) throw new Error('The artwork image or font could not be loaded.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('The artwork asset exceeds its transfer limit.');
        const url = 'data:' + (response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);
        entry.size = bytes.byteLength; entry.ready = true; entry.url = url; assetBytes += entry.size;
        assetIds.add(id);
        assetAliases.set(url, '/_blob/' + id);
        for (const [oldKey, old] of assetCache) {
          if (assetCache.size <= 128 && assetBytes <= 64 * 1024 * 1024) break;
          if (oldKey === key || !old.ready) continue;
          assetCache.delete(oldKey); assetBytes -= old.size; assetAliases.delete(old.url);
        }
        return url;
      })().catch(error => { assetCache.delete(key); throw error; });
      assetCache.set(key, entry);
    }
    return assetCache.get(key).promise;
  };
  function installPreviewTransport() {
    let resolveAsset, fetcher, crypto;
    try {
      resolveAsset = window.parent.__CODEX_DESIGN_EDITOR_RESOLVE_ASSET__;
      fetcher = window.parent.fetch.bind(window.parent);
      crypto = window.parent.crypto;
    } catch { return; }
    if (typeof resolveAsset !== 'function') return;
    window.fetch = (input, init) => {
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (!['GET', 'HEAD'].includes(method) || typeof url !== 'string'
        || !/^(?:blob:|data:|\/?_blob\/[0-9a-f]{32}(?:[?#]|$))/.test(url)) return Promise.reject(new TypeError('A preview can only read its uploaded artwork assets.'));
      return fetcher(input, init);
    };
    if (!window.crypto.randomUUID && crypto?.randomUUID) Object.defineProperty(window.crypto, 'randomUUID', { value: crypto.randomUUID.bind(crypto), configurable: true });
    if (!window.crypto.subtle && crypto?.subtle) Object.defineProperty(window.crypto, 'subtle', { value: crypto.subtle, configurable: true });
    const reference = /(?:\/?_blob\/[0-9a-f]{32})/g;
    const seen = new WeakMap();
    const transform = async (element, attribute, value) => {
      if (typeof value !== 'string' || !value.includes('_blob/')) return;
      let state = seen.get(element); if (!state) { state = new Map(); seen.set(element, state); }
      if (state.get(attribute) === value) return;
      state.set(attribute, value);
      try {
        let next = value;
        for (const match of new Set(value.match(reference) || [])) next = next.split(match).join(await resolveAsset(match));
        if (!element.isConnected || state.get(attribute) !== value) return;
        if (attribute === 'textContent') { if (element.textContent === value) element.textContent = next; }
        else if (element.getAttribute(attribute) === value) element.setAttribute(attribute, next);
      } catch (error) { console.error('Codex Design could not display an artwork asset.', error); }
    };
    const inspect = element => {
      if (element.nodeType !== 1) return;
      for (const attribute of ['src', 'href', 'poster', 'style', 'srcset']) if (element.hasAttribute(attribute)) void transform(element, attribute, element.getAttribute(attribute));
      if (element.tagName === 'STYLE') void transform(element, 'textContent', element.textContent);
      for (const child of element.querySelectorAll('[src],[href],[poster],[style],[srcset],style')) {
        for (const attribute of ['src', 'href', 'poster', 'style', 'srcset']) if (child.hasAttribute(attribute)) void transform(child, attribute, child.getAttribute(attribute));
        if (child.tagName === 'STYLE') void transform(child, 'textContent', child.textContent);
      }
    };
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') inspect(record.target);
        else if (record.type === 'characterData' && record.target.parentElement?.tagName === 'STYLE') inspect(record.target.parentElement);
        else for (const node of record.addedNodes) inspect(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'poster', 'style', 'srcset'], characterData: true });
    inspect(document.documentElement);
  }
  const framePrototype = target.HTMLIFrameElement?.prototype;
  const srcdoc = framePrototype && Object.getOwnPropertyDescriptor(framePrototype, 'srcdoc');
  if (srcdoc?.set && srcdoc.get) {
    const originals = new WeakMap();
    Object.defineProperty(framePrototype, 'srcdoc', { configurable: true, enumerable: srcdoc.enumerable,
      get() { return originals.has(this) ? originals.get(this) : srcdoc.get.call(this); },
      set(value) {
        const source = String(value).replace(/<script data-codex-native-preview-transport>[\s\S]*?<\/script>/gi, ''); originals.set(this, source);
        let preview = source;
        // DS previews normally load these two pinned packaged UMDs through a
        // relative script URL. Inline data URLs preserve order and SRI while
        // avoiding a forbidden network request from the isolated document.
        for (const vendor of configuration.previewVendors || []) {
          const relative = 'artifact-type/vendor/' + vendor.file;
          const url = new URL(relative, base);
          for (const path of [url.href, url.pathname, '/' + relative, relative]) preview = preview.split(path).join(vendor.url);
        }
        const runtime = '<script data-codex-native-preview-transport>(' + installPreviewTransport.toString() + ')();<\/script>';
        srcdoc.set.call(this, /<head\b[^>]*>/i.test(preview) ? preview.replace(/<head\b[^>]*>/i, head => head + runtime) : runtime + preview);
      },
    });
    // React assigns srcDoc through setAttribute rather than the IDL setter.
    const elementPrototype = target.Element?.prototype;
    if (elementPrototype) {
      const setAttribute = elementPrototype.setAttribute;
      elementPrototype.setAttribute = function (name, value) {
        if (this instanceof target.HTMLIFrameElement && String(name).toLowerCase() === 'srcdoc') { this.srcdoc = value; return; }
        return setAttribute.call(this, name, value);
      };
    }
  }
  class EditorEventSource extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    CONNECTING = 0; OPEN = 1; CLOSED = 2;
    readyState = 0; withCredentials = false; onopen = null; onmessage = null; onerror = null;
    constructor(url) {
      super(); this.url = new URL(String(url), base).href; this.path = relative(this.url); this.controller = new AbortController();
      if (this.path === null) throw new TypeError('Only events from this artwork editor can be subscribed.');
      sources.add(this); void this.listen();
    }
    emit(type, data) {
      const event = data === undefined ? new Event(type) : new MessageEvent(type, { data: data.data, lastEventId: data.id || '', origin: base.origin });
      this.dispatchEvent(event); this['on' + type]?.(event);
    }
    async listen() {
      try {
        const opened = await rpc('editor.events.open', { path: this.path }, this.controller.signal);
        if (this.readyState === 2) { void rpc('editor.events.close', { subscriptionId: opened.subscriptionId }).catch(() => {}); return; }
        this.subscriptionId = opened.subscriptionId; this.readyState = 1; let cursor = opened.cursor; this.emit('open');
        while (this.readyState !== 2) {
          const result = await rpc('editor.events.poll', { subscriptionId: this.subscriptionId, cursor }, this.controller.signal);
          for (const event of result.events || []) this.emit(event.event, event);
          cursor = result.cursor;
          if (result.ended || result.error) throw new Error(result.error?.message || 'The editor event connection closed.');
        }
      } catch {
        if (this.readyState === 2) return;
        this.readyState = 2; sources.delete(this); this.emit('error');
      }
    }
    close() {
      if (this.readyState === 2 && !this.subscriptionId) return;
      this.readyState = 2; sources.delete(this); this.controller.abort();
      if (this.subscriptionId) void rpc('editor.events.close', { subscriptionId: this.subscriptionId }).catch(() => {});
    }
  }
  target.EventSource = EditorEventSource;
  const anchorPrototype = target.HTMLAnchorElement?.prototype;
  if (anchorPrototype) {
    const click = anchorPrototype.click;
    anchorPrototype.click = function () {
      if (!this.hasAttribute('download') || !/^(?:blob:|data:)/i.test(this.href)) return click.call(this);
      const filename = this.download || 'download';
      void (async () => {
        const resource = await originalFetch(this.href);
        const bytes = new Uint8Array(await resource.arrayBuffer());
        await rpc('editor.download', { filename, mimeType: resource.headers.get('content-type') || 'application/octet-stream', base64: bytesToBase64(bytes) });
      })().catch(error => target.parent.postMessage({ type: 'codex-design:editor-diagnostic', channel, message: String(error.message || error).slice(0, 500) }, '*'));
    };
  }
  target.addEventListener('unload', () => { for (const source of sources) source.close(); });
  target.addEventListener('error', event => {
    if (!event.message) return;
    target.parent.postMessage({ type: 'codex-design:editor-diagnostic', channel, message: String(event.message).slice(0, 500) }, '*');
  });
  target.parent.postMessage({ type: 'codex-design:editor-transport-ready', channel }, '*');
  if (target.document && target.MutationObserver) {
    let ready = false;
    const observe = () => {
      if (ready || !target.document.querySelector('[data-cds],#root button,.dash-page')) return;
      ready = true; observer.disconnect();
      target.parent.postMessage({ type: 'codex-design:editor-app-ready', channel }, '*');
    };
    const observer = new target.MutationObserver(observe);
    observer.observe(target.document.documentElement, { childList: true, subtree: true });
    observe();
  }
}
