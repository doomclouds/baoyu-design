const ALLOWED = new Set(['editor.request', 'editor.digest', 'editor.motionExport', 'editor.systemSync', 'editor.events.open', 'editor.events.poll', 'editor.events.close', 'editor.download', 'editor.previewDocument']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_LIMIT = 128;
const errorDetail = error => ({ code: error?.code || 'EDITOR_REQUEST_FAILED', message: String(error?.message || error).slice(0, 2000) });

// The host exposes safe insets, not the floating composer's current rectangle.
// Reserve its observed compact footprint, then translate only the overlap with
// this editor iframe. A frame already above the reserve legitimately returns 0.
export function nativeCommentViewportHint(iframe, context, ownerWindow) {
  const rect = iframe.getBoundingClientRect?.();
  const height = ownerWindow.innerHeight;
  if (!rect || !Number.isFinite(rect.bottom) || !Number.isFinite(rect.height) || rect.height <= 0 || !Number.isFinite(height) || height <= 0) return;
  const visible = ownerWindow.visualViewport;
  const visibleBottom = visible && Number.isFinite(visible.offsetTop) && Number.isFinite(visible.height) && visible.height > 0
    ? Math.min(height, visible.offsetTop + visible.height) : height;
  const supplied = context?.safeAreaInsets?.bottom;
  const reserve = Math.max(72, typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0 ? supplied : 0);
  const overlap = Math.max(0, Math.min(rect.height, rect.bottom - (visibleBottom - reserve)));
  const innerHeight = Number.isFinite(iframe.clientHeight) && iframe.clientHeight > 0 ? iframe.clientHeight : rect.height;
  return { bottom: overlap * innerHeight / rect.height };
}

// A failed draft append must not make the composer repeat a successful comment
// mutation. Keep its saved identity and let the existing thread retry only Send.
function savedCommentFailure(result, request, error) {
  if (!Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || typeof result.body !== 'string') return;
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(result.body), character => character.charCodeAt(0))));
    const thread = body?.thread;
    if (!thread || typeof thread.id !== 'string' || !/^c_[A-Za-z0-9_-]{1,100}$/.test(thread.id)
      || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
      || Object.hasOwn(request, 'savedCommentId') && request.savedCommentId !== thread.id) return;
    const detail = errorDetail(error);
    const message = (error?.nativeDraftAdded
      ? 'Your comment was saved and added to the chat draft, but confirming the draft failed. Check the existing draft before adding it again. '
      : 'Your comment was saved, but adding it to the chat draft failed. Use "Retry add to chat" on this comment. ') + detail.message;
    body.thread = { ...thread, agent: { ...thread.agent, nativeRequest: { ...thread.agent?.nativeRequest,
      requestId: request.requestId, status: 'needs_attention', message } } };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    return { result: { ...result, body: btoa(binary) }, warning: { code: detail.code, message } };
  } catch { /* Without a verified saved identity, preserve the transport error. */ }
}

function reuseRequest(cache, requestId, execute) {
  const existing = cache.get(requestId);
  if (existing) return existing.promise;
  if (cache.size >= REQUEST_LIMIT) {
    for (const [id, entry] of cache) {
      if (entry.settled) { cache.delete(id); break; }
    }
  }
  if (cache.size >= REQUEST_LIMIT) throw Object.assign(new Error('The artwork editor has too many pending requests.'), { code: 'EDITOR_REQUEST_BUSY' });
  const entry = { settled: false };
  entry.promise = Promise.resolve().then(execute).finally(() => { entry.settled = true; });
  cache.set(requestId, entry);
  return entry.promise;
}

