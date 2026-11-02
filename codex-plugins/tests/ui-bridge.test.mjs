import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { App } from '@modelcontextprotocol/ext-apps';
import { createMcpBridge, installMcpBridge } from '../source/server/ui-bridge.mjs';
import { PLUGIN_UI_VERSION } from '../source/server/contract.mjs';
import { createExportDialog } from '../source/ui/export-dialog.mjs';
import { artworkAppUrl, requestAppNavigation } from '../source/scripts/artifact-delivery.mjs';

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

function host(t, { context = {}, initialState, file, descriptor, onCall, onMessage, hostCapabilities = { experimental: { 'openai/resource': {} } } } = {}) {
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
          hostCapabilities, hostContext: context,
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
        if (message.method === 'ui/message') return onMessage ? onMessage(message.params) : {};
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

const commentDraft = {
  requestId: '33333333-3333-4333-8333-333333333333', artifactId: firstId,
  uri: 'codex-design://edit-requests/33333333-3333-4333-8333-333333333333',
  title: 'Nimbus', summary: 'Increase the heading contrast.',
};

test('native comments append an immutable request to the active editable draft without generating a response', async t => {
  const f = host(t, { hostCapabilities: { experimental: { 'openai/message': {} } },
    initialState: { capabilities: { actions: ['editor.request'] } } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  assert.equal(bridge.canDraftComments, true);
  assert.equal(bridge.capabilities.canDraftComments, true);
  assert.deepEqual(bridge.capabilities.actions, ['editor.request']);
  await bridge.draftComment({ ...commentDraft, attemptId: secondId });
  assert.deepEqual(f.requests.filter(request => request.method === 'ui/message').map(request => request.params), [{
    role: 'user',
    content: [
      { type: 'text', text: `Apply the attached Codex Design edit request for Nimbus.\nRequest: ${commentDraft.uri}\nIncrease the heading contrast.` },
      { type: 'resource_link', uri: commentDraft.uri, name: `edit-request-${commentDraft.requestId}.json`, title: 'Nimbus', mimeType: 'application/json' },
    ],
    _meta: { 'openai/message': { target: 'active', send: false } },
  }]);
  assert.equal(f.calls().length, 0);
  assert.equal(f.requests.some(request => request.method === 'sampling/createMessage' || request.method === 'ui/update-model-context'), false);
  await bridge.dispose();
  assert.equal(bridge.canDraftComments, false);
  assert.equal(bridge.capabilities.canDraftComments, false);
  await assert.rejects(bridge.draftComment(commentDraft), { code: 'BRIDGE_UNAVAILABLE' });
});

test('each native draft retains its own immutable URI in visible text before a bounded long comment', async t => {
  const f = host(t, { hostCapabilities: { experimental: { 'openai/message': {} } } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  const longSummary = 'Distinct comment content. '.repeat(80) + 'UNABRIDGED-COMMENT-END';
  const drafts = [commentDraft, { ...commentDraft, requestId: secondId,
    uri: `codex-design://edit-requests/${secondId}`, summary: longSummary }];
  for (const draft of drafts) await bridge.draftComment(draft);
  const messages = f.requests.filter(request => request.method === 'ui/message').map(request => request.params);
  assert.equal(messages.length, 2);
  for (const [index, message] of messages.entries()) {
    const visible = message.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const attachment = message.content.find(item => item.type === 'resource_link');
    const uriLine = visible.match(/^Request: (codex-design:\/\/edit-requests\/[0-9a-f-]+)$/m);
    assert.equal(uriLine?.[1], drafts[index].uri);
    assert.equal(attachment.uri, uriLine[1]);
    assert.equal(attachment.name, `edit-request-${drafts[index].requestId}.json`);
    assert.ok(visible.indexOf(uriLine[0]) < visible.indexOf(drafts[index].summary.slice(0, 60)));
    assert.deepEqual(message._meta, { 'openai/message': { target: 'active', send: false } });
  }
  assert.notEqual(messages[0].content[0].text, messages[1].content[0].text);
  assert.ok(messages[1].content[0].text.includes(longSummary.slice(0, 1000)));
  assert.ok(!messages[1].content[0].text.includes('UNABRIDGED-COMMENT-END'));
  assert.match(messages[1].content[0].text, /Read the attached request for the full comment\.$/);
  assert.ok(messages[1].content[0].text.length < 1300);
  assert.equal(f.calls().length, 0);
  assert.equal(f.requests.some(request => request.method === 'sampling/createMessage' || request.method === 'ui/update-model-context'), false);
});

test('native draft capability requires the negotiated OpenAI message extension and never falls back', async t => {
  const f = host(t, { initialState: { capabilities: { actions: ['editor.request'], canDraftComments: true } } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  assert.equal(bridge.canDraftComments, false);
  assert.equal(bridge.capabilities.canDraftComments, false);
  await assert.rejects(bridge.draftComment(commentDraft), { code: 'NATIVE_COMMENT_DRAFT_UNAVAILABLE' });
  assert.equal(f.requests.some(request => request.method === 'ui/message' || request.method === 'ui/open-link' || request.method === 'sampling/createMessage'), false);
  assert.equal(f.calls().length, 0);
});

test('native draft links reject mutable or mismatched request resources before asking the host', async t => {
  const f = host(t, { hostCapabilities: { experimental: { 'openai/message': {} } } });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  for (const patch of [
    { requestId: '' }, { requestId: 'arbitrary' }, { artifactId: '' },
    { attemptId: '' }, { attemptId: 'arbitrary' }, { attemptId: null }, { attemptId: undefined },
    { uri: commentDraft.uri + '?latest=true' }, { uri: commentDraft.uri + '#comment' },
    { uri: 'codex-design://edit-requests/' + secondId },
    { uri: 'https://example.com/' }, { title: '' }, { summary: '' },
  ]) await assert.rejects(bridge.draftComment({ ...commentDraft, ...patch }), { code: 'INVALID_COMMENT_DRAFT' });
  assert.equal(f.requests.some(request => request.method === 'ui/message'), false);
});

test('a declined native draft returns an error without a fallback send or generation', async t => {
  const f = host(t, { hostCapabilities: { experimental: { 'openai/message': {} } }, onMessage: () => ({ isError: true }) });
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.draftComment(commentDraft), { code: 'NATIVE_COMMENT_DRAFT_FAILED' });
  assert.equal(f.requests.filter(request => request.method === 'ui/message').length, 1);
  assert.equal(f.calls().length, 0);
  assert.equal(f.requests.some(request => request.method === 'sampling/createMessage' || request.method === 'ui/open-link'), false);
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

test('independent OS opens bypass host target deduplication and reopen the same closed artwork without duplicating an active tab', async t => {
  const f = host(t);
  const bridge = await createMcpBridge({ app: f.app });
  t.after(() => bridge.dispose());
  let lastHostTarget;
  const sentUris = [];
  const deliver = uri => {
    const relative = new URL(new URL(uri).searchParams.get('path'), 'https://codex-design.invalid');
    const target = { path: relative.pathname.slice(1).split('/'), query: [...relative.searchParams] };
    // The real host compares the app-relative path/query, independently of our
    // internal workspace. Repeating that target emits no context notification.
    const identity = JSON.stringify([target.path, target.query]);
    if (identity === lastHostTarget) return false;
    lastHostTarget = identity;
    f.context({ 'openai/deepLink': target });
    return true;
  };
  const canonical = artworkAppUrl(firstId);
  const open = () => requestAppNavigation(canonical, { platform: 'linux', spawnProcess(_command, args) {
    sentUris.push(args[0]);
    deliver(args[0]);
    const child = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('close', 0)); return child;
  } });
  await open();
  await until(() => bridge.initialState?.viewState?.activeTabId === firstId);
  await bridge.invoke('view.closeTab', { id: firstId });
  assert.equal(bridge.initialState.viewState.activeTabId, 'library');
  assert.equal(deliver(sentUris[0]), false, 'A repeated old OS target reproduces the host deduplication.');
  await delay(10);
  assert.equal(bridge.initialState.viewState.activeTabId, 'library');
  await open();
  await until(() => bridge.initialState.viewState.activeTabId === firstId);
  assert.notEqual(sentUris[0], sentUris[1]);
  assert.equal(new URL(canonical).searchParams.get('path'), `/artifacts/${firstId}`);
  assert.deepEqual(bridge.initialState.viewState.tabs.map(tab => tab.id), ['library', firstId]);
  assert.deepEqual(f.calls().filter(call => call.params.arguments.action === 'view.openTab').map(call => call.params.arguments.payload), [{ id: firstId }, { id: firstId }]);
  let guarded = 0;
  bridge.beforeNavigate = async () => { guarded++; };
  await open();
  await delay(10);
  assert.equal(guarded, 0, 'Reopening an already active artwork must not reload it or disturb live edits.');
  assert.equal(f.calls().filter(call => call.params.arguments.action === 'view.openTab').length, 2);
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

test('library and editor downloads share Save As and never invoke host downloads or refresh library while browsing', async t => {
  let handlers, model;
  const f = host(t, { hostCapabilities: {}, onCall: ({ arguments: { action, payload } }) => {
    if (action === 'export.locations') return resultFor({ locations: [{ id: 'home', label: 'Home', path: '/export' }], defaultDirectory: '/export' });
    if (action === 'export.listDirectory') return resultFor({ path: payload.path, parent: '/', entries: [] });
    if (action === 'export.save') return resultFor({ saved: true, path: '/export/' + payload.filename, filename: payload.filename, bytes: 4 });
    throw new Error('Unexpected export action: ' + action);
  } });
  const bridge = await createMcpBridge({ app: f.app, exportDialogFactory: ({ invoke }) => createExportDialog({ invoke,
    viewFactory(value) { handlers = value; return { render(value) { model = value; }, close() {}, destroy() {} }; },
  }) });
  t.after(() => bridge.dispose());
  const changes = []; bridge.subscribe(event => changes.push(event));
  const exports = [
    { filename: 'Library.codexdesign.json', mimeType: 'application/json', text: '{}' },
    { filename: 'Slides.pdf', mimeType: 'application/pdf', base64: 'JVBERg==' },
    { filename: 'Slides.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', base64: 'UEsDBA==' },
    { filename: 'Design.png', mimeType: 'image/png', base64: 'iVBORw==' },
    { filename: 'System.zip', mimeType: 'application/zip', base64: 'UEsDBA==' },
    { filename: 'Dashboard.html', mimeType: 'text/html', text: '<!doctype html>' },
  ];
  for (const value of exports) {
    const pending = value.filename.endsWith('.codexdesign.json') ? bridge.downloadArtifact(value) : bridge.downloadResource(value);
    await until(() => model?.filename === value.filename && !model.loading);
    handlers.onAction('save'); await until(() => Boolean(model.result));
    assert.equal(model.result.path, '/export/' + value.filename);
    handlers.onAction('done'); assert.equal((await pending).saved, true);
  }
  assert.equal(changes.length, 0, 'export browsing/writes are not library mutations');
  assert.equal(f.requests.some(request => request.method === 'ui/download-file' || request.method === 'ui/open-link'), false);
  const saves = f.calls().filter(call => call.params.arguments.action === 'export.save');
  assert.equal(saves.length, exports.length);
  assert.equal(saves.every(call => call.params.name === 'design_action'), true);
  assert.deepEqual(saves.map(call => call.params.arguments.payload.filename), exports.map(value => value.filename));
  assert.equal(saves[0].params.arguments.payload.text, '{}');
});

test('Save As cancellation rejects the native download without any save or legacy fallback', async t => {
  let handlers, ready = false;
  const f = host(t, { onCall: ({ arguments: { action } }) => resultFor(action === 'export.locations'
    ? { locations: [], defaultDirectory: null } : null) });
  const bridge = await createMcpBridge({ app: f.app, exportDialogFactory: ({ invoke }) => createExportDialog({ invoke,
    viewFactory(value) { handlers = value; return { render(model) { ready = !model.loading; }, close() {}, destroy() {} }; },
  }) });
  t.after(() => bridge.dispose());
  const pending = bridge.downloadResource({ filename: 'Report.pdf', mimeType: 'application/pdf', base64: 'JVBERg==' });
  pending.catch(() => {}); await until(() => ready); handlers.onAction('cancel');
  await assert.rejects(pending, { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(f.calls().some(call => call.params.arguments.action === 'export.save'), false);
  assert.equal(f.requests.some(request => request.method === 'ui/download-file'), false);
});

test('bridge disposal closes active and queued Save As requests before user Save', async t => {
  let renders = 0, destroyed = false;
  const f = host(t, { onCall: () => resultFor({ locations: [], defaultDirectory: null }) });
  const bridge = await createMcpBridge({ app: f.app, exportDialogFactory: ({ invoke }) => createExportDialog({ invoke,
    viewFactory() { return { render() { renders++; }, close() {}, destroy() { destroyed = true; } }; },
  }) });
  const first = bridge.downloadArtifact({ filename: 'One.json', text: '{}' }), second = bridge.downloadArtifact({ filename: 'Two.json', text: '{}' });
  first.catch(() => {}); second.catch(() => {}); await until(() => renders > 0);
  await bridge.dispose();
  await assert.rejects(first, { code: 'DOWNLOAD_CANCELLED' }); await assert.rejects(second, { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(destroyed, true);
  assert.equal(f.calls().some(call => call.params.arguments.action === 'export.save'), false);
});
