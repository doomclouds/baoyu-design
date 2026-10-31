import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { BINDING_FILE, DELIVERY_FILE, atomicJson, deliverComment, readJson, runBounded, runnerFromPath, withLock, alive } from '../source/scripts/bridge-core.mjs';
import { sendComment } from '../source/scripts/send-comment.mjs';
import { hookCommand, parseBridgeArguments } from '../source/scripts/artifact-command.mjs';

const THREAD = '11111111-2222-4333-8444-555555555555';
const fakeSource = `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_TRACE) fs.appendFileSync(process.env.FAKE_TRACE, JSON.stringify({args,cwd:process.cwd()})+'\\n');
if (process.env.FAKE_DELAY) await new Promise(r=>setTimeout(r, Number(process.env.FAKE_DELAY)));
if (process.env.FAKE_NOISY) { process.stdout.write('O'.repeat(300000)); process.stderr.write('E'.repeat(300000)); }
if (process.env.FAKE_FAIL) { process.stderr.write('intentional queue failure'); process.exitCode=7; }
`;

async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codex design '百分% & ! "));
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
  const fake = path.join(root, 'fake codex.mjs');
  await fsp.writeFile(fake, fakeSource);
  const trace = path.join(root, 'trace.jsonl');
  const binding = { version: 1, root, skillDir: path.join(root, 'skills', 'codex-design'), threadId: THREAD, token: 'token-test', codexPath: fake };
  atomicJson(path.join(root, BINDING_FILE), binding);
  const env = { ...process.env, FAKE_TRACE: trace };
  return { root, fake, trace, binding, env, runner: { command: process.execPath, args: [fake] } };
}

const payload = (text = '把标题改成“年度报告” & keep $(literal) `code` %PATH%\n第二行') => ({
  id: 'c_123', file: 'project/home.dc.html', where: 'hero heading', location: { file: 'project/home.dc.html' },
  agent: { status: 'pending', sentAt: '2026-10-31T00:00:00Z' },
  messages: [{ from: 'user', name: 'User', text, at: '2026-10-31T00:00:00Z' }],
});
const calls = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];

test('comment delivery preserves literal user text, thread routing, root and reply command', async (t) => {
  const f = await setup(t);
  const result = await deliverComment(f.binding, payload(), f);
  assert.equal(result.delivered, true);
  const [call] = calls(f.trace);
  assert.deepEqual(call.args.slice(0, 3), ['queue', '--thread', THREAD]);
  const message = call.args[call.args.indexOf('--message') + 1];
  assert.ok(message.includes(JSON.stringify(payload().messages[0].text).slice(1, -1)));
  assert.ok(message.includes(JSON.stringify(f.root)));
  assert.ok(message.includes('comment-reply'));
  assert.ok(message.includes('codex-design'));
  assert.ok(!message.includes('claude-design'));
  assert.ok(message.includes('ordinary user request'));
  assert.equal(call.cwd, f.root);
});

test('request events carry user text, selection and explicit remote configuration', async (t) => {
  const f = await setup(t);
  const binding = { ...f.binding, remote: 'ws://127.0.0.1:4500', remoteAuthTokenEnv: 'CODEX_DESIGN_REMOTE_TOKEN' };
  atomicJson(path.join(f.root, BINDING_FILE), binding);
  await deliverComment(binding, { request: { id: 'r_123', text: 'Make a mobile variant', selection: 'board 2', label: 'Remix' } }, f);
  const [call] = calls(f.trace);
  assert.deepEqual(call.args.slice(-4), ['--remote', binding.remote, '--remote-auth-token-env', binding.remoteAuthTokenEnv]);
  const message = call.args[4];
  assert.match(message, /Make a mobile variant/);
  assert.match(message, /board 2/);
  assert.ok(!message.includes('comment-reply'));
});

