import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyEditorInstance } from '../source/scripts/artifact-command.mjs';
import { openLocalEditor } from '../source/server/service.mjs';
import { alive, BINDING_FILE, readJson, runBounded } from '../source/scripts/bridge-core.mjs';
import { NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE } from '../source/scripts/worker-core.mjs';
import { createFixture } from './fixtures.mjs';

const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const skillDir = path.join(pluginRoot, 'skills/codex-design');
const commandModule = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;
const cleanEnv = { ...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '' };

async function closedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, { prelude = '' } = {}) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-refused-recovery-'));
  const artwork = await createFixture('design', temporary);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { unrelated.once('spawn', resolve); unrelated.once('error', reject); });
  const stateFile = path.join(artwork.root, '.artifact-server.json');
  const state = { kind: 'design', root: artwork.root, pid: unrelated.pid, url: `http://127.0.0.1:${await closedPort()}/design/old-fixture-grant/`, startedAt: new Date().toISOString() };
  const binding = { version: 1, root: artwork.root, skillDir: path.join(temporary, 'old-package/skills/codex-design'), threadId: randomUUID(),
    deliveryMode: 'native', token: randomUUID(), serverPid: state.pid, createdAt: new Date().toISOString(), retainedMetadata: 'Keep the existing controller.' };
  const native = { version: 1, root: artwork.root, threadId: randomUUID(), deliveryMode: 'native', token: randomUUID(), requestProtocol: 'native-draft-v1' };
  await fsp.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
  await fsp.writeFile(path.join(artwork.root, BINDING_FILE), JSON.stringify(binding, null, 2) + '\n');
  await fsp.writeFile(path.join(artwork.root, NATIVE_BINDING_FILE), JSON.stringify(native, null, 2) + '\n');
  await fsp.writeFile(path.join(artwork.root, WORKER_JOBS_FILE), JSON.stringify({ version: 1, jobs: {}, order: [] }) + '\n');
  const launcher = path.join(temporary, 'source-cli.mjs');
  await fsp.writeFile(launcher, `import fs from 'node:fs';\n${prelude}\nimport {runArtifactCommand} from ${JSON.stringify(commandModule)};\nawait runArtifactCommand(${JSON.stringify(skillDir)},process.argv.slice(2));\n`);
  const execute = args => runBounded({ command: process.execPath, args: [launcher] }, args, { env: cleanEnv, cwd: temporary, timeoutMs: 25_000 });
  const protectedFiles = [NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE, 'comments.json', artwork.contentFile];
  const capture = async () => new Map(await Promise.all(protectedFiles.map(async file => [file, await fsp.readFile(path.join(artwork.root, file)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))])));
  const assertProtected = async before => {
    for (const [file, bytes] of before) assert.deepEqual(await fsp.readFile(path.join(artwork.root, file)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), bytes, file);
  };
  const backups = async () => (await fsp.readdir(artwork.root)).filter(name => /^\.artifact-server\.refused-.*\.json$/.test(name));
  t.after(async () => {
    const current = readJson(stateFile);
    if (current && current.pid !== unrelated.pid && alive(current.pid)) {
      try {
        await verifyEditorInstance(current, artwork.root, 'design');
        const stopped = await execute(['stop', artwork.root, '--no-agent']);
        assert.equal(stopped.code, 0, stopped.stderr);
      } catch (error) {
        // A fixture must not signal an unverified PID, even during cleanup.
        assert.fail('The isolated recovered service could not be safely stopped: ' + (error.code || error.name));
      }
    }
    if (alive(unrelated.pid)) unrelated.kill();
    await new Promise(resolve => unrelated.exitCode !== null || unrelated.signalCode !== null ? resolve() : unrelated.once('exit', resolve));
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fsp.rm(temporary, { recursive: true, force: true });
  });
  return { ...artwork, temporary, unrelated, state, stateFile, binding, native, launcher, execute, capture, assertProtected, backups };
}

