import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fileUri, referenceUri, LIBRARY_UI_URI, FILE_UI_URI, PLUGIN_UI_VERSION } from '../source/server/contract.mjs';

const pluginBuildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function session(t, { spike = false, built = false, resourceDiagnostics = true } = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-mcp-test-'));
  const libraryRoot = built ? path.join(temporary, '.codex', 'CodexDesignLibrary') : path.join(temporary, 'library');
  const cleanup = [];
  const runner = path.join(temporary, 'runner.mjs');
  const moduleUrl = relative => pathToFileURL(path.join(pluginBuildRoot, relative)).href;
  await fs.writeFile(runner, spike
    ? `import {serveStdio} from ${JSON.stringify(moduleUrl('node_modules/@modelcontextprotocol/server/dist/stdio.mjs'))};\nimport {createSpikeServer} from ${JSON.stringify(moduleUrl('source/server/spike.mjs'))};\nserveStdio(createSpikeServer);\n`
    : `import {serveStdio} from ${JSON.stringify(moduleUrl('node_modules/@modelcontextprotocol/server/dist/stdio.mjs'))};\nimport {createDesignServer,nativeActivity} from ${JSON.stringify(moduleUrl('source/server/register.mjs'))};\nimport {createLibraryStore} from ${JSON.stringify(moduleUrl('source/library/index.mjs'))};\nserveStdio(()=>createDesignServer({store:createLibraryStore({root:${JSON.stringify(libraryRoot)},isBusy:nativeActivity}),resourceDiagnostics:${JSON.stringify(resourceDiagnostics)},html:'<!doctype html><html><body>test UI</body></html>',icons:[],editorOpen:async record=>({url:'http://127.0.0.1:7443/editor/',artifactId:record.id,nativeConversationBound:false})}));\n`);
  const env = built ? { ...process.env, USERPROFILE: temporary } : process.env;
  if (built) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'import os from "node:os"; process.stdout.write(os.homedir());'], { env, windowsHide: true });
    assert.equal(path.resolve(stdout), temporary, 'The packaged MCP test must isolate its actual default user library before starting it.');
  }
  const child = spawn(process.execPath, [built ? path.join(pluginBuildRoot, 'codex-design', 'server', 'index.mjs') : runner], { cwd: temporary, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', next = 0;
  const stdoutLines = [];
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
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
    for (const task of cleanup) await task();
    for (const call of pending.values()) clearTimeout(call.timer);
    const exited = new Promise(resolve => child.once('close', resolve));
    child.stdin.end(); child.kill();
    if (child.exitCode === null && child.signalCode === null) await exited;
    const relative = path.relative(os.tmpdir(), path.resolve(temporary));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codex-design-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = (action, payload = {}, tool = 'design_action') => rpc('tools/call', { name: tool, arguments: { action, payload } });
  const value = async (action, payload, tool) => { const result = await call(action, payload, tool); assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent.result; };
  return { rpc, call, value, initialized, libraryRoot, cleanup, env, stderr: () => stderr, stdoutLines: () => [...stdoutLines] };
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
  assert.deepEqual(resources.resources.map(resource => resource.uri).sort(), [FILE_UI_URI, LIBRARY_UI_URI].sort());
  assert.ok([FILE_UI_URI, LIBRARY_UI_URI].every(uri => uri.includes(`/${PLUGIN_UI_VERSION}/`)));
  const resource = (await f.rpc('resources/read', { uri: LIBRARY_UI_URI })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /test UI/);
  assert.equal(resource._meta['codex-design/uiVersion'], PLUGIN_UI_VERSION);
  assert.deepEqual(resource._meta.ui.csp.frameDomains, ['blob:', 'data:']);
  assert.deepEqual(resource._meta.ui.csp.baseUriDomains, ['https://codex-design.invalid']);
  assert.equal(resource._meta.ui.csp.frameDomains.some(origin => origin.startsWith('http:')), false);
});

test('UI resource diagnostics identify exact served bytes on stderr without leaking content or polluting MCP stdout', async t => {
  const f = await session(t);
  const resources = [];
  for (const uri of [LIBRARY_UI_URI, FILE_UI_URI]) resources.push((await f.rpc('resources/read', { uri })).contents[0]);
  await f.value('library.list', {}, 'design_read');
  await new Promise(resolve => setImmediate(resolve));
  const diagnostics = f.stderr().trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(diagnostics.length, 2, 'one diagnostic per actual UI resource read; ordinary model reads add none');
  for (const [index, value] of diagnostics.entries()) {
    assert.deepEqual(Object.keys(value).sort(), ['event', 'serverName', 'pluginVersion', 'uiVersion', 'resourceURI', 'htmlSHA256'].sort());
    assert.equal(value.event, 'codex_design_ui_resource_read');
    assert.equal(value.serverName, 'codex-design');
    assert.equal(value.pluginVersion, f.initialized.serverInfo.version);
    assert.equal(value.uiVersion, PLUGIN_UI_VERSION);
    assert.equal(value.resourceURI, resources[index].uri);
    assert.equal(value.htmlSHA256, createHash('sha256').update(resources[index].text, 'utf8').digest('hex'));
  }
  assert.equal(f.stderr().includes('test UI'), false);
  assert.equal(f.stderr().includes(f.libraryRoot), false);
  assert.equal(f.stderr().includes('http://'), false);
  for (const line of f.stdoutLines()) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    assert.notEqual(message.event, 'codex_design_ui_resource_read');
  }
});

