import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '@modelcontextprotocol/ext-apps';
import { createMcpBridge } from '../source/server/ui-bridge.mjs';

async function fixture(t, { supported = true, denied = false } = {}) {
  const app = new App({ name: 'download-test', version: '1' }, {}, { autoResize: false, strict: true });
  const requests = [];
  const transport = {
    async start() {}, async close() { transport.onclose?.(); },
    async send(message) {
      requests.push(message);
      if (message.id === undefined) return;
      const result = message.method === 'ui/initialize'
        ? { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' }, hostCapabilities: supported ? { downloadFile: {} } : {}, hostContext: {} }
        : message.method === 'ui/download-file' ? { isError: denied } : null;
      assert.ok(result, 'Only public initialization and download requests are used.');
      queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
    },
  };
  const connect = app.connect.bind(app); app.connect = () => connect(transport);
  const bridge = await createMcpBridge({ app });
  t.after(() => bridge.dispose());
  return { bridge, downloads: () => requests.filter(item => item.method === 'ui/download-file') };
}

test('native exports use the public host download capability with one content-only embedded resource', async t => {
  const { bridge, downloads } = await fixture(t);
  await bridge.downloadArtifact({ filename: '示例.codexdesign.json', text: '{"format":"codex-design-artifact"}' });
  assert.equal(downloads().length, 1);
  const resource = downloads()[0].params.contents[0];
  assert.equal(resource.type, 'resource'); assert.equal(resource.resource.mimeType, 'application/json');
  assert.equal(decodeURIComponent(new URL(resource.resource.uri).pathname), '/示例.codexdesign.json');
  assert.equal(resource.resource.text, '{"format":"codex-design-artifact"}');
});

test('unsupported and cancelled native downloads fail visibly instead of claiming a sandboxed Blob download succeeded', async t => {
  const unsupported = await fixture(t, { supported: false });
  await assert.rejects(unsupported.bridge.downloadArtifact({ filename: 'Export.json', text: '{}' }), { code: 'DOWNLOAD_UNAVAILABLE' });
  assert.equal(unsupported.downloads().length, 0);
  const denied = await fixture(t, { denied: true });
  await assert.rejects(denied.bridge.downloadArtifact({ filename: 'Export.json', text: '{}' }), { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(denied.downloads().length, 1);
});

test('original editor binary exports are downloaded through the same host bridge without changing bytes', async t => {
  const { bridge, downloads } = await fixture(t);
  const original = Buffer.from('%PDF-1.7\nBinary export\0\xff', 'latin1');
  await bridge.downloadResource({ filename: '幻灯片.pdf', mimeType: 'application/pdf', base64: original.toString('base64') });
  const resource = downloads()[0].params.contents[0].resource;
  assert.equal(resource.mimeType, 'application/pdf'); assert.equal(resource.text, undefined);
  assert.deepEqual(Buffer.from(resource.blob, 'base64'), original);
  await assert.rejects(bridge.downloadResource({ filename: '../bad.pdf', mimeType: 'application/pdf', base64: 'AAAA' }), { code: 'INVALID_DOWNLOAD' });
  assert.equal(downloads().length, 1);
});
