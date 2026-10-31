const ALLOWED = new Set(['editor.request', 'editor.digest', 'editor.events.open', 'editor.events.poll', 'editor.events.close', 'editor.download']);

function loadEditorDocument(channel) {
  let accepted = false;
  let editor;
  const outgoing = new Set(['codex-design:editor-request', 'codex-design:editor-transport-ready', 'codex-design:editor-app-ready', 'codex-design:editor-diagnostic', 'codex-design:editor-flushed']);
  const incoming = new Set(['codex-design:editor-response', 'codex-design:host-context-changed', 'codex-design:editor-flush', 'codex-design:ui-language-changed']);
  const receive = event => {
    const message = event.data;
    if (message?.channel !== channel) return;
    if (event.source === window.parent) {
      if (!accepted && message.type === 'codex-design:editor-document' && typeof message.html === 'string' && message.html.length <= 24 * 1024 * 1024) {
        accepted = true;
        editor = document.createElement('iframe');
        editor.setAttribute('data-codex-native-editor', '');
        editor.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-modals allow-forms');
        editor.setAttribute('allowfullscreen', '');
        editor.allow = 'clipboard-read; clipboard-write; fullscreen';
        editor.title = typeof message.title === 'string' ? message.title.slice(0, 240) : 'Codex Design editor';
        editor.srcdoc = message.html;
        document.body.appendChild(editor);
      } else if (editor && incoming.has(message.type)) editor.contentWindow?.postMessage(message, '*');
    } else if (editor && event.source === editor.contentWindow && outgoing.has(message.type)) window.parent.postMessage(message, '*');
  };
  window.addEventListener('message', receive);
  window.parent.postMessage({ type: 'codex-design:editor-document-request', channel }, '*');
}

