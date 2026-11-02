// This function is serialized into the editor document before its original UI.
// Its only authority is the artwork-scoped message broker in the parent app.
export function installNativeEditorTransport(configuration, target, installPreviews) {
  'use strict';
  target ??= window;
  const base = new URL(configuration.baseUrl);
  const channel = configuration.channel;
  const readOnly = configuration.readOnly === true;
  const requestPrefix = configuration.requestPrefix || '';
  if (requestPrefix && (!readOnly || !/^v\/[1-9][0-9]{0,8}\/$/.test(requestPrefix))) throw new TypeError('Invalid read-only preview scope.');
  const rootBase = new URL(configuration.rootBaseUrl || base.href);
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
  let disposed = false;
  const pendingWrites = new Set();
  let historyOpenId;
  let previews;
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
  target.__CODEX_DESIGN_EDITOR_TRANSPORT__ = { baseUrl: base.href, artifactId: configuration.artifactId,
    canDraftComments: !readOnly && configuration.canDraftComments !== false, readOnly, commentViewport: { bottom: 72 } };
  if (readOnly) target.__CODEX_DESIGN_PREVIEW_CLOSE__ = () => {
    if (!disposed) target.parent.postMessage({ type: 'codex-design:preview-close', channel }, '*');
  };
  // Boot metadata comes from the verified local service. Only its capabilities
  // and known route fields are normalized; authored text is never rewritten.
  let historyMetadata;
  Object.defineProperty(target, '__baoyuHistory', { configurable: true, enumerable: true,
    get: () => historyMetadata,
    set: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.base !== 'string') throw new TypeError('Invalid artwork History metadata.');
      historyMetadata = { ...value, base: base.pathname, canRestore: !readOnly && value.canRestore === true,
        ...(value.preview && typeof value.preview === 'object' ? { preview: { ...value.preview, current_url: rootBase.href } } : {}) };
    },
  });
  const updateCommentViewport = hint => {
    const supplied = hint?.bottom;
    const bottom = typeof supplied === 'number' && Number.isFinite(supplied) && supplied >= 0 ? supplied : 72;
    if (target.__CODEX_DESIGN_EDITOR_TRANSPORT__.commentViewport.bottom === bottom) return;
    target.__CODEX_DESIGN_EDITOR_TRANSPORT__.commentViewport = { bottom };
    // Only the canonical comment root listens to this event. Do not resize the
    // editor/preview viewport or impersonate a browser window resize.
    if (typeof target.dispatchEvent === 'function') target.dispatchEvent(new (target.Event || Event)('codex-design:comment-viewport-changed'));
  };
  target.__CODEX_DESIGN_EDITOR_I18N__ = { preference: configuration.language || 'system', systemLocale: configuration.locale };
  const bytesToBase64 = bytes => {
    let value = '';
    for (let offset = 0; offset < bytes.length; offset += 16_384) value += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    return target.btoa(value);
  };
  const base64ToBytes = text => Uint8Array.from(target.atob(text), character => character.charCodeAt(0));
  const rpc = (action, payload = {}, signal) => new Promise((resolve, reject) => {
    if (disposed) { reject(Object.assign(new Error('The artwork editor has closed.'), { code: 'EDITOR_CLOSED' })); return; }
    if (signal?.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
    const requestId = String(++sequence);
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(requestId); };
    const abort = () => { cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    // A human Save As dialog owns its lifetime. Timing it out here could leave
    // an apparently failed request that writes a file after the user confirms.
    if (action !== 'editor.download') timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('The artwork editor connection timed out.'), { code: 'EDITOR_TRANSPORT_TIMEOUT' })); }, 45_000);
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
  // Keep this controller inside the serialized bootstrap: it must have no
  // module closure or authority over preview documents, artwork or the host.
  const hostTheme = (() => {
    const document = target.document;
    const root = document?.documentElement;
    const originalTheme = root?.getAttribute?.('data-theme');
    let variables = {}, fonts, mode, signature;
    let tokens = {};
    const owned = new Map();
    const content = '[data-appifact-content], [data-codex-artwork], [data-dc-preview], [data-slide-preview]';
    const commentHosts = '[data-baoyu-comments], [data-baoyu-comments-seat], [data-baoyu-history-layer]';
    const observed = new WeakSet();
    const observeScope = scope => {
      if (!observer || observed.has(scope)) return;
      observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'data-font', 'data-density'] });
      observed.add(scope);
    };
    const scopes = () => {
      const result = new Set([document]);
      for (const scope of result) for (const host of scope.querySelectorAll?.(commentHosts) || []) {
        // Canonical comments own these open shadow hosts. Never inspect an
        // artwork subtree or traverse arbitrary/closed user shadow roots.
        if (host.closest?.(content)) continue;
        const shadow = host.shadowRoot;
        if (shadow) { result.add(shadow); observeScope(shadow); }
      }
      return result;
    };
    const eligible = element => element && (element === root || element.matches?.('.cds-root'))
      && !element.closest?.(content);
    const restore = (element, state) => {
      for (const [name, original] of state.original) {
        if (original.value) element.style.setProperty(name, original.value, original.priority);
        else element.style.removeProperty(name);
      }
    };
    const refresh = () => {
      if (!root || disposed) return;
      const candidates = new Set([root].filter(eligible));
      const historyRoots = new Set();
      for (const scope of scopes()) {
        for (const element of scope.querySelectorAll?.('.cds-root') || []) if (eligible(element)) candidates.add(element);
        if (scope.host?.matches?.('[data-baoyu-history-layer]') && !scope.host.closest?.(content)) {
          for (const element of scope.querySelectorAll?.('.wrap') || []) { candidates.add(element); historyRoots.add(element); }
        }
      }
      for (const [element, state] of owned) if (!candidates.has(element)) { restore(element, state); owned.delete(element); }
      for (const element of candidates) {
        if (!element.style) continue;
        const elementTokens = historyRoots.has(element) ? { ...tokens,
          'font-family': tokens['--cds-font-sans'], 'font-size': tokens['--cds-font-size-body'], 'line-height': tokens['--cds-leading-body'],
          '--bg': tokens['--cds-surface-panel'], '--fg': tokens['--cds-text-primary'], '--muted': tokens['--cds-text-secondary'],
          '--faint': tokens['--cds-text-muted'], '--line': tokens['--cds-border'], '--soft': tokens['--cds-surface-2'],
          '--hover': tokens['--cds-fill-button-ghost-hover'], '--check': tokens['--cds-fill-accent'], '--danger': tokens['--cds-text-danger'],
          '--shadow': tokens['--cds-shadow-popover'],
        } : tokens;
        let state = owned.get(element);
        if (!state) { state = { original: new Map(), applied: new Map() }; owned.set(element, state); }
        for (const name of new Set([...state.applied.keys(), ...Object.keys(elementTokens)])) {
          const value = elementTokens[name];
          const current = element.style.getPropertyValue(name), priority = element.style.getPropertyPriority?.(name) || '';
          if (!state.original.has(name) || state.applied.has(name) && (current !== state.applied.get(name) || priority !== 'important')) {
            state.original.set(name, { value: current, priority });
          }
          if (value === undefined) {
            const original = state.original.get(name);
            if (original.value) element.style.setProperty(name, original.value, original.priority);
            else element.style.removeProperty(name);
            state.original.delete(name); state.applied.delete(name);
          } else {
            if (current !== value || priority !== 'important') element.style.setProperty(name, value, 'important');
            state.applied.set(name, value);
          }
        }
      }
    };
    const resolveTokens = () => {
      const result = {};
      if (!root || !document.createElement || !target.getComputedStyle) return result;
      const probe = document.createElement('span');
      probe.setAttribute('aria-hidden', 'true');
      for (const [name, value] of Object.entries(variables)) probe.style.setProperty(name, value);
      for (const [name, value] of Object.entries({ position: 'fixed', visibility: 'hidden', 'pointer-events': 'none', width: '0px', height: '0px', overflow: 'hidden' })) probe.style.setProperty(name, value);
      (document.body || root).appendChild(probe);
      const read = (name, property) => {
        const value = variables[name];
        if (typeof value !== 'string' || !value.trim()) return;
        const supported = target.CSS?.supports;
        if (supported && !supported(property, value)) return;
        // Computed custom properties are empty for unresolved/cyclic var().
        // Measure real CSS values, rather than parseFloat('1rem') as one pixel.
        const resolved = target.getComputedStyle(probe).getPropertyValue(name).trim();
        if (!resolved) return;
        if (property === 'line-height' && /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(resolved)) return resolved;
        probe.style.removeProperty(property);
        probe.style.setProperty(property, value);
        const computed = target.getComputedStyle(probe).getPropertyValue(property).trim();
        if (computed) return computed;
      };
      const map = (source, property, destinations) => {
        const value = read(source, property);
        if (value !== undefined) for (const destination of destinations) result[destination] = value;
        return value;
      };
      try {
        map('--font-sans', 'font-family', ['--cds-font-sans', '--cds-font-sans-display']);
        // The generic mono token may be consumed by authored code blocks.
        // Use the dedicated UI token, just as the artwork boundary retains its
        // own --cds-font-system rather than replacing it with the host font.
        map('--font-mono', 'font-family', ['--cds-font-mono-ui']);
        const size = read('--font-text-md-size', 'font-size');
        const px = size && /^([0-9]+(?:\.[0-9]+)?)px$/.exec(size);
        if (px && Number(px[1]) >= 8 && Number(px[1]) <= 48) {
          probe.style.setProperty('font-size', '1rem');
          const rem = /^([0-9]+(?:\.[0-9]+)?)px$/.exec(target.getComputedStyle(probe).getPropertyValue('font-size').trim());
          if (rem && Number(rem[1]) > 0) {
            // The packaged comfortable CDS body is .875rem (14px at a 16px
            // root), not 1rem. Preserve its scale while matching the host body.
            result['--cds-rem-scale'] = String(Number(px[1]) / (Number(rem[1]) * 0.875));
            result['--cds-font-size-body'] = size;
          }
        }
        if (size) probe.style.setProperty('font-size', size);
        map('--font-text-md-line-height', 'line-height', ['--cds-leading-body']);
        for (const [source, role] of [['normal', 'regular'], ['medium', 'medium'], ['semibold', 'semibold'], ['bold', 'bold']]) {
          const weight = map('--font-weight-' + source, 'font-weight', ['--cds-font-weight-' + role]);
          if (weight && /^[0-9]+(?:\.[0-9]+)?$/.test(weight)) result['--cds-font-wght-' + role] = '"wght" ' + weight;
        }
        for (const [source, destinations] of [
          ['--color-background-primary', ['--cds-surface-0', '--cds-page-bg', '--t-bg']],
          ['--color-background-secondary', ['--cds-surface-1', '--cds-surface-panel', '--cds-surface-popover', '--t-panel']],
          ['--color-background-tertiary', ['--cds-surface-2', '--cds-surface-3', '--cds-fill-button-layer', '--cds-fill-button-ghost-hover']],
          ['--color-background-disabled', ['--cds-fill-disabled']],
          ['--color-text-primary', ['--cds-text-primary', '--t-fg']],
          ['--color-text-secondary', ['--cds-text-secondary', '--t-fg-secondary']],
          ['--color-text-tertiary', ['--cds-text-muted', '--t-fg-muted']],
          ['--color-text-inverse', ['--cds-on-accent']],
          ['--color-text-info', ['--cds-fill-accent', '--cds-fill-accent-hover', '--t-app-accent', '--t-blue-text']],
          ['--color-text-danger', ['--cds-text-danger', '--cds-fill-danger', '--cds-fill-danger-hover', '--t-bad']],
          ['--color-text-success', ['--cds-fill-success', '--cds-fill-success-hover', '--t-ok']],
          ['--color-text-warning', ['--cds-fill-warning', '--cds-fill-warning-hover', '--t-warn']],
          ['--color-border-primary', ['--cds-border-strong', '--cds-border-stronger', '--t-border-strong']],
          ['--color-border-secondary', ['--cds-border', '--t-border']],
        ]) map(source, 'color', destinations);
        const focus = read('--color-ring-primary', 'color');
        if (focus) for (const name of ['--cds-focus-shadow', '--cds-shadow-drop-ring']) result[name] = '0 0 0 2px ' + focus;
        const dangerFocus = read('--color-ring-danger', 'color');
        if (dangerFocus) for (const name of ['--cds-focus-shadow-danger', '--cds-shadow-drop-ring-danger']) result[name] = '0 0 0 2px ' + dangerFocus;
        map('--border-radius-xs', 'border-radius', ['--cds-radius--xs']);
        map('--border-radius-sm', 'border-radius', ['--cds-radius--sm', '--cds-checkbox-radius']);
        map('--border-radius-md', 'border-radius', ['--cds-radius']);
        map('--border-radius-lg', 'border-radius', ['--cds-radius--lg', '--cds-panel-radius']);
        map('--shadow-sm', 'box-shadow', ['--cds-shadow-sm']);
        map('--shadow-md', 'box-shadow', ['--cds-shadow-md', '--cds-shadow-popover']);
        map('--shadow-lg', 'box-shadow', ['--cds-shadow-lg', '--cds-panel-shadow']);
      } finally { probe.remove(); }
      return result;
    };
    const hasChrome = node => node?.matches?.('.cds-root') || node?.matches?.(commentHosts)
      || node?.querySelector?.('.cds-root, ' + commentHosts);
    const changed = records => {
      // Object drags and authored animation can mutate thousands of styles.
      // Only new/removed chrome roots or changes to a managed root need work.
      const relevant = records.some(record => !record.target?.closest?.(content) && (
        record.type === 'attributes' ? eligible(record.target) || record.target?.matches?.(commentHosts)
          : [...(record.addedNodes || []), ...(record.removedNodes || [])].some(hasChrome)));
      if (relevant) refresh();
    };
    const observer = root && typeof target.MutationObserver === 'function' ? new target.MutationObserver(changed) : null;
    if (root) observeScope(root);
    const elementPrototype = target.Element?.prototype;
    const originalAttachShadow = elementPrototype?.attachShadow;
    let attachShadow;
    if (typeof originalAttachShadow === 'function') {
      attachShadow = function (options) {
        const shadow = originalAttachShadow.call(this, options);
        if (!disposed && options?.mode === 'open' && this.matches?.(commentHosts) && !this.closest?.(content)) {
          observeScope(shadow); refresh();
        }
        return shadow;
      };
      elementPrototype.attachShadow = attachShadow;
    }
    return {
      update(context, snapshot) {
        if (!root || !context || typeof context !== 'object' || disposed) return;
        if (Object.hasOwn(context, 'theme') || snapshot) mode = ['dark', 'light'].includes(context.theme) ? context.theme : undefined;
        if (mode) root.setAttribute('data-theme', mode);
        else if (originalTheme) root.setAttribute('data-theme', originalTheme);
        else root.removeAttribute?.('data-theme');
        if (snapshot) variables = {};
        if (context.styles?.variables === null) variables = {};
        else if (context.styles?.variables && typeof context.styles.variables === 'object') {
          for (const [name, value] of Object.entries(context.styles.variables).slice(0, 512)) {
            if (!/^--[a-zA-Z0-9_-]+$/.test(name)) continue;
            if (typeof value === 'string' && value.trim() && value.length <= 8192) variables[name] = value;
            else delete variables[name];
          }
        }
        if (snapshot || context.styles?.css && Object.hasOwn(context.styles.css, 'fonts')) fonts = typeof context.styles?.css?.fonts === 'string' ? context.styles.css.fonts : undefined;
        let fontStyle = document.getElementById?.('codex-native-host-fonts');
        if (fonts) {
          if (!fontStyle) { fontStyle = document.createElement('style'); fontStyle.id = 'codex-native-host-fonts'; document.head.appendChild(fontStyle); }
          if (fontStyle.textContent !== fonts) fontStyle.textContent = fonts;
        } else fontStyle?.remove();
        const next = JSON.stringify([variables, mode]);
        if (next !== signature) { tokens = resolveTokens(); signature = next; }
        refresh();
      },
      dispose() {
        observer?.disconnect();
        if (attachShadow && elementPrototype.attachShadow === attachShadow) elementPrototype.attachShadow = originalAttachShadow;
        for (const [element, state] of owned) restore(element, state);
        owned.clear();
        document?.getElementById?.('codex-native-host-fonts')?.remove();
        if (originalTheme) root?.setAttribute('data-theme', originalTheme);
        else root?.removeAttribute?.('data-theme');
      },
    };
  })();
  const flushEditor = async () => {
    if (readOnly) return true;
    target.document?.activeElement?.blur?.();
    if (typeof target.__CODEX_DESIGN_EDITOR_FLUSH__ === 'function') {
      if (await target.__CODEX_DESIGN_EDITOR_FLUSH__() !== true) throw new Error('The editor still has unsaved changes.');
    } else {
      const deadline = Date.now() + 8_000;
      while (!target.dispatchEvent(new Event('beforeunload', { cancelable: true }))) {
        if (Date.now() >= deadline) throw new Error('The editor still has unsaved changes.');
        if (pendingWrites.size) await Promise.all([...pendingWrites]);
        else await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    await Promise.all([...pendingWrites]);
    return true;
  };
  target.addEventListener('message', event => {
    const message = event.data;
    if (disposed || event.source !== target.parent || message?.channel !== channel) return;
    if (message.type === 'codex-design:comment-viewport-changed') {
      updateCommentViewport(message.commentViewport);
      return;
    }
    if (message.type === 'codex-design:editor-flush') {
      void (async () => {
        try {
          await flushEditor();
          target.parent.postMessage({ type: 'codex-design:editor-flushed', channel, requestId: message.requestId, saved: true }, '*');
        } catch (error) {
          target.parent.postMessage({ type: 'codex-design:editor-flushed', channel, requestId: message.requestId, saved: false,
            error: { code: 'EDITOR_UNSAVED_CHANGES', message: String(error.message || error) } }, '*');
        }
      })();
      return;
    }
    if (message.type === 'codex-design:editor-history-open') {
      if (typeof message.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.requestId)) return;
      historyOpenId = message.requestId;
      void (async () => {
        try {
          await flushEditor();
          if (disposed || historyOpenId !== message.requestId) return;
          const history = target.__CODEX_DESIGN_NATIVE_HISTORY__;
          if (!history || readOnly) throw new Error('Edit history is not available in this view.');
          const opened = await history.open();
          if (disposed || historyOpenId !== message.requestId) return;
          target.parent.postMessage({ type: 'codex-design:editor-history-opened', channel, requestId: message.requestId, opened: opened === true }, '*');
        } catch (error) {
          if (disposed || historyOpenId !== message.requestId) return;
          target.parent.postMessage({ type: 'codex-design:editor-history-opened', channel, requestId: message.requestId, opened: false,
            error: { code: error.code || 'EDITOR_HISTORY_UNAVAILABLE', message: String(error.message || error) } }, '*');
        }
      })();
      return;
    }
    if (message.type === 'codex-design:editor-history-close') {
      if (message.requestId !== historyOpenId) return;
      historyOpenId = undefined;
      target.__CODEX_DESIGN_NATIVE_HISTORY__?.close?.();
      return;
    }
    if (message.type === 'codex-design:host-context-changed') {
      hostTheme.update(message.context, message.hostContextIsSnapshot === true);
      const styles = { theme: message.context?.theme, styles: message.context?.styles };
      target.__CODEX_DESIGN_EDITOR_TRANSPORT__.hostContext = styles;
      previews?.updateHostContext?.(styles);
      if (message.hostContextIsSnapshot === true || Object.hasOwn(message, 'commentViewport')) updateCommentViewport(message.commentViewport);
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
      if (!/^\/(?:_api(?:\/|$)|_blob\/|_files\.json$|__comments(?:\/|$)|__deck\/|__design(?:-system)?\/|__history(?:\/|$)|__ds\/|project\/|db\/)/.test(url.pathname)) return null;
      return requestPrefix + url.pathname.slice(1) + url.search;
    }
    return requestPrefix + url.pathname.slice(base.pathname.length) + url.search;
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
    const requestedMethod = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (readOnly && !['GET', 'HEAD'].includes(requestedMethod)) throw Object.assign(new Error('Earlier versions are read-only.'), { code: 'EDITOR_PREVIEW_READ_ONLY' });
    const path = relative(url);
    if (path === null) return originalFetch(input, init);
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    if (readOnly && !['GET', 'HEAD'].includes(request.method)) throw Object.assign(new Error('Earlier versions are read-only.'), { code: 'EDITOR_PREVIEW_READ_ONLY' });
    // History remains open while the user edits. Flush again at the actual
    // destructive action, before this restore joins the pending-write barrier.
    if (!['GET', 'HEAD'].includes(request.method) && /^__history\/(?:\d+\/restore|notice\/[^/?]+\/recover)(?:\?|$)/.test(path)) await flushEditor();
    const headers = {};
    for (const name of ['content-type', 'accept', 'if-match', 'if-none-match', 'last-event-id', 'x-filename', 'x-deck-client']) if (request.headers.has(name)) headers[name] = request.headers.get(name);
    let requestBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    if (requestBytes && /(?:^|\/)(?:__deck\/publish|_api\/write)$/.test(path.split('?')[0]) && request.headers.get('content-type')?.includes('application/json')) requestBytes = await preserveAssetReferences(requestBytes);
    const body = requestBytes ? bytesToBase64(requestBytes) : undefined;
    const responseTask = rpc('editor.request', { request: { path, method: request.method, headers, ...(body === undefined ? {} : { body }) } }, init?.signal || request.signal);
    const writing = !['GET', 'HEAD'].includes(request.method);
    if (writing) pendingWrites.add(responseTask);
    let response;
    try { response = await responseTask; }
    finally { if (writing) pendingWrites.delete(responseTask); }
    let responseBytes = base64ToBytes(response.body);
    if (!readOnly && /^__history(?:\/|\?|$)/.test(path) && response.headers?.['content-type']?.includes('application/json')) {
      try {
        const value = JSON.parse(new TextDecoder().decode(responseBytes));
        for (const row of Array.isArray(value.rows) ? value.rows : []) {
          if (typeof row.preview !== 'string') continue;
          const serverPath = configuration.serverPath;
          const route = typeof serverPath === 'string' && row.preview.startsWith(serverPath) ? row.preview.slice(serverPath.length) : row.preview;
          if (/^v\/[1-9][0-9]{0,8}\/$/.test(route)) row.preview = new URL(route, rootBase).href;
          else if (configuration.kind === 'dashboard' && Number.isSafeInteger(row.n) && row.n >= 1 && row.n <= 999999999 && route === `?at=${row.n}`) row.preview = new URL(`v/${row.n}/`, rootBase).href;
        }
        responseBytes = new TextEncoder().encode(JSON.stringify(value));
      } catch { /* Preserve an invalid response so the canonical History UI reports it. */ }
    }
    const result = new Response([101, 204, 205, 304].includes(response.status) || request.method === 'HEAD' ? null : responseBytes, { status: response.status, statusText: response.statusText, headers: response.headers });
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
  const startPreviews = () => {
    if (disposed || readOnly || previews || typeof installPreviews !== 'function' || !target.document?.body) return;
    previews = installPreviews({ target, baseUrl: rootBase.href, rpc, flush: flushEditor });
    const context = target.__CODEX_DESIGN_EDITOR_TRANSPORT__.hostContext;
    if (context) previews?.updateHostContext?.(context);
  };
  if (target.document?.body) startPreviews();
  else target.document?.addEventListener?.('DOMContentLoaded', startPreviews, { once: true });
  if (readOnly && target.document) {
    target.document.addEventListener('click', event => {
      const anchor = event.target?.closest?.('a[href]');
      if (!anchor) return;
      let url; try { url = new URL(anchor.getAttribute('href'), base); } catch { return; }
      if (url.href !== rootBase.href) return;
      event.preventDefault();
      target.parent.postMessage({ type: 'codex-design:preview-close', channel }, '*');
    }, true);
  }
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
  target.addEventListener('unload', () => {
    for (const source of sources) source.close();
    disposed = true;
    target.document?.removeEventListener?.('DOMContentLoaded', startPreviews);
    hostTheme.dispose();
    previews?.dispose?.();
    target.__CODEX_DESIGN_NATIVE_HISTORY__?.dispose?.();
    if (readOnly) delete target.__CODEX_DESIGN_PREVIEW_CLOSE__;
    for (const call of [...pending.values()]) call.reject(Object.assign(new Error('The artwork editor has closed.'), { code: 'EDITOR_CLOSED' }));
  });
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