test('a real closed-port stale record with an unrelated live PID recovers through the CLI lock without rebinding its native parent', { timeout: 40_000 }, async t => {
  const f = await fixture(t), before = await f.capture(), stateBytes = await fsp.readFile(f.stateFile);
  const result = await openLocalEditor({ path: f.root, kind: 'design', id: 'fixture' }, { pluginRoot, env: cleanEnv,
    spawnProcess(command, args, options) { return spawn(command, [f.launcher, ...args.slice(1)], options); } });
  const current = readJson(f.stateFile);
  assert.notEqual(current.pid, f.unrelated.pid);
  assert.equal(alive(f.unrelated.pid), true, 'The stale PID never receives a signal.');
  assert.equal((await verifyEditorInstance(current, f.root, 'design')).pid, current.pid);
  assert.equal(result.url, current.url);
  assert.equal((await f.backups()).length, 1);
  assert.deepEqual(await fsp.readFile(path.join(f.root, (await f.backups())[0])), stateBytes);
  const binding = readJson(path.join(f.root, BINDING_FILE));
  assert.equal(binding.serverPid, current.pid); assert.equal(binding.skillDir, skillDir);
  const { serverPid, skillDir: runtimeSkill, ...preserved } = binding;
  const { serverPid: previousPid, skillDir: previousSkill, ...expected } = f.binding;
  assert.deepEqual(preserved, expected, 'Only legacy data-runtime coordinates change.');
  await f.assertProtected(before);
  const comment = await fetch(new URL('__comments', current.url), { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(current.url).origin },
    body: JSON.stringify({ anchor: 'fixture-anchor', label: 'Fixture', text: 'Local comment, no legacy hook.', send: false }) });
  assert.equal(comment.status, 201);
  assert.match(await comment.text(), /Local comment/);
});

for (const noAgent of [false, true]) test(`independent concurrent ${noAgent ? 'no-agent' : 'native'} CLI processes archive once and share one newly verified service`, { timeout: 40_000 }, async t => {
  const f = await fixture(t), before = await f.capture();
  const args = ['open-service', f.root, ...(noAgent ? ['--no-agent'] : ['--delivery', 'native'])];
  const results = await Promise.all([f.execute(args), f.execute(args)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const outputs = results.map(result => JSON.parse(result.stdout));
  assert.equal(outputs[0].pid, outputs[1].pid);
  assert.equal(outputs.filter(output => output.recovered).length, 1);
  assert.equal(outputs.filter(output => output.reused).length, 1);
  assert.equal((await f.backups()).length, 1);
  assert.equal(alive(f.unrelated.pid), true);
  await f.assertProtected(before);
});

test('an idle native listener is preserved while only its refused data service is replaced', { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({ version: 1, root: f.root, nativeThreadId: randomUUID(), status: 'waiting',
    listener: { pid: f.unrelated.pid, expiresAt: Date.now() + 60_000 } }));
  const before = await f.capture();
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).recovered, true);
  assert.equal(alive(f.unrelated.pid), true); await f.assertProtected(before);
});

test('only exact refused connection-establishment leaves receive the recovery reason', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-refused-classification-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const state = { root, kind: 'design', pid: process.pid, url: 'http://127.0.0.1:1/design/fixture/' };
  const original = globalThis.fetch;
  const leaf = code => Object.assign(new Error('Bounded fixture failure.'), { code });
  try {
    for (const [cause, expected] of [
      [leaf('ECONNREFUSED'), true],
      [new AggregateError([leaf('ECONNREFUSED'), leaf('ECONNREFUSED')]), true],
      [new AggregateError([leaf('ECONNREFUSED'), leaf('ETIMEDOUT')]), false],
      [new AggregateError([]), false], [leaf('ECONNRESET'), false], [leaf('ENOTFOUND'), false], [leaf('ABORT_ERR'), false],
    ]) {
      globalThis.fetch = async () => { throw new TypeError('Fetch failed', { cause }); };
      await assert.rejects(verifyEditorInstance(state, root, 'design'), error => error.code === 'EDITOR_IDENTITY_UNVERIFIED' && (error.reason === 'SESSION_CONNECTION_REFUSED') === expected);
    }
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(verifyEditorInstance(state, root, 'design'), error => error.code === 'EDITOR_IDENTITY_UNVERIFIED' && !error.reason);
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new TypeError('Body failed', { cause: leaf('ECONNREFUSED') }); } });
    await assert.rejects(verifyEditorInstance(state, root, 'design'), error => error.code === 'EDITOR_IDENTITY_UNVERIFIED' && !error.reason);
    globalThis.fetch = async () => { assert.fail('Unapproved URLs must not be fetched.'); };
    for (const url of ['https://127.0.0.1:1/', 'http://example.invalid/', 'http://127.0.0.2:1/', 'http://name:secret@127.0.0.1:1/', 'http://127.0.0.1:1/?x=1']) {
      await assert.rejects(verifyEditorInstance({ ...state, url }, root, 'design'), error => error.code === 'EDITOR_IDENTITY_UNVERIFIED' && !error.reason && !error.message.includes('secret'));
    }
  } finally { globalThis.fetch = original; }
});