function loadEditorDocument(channel) {
  let accepted = false;
  let editor;
  const outgoing = new Set(['codex-design:editor-request', 'codex-design:editor-transport-ready', 'codex-design:editor-app-ready', 'codex-design:editor-diagnostic', 'codex-design:editor-flushed', 'codex-design:editor-history-opened']);
  const incoming = new Set(['codex-design:editor-response', 'codex-design:host-context-changed', 'codex-design:comment-viewport-changed', 'codex-design:editor-flush', 'codex-design:ui-language-changed', 'codex-design:editor-history-open', 'codex-design:editor-history-close']);
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
export function mountNativeEditor({ iframe, bridge, artifactId, channel, document: editorDocument, onError, onReady, startupTimeoutMs = 30_000, historyTimeoutMs = 10_000 } = {}) {
  if (typeof editorDocument?.html !== 'string' || !editorDocument.html.trim()) throw new TypeError('The editor document is missing.');
  const ownerWindow = iframe.ownerDocument?.defaultView || window;
  const subscriptions = new Set();
  const motionJobs = new Set();
  const requests = new Map(), drafts = new Map();
  let disposed = false;
  let appReady = false;
  let flush;
  let readyFailure, historyAction;
  const readyWaiters = new Set();
  let viewportObserver, lastViewportBottom;
  const startup = setTimeout(() => {
    if (!disposed) {
      readyFailure = Object.assign(new Error('The artwork editor did not finish opening. Retry this artwork tab.'), { code: 'EDITOR_START_TIMEOUT' });
      for (const waiter of readyWaiters) waiter.reject(readyFailure);
      readyWaiters.clear();
      onError?.(errorDetail(readyFailure));
    }
  }, startupTimeoutMs);
  startup.unref?.();
  const sendHostContext = () => {
    if (disposed) return;
    const commentViewport = nativeCommentViewportHint(iframe, bridge.hostContext, ownerWindow);
    lastViewportBottom = commentViewport?.bottom;
    if (bridge.hostContext || commentViewport) iframe.contentWindow?.postMessage({ type: 'codex-design:host-context-changed', channel, context: bridge.hostContext,
      hostContextIsSnapshot: true, commentViewport }, '*');
  };
  const sendCommentViewport = () => {
    if (disposed) return;
    const commentViewport = nativeCommentViewportHint(iframe, bridge.hostContext, ownerWindow);
    if (commentViewport?.bottom === lastViewportBottom) return;
    lastViewportBottom = commentViewport?.bottom;
    iframe.contentWindow?.postMessage({ type: 'codex-design:comment-viewport-changed', channel, commentViewport }, '*');
  };
  const stopViewport = () => {
    viewportObserver?.disconnect();
    ownerWindow.removeEventListener?.('resize', sendCommentViewport);
    ownerWindow.removeEventListener?.('scroll', sendCommentViewport, { capture: true });
    ownerWindow.visualViewport?.removeEventListener?.('resize', sendCommentViewport);
    ownerWindow.visualViewport?.removeEventListener?.('scroll', sendCommentViewport);
  };
  const reply = (requestId, value) => {
    if (!disposed) iframe.contentWindow?.postMessage({ type: 'codex-design:editor-response', channel, requestId, ...value }, '*');
  };
  const draftComment = request => {
    if (!request || request.artifactId !== artifactId || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
      || Object.hasOwn(request, 'attemptId') && (typeof request.attemptId !== 'string' || !UUID.test(request.attemptId))
      || request.uri !== `codex-design://edit-requests/${request.requestId}`) {
      throw Object.assign(new Error('The comment draft does not belong to this artwork.'), { code: 'INVALID_COMMENT_DRAFT' });
    }
    const draftKey = request.attemptId === undefined ? request.requestId : `${request.requestId}:${request.attemptId}`;
    return reuseRequest(drafts, draftKey, async () => {
      let appended = false;
      try {
        if (disposed) throw Object.assign(new Error('The artwork editor has closed.'), { code: 'EDITOR_CLOSED' });
        if (typeof bridge.draftComment !== 'function') throw Object.assign(new Error('This host cannot add design comments to the active chat draft.'), { code: 'NATIVE_COMMENT_DRAFT_UNAVAILABLE' });
        await bridge.draftComment(request);
        appended = true;
        await bridge.invoke('request.draftAdded', { requestId: request.requestId });
      } catch (error) {
        const failure = appended ? Object.assign(new Error('The chat draft was added, but confirming it failed. ' + errorDetail(error).message), {
          code: error?.code || 'NATIVE_COMMENT_DRAFT_ACK_FAILED', nativeDraftAdded: true,
        }) : error;
        await bridge.invoke('request.draftFailed', { requestId: request.requestId, error: errorDetail(failure) }).catch(() => {});
        // A new RPC may explicitly retry the same immutable request after an
        // append failure. The original RPC still retains its error response.
        if (!appended) drafts.delete(draftKey);
        throw failure;
      }
    });
  };
  const execute = async message => {
    let result;
    try {
      result = message.action === 'editor.download'
        ? await bridge.downloadResource({ ...message.payload, artifactId })
        : message.action === 'editor.systemSync'
          ? await bridge.syncDesignSystem({ id: artifactId, namespace: message.payload.namespace })
          : await bridge.invoke(message.action, { ...message.payload, id: artifactId });
      if (message.action === 'editor.events.open' && result?.subscriptionId) {
        if (disposed) { void bridge.invoke('editor.events.close', { id: artifactId, subscriptionId: result.subscriptionId }).catch(() => {}); return; }
        subscriptions.add(result.subscriptionId);
      }
      if (message.action === 'editor.events.close') subscriptions.delete(message.payload.subscriptionId);
      if (message.action === 'editor.motionExport' && typeof result?.jobId === 'string' && UUID.test(result.jobId)) {
        if (result.status === 'running') {
          if (disposed) { void bridge.invoke('editor.motionExport', { id: artifactId, operation: 'cancel', jobId: result.jobId }).catch(() => {}); return; }
          motionJobs.add(result.jobId);
        } else motionJobs.delete(result.jobId);
      }
      if (message.action === 'editor.request' && result?.nativeDraft) await draftComment(result.nativeDraft);
      return { result };
    } catch (error) {
      const saved = message.action === 'editor.request' && result?.nativeDraft && savedCommentFailure(result, result.nativeDraft, error);
      if (saved) { onError?.(saved.warning); return { result: saved.result }; }
      return { error: errorDetail(error) };
    }
  };
  const listener = async event => {
    const message = event.data;
    if (disposed || event.source !== iframe.contentWindow || message?.channel !== channel) return;
    if (message.type === 'codex-design:editor-document-request') {
      iframe.contentWindow?.postMessage({ type: 'codex-design:editor-document', channel, html: editorDocument.html, title: iframe.title }, '*');
      return;
    }
    if (message.type === 'codex-design:editor-transport-ready') { sendHostContext(); return; }
    if (message.type === 'codex-design:editor-app-ready') {
      appReady = true; clearTimeout(startup);
      for (const waiter of readyWaiters) waiter.resolve();
      readyWaiters.clear();
      onReady?.(); return;
    }
    if (message.type === 'codex-design:editor-flushed') {
      if (!flush || message.requestId !== flush.requestId) return;
      const current = flush; flush = undefined; clearTimeout(current.timer);
      message.saved === true ? current.resolve({ saved: true }) : current.reject(Object.assign(new Error(message.error?.message || 'The editor still has unsaved changes.'), { code: message.error?.code || 'EDITOR_UNSAVED_CHANGES' }));
      return;
    }
    if (message.type === 'codex-design:editor-history-opened') {
      const current = historyAction;
      if (!current?.reply || message.requestId !== current.requestId) return;
      clearTimeout(current.timer);
      if (message.opened === true) current.reply.resolve({ opened: true });
      else current.reply.reject(Object.assign(new Error(message.error?.message || 'Detailed edit history is unavailable for this artwork.'), { code: message.error?.code || 'NATIVE_HISTORY_UNAVAILABLE' }));
      current.reply = undefined;
      return;
    }
    if (message.type === 'codex-design:editor-diagnostic') { onError?.({ code: 'EDITOR_RUNTIME_ERROR', message: message.message }); return; }
    if (message.type !== 'codex-design:editor-request' || !ALLOWED.has(message.action)
      || typeof message.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(message.requestId)
      || !message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) return;
    try {
      reply(message.requestId, await reuseRequest(requests, message.requestId, () => execute(message)));
    } catch (error) { reply(message.requestId, { error: errorDetail(error) }); }
  };
  let url;
  ownerWindow.addEventListener?.('resize', sendCommentViewport);
  ownerWindow.addEventListener?.('scroll', sendCommentViewport, { capture: true, passive: true });
  ownerWindow.visualViewport?.addEventListener?.('resize', sendCommentViewport);
  ownerWindow.visualViewport?.addEventListener?.('scroll', sendCommentViewport);
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
    if (typeof ownerWindow.ResizeObserver === 'function') {
      viewportObserver = new ownerWindow.ResizeObserver(sendCommentViewport);
      viewportObserver.observe(iframe);
    }
  } catch (error) {
    disposed = true; clearTimeout(startup); stopViewport(); ownerWindow.removeEventListener('message', listener); iframe.removeEventListener?.('load', sendHostContext); unsubscribe?.();
    throw error;
  }
  const flushEditor = () => {
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
  };
  const openHistory = ({ signal } = {}) => {
    if (disposed) return Promise.reject(Object.assign(new Error('The artwork editor has closed.'), { code: 'EDITOR_CLOSED' }));
    if (signal?.aborted) return Promise.reject(signal.reason || Object.assign(new Error('Opening edit history was cancelled.'), { code: 'EDITOR_HISTORY_CANCELLED' }));
    if (historyAction) return historyAction.promise;
    const action = {};
    let rejectCancelled;
    const cancelled = new Promise((_resolve, reject) => { rejectCancelled = reject; });
    void cancelled.catch(() => {});
    action.cancel = error => {
      if (action.requestId) iframe.contentWindow?.postMessage({ type: 'codex-design:editor-history-close', channel, requestId: action.requestId }, '*');
      rejectCancelled(error);
    };
    const onAbort = () => action.cancel(signal.reason || Object.assign(new Error('Opening edit history was cancelled.'), { code: 'EDITOR_HISTORY_CANCELLED' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    action.promise = (async () => {
      if (!appReady) {
        if (readyFailure) throw readyFailure;
        const ready = new Promise((resolve, reject) => { action.ready = { resolve, reject }; readyWaiters.add(action.ready); });
        await Promise.race([ready, cancelled]);
      }
      await Promise.race([flushEditor(), cancelled]);
      if (disposed || signal?.aborted) throw signal?.reason || Object.assign(new Error('The artwork editor has closed.'), { code: 'EDITOR_CLOSED' });
      action.requestId = crypto.randomUUID();
      const reply = new Promise((resolve, reject) => { action.reply = { resolve, reject }; });
      action.timer = setTimeout(() => action.cancel(Object.assign(new Error('The editor did not confirm opening edit history.'), { code: 'EDITOR_HISTORY_TIMEOUT' })), historyTimeoutMs);
      iframe.contentWindow?.postMessage({ type: 'codex-design:editor-history-open', channel, requestId: action.requestId }, '*');
      return await Promise.race([reply, cancelled]);
    })().finally(() => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(action.timer);
      if (action.ready) readyWaiters.delete(action.ready);
      if (historyAction === action) historyAction = undefined;
    });
    historyAction = action;
    return action.promise;
  };
  return {
    url,
    post(message) { if (!disposed) iframe.contentWindow?.postMessage({ ...message, channel }, '*'); },
    flush: flushEditor,
    openHistory,
    dispose() {
      if (disposed) return;
      bridge.cancelSystemSync?.(artifactId);
      for (const jobId of motionJobs) void bridge.invoke('editor.motionExport', { id: artifactId, operation: 'cancel', jobId }).catch(() => {});
      motionJobs.clear();
      disposed = true; clearTimeout(startup); stopViewport(); ownerWindow.removeEventListener('message', listener); iframe.removeEventListener?.('load', sendHostContext); unsubscribe?.();
      const closed = Object.assign(new Error('The artwork editor closed before edit history opened.'), { code: 'EDITOR_CLOSED' });
      historyAction?.cancel(closed);
      for (const waiter of readyWaiters) waiter.reject(closed);
      readyWaiters.clear();
      if (flush) { clearTimeout(flush.timer); flush.reject(Object.assign(new Error('The editor closed before saving was confirmed.'), { code: 'EDITOR_UNSAVED_CHANGES' })); flush = undefined; }
      for (const subscriptionId of subscriptions) void bridge.invoke('editor.events.close', { id: artifactId, subscriptionId }).catch(() => {});
      subscriptions.clear();
      requests.clear(); drafts.clear();
    },
  };
}
