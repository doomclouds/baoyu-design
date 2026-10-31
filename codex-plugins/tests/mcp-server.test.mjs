import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fileUri, referenceUri } from '../source/server/contract.mjs';

const pluginBuildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function session(t, { spike = false } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-mcp-test-'));
  const libraryRoot = path.join(temporary, 'library');
  const runner = path.join(temporary, 'runner.mjs');
  const moduleUrl = relative => pathToFileURL(path.join(pluginBuildRoot, relative)).href;
  await fs.writeFile(runner, spike
    ? `import {serveStdio} from ${JSON.stringify(moduleUrl('node_modules/@modelcontextprotocol/server/dist/stdio.mjs'))};\nimport {createSpikeServer} from ${JSON.stringify(moduleUrl('source/server/spike.mjs'))};\nserveStdio(createSpikeServer);\n`
    : `import {serveStdio} from ${JSON.stringify(moduleUrl('node_modules/@modelcontextprotocol/server/dist/stdio.mjs'))};\nimport {createDesignServer,nativeActivity} from ${JSON.stringify(moduleUrl('source/server/register.mjs'))};\nimport {createLibraryStore} from ${JSON.stringify(moduleUrl('source/library/index.mjs'))};\nserveStdio(()=>createDesignServer({store:createLibraryStore({root:${JSON.stringify(libraryRoot)},isBusy:nativeActivity}),html:'<!doctype html><html><body>test UI</body></html>',icons:[],editorOpen:async record=>({url:'http://127.0.0.1:7443/editor/',artifactId:record.id,nativeConversationBound:false})}));\n`);
  const child = spawn(process.execPath, [runner], { cwd: temporary, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', next = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      const call = pending.get(message.id);
      if (!call) continue;
      clearTimeout(call.timer); pending.delete(message.id);
      message.error ? call.reject(Object.assign(new Error(message.error.message), { rpcError: message.error })) : call.resolve(message.result);
    }
  });
  child.once('exit', code => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(`MCP exited ${code}: ${stderr}`)); } pending.clear(); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    for (const call of pending.values()) clearTimeout(call.timer);
    const exited = new Promise(resolve => child.once('close', resolve));
    child.stdin.end(); child.kill();
    if (child.exitCode === null && child.signalCode === null) await exited;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codex-design-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = (action, payload = {}, tool = 'design_action') => rpc('tools/call', { name: tool, arguments: { action, payload } });
  const value = async (action, payload, tool) => { const result = await call(action, payload, tool); assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent.result; };
  return { rpc, call, value, initialized, libraryRoot };
}

test('global/file entries use app-only UI; ordinary model tools never attach a panel', async t => {
  const f = await session(t);
  const { tools } = await f.rpc('tools/list', {});
  for (const name of ['DesignLibrary', 'DesignFile']) assert.deepEqual(tools.find(tool => tool.name === name)._meta.ui.visibility, ['app']);
  assert.deepEqual(tools.find(tool => tool.name === 'DesignFile')._meta['openai/ui'].entrypoints, [{ type: 'file', extensions: ['.codexdesign'] }]);
  assert.deepEqual(tools.find(tool => tool.name === 'DesignLibrary')._meta['openai/ui'].entrypoints, [{ type: 'global' }]);
  for (const name of ['design_read', 'design_action', 'search_mentions']) {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool);
    assert.equal(tool._meta?.ui?.resourceUri, undefined);
    assert.equal(tool._meta?.['openai/outputTemplate'], undefined);
  }
  assert.equal(tools.find(tool => tool.name === 'search_mentions').annotations.readOnlyHint, true);
  const resources = await f.rpc('resources/list', {});
  assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), ['ui://codex-design/file', 'ui://codex-design/library']);
  const resource = (await f.rpc('resources/read', { uri: 'ui://codex-design/library' })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /test UI/);
  assert.ok(resource._meta.ui.csp.frameDomains.includes('http://127.0.0.1:*'));
});