for (const mode of ['mismatch', 'timeout', 'http-error', 'invalid-json']) test(`a real ${mode} endpoint is never treated as a disappeared editor`, { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const server = http.createServer((_request, response) => {
    if (mode === 'timeout') return;
    response.writeHead(mode === 'http-error' ? 404 : 200, { 'content-type': 'application/json' });
    response.end(mode === 'invalid-json' ? '{broken' : JSON.stringify({ pid: process.pid, kind: 'design', root: f.root }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const state = { ...f.state, url: `http://127.0.0.1:${server.address().port}/fixture/` };
  await fsp.writeFile(f.stateFile, JSON.stringify(state));
  const before = await fsp.readFile(f.stateFile), binding = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(f.stateFile), before); assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), binding);
  assert.deepEqual(await f.backups(), []); assert.equal(alive(f.unrelated.pid), true);
});

for (const mode of ['active', 'pending', 'orphan-active', 'registry-active', 'registry-working', 'legacy-process']) test(`${mode} ownership refuses archival without touching jobs, parent, comments or state`, async t => {
  const f = await fixture(t);
  if (mode === 'registry-active') await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({ version: 1, root: f.root, activeJobId: 'unknown', status: 'working' }));
  else if (mode === 'registry-working') await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({ version: 1, root: f.root, status: 'working' }));
  else if (mode === 'legacy-process') await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({ version: 1, root: f.root, status: 'waiting', pid: f.unrelated.pid, url: '', token: '' }));
  else await fsp.writeFile(path.join(f.root, WORKER_JOBS_FILE), JSON.stringify({ version: 1, order: mode === 'orphan-active' ? [] : ['job'], jobs: { job: { id: 'job', status: mode === 'pending' ? 'pending' : 'active', event: { kind: 'comment', data: { id: 'comment' } } } } }));
  const before = await f.capture(), state = await fsp.readFile(f.stateFile), bridge = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(f.stateFile), state); assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridge);
  assert.deepEqual(await f.backups(), []); await f.assertProtected(before);
});

for (const mode of ['main', 'custom-hook', 'no-binding', 'preview']) test(`refused ${mode} sources remain unverified instead of silently dropping a hook`, async t => {
  const f = await fixture(t);
  if (mode === 'main') await fsp.writeFile(path.join(f.root, BINDING_FILE), JSON.stringify({ ...f.binding, deliveryMode: 'main' }));
  if (mode === 'no-binding') await fsp.rm(path.join(f.root, BINDING_FILE));
  const state = await fsp.readFile(f.stateFile);
  const result = await f.execute([mode === 'preview' ? 'preview' : 'open-service', f.root, ...(mode === 'custom-hook' ? ['--agent-hook', 'fixture-must-not-run'] : [])]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(f.stateFile), state); assert.deepEqual(await f.backups(), []);
});

test('a concurrent state writer during the locked recheck is preserved and prevents archive/start', async t => {
  const f = await fixture(t);
  const changed = Buffer.from(JSON.stringify({ ...f.state, externalRevision: 'Preserve this replacement.' }));
  await fsp.writeFile(f.launcher, `import fs from 'node:fs';import {runArtifactCommand} from ${JSON.stringify(commandModule)};
const previous=globalThis.fetch;let attempts=0;globalThis.fetch=async(...args)=>{try{return await previous(...args)}catch(error){if(++attempts===2)fs.writeFileSync(${JSON.stringify(f.stateFile)},Buffer.from(${JSON.stringify(changed.toString('base64'))},'base64'));throw error;}};
await runArtifactCommand(${JSON.stringify(skillDir)},process.argv.slice(2));`);
  const before = await f.capture(), bridge = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(f.stateFile), changed); assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridge);
  assert.deepEqual(await f.backups(), []); await f.assertProtected(before);
});

test('an unexpected external replacement at rename is preserved in the backup and never starts a service', async t => {
  const f = await fixture(t), before = await f.capture();
  const changed = Buffer.from(JSON.stringify({ ...f.state, externalRevision: 'Changed outside the cooperative startup lock.' }));
  await fsp.writeFile(f.launcher, `import fs from 'node:fs';import {runArtifactCommand} from ${JSON.stringify(commandModule)};
const previous=fs.renameSync;fs.renameSync=(source,destination)=>{if(source===${JSON.stringify(f.stateFile)})fs.writeFileSync(source,Buffer.from(${JSON.stringify(changed.toString('base64'))},'base64'));return previous(source,destination);};
await runArtifactCommand(${JSON.stringify(skillDir)},process.argv.slice(2));`);
  const bridge = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  const backups = await f.backups(); assert.equal(backups.length, 1);
  assert.deepEqual(await fsp.readFile(path.join(f.root, backups[0])), changed, 'Never overwrite or automatically rename an unexpected writer back.');
  await assert.rejects(fsp.readFile(f.stateFile), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridge);
  assert.equal(alive(f.unrelated.pid), true); await f.assertProtected(before);
});

