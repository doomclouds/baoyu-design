// Serialized into an opaque editor document. Keep every helper in this function.
export function installNativePreviews({ target, baseUrl, rpc, flush } = {}) {
  target ??= window;
  const document = target.document;
  if (!document?.body || typeof rpc !== 'function') throw new TypeError('A native preview needs its editor document and scoped transport.');
  if (target.__CODEX_DESIGN_EDITOR_TRANSPORT__?.readOnly === true) return { open: async () => false, close() {}, updateHostContext() {}, dispose() {} };
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.hostname !== 'codex-design.invalid' || base.username || base.password || base.search || base.hash
    || !/^\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/i.test(base.pathname)) throw new TypeError('A preview needs its artwork virtual root.');
  const originalOpen = target.open;
  const LIMIT = 24 * 1024 * 1024, PASSIVE_LIMIT = 2 * 1024 * 1024;
  const MAX_PENDING = 32, MAX_CACHE = 128, MAX_PENDING_BYTES = 48 * 1024 * 1024, MAX_CACHE_BYTES = 64 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/;
  const PASSIVE_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  let disposed = false, current;
  let hostContext = {};
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const detail = error => ({ code: typeof error?.code === 'string' ? error.code.slice(0, 100) : 'PREVIEW_FAILED', message: String(error?.message || error).slice(0, 2000) });
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const alive = entry => !disposed && !entry.closed && current === entry;
  const classify = value => {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\u0000-\u0020]/.test(value)) return { refused: true };
    let url;
    try { url = new URL(value, base); } catch { return { refused: true }; }
    if (url.username || url.password) return { refused: true };
    if (url.origin !== base.origin) {
      const local = /^(?:localhost\.?|.*\.localhost\.?|0\.0\.0\.0|127(?:\.\d{1,3}){3}|\[::(?:1)?\]|\[::ffff:[^\]]+\])$/i.test(url.hostname);
      const virtual = /(?:^|\.)codex-design\.invalid\.?$/i.test(url.hostname);
      return !local && !virtual && (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:') ? { external: true } : { refused: true };
    }
    if (!url.pathname.startsWith(base.pathname) || url.search || url.hash) return { refused: true };
    const relative = url.pathname.slice(base.pathname.length);
    const system = /^__ds\/([a-z0-9][a-z0-9_-]{0,63})\/$/.exec(relative);
    if (system) return { path: relative, kind: 'system', title: 'Design system reference' };
    const version = /^v\/(\d{1,9})\/$/.exec(relative);
    if (version && Number(version[1]) > 0) return { path: `v/${Number(version[1])}/`, kind: 'history', version: Number(version[1]), title: `Version ${Number(version[1])} - Read only` };
    return { refused: true };
  };
  const send = (entry, message) => {
    if (alive(entry)) entry.frame?.contentWindow?.postMessage({ ...message, channel: entry.channel }, '*');
  };
  const closeSubscriptions = entry => {
    for (const id of entry.subscriptions.keys()) void Promise.resolve().then(() => rpc('editor.events.close', { subscriptionId: id })).catch(() => {});
    entry.subscriptions.clear();
  };
  const close = (restoreFocus = true) => {
    const entry = current;
    if (!entry) return;
    entry.closed = true; current = undefined;
    clearTimeout(entry.startup);
    closeSubscriptions(entry);
    entry.requests.clear(); entry.cacheBytes = 0;
    entry.overlay.remove();
    for (const url of entry.urls) target.URL.revokeObjectURL(url);
    entry.urls.clear();
    if (restoreFocus && !disposed && entry.focus?.isConnected !== false) {
      try { entry.focus?.focus?.({ preventScroll: true }); } catch { /* A replaced control no longer owns focus. */ }
    }
  };
  const create = title => {
    close(false);
    const overlay = document.createElement('section'), header = document.createElement('div'), heading = document.createElement('strong');
    const button = document.createElement('button'), status = document.createElement('p'), content = document.createElement('div');
    overlay.setAttribute('data-codex-native-preview', ''); overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', title);
    overlay.style.cssText = 'position:fixed;inset:12px;z-index:2147483640;display:flex;flex-direction:column;overflow:hidden;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;background:Canvas;color:CanvasText;font:inherit;box-shadow:0 12px 40px #0004';
    header.style.cssText = 'display:flex;align-items:center;gap:16px;min-height:48px;padding:8px 16px;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent);flex:none';
    heading.textContent = title; heading.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px';
    button.type = 'button'; button.textContent = 'Back to current'; button.setAttribute('aria-label', 'Close read-only preview');
    button.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:6px 10px;cursor:pointer';
    status.textContent = 'Opening read-only preview...'; status.setAttribute('role', 'status'); status.style.cssText = 'margin:12px 16px;font-size:13px;overflow-wrap:anywhere';
    content.style.cssText = 'flex:1;min-height:0;display:flex';
    header.append(heading, button); overlay.append(header, status, content); document.body.append(overlay);
    const entry = { overlay, content, status, button, closed: false, focus: document.activeElement,
      subscriptions: new Map(), pendingStreams: 0, requests: new Map(), pending: 0, pendingBytes: 0, cacheBytes: 0, urls: new Set() };
    current = entry;
    button.addEventListener('click', () => { if (alive(entry)) close(); });
    button.focus?.({ preventScroll: true });
    return entry;
  };
  const showError = (entry, error) => {
    if (!alive(entry)) return;
    clearTimeout(entry.startup);
    entry.status.textContent = detail(error).message;
    entry.status.setAttribute('role', 'alert');
    entry.status.hidden = false;
  };
  const frame = (entry, sandbox) => {
    const child = document.createElement('iframe');
    child.title = entry.title || 'Read-only preview'; child.setAttribute('sandbox', sandbox);
    child.setAttribute('referrerpolicy', 'no-referrer');
    child.style.cssText = 'display:block;border:0;flex:1;min-width:0;width:100%;height:100%;background:transparent';
    entry.frame = child; entry.content.append(child);
    return child;
  };
  const passiveHtml = html => {
    // Template content belongs to a separate inert document. Do not use
    // DOMParser(text/html), which may fetch image/frame URLs before sanitizing.
    const template = document.createElement('template');
    if (!template.content?.querySelectorAll) throw failure('PREVIEW_UNAVAILABLE', 'An inert reference parser is unavailable.');
    template.innerHTML = html;
    const content = template.content;
    for (const node of content.querySelectorAll('script,noscript,base,meta,link,iframe,object,embed,form,input,button,textarea,select,video,audio,source,track,template,foreignObject,animate,set')) node.remove();
    for (const node of content.querySelectorAll('*')) {
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase(), value = attribute.value;
        if (name.startsWith('on') || ['target', 'download', 'ping', 'action', 'formaction', 'srcdoc', 'xlink:href'].includes(name)
          || name === 'href' && !/^#[A-Za-z0-9_:.\-]{1,128}$/.test(value)
          || name === 'src' && !(node.localName === 'img' && /^data:image\/(?:png|gif|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(value))) node.removeAttribute(attribute.name);
      }
      if (node.localName === 'a' && !node.hasAttribute('href')) {
        node.setAttribute('aria-disabled', 'true'); node.setAttribute('title', 'Links are disabled in this read-only reference.');
      }
    }
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + PASSIVE_CSP
      + '"><meta name="referrer" content="no-referrer"></head><body>' + template.innerHTML + '</body></html>';
  };
  function loadSnapshotDocument(channel) {
    // This function is reflected and executed in a new opaque document. Bind
    // its document here: capturing the installer's local document breaks when
    // the bundler renames that outer binding (for example, to document2).
    const document = window.document;
    let accepted = false, editor, errors = 0;
    const outgoing = new Set(['codex-design:editor-request', 'codex-design:editor-transport-ready', 'codex-design:editor-app-ready', 'codex-design:editor-diagnostic', 'codex-design:preview-close']);
    const incoming = new Set(['codex-design:editor-response', 'codex-design:host-context-changed', 'codex-design:comment-viewport-changed']);
    const diagnostic = error => {
      if (errors >= 4) return;
      const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
      if (!message) return;
      errors++;
      window.parent.postMessage({ type: 'codex-design:editor-diagnostic', channel, message: 'Historical preview loader: ' + message.slice(0, 1000) }, '*');
    };
    window.addEventListener('error', event => diagnostic(event.message), true);
    window.addEventListener('unhandledrejection', event => diagnostic(event.reason));
    window.addEventListener('message', event => {
      const message = event.data;
      if (message?.channel !== channel) return;
      try {
        if (event.source === window.parent) {
          if (!accepted && message.type === 'codex-design:editor-document' && typeof message.html === 'string' && message.html.length <= 24 * 1024 * 1024) {
            accepted = true; editor = document.createElement('iframe');
            editor.setAttribute('sandbox', 'allow-scripts allow-same-origin'); editor.setAttribute('referrerpolicy', 'no-referrer');
            editor.title = 'Read-only historical editor'; editor.srcdoc = message.html; document.body.append(editor);
          } else if (editor && incoming.has(message.type)) editor.contentWindow?.postMessage(message, '*');
        } else if (editor && event.source === editor.contentWindow && outgoing.has(message.type)) window.parent.postMessage(message, '*');
      } catch (error) { diagnostic(error); }
    });
    window.parent.postMessage({ type: 'codex-design:editor-document-request', channel }, '*');
  }
  const historyPath = (entry, value, events = false) => {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\u0000-\u0020]/.test(value) || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw failure('PREVIEW_READ_ONLY', 'A historical preview can only read its own version.');
    const encoded = value.split(/[?#]/, 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(encoded); } catch { throw failure('PREVIEW_READ_ONLY', 'Invalid historical preview path.'); }
    if (/%2f|%5c/i.test(encoded) || decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded) || /%2f|%5c|%2e/i.test(decoded)
      || decoded.split('/').some(part => part === '.' || part === '..') || !decoded.startsWith(entry.prefix)) throw failure('PREVIEW_READ_ONLY', 'A historical preview cannot leave its captured version.');
    const url = new URL(value, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname + entry.prefix) || url.hash
      || events && !/(?:^|\/)events$/.test(decoded)) throw failure('PREVIEW_READ_ONLY', 'The historical preview endpoint is unavailable.');
    return value;
  };
  const validate = (entry, action, payload) => {
    if (!plain(payload)) throw failure('PREVIEW_READ_ONLY', 'Invalid historical preview request.');
    if (action === 'editor.request') {
      const value = payload.request;
      if (!plain(value) || Object.hasOwn(value, 'body')) throw failure('PREVIEW_READ_ONLY', 'A historical preview cannot write files.');
      const method = String(value.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') throw failure('PREVIEW_READ_ONLY', 'A historical preview is read only.');
      const headers = {};
      if (value.headers !== undefined) {
        if (!plain(value.headers) || Object.keys(value.headers).length > 8) throw failure('PREVIEW_READ_ONLY', 'Invalid preview headers.');
        for (const [key, item] of Object.entries(value.headers)) {
          if (!['accept', 'content-type', 'if-match', 'if-none-match', 'last-event-id'].includes(key.toLowerCase()) || typeof item !== 'string' || item.length > 4096 || /[\r\n]/.test(item)) throw failure('PREVIEW_READ_ONLY', 'Unsupported preview header.');
          headers[key.toLowerCase()] = item;
        }
      }
      return { request: { path: historyPath(entry, value.path), method, headers } };
    }
    if (action === 'editor.digest') {
      const text = payload.base64;
      if (payload.algorithm !== 'SHA-256' || typeof text !== 'string' || text.length > 44_739_244
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw failure('PREVIEW_READ_ONLY', 'Only a bounded SHA-256 digest is available.');
      const bytes = target.atob(text);
      if (bytes.length > 32 * 1024 * 1024 || target.btoa(bytes) !== text) throw failure('PREVIEW_READ_ONLY', 'Invalid preview digest payload.');
      return { algorithm: 'SHA-256', base64: text };
    }
    if (action === 'editor.events.open') return { path: historyPath(entry, payload.path, true) };
    if (action === 'editor.events.poll' || action === 'editor.events.close') {
      if (typeof payload.subscriptionId !== 'string' || !entry.subscriptions.has(payload.subscriptionId)) throw failure('PREVIEW_READ_ONLY', 'This event stream does not belong to the preview.');
      if (action === 'editor.events.poll' && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0 || payload.cursor > entry.subscriptions.get(payload.subscriptionId))) throw failure('PREVIEW_READ_ONLY', 'Invalid preview event cursor.');
      return { subscriptionId: payload.subscriptionId, ...(action === 'editor.events.poll' ? { cursor: payload.cursor } : {}) };
    }
    throw failure('PREVIEW_READ_ONLY', 'Historical previews cannot save, download or send requests to chat.');
  };
  const execute = async (entry, action, payload) => {
    if (!alive(entry)) throw failure('PREVIEW_CLOSED', 'The read-only preview has closed.');
    if (action === 'editor.events.open') {
      if (entry.subscriptions.size + entry.pendingStreams >= 4) throw failure('PREVIEW_BUSY', 'The preview already has its event streams.');
      entry.pendingStreams++;
      try {
        const result = await rpc(action, payload);
        if (!UUID.test(result?.subscriptionId || '') || !Number.isSafeInteger(result.cursor) || result.cursor < 0) {
          if (UUID.test(result?.subscriptionId || '')) void Promise.resolve().then(() => rpc('editor.events.close', { subscriptionId: result.subscriptionId })).catch(() => {});
          throw failure('PREVIEW_FAILED', 'The preview event service returned an invalid stream.');
        }
        if (!alive(entry)) { void Promise.resolve().then(() => rpc('editor.events.close', { subscriptionId: result.subscriptionId })).catch(() => {}); return; }
        entry.subscriptions.set(result.subscriptionId, result.cursor); return result;
      } finally { entry.pendingStreams--; }
    }
    if (action === 'editor.events.close') {
      const result = await rpc(action, payload);
      entry.subscriptions.delete(payload.subscriptionId);
      return result;
    }
    const result = await rpc(action, payload);
    if (action === 'editor.events.poll' && alive(entry)) {
      if (!Number.isSafeInteger(result?.cursor) || result.cursor < payload.cursor || !Array.isArray(result.events) || result.events.length > 128) throw failure('PREVIEW_FAILED', 'The preview event service returned invalid events.');
      if (entry.subscriptions.has(payload.subscriptionId)) entry.subscriptions.set(payload.subscriptionId, Math.max(entry.subscriptions.get(payload.subscriptionId), result.cursor));
    }
    return result;
  };
  const forget = (entry, id, cached) => {
    if (entry.requests.get(id) !== cached) return;
    entry.requests.delete(id); entry.cacheBytes -= cached.bytes;
  };
  const trimCache = (entry, needed, currentId) => {
    for (const [id, cached] of entry.requests) {
      if (entry.requests.size < MAX_CACHE && entry.cacheBytes + needed <= MAX_CACHE_BYTES) break;
      if (id !== currentId && cached.settled && !(cached.subscriptionId && entry.subscriptions.has(cached.subscriptionId))) forget(entry, id, cached);
    }
  };
  const resultFor = (entry, id, cached, answer) => {
    if (!alive(entry)) return answer;
    const bytes = new TextEncoder().encode(JSON.stringify(answer)).byteLength;
    if (bytes > MAX_CACHE_BYTES) throw failure('PREVIEW_TOO_LARGE', 'The preview response exceeds its transfer limit.');
    trimCache(entry, bytes, id);
    if (entry.cacheBytes + bytes <= MAX_CACHE_BYTES) { cached.bytes += bytes; entry.cacheBytes += bytes; }
    else cached.evictWhenSettled = true;
    return answer;
  };
  const receive = async event => {
    const entry = current, message = event.data;
    if (!entry || !alive(entry) || entry.kind !== 'history' || event.source !== entry.frame?.contentWindow || message?.channel !== entry.channel) return;
    if (message.type === 'codex-design:editor-document-request') { send(entry, { type: 'codex-design:editor-document', html: entry.html }); return; }
    if (message.type === 'codex-design:preview-close') { close(); return; }
    if (message.type === 'codex-design:editor-transport-ready') { send(entry, { type: 'codex-design:host-context-changed', context: hostContext, hostContextIsSnapshot: true }); return; }
    if (message.type === 'codex-design:editor-app-ready') { clearTimeout(entry.startup); entry.status.hidden = true; return; }
    if (message.type === 'codex-design:editor-diagnostic') { showError(entry, failure('PREVIEW_RUNTIME_ERROR', typeof message.message === 'string' ? message.message.slice(0, 2000) : 'The historical preview could not be displayed.')); return; }
    if (message.type !== 'codex-design:editor-request' || typeof message.requestId !== 'string' || !REQUEST_ID.test(message.requestId)) return;
    const respond = value => send(entry, { type: 'codex-design:editor-response', requestId: message.requestId, ...value });
    try {
      const payload = validate(entry, message.action, message.payload);
      const signature = message.action + ':' + JSON.stringify(payload);
      const bytes = new TextEncoder().encode(signature).byteLength;
      if (bytes > MAX_PENDING_BYTES) throw failure('PREVIEW_BUSY', 'The preview request exceeds its transfer limit.');
      let cached = entry.requests.get(message.requestId);
      if (cached && cached.signature !== signature) throw failure('PREVIEW_REQUEST_CONFLICT', 'A preview request identifier was reused with different content.');
      if (!cached) {
        if (entry.pending >= MAX_PENDING || entry.pendingBytes + bytes > MAX_PENDING_BYTES) throw failure('PREVIEW_BUSY', 'The preview has too many pending reads.');
        trimCache(entry, bytes);
        if (entry.requests.size >= MAX_CACHE || entry.cacheBytes + bytes > MAX_CACHE_BYTES) throw failure('PREVIEW_BUSY', 'The preview request cache is full.');
        cached = { signature, settled: false, bytes };
        entry.pending++; entry.pendingBytes += bytes; entry.cacheBytes += bytes;
        cached.promise = Promise.resolve().then(() => execute(entry, message.action, payload))
          .then(result => {
            if (message.action === 'editor.events.open' && UUID.test(result?.subscriptionId || '')) cached.subscriptionId = result.subscriptionId;
            return resultFor(entry, message.requestId, cached, { result });
          })
          .catch(error => resultFor(entry, message.requestId, cached, { error: detail(error) }))
          .finally(() => {
            cached.settled = true; entry.pending--; entry.pendingBytes -= bytes;
            if (cached.evictWhenSettled || !alive(entry)) forget(entry, message.requestId, cached);
          });
        entry.requests.set(message.requestId, cached);
      }
      respond(await cached.promise);
    } catch (error) { respond({ error: detail(error) }); }
  };
  const open = async value => {
    const item = classify(value);
    if (disposed || item.external) return false;
    const entry = create(item.title || 'Read-only preview'); entry.kind = item.kind; entry.title = item.title;
    try {
      if (item.refused) throw failure('PREVIEW_UNAVAILABLE', 'This link cannot be opened as a read-only Codex Design preview.');
      const saved = typeof flush === 'function' ? await flush() : undefined;
      if (!alive(entry)) return false;
      if (saved?.saved === false) throw failure('EDITOR_UNSAVED_CHANGES', 'Save the current editor before opening its preview.');
      if (item.kind === 'system') {
        const response = await target.fetch(new URL(item.path, base).href, { method: 'GET' });
        if (!alive(entry)) return false;
        if (!response.ok || !/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '')) throw failure('PREVIEW_UNAVAILABLE', `The design system reference could not be loaded (HTTP ${response.status}).`);
        if (Number(response.headers.get('content-length')) > PASSIVE_LIMIT) throw failure('PREVIEW_TOO_LARGE', 'The design system reference exceeds its preview limit.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!alive(entry)) return false;
        if (bytes.byteLength > PASSIVE_LIMIT) throw failure('PREVIEW_TOO_LARGE', 'The design system reference exceeds its preview limit.');
        const html = passiveHtml(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!alive(entry)) return false;
        const url = target.URL.createObjectURL(new Blob([html], { type: 'text/html' })); entry.urls.add(url);
        frame(entry, '').src = url; entry.status.hidden = true;
      } else {
        entry.channel = target.crypto.randomUUID(); entry.prefix = item.path;
        if (!UUID.test(entry.channel)) throw failure('PREVIEW_FAILED', 'A unique preview channel could not be created.');
        const result = await rpc('editor.previewDocument', { version: item.version, channel: entry.channel });
        if (!alive(entry)) return false;
        if (typeof result?.html !== 'string' || !result.html.trim() || new TextEncoder().encode(result.html).byteLength > LIMIT) throw failure('PREVIEW_TOO_LARGE', 'The historical editor document is missing or exceeds its preview limit.');
        entry.html = result.html;
        const loader = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="form-action &#39;none&#39;"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script>(' + loadSnapshotDocument.toString().replace(/<\/script/gi, '<\\/script') + ')(' + JSON.stringify(entry.channel) + ');<\/script></body></html>';
        frame(entry, 'allow-scripts allow-same-origin').src = 'data:text/html;base64,' + target.btoa(loader);
        entry.startup = setTimeout(() => showError(entry, failure('PREVIEW_START_TIMEOUT', 'The historical editor did not finish opening. Close and retry this preview.')), 30_000);
        entry.startup.unref?.();
      }
      return true;
    } catch (error) { showError(entry, error); return false; }
  };
  const wrappedOpen = function (value, ...args) {
    const item = classify(value);
    if (item.external) return typeof originalOpen === 'function' ? originalOpen.call(target, value, ...args) : null;
    void open(value); return null;
  };
  const click = event => {
    if (event.defaultPrevented || event.button !== undefined && event.button !== 0 && event.button !== 1) return;
    const link = event.composedPath?.().find(node => node?.nodeType === 1 && String(node.localName).toLowerCase() === 'a' && node.hasAttribute('href'));
    if (!link || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) return;
    const item = classify(href);
    if (item.external) return;
    event.preventDefault(); event.stopPropagation?.(); void open(href);
  };
  const key = event => { if (current && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation?.(); close(); } };
  const updateHostContext = context => {
    const value = { ...(context?.theme === 'light' || context?.theme === 'dark' ? { theme: context.theme } : {}), ...(plain(context?.styles) ? { styles: context.styles } : {}) };
    try {
      const text = JSON.stringify(value);
      hostContext = text.length <= 2 * 1024 * 1024 ? JSON.parse(text) : { theme: value.theme };
    } catch { hostContext = {}; }
    if (current?.kind === 'history') send(current, { type: 'codex-design:host-context-changed', context: hostContext, hostContextIsSnapshot: true });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; close(false);
    target.removeEventListener('message', receive); target.removeEventListener('unload', dispose);
    document.removeEventListener('click', click, true); document.removeEventListener('auxclick', click, true); document.removeEventListener('keydown', key, true);
    if (target.open === wrappedOpen) target.open = originalOpen;
  };
  target.open = wrappedOpen;
  target.addEventListener('message', receive); target.addEventListener('unload', dispose);
  document.addEventListener('click', click, true); document.addEventListener('auxclick', click, true); document.addEventListener('keydown', key, true);
  updateHostContext(target.__CODEX_DESIGN_EDITOR_TRANSPORT__?.hostContext);
  return { open, close, updateHostContext, dispose };
}