test('real LibraryStore CRUD and persistent artwork tabs work through stdio without chat creation', async t => {
  const f = await session(t);
  const initial = await f.rpc('tools/call', { name: 'DesignLibrary', arguments: {} });
  assert.deepEqual(initial.content, []);
  assert.deepEqual(initial.structuredContent.artifacts, []);
  const first = await f.value('library.create', { kind: 'slides', title: 'Sky review' });
  assert.equal(first.contentStatus, 'ok');
  const taskFile = path.join(first.path, '.codex-design-worker-jobs.json');
  await fs.writeFile(taskFile, JSON.stringify({ version: 1, order: ['active-test'], jobs: { 'active-test': { id: 'active-test', status: 'active', event: { kind: 'comment', data: { id: 'comment-test' } } } } }));
  const blocked = await f.call('library.rename', { id: first.id, title: 'Cannot overwrite active artwork' });
  assert.equal(blocked.isError, true); assert.equal(blocked.structuredContent.error.code, 'ARTIFACT_BUSY');
  await fs.unlink(taskFile);
  const second = await f.value('library.duplicate', { id: first.id, title: 'Sky review copy' });
  assert.notEqual(first.id, second.id);
  await f.value('library.rename', { id: first.id, title: 'Nimbus review' });
  await f.value('library.setFavorite', { id: first.id, favorite: true });
  const records = await f.value('library.list', { includeDeleted: true }, 'design_read');
  assert.equal(records.length, 2);
  assert.equal(records.find(record => record.id === first.id).title, 'Nimbus review');
  const view = await f.value('view.openTab', { id: first.id });
  assert.equal(view.activeTabId, first.id);
  assert.equal((await f.value('editor.open', { id: first.id })).nativeConversationBound, false);
  const conversation = await f.value('conversation.get', { id: first.id }, 'design_read');
  assert.equal(conversation.status, 'unsupported'); assert.equal(conversation.binding, null);
  assert.equal(conversation.capabilities.sendMessage, false); assert.deepEqual(conversation.messages, []);
  await f.value('library.trash', { id: first.id });
  assert.equal((await f.value('view.get', {}, 'design_read')).activeTabId, 'library');
  await f.value('library.restore', { id: first.id });
  assert.equal((await f.value('library.get', { id: first.id }, 'design_read')).id, first.id);
});

test('composer mentions and resource reads remain content-only read-only references', async t => {
  const f = await session(t);
  const artifact = await f.value('library.create', { kind: 'design-system', title: 'Nimbus tokens' });
  const mentions = await f.rpc('tools/call', { name: 'search_mentions', arguments: { query: 'Nimbus' } });
  assert.equal(mentions.structuredContent.items[0].uri, referenceUri(artifact.id));
  const reference = JSON.parse((await f.rpc('resources/read', { uri: referenceUri(artifact.id) })).contents[0].text);
  assert.equal(reference.readOnly, true);
  assert.ok(reference.files.some(file => file.path === 'project/tokens.json'));
  const content = await f.rpc('resources/read', { uri: fileUri(artifact.id, 'project/tokens.json') });
  assert.ok(JSON.parse(content.contents[0].text));
  for (const relative of ['comments.json', '_state/bindings.json', '../../secret.txt']) {
    const result = await f.call('reference.readFile', { id: artifact.id, path: relative }, 'design_read');
    assert.equal(result.isError, true);
  }
  await assert.rejects(f.rpc('resources/read', { uri: fileUri(artifact.id, 'comments.json') }));
  assert.equal((await f.call('editor.open', { id: '../../escape' })).isError, true);
});

test('discovery spike accepts empty global input and opaque file-handler input', async t => {
  const f = await session(t, { spike: true });
  const global = await f.rpc('tools/call', { name: 'DesignLibrary', arguments: {} });
  assert.deepEqual(global.content, []);
  assert.equal(global.structuredContent.probe, true);
  const file = await f.rpc('tools/call', { name: 'DesignFile', arguments: { file: { name: 'example.codexdesign', resourceUri: 'file://opaque-host-grant' } } });
  assert.equal(file.structuredContent.file.resourceUri, 'file://opaque-host-grant');
  assert.equal(file.structuredContent.nativeEditConversation, 'not-established');
});
