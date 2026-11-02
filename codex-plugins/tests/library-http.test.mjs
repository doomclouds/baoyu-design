import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startLibraryPreview, libraryPreviewStatus, stopLibraryPreview, PREVIEW_STATE } from '../source/server/http-preview.mjs';

const html = '<!doctype html><html><head><meta charset="utf-8"><title>Library</title><style>.app{color:#202020}</style></head><body><div id="codex-design-root"></div><script type="module">window.previewFixtureLoaded=true;</script></body></html>';
const execFileAsync = promisify(execFile);
async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-http-test-'));
  const root = path.join(temporary, 'Library');
  const server = await startLibraryPreview({ root, html, ...options });
  t.after(async () => { await server.close(); const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(temporary, { recursive: true, force: true }); });
  const origin = new URL(server.url).origin;
  const invoke = async (action, payload = {}) => {
    const response = await fetch(server.endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    return { response, body: await response.json() };
  };
  return { root, server, origin, invoke };
}

test('real loopback API persists library CRUD and unique tabs; UI receives the same-origin token endpoint', async t => {
  const { root, server, invoke } = await fixture(t);
  const response = await fetch(server.url); const document = await response.text();
  assert.equal(response.status, 200); assert.ok(document.includes(JSON.stringify(server.endpoint))); assert.match(document, /window\.codexDesignHttpEndpoint=/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'nonce-/); assert.equal(response.headers.get('access-control-allow-origin'), null);
  const created = await invoke('library.create', { kind: 'design', title: '真实 HTTP 作品' });
  assert.equal(created.response.status, 200); const id = created.body.result.id;
  assert.equal((await invoke('library.rename', { id, title: '已改名' })).body.result.title, '已改名');
  assert.equal((await invoke('library.setFavorite', { id, favorite: true })).body.result.favorite, true);
  await invoke('view.openTab', { id }); await invoke('view.openTab', { id });
  assert.deepEqual((await invoke('view.get')).body.result.tabs.map(tab => tab.id), ['library', id]);
  assert.equal((await invoke('library.list', { query: '已改名' })).body.result.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'design', id, 'artifact.json'), 'utf8')).title, '已改名');
  const conversation = await invoke('conversation.send', { id, text: 'This must never be sent.' });
  assert.equal(conversation.response.status, 400); assert.equal(conversation.body.error.code, 'NATIVE_EDIT_CHAT_UNAVAILABLE');
});