test('duplicate suppression persists across calls and ignores agent replies', async (t) => {
  const f = await setup(t);
  await deliverComment(f.binding, payload(), f);
  const next = payload();
  next.agent.status = 'delivered';
  next.location = { file: next.file, description: 'updated non-user metadata' };
  next.messages.push({ from: 'agent', text: 'Done', at: '2026-10-31T00:01:00Z' });
  assert.equal((await deliverComment(f.binding, next, f)).duplicate, true);
  assert.equal(calls(f.trace).length, 1);
  assert.equal(Object.keys(readJson(path.join(f.root, DELIVERY_FILE)).delivered).length, 1);
});

test('edited or new user revision and another bound chat are delivered again', async (t) => {
  const f = await setup(t);
  await deliverComment(f.binding, payload(), f);
  const next = payload(); next.messages[0].editedAt = '2026-10-31T00:02:00Z';
  await deliverComment(f.binding, next, f);
  const rebound = { ...f.binding, token: 'rebound-token', threadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  atomicJson(path.join(f.root, BINDING_FILE), rebound);
  await deliverComment(rebound, next, f);
  assert.equal(calls(f.trace).length, 3);
});

test('queue failure does not mark delivered and permits a later retry', async (t) => {
  const f = await setup(t);
  await assert.rejects(deliverComment(f.binding, payload(), { ...f, env: { ...f.env, FAKE_FAIL: '1' } }), { code: 'QUEUE_FAILED' });
  assert.equal(fs.existsSync(path.join(f.root, DELIVERY_FILE)), false);
  assert.equal((await deliverComment(f.binding, payload(), f)).duplicate, false);
  assert.equal(calls(f.trace).length, 2);
});

test('simultaneous deliveries use one queue invocation', async (t) => {
  const f = await setup(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => deliverComment(f.binding, payload(), { ...f, env: { ...f.env, FAKE_DELAY: '100' } })));
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
  assert.equal(calls(f.trace).length, 1);
});

test('oversized user context is saved intact and the queue argument stays within Windows limits', async (t) => {
  const f = await setup(t);
  const longText = '详细需求'.repeat(12_000);
  await deliverComment(f.binding, payload(longText), f);
  const message = calls(f.trace)[0].args[4];
  assert.ok(message.length < 12_000);
  const events = await fsp.readdir(path.join(f.root, '.codex-design-events'));
  const saved = readJson(path.join(f.root, '.codex-design-events', events[0]));
  assert.equal(saved.data.messages[0].text, longText);
});

test('independent hook processes share the persistent delivery lock', async (t) => {
  const f = await setup(t);
  atomicJson(path.join(f.root, BINDING_FILE), f.binding);
  const script = fileURLToPath(new URL('../source/scripts/send-comment.mjs', import.meta.url));
  const runHook = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--binding-token', f.binding.token], {
      env: { ...f.env, ARTIFACT_ROOT: f.root, FAKE_DELAY: '100' }, shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(payload()));
  });
  await Promise.all([runHook(), runHook(), runHook()]);
  assert.equal(calls(f.trace).length, 1);
});

test('queue output is drained with bounded retained buffers', async (t) => {
  const f = await setup(t);
  const result = await runBounded(f.runner, ['queue'], { ...f, env: { ...f.env, FAKE_NOISY: '1' }, maxOutputBytes: 2048 });
  assert.equal(result.code, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 2048);
  assert.ok(Buffer.byteLength(result.stderr) <= 2048);
});

test('queue timeout fails without recording delivery and releases its lock', async (t) => {
  const f = await setup(t);
  await assert.rejects(deliverComment(f.binding, payload(), { ...f, env: { ...f.env, FAKE_DELAY: '3000' }, timeoutMs: 100 }), { code: 'QUEUE_TIMEOUT' });
  assert.equal(fs.existsSync(path.join(f.root, DELIVERY_FILE)), false);
  assert.equal(fs.existsSync(path.join(f.root, `${DELIVERY_FILE}.lock`)), false);
  const retried = await deliverComment(f.binding, payload(), f);
  assert.equal(retried.delivered, true);
  // Under load, timeout may terminate the first process before its JS starts.
  assert.ok(calls(f.trace).length >= 1 && calls(f.trace).length <= 2);
});