test('aliased state files and worker lock directories cannot authorize recovery', async t => {
  const f = await fixture(t), state = await fsp.readFile(f.stateFile);
  const alias = path.join(f.temporary, 'state-hardlink.json');
  await fsp.link(f.stateFile, alias);
  let result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(alias), state); assert.deepEqual(await f.backups(), []);
  await fsp.rm(alias);
  const outside = path.join(f.temporary, 'outside-worker-lock');
  await fsp.mkdir(outside);
  const owner = Buffer.from(JSON.stringify({ pid: 1, token: 'never-remove', at: 0 }));
  await fsp.writeFile(path.join(outside, 'owner.json'), owner);
  await fsp.symlink(outside, path.join(f.root, WORKER_LOCK_FILE), process.platform === 'win32' ? 'junction' : 'dir');
  result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(path.join(outside, 'owner.json')), owner); assert.deepEqual(await fsp.readFile(f.stateFile), state);
  assert.deepEqual(await f.backups(), []);
});

test('a writer replacing the legacy bridge after startup cannot receive an invented future PID update', { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const changed = Buffer.from(JSON.stringify({ ...f.binding, retainedMetadata: 'A different controller wrote this.' }));
  await fsp.writeFile(f.launcher, `import fs from 'node:fs';import {runArtifactCommand} from ${JSON.stringify(commandModule)};
const previous=globalThis.fetch;globalThis.fetch=async(input,...rest)=>{const response=await previous(input,...rest);if(String(input).includes('__codex/editor-session')&&!String(input).startsWith(${JSON.stringify(new URL(f.state.url).origin)}))fs.writeFileSync(${JSON.stringify(path.join(f.root, BINDING_FILE))},Buffer.from(${JSON.stringify(changed.toString('base64'))},'base64'));return response;};
await runArtifactCommand(${JSON.stringify(skillDir)},process.argv.slice(2));`);
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), changed);
  assert.notEqual(readJson(f.stateFile).pid, f.unrelated.pid);
  assert.equal(alive(f.unrelated.pid), true);
});

for (const shape of ['missing', 'dead']) for (const noAgent of [false, true]) test(`failed raw startup with ${shape} state cannot fresh-bind on ${noAgent ? 'no-agent' : 'native'} Retry`, async t => {
  const f = await fixture(t), before = await f.capture(), bridgeBytes = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const failedSkill = path.join(f.temporary, 'failed-package/skills/codex-design');
  await fsp.mkdir(path.join(failedSkill, 'scripts'), { recursive: true });
  const raw = path.join(failedSkill, 'scripts/artifact.mjs');
  const dead = shape === 'dead' ? `fs.writeFileSync(${JSON.stringify(f.stateFile)},JSON.stringify({...${JSON.stringify(f.state)},pid:process.pid}));` : '';
  await fsp.writeFile(raw, `import fs from 'node:fs';${dead}process.stderr.write('FIXTURE_RAW_STARTUP_FAILED\\n');process.exitCode=73;`);
  await fsp.writeFile(f.launcher, `import {runArtifactCommand} from ${JSON.stringify(commandModule)};await runArtifactCommand(${JSON.stringify(failedSkill)},process.argv.slice(2));`);
  const args = ['open-service', f.root, ...(noAgent ? ['--no-agent'] : [])];
  const first = await f.execute(args);
  assert.equal(first.code, 73); assert.match(first.stderr, /FIXTURE_RAW_STARTUP_FAILED/);
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridgeBytes);
  assert.equal((await f.backups()).length, 1);
  const stateAfterFailure = await fsp.readFile(f.stateFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (shape === 'dead') assert.equal(alive(JSON.parse(stateAfterFailure).pid), false);
  else assert.equal(stateAfterFailure, null);
  const unexpected = path.join(f.root, 'unexpected-retry-start');
  await fsp.writeFile(raw, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(unexpected)},'must not run');process.exitCode=74;`);
  const retry = await f.execute(args);
  assert.equal(retry.code, 2); assert.match(retry.stderr, /EDITOR_IDENTITY_UNVERIFIED/); assert.match(retry.stderr, /previous data-service recovery/);
  assert.equal(fs.existsSync(unexpected), false);
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridgeBytes);
  assert.deepEqual(await fsp.readFile(f.stateFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), stateAfterFailure);
  await f.assertProtected(before);
});

test('an ordinary dead-PID record without a refused backup keeps the existing fresh-start behavior', { timeout: 40_000 }, async t => {
  const f = await fixture(t), before = await f.capture();
  f.unrelated.kill();
  await new Promise(resolve => f.unrelated.once('exit', resolve));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).recovered, undefined);
  assert.notEqual(readJson(f.stateFile).pid, f.unrelated.pid);
  assert.deepEqual(await f.backups(), []);
  await f.assertProtected(before);
});