test('UI resource diagnostics can be disabled without changing the served resource or metadata', async t => {
  const f = await session(t, { resourceDiagnostics: false });
  const resource = (await f.rpc('resources/read', { uri: LIBRARY_UI_URI })).contents[0];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stderr(), '');
  assert.equal(resource._meta['codex-design/uiVersion'], PLUGIN_UI_VERSION);
  assert.equal(resource._meta['openai/ui'].preferredDisplayMode, 'fullscreen');
  assert.deepEqual(resource._meta.ui.csp.frameDomains, ['blob:', 'data:']);
  assert.match(resource.text, /test UI/);
});

test('real LibraryStore CRUD and persistent artwork tabs work through stdio without chat creation', async t => {
  const f = await session(t);
  const initial = await f.rpc('tools/call', { name: 'DesignLibrary', arguments: {} });
  assert.deepEqual(initial.content, []);
  assert.deepEqual(initial.structuredContent.artifacts, []);
  const first = await f.value('library.create', { kind: 'slides', title: 'Sky review' });
  assert.equal(first.contentStatus, 'ok');
  const digest = await f.value('editor.digest', { id: first.id, algorithm: 'SHA-256', base64: Buffer.from('abc').toString('base64') });
  assert.equal(Buffer.from(digest.base64, 'base64').toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal((await f.call('editor.digest', { id: first.id, algorithm: 'SHA-1', base64: '' })).isError, true);
  const largeBytes = Buffer.alloc(4 * 1024 * 1024, 0xab);
  const largeDigest = await f.value('editor.digest', { id: first.id, algorithm: 'SHA-256', base64: largeBytes.toString('base64') });
  assert.equal(Buffer.from(largeDigest.base64, 'base64').toString('hex'), createHash('sha256').update(largeBytes).digest('hex'));
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

test('the actual packaged MCP server emits a self-contained native bootstrap that reads real artwork without a browser HTTP connection', { timeout: 45_000, skip: process.platform !== 'win32' ? 'This default-home isolation test uses the Windows USERPROFILE contract; cross-platform runtime behavior is covered through explicit temporary stores.' : false }, async t => {
  const f = await session(t, { built: true });
  const artifact = await f.value('library.create', { kind: 'slides', title: 'Packaged native transport verification' });
  assert.ok(artifact.path.startsWith(f.libraryRoot + path.sep));
  f.cleanup.push(async () => {
    await promisify(execFile)(process.execPath, [path.join(pluginBuildRoot, 'codex-design', 'skills', 'codex-slides', 'scripts', 'codex-artifact.mjs'), 'stop', artifact.path], { env: f.env, windowsHide: true, timeout: 15_000 });
  });
  const channel = 'packaged-native-channel';
  const document = await f.value('editor.document', { id: artifact.id, channel, language: 'zh' });
  assert.equal(document.transport, 'mcp');
  const bootstrap = /<head\b[^>]*>[\s\S]*?<script>([\s\S]*?)<\/script>/i.exec(document.html)?.[1];
  assert.ok(bootstrap?.includes('codex-design:editor-request'));
  const callbacks = new Map(), requests = [];
  const parent = { postMessage(message) {
    requests.push(message);
    if (message.type !== 'codex-design:editor-request') return;
    void f.value(message.action, { ...message.payload, id: artifact.id }).then(result => callbacks.get('message')({ source: parent, data: { type: 'codex-design:editor-response', channel, requestId: message.requestId, result } }));
  } };
  const target = { parent, fetch: async () => { throw new Error('Native artwork fetch must use the MCP broker.'); }, addEventListener: (type, listener) => callbacks.set(type, listener), btoa, atob };
  vm.runInNewContext(bootstrap, { window: target, URL, EventTarget, Event, MessageEvent, Request, Response, Headers, Uint8Array, DOMException, AbortController, setTimeout, clearTimeout }, { timeout: 2_000 });
  const response = await target.fetch('_files.json');
  assert.ok(response.ok);
  const files = await response.json();
  assert.ok(files.files['project/deck.json']);
  assert.ok(requests.some(request => request.type === 'codex-design:editor-transport-ready'));
});