test('send-comment validates token/root and preserves split UTF-8 input', async (t) => {
  const f = await setup(t);
  atomicJson(path.join(f.root, BINDING_FILE), f.binding);
  const bytes = Buffer.from(JSON.stringify(payload('中文字符')));
  const input = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])));
  await sendComment({ argv: ['--binding-token', f.binding.token], env: { ...f.env, ARTIFACT_ROOT: f.root }, input, runner: f.runner });
  assert.match(calls(f.trace)[0].args[4], /中文字符/);
  await assert.rejects(sendComment({ argv: ['--binding-token', 'other-token'], env: { ...f.env, ARTIFACT_ROOT: f.root }, input: Readable.from([]) }), { code: 'INVALID_BINDING' });
});

test('Windows npm shim resolves to Node entrypoint without a command shell', async (t) => {
  const f = await setup(t);
  const shim = path.join(f.root, 'codex.cmd');
  const entry = path.join(f.root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await fsp.mkdir(path.dirname(entry), { recursive: true });
  await fsp.writeFile(shim, '@echo off'); await fsp.writeFile(entry, '// test entry');
  assert.deepEqual(runnerFromPath(shim, { platform: 'win32' }), { command: process.execPath, args: [entry] });
});

test('wrapper strips only its flags and preserves unknown flags/custom hooks', () => {
  const args = ['open', '--thread', THREAD, '--future', 'literal', 'design root', '--port=3456', '--agent-hook', 'custom command', '--remote=ws://localhost:4000', '--no-agent'];
  const parsed = parseBridgeArguments(args);
  assert.deepEqual(parsed.forwarded, ['open', '--future', 'literal', 'design root', '--port=3456', '--agent-hook', 'custom command']);
  assert.equal(parsed.options.threadId, THREAD);
  assert.equal(parsed.options.noAgent, true);
  assert.equal(parsed.options.remote, 'ws://localhost:4000');
  assert.throws(() => parseBridgeArguments(['open', 'root', '--thread']), { code: 'INVALID_FLAG' });
});

test('hook shell command contains only environment references and an opaque token', () => {
  assert.equal(hookCommand('test-token', 'win32'), '"%CODEX_DESIGN_BRIDGE_NODE%" "%CODEX_DESIGN_BRIDGE_SCRIPT%" --binding-token test-token');
  assert.equal(hookCommand('test-token', 'linux'), '"$CODEX_DESIGN_BRIDGE_NODE" "$CODEX_DESIGN_BRIDGE_SCRIPT" --binding-token test-token');
  assert.throws(() => hookCommand('invalid & token'), { code: 'INVALID_BINDING' });
});

test('atomic state replacement retries transient sharing failures without deleting the destination', async (t) => {
  const f = await setup(t);
  const file = path.join(f.root, 'atomic.json');
  atomicJson(file, { revision: 1 });
  const originalRename = fs.renameSync;
  let failures = 0;
  fs.renameSync = (source, target) => {
    if (target === file && failures < 2) {
      failures++;
      assert.deepEqual(readJson(file), { revision: 1 });
      throw Object.assign(new Error('shared reader'), { code: 'EPERM' });
    }
    return originalRename(source, target);
  };
  try { atomicJson(file, { revision: 2 }); }
  finally { fs.renameSync = originalRename; }
  assert.equal(failures, 2);
  assert.deepEqual(readJson(file), { revision: 2 });
});

test('a hook waiting for the binding lock cannot deliver after the editor is rebound', async (t) => {
  const f = await setup(t);
  let pending;
  await withLock(path.join(f.root, `${BINDING_FILE}.lock`), async () => {
    pending = deliverComment(f.binding, payload(), f);
    atomicJson(path.join(f.root, BINDING_FILE), { ...f.binding, token: 'new-binding-token', threadId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await assert.rejects(pending, { code: 'INVALID_BINDING' });
  assert.equal(calls(f.trace).length, 0);
});

test('serve startup deadline stops an unresponsive helper and releases its binding lock', async (t) => {
  const f = await setup(t);
  const skill = path.join(f.root, 'skills', 'codex-design');
  await fsp.mkdir(path.join(skill, 'scripts'), { recursive: true });
  const pidFile = path.join(f.root, 'helper-pid.txt');
  await fsp.writeFile(path.join(skill, 'scripts', 'artifact.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000);`);
  const launch = path.join(f.root, 'launch.mjs');
  const source = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;
  await fsp.writeFile(launch, `import {runArtifactCommand} from ${JSON.stringify(source)}; await runArtifactCommand(${JSON.stringify(skill)}, ${JSON.stringify(['serve', f.root, '--thread', THREAD, '--codex-path', f.fake])}, {startupTimeoutMs:150});`);
  const result = await runBounded({ command: process.execPath, args: [launch] }, [], { cwd: f.root, env: f.env, timeoutMs: 4000 });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /EDITOR_STARTUP_TIMEOUT/);
  assert.equal(fs.existsSync(path.join(f.root, `${BINDING_FILE}.lock`)), false);
  assert.equal(fs.existsSync(path.join(f.root, BINDING_FILE)), false);
  if (fs.existsSync(pidFile)) assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
});

test('stale editor PID reused by an unrelated live process is never reused, rebound or stopped', async (t) => {
  const f = await setup(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, shell: false, stdio: 'ignore' });
  await new Promise((resolve, reject) => { unrelated.once('spawn', resolve); unrelated.once('error', reject); });
  t.after(() => { if (alive(unrelated.pid)) unrelated.kill(); });
  const service = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    // This is a different live process, serving the same root/kind at a reused URL.
    response.end(JSON.stringify({ root: f.root, kind: 'design', pid: process.pid }));
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => service.close(resolve)));
  const state = { root: f.root, kind: 'design', pid: unrelated.pid, url: `http://127.0.0.1:${service.address().port}/design/old-grant/` };
  const binding = { ...f.binding, serverPid: unrelated.pid };
  atomicJson(path.join(f.root, '.artifact-server.json'), state);
  atomicJson(path.join(f.root, BINDING_FILE), binding);
  await fsp.mkdir(path.join(binding.skillDir, 'scripts'), { recursive: true });
  const invoked = path.join(f.root, 'original-was-invoked');
  await fsp.writeFile(path.join(binding.skillDir, 'scripts', 'artifact.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(invoked)}, 'called'); if(process.argv[2]==='stop') process.kill(${unrelated.pid});`);
  const launch = path.join(f.root, 'safety-launch.mjs');
  const source = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;
  await fsp.writeFile(launch, `import {runArtifactCommand} from ${JSON.stringify(source)}; await runArtifactCommand(${JSON.stringify(binding.skillDir)}, process.argv.slice(2));`);
  for (const args of [
    ['open', f.root, '--thread', THREAD, '--codex-path', f.fake],
    ['open', f.root, '--thread', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '--codex-path', f.fake, '--rebind'],
    ['open', f.root, '--no-agent'],
    ['stop', f.root, '--no-agent'],
  ]) {
    const result = await runBounded({ command: process.execPath, args: [launch] }, args, { env: f.env, timeoutMs: 5000 });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
    assert.equal(alive(unrelated.pid), true, 'an unrelated process must never receive a stop signal');
    assert.deepEqual(readJson(path.join(f.root, '.artifact-server.json')), state);
    assert.deepEqual(readJson(path.join(f.root, BINDING_FILE)), binding);
    assert.equal(fs.existsSync(invoked), false, 'unverified records must not reach the original CLI');
  }
});
