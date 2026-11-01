import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '@modelcontextprotocol/ext-apps';
import { createMcpBridge } from '../source/server/ui-bridge.mjs';

async function fixture(t, { downloadSupported = false, exportSupported = true, cancelled = false } = {}) {
  const app = new App({ name: 'download-test', version: '1' }, {}, { autoResize: false, strict: true });
  const requests = [], choices = [];
  const transport = {
    async start() {}, async close() { transport.onclose?.(); },
    async send(message) {
      requests.push(message);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'ui/initialize') result = { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' },
        hostCapabilities: downloadSupported ? { downloadFile: {} } : {}, hostContext: {} };
      if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'design_action');
        assert.equal(message.params.arguments.action, 'export.save');
        const payload = message.params.arguments.payload;
        result = exportSupported ? { content: [], structuredContent: { result: { saved: true, path: '/selected/' + payload.filename, filename: payload.filename,
          bytes: payload.text === undefined ? Buffer.from(payload.base64, 'base64').byteLength : Buffer.byteLength(payload.text) } } }
          : { isError: true, content: [], structuredContent: { error: { code: 'EXPORT_UNAVAILABLE', message: 'Save As is unavailable.' } } };
      }
      assert.ok(result, 'Only initialization and the app-only export API are used.');
      queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
    },
  };
  const connect = app.connect.bind(app); app.connect = () => connect(transport);
  const bridge = await createMcpBridge({ app, exportDialogFactory: ({ invoke }) => ({
    async save(resource) {
      choices.push(resource);
      if (cancelled) throw Object.assign(new Error('Export cancelled.'), { code: 'DOWNLOAD_CANCELLED' });
      // The chooser is injected here; no filesystem operation or native UI runs.
      return invoke('export.save', { ...resource, directory: '/selected', requestId: '11111111-1111-4111-8111-111111111111' });
    },
    dispose() {},
  }) });
  t.after(() => bridge.dispose());
  return { bridge, choices, saves: () => requests.filter(item => item.method === 'tools/call'), legacyDownloads: () => requests.filter(item => item.method === 'ui/download-file') };
}

test('native library exports pass content-only text to Save As and return the actual selected path', async t => {
  const { bridge, choices, saves, legacyDownloads } = await fixture(t);
  const result = await bridge.downloadArtifact({ filename: '示例.codexdesign.json', text: '{"format":"codex-design-artifact"}' });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].mimeType, 'application/json');
  assert.equal(choices[0].filename, '示例.codexdesign.json');
  assert.equal(choices[0].text, '{"format":"codex-design-artifact"}');
  assert.equal(saves()[0].params.arguments.payload.directory, '/selected');
  assert.equal(result.saved, true); assert.equal(result.path, '/selected/示例.codexdesign.json');
  assert.equal(legacyDownloads().length, 0);
});

test('unavailable Save As and user cancellation fail visibly without a host-download fallback', async t => {
  const unsupported = await fixture(t, { exportSupported: false, downloadSupported: true });
  await assert.rejects(unsupported.bridge.downloadArtifact({ filename: 'Export.json', text: '{}' }), { code: 'EXPORT_UNAVAILABLE' });
  assert.equal(unsupported.legacyDownloads().length, 0);
  const cancelled = await fixture(t, { cancelled: true, downloadSupported: true });
  await assert.rejects(cancelled.bridge.downloadArtifact({ filename: 'Export.json', text: '{}' }), { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(cancelled.saves().length, 0);
  assert.equal(cancelled.legacyDownloads().length, 0);
});

test('editor binary exports share Save As without changing bytes, MIME or the suggested filename', async t => {
  const { bridge, choices, legacyDownloads } = await fixture(t);
  const original = Buffer.from('%PDF-1.7\nBinary export\0\xff', 'latin1');
  const result = await bridge.downloadResource({ filename: '幻灯片.pdf', mimeType: 'application/pdf', base64: original.toString('base64') });
  assert.equal(choices[0].mimeType, 'application/pdf'); assert.equal(choices[0].text, undefined);
  assert.deepEqual(Buffer.from(choices[0].base64, 'base64'), original);
  assert.equal(result.path, '/selected/幻灯片.pdf');
  await assert.rejects(bridge.downloadResource({ filename: '../bad.pdf', mimeType: 'application/pdf', base64: 'AAAA' }), { code: 'INVALID_DOWNLOAD' });
  assert.equal(choices.length, 1); assert.equal(legacyDownloads().length, 0);
});