// The inner document receives no host/tool access. Requests are accepted only
// from this exact frame, with a per-open channel, and the artwork id is fixed.
export function mountNativeEditor({ iframe, bridge, artifactId, channel, document: editorDocument, onError, onReady, startupTimeoutMs = 30_000 } = {}) {
  if (typeof editorDocument?.html !== 'string' || !editorDocument.html.trim()) throw new TypeError('The editor document is missing.');
  const ownerWindow = iframe.ownerDocument?.defaultView || window;
  const subscriptions = new Set();
  let disposed = false;
  let appReady = false;
  let flush;
  const startup = setTimeout(() => {
    if (!disposed) onError?.({ code: 'EDITOR_START_TIMEOUT', message: 'The artwork editor did not finish opening. Retry this artwork tab.' });
  }, startupTimeoutMs);
  startup.unref?.();
  const sendHostContext = () => {
    if (!disposed && bridge.hostContext) iframe.contentWindow?.postMessage({ type: 'codex-design:host-context-changed', channel, context: bridge.hostContext }, '*');
  };
  const reply = (requestId, value) => {
    if (!disposed) iframe.contentWindow?.postMessage({ type: 'codex-design:editor-response', channel, requestId, ...value }, '*');
  };
  const listener = async event => {
    const message = event.data;
    if (disposed || event.source !== iframe.contentWindow || message?.channel !== channel) return;
    if (message.type === 'codex-design:editor-document-request') {
      iframe.contentWindow?.postMessage({ type: 'codex-design:editor-document', channel, html: editorDocument.html, title: iframe.title }, '*');
      return;
    }
    if (message.type === 'codex-design:editor-transport-ready') { sendHostContext(); return; }
    if (message.type === 'codex-design:editor-app-ready') { appReady = true; clearTimeout(startup); onReady?.(); return; }
    if (message.type === 'codex-design:editor-flushed') {
      if (!flush || message.requestId !== flush.requestId) return;
      const current = flush; flush = undefined; clearTimeout(current.timer);
      message.saved === true ? current.resolve({ saved: true }) : current.reject(Object.assign(new Error(message.error?.message || 'The editor still has unsaved changes.'), { code: message.error?.code || 'EDITOR_UNSAVED_CHANGES' }));
      return;
    }
    if (message.type === 'codex-design:editor-diagnostic') { onError?.({ code: 'EDITOR_RUNTIME_ERROR', message: message.message }); return; }
    if (message.type !== 'codex-design:editor-request' || !ALLOWED.has(message.action)
      || typeof message.requestId !== 'string' || message.requestId.length > 80 || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return;
    try {
      const result = message.action === 'editor.download'
        ? await bridge.downloadResource(message.payload)
        : await bridge.invoke(message.action, { ...message.payload, id: artifactId });
      if (message.action === 'editor.events.open' && result?.subscriptionId) {
        if (disposed) { void bridge.invoke('editor.events.close', { id: artifactId, subscriptionId: result.subscriptionId }).catch(() => {}); return; }
        subscriptions.add(result.subscriptionId);
      }
      if (message.action === 'editor.events.close') subscriptions.delete(message.payload.subscriptionId);
      reply(message.requestId, { result });
    } catch (error) { reply(message.requestId, { error: { code: error.code || 'EDITOR_REQUEST_FAILED', message: String(error.message || error).slice(0, 2000) } }); }
  };
  let url;
  ownerWindow.addEventListener('message', listener);
  iframe.addEventListener?.('load', sendHostContext);
  const unsubscribe = bridge.subscribe?.(event => { if (event?.type === 'host-context.changed') sendHostContext(); });
  try {
    if (new TextEncoder().encode(editorDocument.html).byteLength > 24 * 1024 * 1024) throw new TypeError('The native editor document exceeds its transfer limit.');
    // A tiny data: loader avoids the browser's navigation-URL size limit. The
    // full document arrives through the validated parent channel and is written
    // by the isolated editor document rather than by the MCP app.
    const loader = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="form-action &#39;none&#39;"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><script>(' + loadEditorDocument.toString() + ')(' + JSON.stringify(channel) + ');<\/script></body></html>';
    url = 'data:text/html;base64,' + btoa(loader);
    // data: gives the editor an intrinsic opaque origin, distinct from the MCP
    // app. allow-same-origin avoids forcing a NEW opaque origin on every inner
    // preview, so the editor can inspect its own canonical srcdoc previews.
    // Never replace this data: navigation with srcdoc + allow-same-origin.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-modals allow-forms');
    iframe.removeAttribute?.('srcdoc');
    iframe.src = url;
  } catch (error) {
    disposed = true; clearTimeout(startup); ownerWindow.removeEventListener('message', listener); iframe.removeEventListener?.('load', sendHostContext); unsubscribe?.();
    throw error;
  }
  return {
    url,
    post(message) { if (!disposed) iframe.contentWindow?.postMessage({ ...message, channel }, '*'); },
    flush() {
      if (disposed) return Promise.reject(Object.assign(new Error('The artwork editor has closed.'), { code: 'EDITOR_CLOSED' }));
      // Before the actual controls mount the user cannot have made an edit.
      if (!appReady) return Promise.resolve({ saved: true });
      if (flush) return flush.promise;
      const requestId = crypto.randomUUID();
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => {
        if (flush?.requestId !== requestId) return;
        flush = undefined;
        reject(Object.assign(new Error('The editor did not confirm that changes were saved.'), { code: 'EDITOR_UNSAVED_CHANGES' }));
      }, 10_000);
      flush = { requestId, promise, resolve, reject, timer };
      iframe.contentWindow?.postMessage({ type: 'codex-design:editor-flush', channel, requestId }, '*');
      return promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(startup); ownerWindow.removeEventListener('message', listener); iframe.removeEventListener?.('load', sendHostContext); unsubscribe?.();
      if (flush) { clearTimeout(flush.timer); flush.reject(Object.assign(new Error('The editor closed before saving was confirmed.'), { code: 'EDITOR_UNSAVED_CHANGES' })); flush = undefined; }
      for (const subscriptionId of subscriptions) void bridge.invoke('editor.events.close', { id: artifactId, subscriptionId }).catch(() => {});
      subscriptions.clear();
    },
  };
}
