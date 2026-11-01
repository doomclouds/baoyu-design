import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '@modelcontextprotocol/ext-apps';
import { createMcpBridge, installMcpBridge } from '../source/server/ui-bridge.mjs';
import { PLUGIN_UI_VERSION } from '../source/server/contract.mjs';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const libraryView = { version: 1, tabs: [{ id: 'library', type: 'library' }], activeTabId: 'library' };
const artifactView = id => ({ ...libraryView, tabs: [...libraryView.tabs, { id, type: 'artifact', artifactId: id }], activeTabId: id });
const resultFor = value => ({ content: [], structuredContent: { result: value } });

async function until(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('The expected bridge event did not arrive.');
    await delay(5);
  }
}

function host(t, { context = {}, initialState, file, descriptor, onCall } = {}) {
  const app = new App({ name: 'ui-bridge-test', version: '1' }, {}, { autoResize: false, strict: true });
  const requests = [];
  const notify = (method, params) => transport.onmessage?.({ jsonrpc: '2.0', method, params });
  const transport = {
    async start() {},
    async close() { transport.onclose?.(); },
    async send(message) {
      requests.push(message);
      if (message.id === undefined) {
        if (message.method === 'ui/notifications/initialized') {
          if (file) notify('ui/notifications/tool-input', { arguments: { file } });
          if (initialState) notify('ui/notifications/tool-result', { content: [], structuredContent: initialState });
        }
        return;
      }
      const response = async () => {
        if (message.method === 'ui/initialize') return {
          protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' },
          hostCapabilities: { experimental: { 'openai/resource': {} } }, hostContext: context,
        };
        if (message.method === 'resources/read') return {
          contents: [{ uri: file.resourceUri, mimeType: 'application/json', text: JSON.stringify(descriptor) }],
        };
        if (message.method === 'tools/call') {
          if (onCall) return onCall(message.params);
          const { action, payload } = message.params.arguments;
          if (action === 'view.openTab') return resultFor(artifactView(payload.id));
          if (action === 'view.closeTab') return resultFor(libraryView);
        }
        throw new Error(`Unexpected host request: ${message.method}`);
      };
      void response().then(result => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }),
        error => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } }));
    },
  };
  const connect = app.connect.bind(app);
  app.connect = () => connect(transport);
  t.after(() => app.close());
  return {
    app, requests, notify,
    calls: () => requests.filter(request => request.method === 'tools/call'),
    context: patch => notify('ui/notifications/host-context-changed', patch),
  };
}

test('a native bridge declares its UI version and becomes unavailable before disposal completes', async t => {
  const f = host(t);
  const bridge = await createMcpBridge({ app: f.app });
  assert.equal(bridge.transport, 'mcp');
  assert.equal(bridge.uiVersion, PLUGIN_UI_VERSION);
  assert.equal(bridge.supportsInlineEditor, true);
  assert.equal(bridge.available, true);
  assert.equal(bridge.diagnostics().uiVersion, PLUGIN_UI_VERSION);
  const closing = bridge.dispose();
  assert.equal(bridge.available, false);
  await closing;
  await assert.rejects(bridge.invoke('view.get'), { code: 'BRIDGE_UNAVAILABLE' });
});