test('Origin, token, Host, methods, content type, JSON and request size are enforced', async t => {
  const { server, origin } = await fixture(t, { maxRequestBytes: 128 });
  const post = (headers, body = '{}') => fetch(server.endpoint, { method: 'POST', headers, body });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: 'https://evil.invalid', 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: origin, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ Origin: origin, 'Content-Type': 'application/json' }, '{bad json')).status, 400);
  assert.equal((await post({ Origin: origin, 'Content-Type': 'application/json' }, 'x'.repeat(129))).status, 413);
  assert.equal((await fetch(server.endpoint)).status, 405);
  assert.equal((await fetch(new URL('/not-the-token/api', server.url), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await fetch(new URL('styles.css', server.url))).status, 404);
  assert.equal((await fetch(server.url, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => { const request = http.get(server.url, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(wrongHost, 421);
  const navigation = await new Promise((resolve, reject) => { const request = http.get(server.url, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(navigation, 200, 'a user can navigate to the explicit local preview link');
});

test('default HTTP store uses real native task state to refuse busy deletion', async t => {
  const { root, invoke } = await fixture(t);
  const id = (await invoke('library.create', { kind: 'design', title: 'Busy native artwork' })).body.result.id;
  const jobs = { version: 1, jobs: { active: { id: 'active', event: { kind: 'request', data: { id: 'r_active' } }, status: 'active', queuedAt: new Date().toISOString() } }, order: ['active'] };
  await fs.writeFile(path.join(root, 'design', id, '.codex-design-worker-jobs.json'), JSON.stringify(jobs));
  const refused = await invoke('library.trash', { id }); assert.equal(refused.response.status, 409); assert.equal(refused.body.error.code, 'ARTIFACT_BUSY');
  assert.equal((await invoke('library.get', { id })).body.result.contentStatus, 'ok');
});

test('authenticated graceful stop verifies session identity without signalling a recorded PID', async t => {
  const { root, server } = await fixture(t);
  assert.equal((await libraryPreviewStatus({ root })).running, true);
  const file = path.join(root, ...PREVIEW_STATE.split('/')), original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, JSON.stringify({ ...JSON.parse(original), instanceId: 'a-different-instance' }));
  await assert.rejects(stopLibraryPreview({ root }), { code: 'PREVIEW_IDENTITY_UNVERIFIED' });
  assert.equal((await fetch(server.url)).status, 200, 'a mismatched record must not stop the live service');
  await fs.writeFile(file, original);
  const stopped = await stopLibraryPreview({ root }); assert.equal(stopped.stopped, true);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (!(await libraryPreviewStatus({ root })).running) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal((await libraryPreviewStatus({ root })).running, false);
});

test('unbuilt UI with external assets is refused instead of silently rendering a broken native workspace', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-http-unbuilt-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..')); await fs.rm(temporary, { recursive: true, force: true }); });
  await assert.rejects(startLibraryPreview({ root: path.join(temporary, 'Library'), html: '<html><head><script type="module" src="./entry.js"></script></head><body></body></html>' }), { code: 'UI_NOT_BUNDLED' });
});

test('CLI detached open, status and authenticated stop operate on only the explicitly selected temporary library', { timeout: 30_000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-http-cli-'));
  const root = path.join(temporary, 'Library'), pluginRoot = path.join(temporary, 'BuiltPlugin');
  const cli = fileURLToPath(new URL('../source/scripts/library-preview.mjs', import.meta.url));
  const diagnosticsFile = path.join(temporary, 'cli-diagnostics.json');
  const diagnostics = { version: 1, temporary, root, pluginRoot, executable: process.execPath, cli, stages: [] };
  let bodyCompleted = false;
  const errorDetails = cause => ({ name: cause.name, code: cause.code, message: cause.message,
    stdout: typeof cause.stdout === 'string' ? cause.stdout.slice(-65_536) : undefined,
    stderr: typeof cause.stderr === 'string' ? cause.stderr.slice(-65_536) : undefined,
    signal: cause.signal, killed: cause.killed });
  const readEvidence = async relative => {
    const file = path.join(root, ...relative.split('/'));
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) return { file, refused: 'not a regular unaliased file' };
      const handle = await fs.open(file, 'r');
      try {
        const length = Math.min(info.size, 65_536), bytes = Buffer.alloc(length);
        await handle.read(bytes, 0, length, Math.max(0, info.size - length));
        return { file, bytes: info.size, modifiedAt: info.mtime.toISOString(), truncated: length < info.size, text: bytes.toString('utf8') };
      } finally { await handle.close(); }
    } catch (cause) { return { file, missing: cause.code === 'ENOENT', error: cause.code === 'ENOENT' ? undefined : errorDetails(cause) }; }
  };
  const snapshot = async () => ({ state: await readEvidence(PREVIEW_STATE), log: await readEvidence('_state/library-preview.log') });
  const saveDiagnostics = () => fs.writeFile(diagnosticsFile, JSON.stringify(diagnostics, null, 2) + '\n');
  const stage = async (name, operation) => {
    const entry = { stage: name, startedAt: new Date().toISOString(), before: await snapshot() };
    diagnostics.stages.push(entry);
    try {
      const result = await operation(entry);
      entry.result = result; entry.passed = true;
      return result;
    } catch (cause) {
      entry.passed = false; entry.error = errorDetails(cause);
      throw new Error(`[${name}] ${cause.message}; temporary evidence: ${diagnosticsFile}`, { cause });
    } finally {
      entry.finishedAt = new Date().toISOString(); entry.after = await snapshot();
      await saveDiagnostics();
    }
  };
  const run = (name, command, check) => stage(name, async entry => {
    entry.argv = [cli, command, '--root', root, '--plugin-root', pluginRoot];
    const output = await execFileAsync(process.execPath, entry.argv, { timeout: 20_000, windowsHide: true });
    entry.stdout = output.stdout; entry.stderr = output.stderr;
    const result = JSON.parse(output.stdout); check?.(result); return result;
  });
  t.after(async () => {
    diagnostics.beforeCleanup = await snapshot();
    try {
      await run('cleanup-stop', 'stop', result => assert.ok(result.stopped === true || result.running === false,
        'authenticated cleanup must confirm stopped or already not running'));
    } catch (cause) {
      diagnostics.retained = true; diagnostics.cleanupError = errorDetails(cause);
      await saveDiagnostics();
      t.diagnostic(`Cleanup could not confirm graceful shutdown. Preserved ${temporary}; inspect ${diagnosticsFile} and the original preview state/log. No PID was signalled by the fixture.`);
      throw cause;
    }
    if (!bodyCompleted) {
      diagnostics.retained = true; await saveDiagnostics();
      t.diagnostic(`Failed CLI stage evidence retained at ${diagnosticsFile}; authenticated cleanup completed.`);
      return;
    }
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(pluginRoot, 'ui'), { recursive: true }); await fs.writeFile(path.join(pluginRoot, 'ui/index.html'), html);
  const opened = await run('initial-open', 'open', result => {
    assert.equal(result.nativeIntegrationVerified, false); assert.equal(result.mode, 'local-http-preview');
  });
  await run('initial-status', 'status', result => { assert.equal(result.running, true); assert.equal(result.pid, opened.pid); });
  await run('reuse-open', 'open', result => { assert.equal(result.reused, true); assert.equal(result.pid, opened.pid); });
  await stage('page-fetch', async () => { const response = await fetch(opened.url); assert.equal(response.status, 200); return { status: response.status }; });
  await run('explicit-stop', 'stop', result => assert.equal(result.stopped, true));
  await run('stopped-status', 'status', result => assert.equal(result.running, false));
  bodyCompleted = true;
});
