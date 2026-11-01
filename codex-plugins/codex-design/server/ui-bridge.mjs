import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { ACTIONS, READ_ACTIONS, UNSUPPORTED_CHAT_CODE, PLUGIN_UI_VERSION } from './contract.mjs';
import { createExportDialog } from '../ui/export-dialog.mjs';

const fail = (message, code) => Object.assign(new Error(message), { code });
const changed = action => !READ_ACTIONS.includes(action) && !action.startsWith('editor.') && !action.startsWith('export.') && action !== 'thumbnail.get';
const artifactRoute = /^\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?[^#]*)?$/i;
const artifactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createMcpBridge({ timeoutMs = 8_000, onInitialResult, exportDialogFactory = createExportDialog, app = new App({ name: 'codex-design', version: PLUGIN_UI_VERSION }) } = {}) {
  const extensions = new OpenAIExtensions(app);
  const listeners = new Set();
  let toolInput;
  let disposed = false;
  let connected = false;
  let descriptorUri;
  let descriptorTask;
  let latestViewState;
  let navigation = Promise.resolve();
  let pendingArtifact;
  let exportDialog;
  const bridge = {
    available: true, transport: 'mcp', uiVersion: PLUGIN_UI_VERSION, supportsInlineEditor: true,
    language: 'en', hostContext: null, initialState: null, capabilities: { actions: [...ACTIONS], canDraftComments: false },
    get canDraftComments() { return connected && !disposed && Boolean(extensions.message); },
    async invoke(action, payload = {}) {
      if (disposed) throw fail('The design library connection has closed.', 'BRIDGE_UNAVAILABLE');
      if (action === 'conversation.send') throw fail('A verified per-artifact native conversation bridge is not available.', UNSUPPORTED_CHAT_CODE);
      const result = await app.callServerTool({ name: READ_ACTIONS.includes(action) ? 'design_read' : 'design_action', arguments: { action, payload } });
      if (result.isError || result.structuredContent?.error) {
        let detail = result.structuredContent?.error;
        if (!detail) { try { detail = JSON.parse(result.content?.find(item => item.type === 'text')?.text); } catch {} }
        throw fail(detail?.message || 'The library request failed.', detail?.code || 'DESIGN_LIBRARY_ERROR');
      }
      const value = result.structuredContent?.result;
      if (action.startsWith('view.') && changed(action)) {
        latestViewState = value;
        bridge.initialState = { ...bridge.initialState, viewState: value };
      }
      if (changed(action)) for (const listener of listeners) listener(action.startsWith('view.')
        ? { type: 'view.changed', viewState: value } : { type: 'library.changed', action, result: value });
      return value;
    },
    async draftComment(request) {
      if (disposed) throw fail('The design library connection has closed.', 'BRIDGE_UNAVAILABLE');
      if (!bridge.canDraftComments) throw fail('This host cannot add design comments to the active chat draft.', 'NATIVE_COMMENT_DRAFT_UNAVAILABLE');
      if (!request || typeof request.requestId !== 'string' || !artifactId.test(request.requestId)
        || typeof request.artifactId !== 'string' || !artifactId.test(request.artifactId)
        || Object.hasOwn(request, 'attemptId') && (typeof request.attemptId !== 'string' || !artifactId.test(request.attemptId))
        || request.uri !== `codex-design://edit-requests/${request.requestId}`
        || typeof request.title !== 'string' || !request.title.trim() || request.title.length > 300
        || typeof request.summary !== 'string' || !request.summary.trim() || request.summary.length > 20_000) {
        throw fail('The immutable design comment request is invalid.', 'INVALID_COMMENT_DRAFT');
      }
      const result = await extensions.message.send({
        role: 'user',
        content: [
          { type: 'text', text: `Apply the attached Codex Design edit request for ${request.title}.\nRequest: ${request.uri}\n${request.summary.slice(0, 1000)}${request.summary.length > 1000 ? '\nRead the attached request for the full comment.' : ''}` },
          { type: 'resource_link', uri: request.uri, name: `edit-request-${request.requestId}.json`, title: request.title, mimeType: 'application/json' },
        ],
        _meta: { 'openai/message': { target: 'active', send: false } },
      });
      if (result.isError) throw fail('The host could not add the design comment to the active chat draft.', 'NATIVE_COMMENT_DRAFT_FAILED');
      return result;
    },
    async downloadArtifact({ filename, text }) {
      return bridge.downloadResource({ filename, mimeType: 'application/json', text });
    },
    async downloadResource({ filename, mimeType, text, base64 }) {
      if (disposed) throw fail('The design library connection has closed.', 'BRIDGE_UNAVAILABLE');
      if (typeof filename !== 'string' || !filename || filename.length > 300 || /[\\/\u0000-\u001f\u007f]/.test(filename)
        || typeof mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9= -]+)?$/i.test(mimeType)
        || (typeof text === 'string') === (typeof base64 === 'string')) throw fail('Invalid artwork download.', 'INVALID_DOWNLOAD');
      if (typeof base64 === 'string' && (base64.length > 180 * 1024 * 1024 || base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64))) throw fail('Invalid artwork download encoding.', 'INVALID_DOWNLOAD');
      exportDialog ??= exportDialogFactory({ invoke: (action, payload) => bridge.invoke(action, payload) });
      const result = await exportDialog.save({ filename, mimeType, ...(text === undefined ? { base64 } : { text }) });
      if (result?.saved !== true || typeof result.path !== 'string' || !result.path) throw fail('The export save result could not be confirmed.', 'EXPORT_UNCONFIRMED');
      return result;
    },
    diagnostics() {
      const host = app.getHostVersion();
      const context = app.getHostContext();
      return { uiVersion: PLUGIN_UI_VERSION, transport: 'mcp',
        host: host ? { name: host.name, version: host.version } : null,
        capabilityNames: Object.keys(app.getHostCapabilities() || {}).sort(),
        theme: context?.theme, locale: context?.locale, displayMode: context?.displayMode,
        styleVariableNames: Object.keys(context?.styles?.variables || {}).sort() };
    },
    subscribe(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    async dispose() { disposed = true; exportDialog?.dispose?.(); bridge.available = false; connected = false; bridge.capabilities.canDraftComments = false; listeners.clear(); app.removeEventListener('hostcontextchanged', onHostContext); await app.close(); },
  };
  const applyContext = () => {
    // SDK listeners receive params directly; the SDK merges each partial patch first.
    const context = app.getHostContext();
    bridge.hostContext = context ?? null;
    bridge.capabilities.canDraftComments = bridge.canDraftComments;
    const root = globalThis.document?.documentElement;
    const host = app.getHostVersion();
    if (root?.setAttribute) {
      root.setAttribute('data-codex-design-version', PLUGIN_UI_VERSION);
      root.setAttribute('data-codex-design-transport', 'mcp');
      if (host?.name) root.setAttribute('data-codex-design-host', host.name);
    }
    if (context?.theme) applyDocumentTheme(context.theme);
    if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
    if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
    bridge.language = 'en';
    for (const listener of listeners) listener({ type: 'host-context.changed', context: bridge.hostContext });
  };
  const reportError = (error, property, fallback) => {
    if (disposed) return;
    bridge[property] = { code: error.code || fallback, message: error.message };
    for (const listener of listeners) listener({ type: 'bridge.error', error: bridge[property] });
  };
  const openArtifact = id => {
    id = id.toLowerCase();
    if (pendingArtifact === id) return navigation;
    pendingArtifact = id;
    const task = navigation.catch(() => {}).then(async () => {
      if (disposed) return;
      if (latestViewState?.activeTabId === id && latestViewState.tabs?.some(tab => tab.artifactId === id)) return latestViewState;
      await bridge.beforeNavigate?.({ action: 'openTab', id });
      return bridge.invoke('view.openTab', { id });
    });
    navigation = task;
    void task.finally(() => { if (navigation === task) pendingArtifact = undefined; }).catch(() => {});
    return task;
  };
  const followDeepLink = async () => {
    if (!connected || disposed) return;
    // The official SDK normalizes current and older host payloads to an app-relative URL.
    const url = extensions.deepLink.getCurrent()?.url;
    const match = typeof url === 'string' ? artifactRoute.exec(url) : null;
    if (!match) return;
    try { await openArtifact(match[1]); }
    catch (error) { reportError(error, 'navigationError', 'ARTIFACT_OPEN_FAILED'); }
  };
  const onHostContext = params => {
    if (disposed) return;
    applyContext();
    if (Object.hasOwn(params, 'openai/deepLink')) void followDeepLink();
  };
  const readDescriptor = () => {
    const file = toolInput?.file ?? bridge.initialState?.file;
    if (!connected || disposed || !file?.resourceUri || !extensions.resources) return;
    if (descriptorUri === file.resourceUri) return descriptorTask;
    descriptorUri = file.resourceUri;
    descriptorTask = (async () => {
      try {
        const resource = await extensions.resources.read({ uri: file.resourceUri, representation: 'text' });
        if (disposed || descriptorUri !== file.resourceUri) return;
        const text = resource.contents.find(item => typeof item.text === 'string')?.text;
        let descriptor;
        try { descriptor = JSON.parse(text); } catch { throw fail('The artwork descriptor is not valid JSON.', 'INVALID_DESCRIPTOR'); }
        if (descriptor?.format !== 'codex-design-descriptor' || descriptor.version !== 1 || typeof descriptor.artifactId !== 'string' || !artifactId.test(descriptor.artifactId)) {
          throw fail('Unsupported Codex Design artwork descriptor.', 'INVALID_DESCRIPTOR');
        }
        await openArtifact(descriptor.artifactId);
      } catch (error) {
        reportError(error, 'fileError', 'FILE_OPEN_FAILED');
      }
    })();
    return descriptorTask;
  };
  app.addEventListener('hostcontextchanged', onHostContext);
  app.onteardown = async () => {
    await bridge.beforeNavigate?.({ action: 'teardown' });
    exportDialog?.dispose?.(); exportDialog = undefined;
    return {};
  };
  app.ontoolinput = ({ arguments: args }) => { toolInput = args; void readDescriptor(); };
  app.ontoolresult = result => {
    if (disposed) return;
    bridge.initialState = result.structuredContent ?? null;
    if (latestViewState) bridge.initialState = { ...bridge.initialState, viewState: latestViewState };
    if (bridge.initialState?.capabilities) bridge.capabilities = { ...bridge.initialState.capabilities, canDraftComments: bridge.canDraftComments };
    onInitialResult?.(bridge.initialState);
    for (const listener of listeners) listener({ type: 'initial-state', result: bridge.initialState });
    void readDescriptor();
  };
  let timer;
  try {
    await Promise.race([app.connect(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('The host did not establish the MCP App connection.', 'BRIDGE_UNAVAILABLE')), timeoutMs); })]);
  } catch (error) { await bridge.dispose().catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
  connected = true;
  applyContext();
  // Initialization does not emit hostcontextchanged. Read the initial route explicitly.
  await followDeepLink();
  await readDescriptor();
  return bridge;
}

export async function installMcpBridge(options) {
  // A standalone preview has no MCP parent; never leave it waiting on a handshake.
  if (window.parent === window) return null;
  const bridge = await createMcpBridge(options);
  window.codexDesignBridge = bridge;
  if (typeof window.installCodexDesignBridge === 'function') await window.installCodexDesignBridge(bridge);
  else window.dispatchEvent(new CustomEvent('codex-design:bridge-ready', { detail: { bridge } }));
  return bridge;
}