test('host locale stays unchanged in context while the plugin UI remains English-only', async t => {
  const f = host(t, { context: { locale: 'zh-CN' } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  assert.equal(bridge.hostContext.locale, 'zh-CN');
  assert.equal(bridge.language, 'en');
  assert.deepEqual(bridge.diagnostics().host, { name: 'test-host', version: '1' });
  assert.equal(bridge.diagnostics().transport, 'mcp');
  const params = [], events = [];
  f.app.addEventListener('hostcontextchanged', value => params.push(value));
  bridge.subscribe(event => events.push(event));
  f.context({ locale: 'en-GB' });
  await until(() => bridge.hostContext.locale === 'en-GB');
  f.context({ displayMode: 'fullscreen' });
  await until(() => params.length === 2);
  assert.deepEqual(params, [{ locale: 'en-GB' }, { displayMode: 'fullscreen' }]);
  assert.equal(bridge.language, 'en');
  assert.deepEqual(bridge.hostContext, { locale: 'en-GB', displayMode: 'fullscreen' });
  assert.deepEqual(events.filter(event => event.type === 'host-context.changed').map(event => event.context), [
    { locale: 'en-GB' }, { locale: 'en-GB', displayMode: 'fullscreen' },
  ]);
  assert.equal(events.filter(event => event.type === 'language.changed').length, 0);
  assert.deepEqual(events.filter(event => event.type === 'language.changed'), []);
  assert.equal(f.calls().length, 0);
});

test('initial deep link survives early and late initial results without duplicate tab requests', async t => {
  const f = host(t, { context: { 'openai/deepLink': { url: `/artifacts/${firstId}` } }, initialState: { artifacts: [], viewState: libraryView } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  assert.equal(bridge.initialState.viewState.activeTabId, firstId);
  assert.deepEqual(f.calls().map(call => call.params.arguments), [{ action: 'view.openTab', payload: { id: firstId } }]);
  const events = [];
  bridge.subscribe(event => events.push(event));
  f.notify('ui/notifications/tool-result', { content: [], structuredContent: { artifacts: [{ id: firstId }], viewState: libraryView } });
  f.context({ displayMode: 'fullscreen' });
  f.context({ 'openai/deepLink': { url: `/artifacts/${firstId}` } });
  await until(() => events.some(event => event.type === 'initial-state'));
  await delay(10);
  assert.equal(bridge.initialState.viewState.activeTabId, firstId);
  assert.equal(events.find(event => event.type === 'initial-state').result.viewState.activeTabId, firstId);
  assert.equal(f.calls().length, 1);
});

test('deep link activations are serialized and can reopen a manually closed artwork tab', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = host(t, { onCall: async ({ arguments: { action, payload } }) => {
    if (action === 'view.openTab') {
      if (payload.id === firstId) await gate;
      return resultFor(artifactView(payload.id));
    }
    return resultFor(libraryView);
  } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  f.context({ 'openai/deepLink': { url: `/artifacts/${firstId}` } });
  await until(() => f.calls().length === 1);
  f.context({ 'openai/deepLink': { url: `/artifacts/${secondId}?view=canvas` } });
  await delay(10);
  assert.equal(f.calls().length, 1);
  release();
  await until(() => bridge.initialState?.viewState?.activeTabId === secondId);
  assert.deepEqual(f.calls().map(call => call.params.arguments.payload.id), [firstId, secondId]);
  await bridge.invoke('view.closeTab', { id: secondId });
  f.context({ 'openai/deepLink': { url: `/artifacts/${secondId}` } });
  await until(() => bridge.initialState.viewState.activeTabId === secondId);
  assert.equal(f.calls().filter(call => call.params.arguments.action === 'view.openTab').length, 3);
});

test('only current-app artifact routes are accepted; URLs, fragments and traversal never dispatch', async t => {
  const f = host(t);
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  for (const url of [
    `https://example.com/artifacts/${firstId}`, `//example.com/artifacts/${firstId}`,
    `codex://plugins/other/app/Open?path=/artifacts/${firstId}`, `/artifacts/${firstId}#comment`,
    `/elsewhere/../artifacts/${firstId}`, `/artifacts/${firstId}/../${secondId}`,
    `/artifacts/%2e%2e`, `/artifacts/not-a-uuid`, `/artifacts/${firstId}/extra`,
  ]) f.context({ 'openai/deepLink': { url } });
  await delay(10);
  assert.equal(f.calls().length, 0);
  assert.equal(f.requests.some(request => request.method === 'ui/message' || request.method === 'ui/open-link'), false);
  await assert.rejects(bridge.invoke('conversation.send', { id: firstId, text: 'Do not send' }), { code: 'NATIVE_EDIT_CHAT_UNAVAILABLE' });
});

test('official SDK normalizes older deep-link host payloads and reports failed artwork opens', async t => {
  const f = host(t, { context: { 'openai/deepLink': { path: ['artifacts', firstId.toUpperCase()], query: [] } },
    onCall: async () => ({ isError: true, content: [], structuredContent: { error: { code: 'NOT_FOUND', message: 'Artwork is missing.' } } }) });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  assert.equal(f.calls()[0].params.arguments.payload.id, firstId);
  assert.deepEqual(bridge.navigationError, { code: 'NOT_FOUND', message: 'Artwork is missing.' });
  assert.equal(bridge.initialState, null);
});

test('file entrypoint reads its granted descriptor once and preserves the opened tab in initial state', async t => {
  const file = { name: 'Nimbus.codexdesign', resourceUri: 'codex-resource://test-grant' };
  const f = host(t, { file, descriptor: { format: 'codex-design-descriptor', version: 1, artifactId: firstId },
    initialState: { entrypoint: 'file', file, artifacts: [], viewState: libraryView } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  f.notify('ui/notifications/tool-input', { arguments: { file } });
  f.notify('ui/notifications/tool-result', { content: [], structuredContent: { file, viewState: libraryView } });
  await delay(10);
  assert.equal(f.requests.filter(request => request.method === 'resources/read').length, 1);
  assert.equal(f.calls().length, 1);
  assert.equal(bridge.initialState.viewState.activeTabId, firstId);
});

test('installation mounts once; later context and tool-result events update the bridge only', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let mounts = 0;
  const fakeWindow = { parent: {}, installCodexDesignBridge: async () => { mounts++; } };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  t.after(() => original ? Object.defineProperty(globalThis, 'window', original) : delete globalThis.window);
  const f = host(t, { initialState: { artifacts: [], viewState: libraryView } });
  const bridge = await installMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  f.context({ 'openai/deepLink': { url: `/artifacts/${firstId}` } });
  f.notify('ui/notifications/tool-result', { content: [], structuredContent: { artifacts: [], viewState: libraryView } });
  await until(() => bridge.initialState?.viewState?.activeTabId === firstId);
  assert.equal(mounts, 1);
  assert.equal(fakeWindow.codexDesignBridge, bridge);
});

test('an external artwork deep link keeps the current editor open when its unsaved navigation guard fails', async t => {
  const f = host(t, { initialState: { artifacts: [], viewState: artifactView(firstId) } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  bridge.beforeNavigate = async () => { throw Object.assign(new Error('Still saving.'), { code: 'EDITOR_UNSAVED_CHANGES' }); };
  f.context({ 'openai/deepLink': { url: `/artifacts/${secondId}` } });
  await until(() => bridge.navigationError?.code === 'EDITOR_UNSAVED_CHANGES');
  assert.equal(f.calls().length, 0);
  assert.equal(bridge.initialState.viewState.activeTabId, firstId);
});
