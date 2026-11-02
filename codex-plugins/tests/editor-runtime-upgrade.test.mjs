import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {alive, BINDING_FILE, readJson, runBounded} from '../source/scripts/bridge-core.mjs';
import {verifyEditorInstance} from '../source/scripts/artifact-command.mjs';
import {NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE} from '../source/scripts/worker-core.mjs';
import {createFixture} from './fixtures.mjs';

const commandModule = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;
const cleanEnv = {...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: ''};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, {health = 'legacy', mode = '', noNative = false} = {}) {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-upgrade-'));
  const artifact = await createFixture('design', temporary);
  const stateFile = path.join(artifact.root, '.artifact-server.json');
  const currentSkill = path.join(temporary, 'current package/skills/codex-design');
  const scripts = path.join(currentSkill, 'scripts');
  await fsp.mkdir(scripts, {recursive: true});
  const runtimeFile = path.join(temporary, 'runtime-fixture.mjs');
  await fsp.writeFile(runtimeFile, `import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
const [root,mode]=process.argv.slice(2);
const health=()=>({pid:process.pid,root,kind:mode==='wrong-kind'?'slides':'design',...(mode==='legacy'?{}:{nativeSessionVersion:mode==='v1'?1:mode==='future'?3:2,nativeLocalOnly:mode!=='nonlocal'})});
const server=http.createServer((request,response)=>{if(request.url!=='/design/fixture-grant/__codex/editor-session'){response.writeHead(404).end();return;}response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(health()));});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(path.join(root,'.artifact-server.json'),JSON.stringify({kind:'design',root,pid:process.pid,url:'http://127.0.0.1:'+server.address().port+'/design/fixture-grant/',startedAt:new Date().toISOString()},null,2)+'\\n');});
`);
  const old = spawn(process.execPath, [runtimeFile, artifact.root, health], {cwd: temporary, windowsHide: true, stdio: 'ignore'});
  await new Promise((resolve, reject) => {old.once('spawn', resolve); old.once('error', reject);});
  const oldClosed = new Promise(resolve => old.once('close', resolve));
  const until = Date.now() + 10_000;
  while (readJson(stateFile)?.pid !== old.pid && Date.now() < until) await pause(20);
  assert.equal(readJson(stateFile)?.pid, old.pid);
  const originalState = await fsp.readFile(stateFile);
  const bridge = {version: 1, root: artifact.root, skillDir: ['v2', 'nonlocal', 'future'].includes(health) ? currentSkill : path.join(temporary, 'removed package/skills/codex-design'),
    serverPid: old.pid, threadId: null, token: randomUUID(), deliveryMode: 'native', createdAt: new Date().toISOString(), retained: 'Keep original runtime metadata.'};
  const native = {version: 1, root: artifact.root, skillDir: path.join(temporary, 'previous package/skills/codex-design'), threadId: randomUUID(),
    token: randomUUID(), deliveryMode: 'native', requestProtocol: 'native-draft-v1'};
  native.nativeParentThreadId = native.threadId;
  const registry = {version: 1, root: artifact.root, nativeThreadId: randomUUID(), originThreadId: native.threadId,
    registrationId: randomUUID(), name: 'isolated upgrade fixture', status: 'paused'};
  await fsp.writeFile(path.join(artifact.root, BINDING_FILE), JSON.stringify(bridge, null, 2) + '\n');
  if (!noNative) {
    await fsp.writeFile(path.join(artifact.root, NATIVE_BINDING_FILE), JSON.stringify(native, null, 2) + '\n');
    await fsp.writeFile(path.join(artifact.root, WORKER_FILE), JSON.stringify(registry, null, 2) + '\n');
  }
  await fsp.writeFile(path.join(artifact.root, WORKER_JOBS_FILE), JSON.stringify({version: 1, jobs: {done: {id: 'done', status: 'completed', event: {kind: 'comment', data: {id: 'fixture'}}}}, order: ['done']}) + '\n');
  await fsp.writeFile(path.join(artifact.root, 'comments.json'), JSON.stringify({version: 1, threads: [{id: 'fixture', status: 'open', messages: [{author: {kind: 'user'}, text: 'Preserve this comment.'}]}]}) + '\n');
  const calls = path.join(temporary, 'raw-calls.jsonl');
  const raw = path.join(scripts, 'artifact.mjs');
  await fsp.writeFile(raw, `import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const [command,root]=process.argv.slice(2),file=path.join(root,'.artifact-server.json'),mode=process.env.FIXTURE_UPGRADE_MODE;
const read=()=>{try{return JSON.parse(fs.readFileSync(file));}catch{return null;}},alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}},wait=ms=>new Promise(r=>setTimeout(r,ms));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({command,native:process.env.CODEX_DESIGN_NATIVE_SESSION})+'\\n');
if(command==='stop'){const state=read();if(mode==='stop-fail'){console.log(JSON.stringify({stopped:false,pid:state.pid}));}
else{process.kill(state.pid);const end=Date.now()+5000;while(alive(state.pid)&&Date.now()<end)await wait(20);if(alive(state.pid))throw Error('fixture failed to stop');if(mode==='stop-mutates-native'){const n=path.join(root,'.codex-design-native-binding.json');fs.writeFileSync(n,JSON.stringify({...JSON.parse(fs.readFileSync(n)),externalRevision:'Preserve concurrent controller metadata'})+'\\n');}fs.rmSync(file);console.log(JSON.stringify({stopped:true,pid:state.pid}));}}
else if(command==='open'||command==='serve'){const before=read();if(before&&alive(before.pid)){console.log(JSON.stringify({...before,reused:true}));}
else if(mode==='startup-fail'||mode==='startup-dead'){if(mode==='startup-dead')fs.writeFileSync(file,JSON.stringify({root,kind:'design',pid:process.pid,url:'http://127.0.0.1:1/design/dead/'}));console.error('FIXTURE_STARTUP_FAILED');process.exitCode=73;}
else{const child=spawn(process.execPath,[${JSON.stringify(runtimeFile)},root,mode==='startup-nonlocal'?'nonlocal':'v2'],{cwd:root,env:process.env,detached:true,windowsHide:true,stdio:'ignore'});child.unref();const end=Date.now()+10000;while(read()?.pid!==child.pid&&Date.now()<end)await wait(20);if(read()?.pid!==child.pid)throw Error('fixture failed to start');console.log(JSON.stringify(read()));}}
else throw Error('unexpected fixture command '+command);
`);
  const launcher = path.join(temporary, 'source-cli.mjs');
  const writeLauncher = prelude => fsp.writeFile(launcher, `import fs from 'node:fs';\n${prelude}\nimport {runArtifactCommand} from ${JSON.stringify(commandModule)};await runArtifactCommand(${JSON.stringify(currentSkill)},process.argv.slice(2));\n`);
  await writeLauncher('');
  const execute = (args, extra = {}) => runBounded({command: process.execPath, args: [launcher]}, args,
    {env: {...cleanEnv, FIXTURE_UPGRADE_MODE: mode, ...extra}, cwd: temporary, timeoutMs: 25_000});
  const protectedNames = [NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE, 'comments.json', artifact.contentFile];
  const capture = async () => new Map(await Promise.all(protectedNames.map(async name => [name, await fsp.readFile(path.join(artifact.root, name)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))])));
  const assertProtected = async captured => {
    for (const [name, bytes] of captured) assert.deepEqual(await fsp.readFile(path.join(artifact.root, name)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), bytes, name);
  };
  const backups = async () => (await fsp.readdir(artifact.root)).filter(name => name.startsWith('.artifact-server.upgrade-'));
  const rawCalls = async () => (await fsp.readFile(calls, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  t.after(async () => {
    const state = readJson(stateFile);
    if (state && state.pid !== old.pid && alive(state.pid)) {
      await verifyEditorInstance(state, artifact.root, 'design');
      const stopped = await execute(['stop', artifact.root, '--no-agent'], {FIXTURE_UPGRADE_MODE: ''});
      assert.equal(stopped.code, 0, stopped.stderr);
      assert.equal(alive(state.pid), false);
    }
    if (old.exitCode === null && old.signalCode === null) old.kill();
    await oldClosed;
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fsp.rm(temporary, {recursive: true, force: true});
  });
  return {...artifact, temporary, stateFile, originalState, old, bridge, native, registry, currentSkill, execute, capture, assertProtected, backups, rawCalls, writeLauncher};
}

for (const noAgent of [false, true]) test(`an idle verified legacy native service upgrades through raw stop/start with ${noAgent ? 'no-agent' : 'normal'} internal open`, {timeout: 40_000}, async t => {
  const f = await fixture(t), before = await f.capture();
  const result = await f.execute(['open-service', f.root, ...(noAgent ? ['--no-agent'] : [])]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout), fresh = readJson(f.stateFile);
  assert.equal(output.runtimeUpgraded, true); assert.equal(output.pid, fresh.pid); assert.notEqual(fresh.pid, f.old.pid);
  assert.equal(alive(f.old.pid), false);
  assert.equal((await verifyEditorInstance(fresh, f.root, 'design')).nativeLocalOnly, true);
  const {serverPid, skillDir, ...bridge} = readJson(path.join(f.root, BINDING_FILE));
  const {serverPid: _oldPid, skillDir: _oldSkill, ...expected} = f.bridge;
  assert.deepEqual(bridge, expected); assert.equal(serverPid, fresh.pid); assert.equal(skillDir, f.currentSkill);
  await f.assertProtected(before);
  assert.equal((await f.backups()).length, 1);
  assert.deepEqual(await fsp.readFile(path.join(f.root, (await f.backups())[0])), f.originalState);
  assert.deepEqual((await f.rawCalls()).map(call => call.command), ['stop', 'open']);
  assert.ok((await f.rawCalls()).every(call => call.native === '1'));
});

test('a declared v1 native runtime upgrades, including artwork with no registered request controller', async t => {
  const f = await fixture(t, {health: 'v1', noNative: true}), before = await f.capture();
  const result = await f.execute(['open-service', f.root, '--no-agent']);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).runtimeUpgraded, true);
  await f.assertProtected(before);
});

for (const noAgent of [false, true]) test(`a current v2 local runtime is reused without retirement (${noAgent ? 'no-agent' : 'normal'})`, async t => {
  const f = await fixture(t, {health: 'v2'}), before = await f.capture();
  const result = await f.execute(['open-service', f.root, ...(noAgent ? ['--no-agent'] : [])]);
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).reused, true);
  assert.equal(readJson(f.stateFile).pid, f.old.pid); assert.deepEqual(await f.backups(), []);
  assert.equal((await f.rawCalls()).some(call => call.command === 'stop'), false); await f.assertProtected(before);
});

for (const health of ['nonlocal', 'future', 'wrong-kind']) test(`a ${health} live endpoint cannot authorize retirement`, async t => {
  const f = await fixture(t, {health}), before = await f.capture();
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /EDITOR_IDENTITY_UNVERIFIED/);
  assert.equal(alive(f.old.pid), true); assert.deepEqual(await f.rawCalls(), []); assert.deepEqual(await f.backups(), []); await f.assertProtected(before);
});

for (const shape of ['no-bridge', 'main-bridge', 'wrong-pid', 'active', 'pending', 'orphan-active', 'listener', 'expired-listener', 'wrong-origin', 'legacy-registry']) test(`${shape} state prevents old-runtime retirement and preserves all ownership`, async t => {
  const f = await fixture(t);
  if (shape === 'no-bridge') await fsp.rm(path.join(f.root, BINDING_FILE));
  if (shape === 'main-bridge') await fsp.writeFile(path.join(f.root, BINDING_FILE), JSON.stringify({...f.bridge, deliveryMode: 'main'}));
  if (shape === 'wrong-pid') await fsp.writeFile(path.join(f.root, BINDING_FILE), JSON.stringify({...f.bridge, serverPid: f.old.pid + 1}));
  if (['active', 'pending', 'orphan-active'].includes(shape)) await fsp.writeFile(path.join(f.root, WORKER_JOBS_FILE), JSON.stringify({version: 1, jobs: {job: {id: 'job', status: shape === 'pending' ? 'pending' : 'active', event: {kind: 'comment', data: {id: 'fixture'}}}}, order: shape === 'orphan-active' ? [] : ['job']}));
  if (shape === 'listener' || shape === 'expired-listener') await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({...f.registry, listener: {pid: f.old.pid, expiresAt: Date.now() + (shape === 'listener' ? 60000 : -60000)}}));
  if (shape === 'wrong-origin') await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({...f.registry, originThreadId: randomUUID()}));
  if (shape === 'legacy-registry') await fsp.writeFile(path.join(f.root, WORKER_FILE), JSON.stringify({...f.registry, pid: f.old.pid, token: ''}));
  const before = await f.capture(), state = await fsp.readFile(f.stateFile), bridge = await fsp.readFile(path.join(f.root, BINDING_FILE)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const result = await f.execute(['open-service', f.root, '--no-agent']);
  assert.equal(result.code, 2); assert.equal(alive(f.old.pid), true);
  assert.deepEqual(await f.rawCalls(), []); assert.deepEqual(await f.backups(), []);
  assert.deepEqual(await fsp.readFile(f.stateFile), state);
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), bridge);
  await f.assertProtected(before);
});

for (const source of ['preview', 'custom-hook', 'main', 'foreground']) test(`${source} entry does not silently replace an old live service`, async t => {
  const f = await fixture(t), before = await f.capture();
  const args = source === 'preview' ? ['preview', f.root, '--no-agent'] : source === 'foreground' ? ['serve-service', f.root, '--no-agent'] : ['open-service', f.root, ...(source === 'custom-hook' ? ['--agent-hook', 'must-not-run'] : ['--delivery', 'main', '--thread', f.native.threadId])];
  const result = await f.execute(args);
  assert.equal(result.code, source === 'preview' ? 0 : 2, result.stderr);
  assert.equal(alive(f.old.pid), true); assert.equal((await f.rawCalls()).some(call => call.command === 'stop'), false);
  assert.deepEqual(await f.backups(), []); await f.assertProtected(before);
});

for (const control of ['state', 'native-binding', 'comments']) test(`a concurrent ${control} replacement during the locked health recheck prevents any stop`, async t => {
  const f = await fixture(t);
  const file = control === 'state' ? f.stateFile : path.join(f.root, control === 'comments' ? 'comments.json' : NATIVE_BINDING_FILE);
  const changed = control === 'state' ? {...readJson(file), external: 'Preserve replacement'} : control === 'native-binding' ? {...f.native, token: randomUUID()} : {version: 1, threads: [], external: 'Preserve newer comments'};
  const bytes = JSON.stringify(changed) + '\n';
  await f.writeLauncher(`const original=globalThis.fetch;let reads=0;globalThis.fetch=async(...args)=>{const result=await original(...args);if(++reads===2)fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(bytes)});return result;};`);
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.equal(alive(f.old.pid), true); assert.deepEqual(await f.rawCalls(), []);
  assert.equal(await fsp.readFile(file, 'utf8'), bytes); assert.deepEqual(await f.backups(), []);
});

for (const mode of ['startup-fail', 'startup-dead']) test(`a ${mode} raw upgrade preserves bindings and blocks silent fresh-binding on Retry`, async t => {
  const f = await fixture(t, {mode}), before = await f.capture(), bridge = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const args = ['open-service', f.root, '--no-agent'];
  const first = await f.execute(args);
  assert.equal(first.code, 73, first.stderr); assert.match(first.stderr, /FIXTURE_STARTUP_FAILED/);
  assert.equal(alive(f.old.pid), false); assert.equal((await f.backups()).length, 1);
  const state = await fsp.readFile(f.stateFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const retried = await f.execute(args);
  assert.equal(retried.code, 2); assert.match(retried.stderr, /previous data-service upgrade/);
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridge);
  assert.deepEqual(await fsp.readFile(f.stateFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), state);
  assert.deepEqual((await f.rawCalls()).map(call => call.command), ['stop', 'open']); await f.assertProtected(before);
});

test('a raw stop refusal preserves the live service without creating a startup archive', async t => {
  const f = await fixture(t, {mode: 'stop-fail'}), before = await f.capture();
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.equal(alive(f.old.pid), true); assert.deepEqual(await f.backups(), []);
  assert.deepEqual((await f.rawCalls()).map(call => call.command), ['stop']); await f.assertProtected(before);
});

test('a nonlocal replacement is reported as an incomplete upgrade without inventing a new controller', async t => {
  const f = await fixture(t, {mode: 'startup-nonlocal'}), before = await f.capture(), bridge = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.match(result.stderr, /old data service was retired/);
  assert.equal(alive(f.old.pid), false); assert.equal((await f.backups()).length, 1);
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridge); await f.assertProtected(before);
});

test('a controller replacement during raw stop is preserved and leaves failed-upgrade evidence before Retry', async t => {
  const f = await fixture(t, {mode: 'stop-mutates-native'}), bridge = await fsp.readFile(path.join(f.root, BINDING_FILE));
  const result = await f.execute(['open-service', f.root, '--no-agent']);
  assert.equal(result.code, 2); assert.match(result.stderr, /old data service was retired/);
  assert.equal(alive(f.old.pid), false); assert.equal((await f.backups()).length, 1);
  const changed = await fsp.readFile(path.join(f.root, NATIVE_BINDING_FILE));
  assert.equal(JSON.parse(changed).externalRevision, 'Preserve concurrent controller metadata');
  assert.deepEqual(await fsp.readFile(path.join(f.root, BINDING_FILE)), bridge);
  const retry = await f.execute(['open-service', f.root, '--no-agent']);
  assert.equal(retry.code, 2); assert.match(retry.stderr, /previous data-service upgrade/);
  assert.deepEqual(await fsp.readFile(path.join(f.root, NATIVE_BINDING_FILE)), changed);
  assert.deepEqual((await f.rawCalls()).map(call => call.command), ['stop']);
});

test('independent CLI upgrades serialize retirement and reuse one fresh native runtime', {timeout: 40_000}, async t => {
  const f = await fixture(t), before = await f.capture();
  const results = await Promise.all([f.execute(['open-service', f.root]), f.execute(['open-service', f.root])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const outputs = results.map(result => JSON.parse(result.stdout));
  assert.equal(outputs[0].pid, outputs[1].pid);
  assert.equal(outputs.filter(output => output.runtimeUpgraded).length, 1);
  assert.equal(outputs.filter(output => output.reused).length, 1);
  assert.equal((await f.rawCalls()).filter(call => call.command === 'stop').length, 1);
  assert.equal((await f.backups()).length, 1); await f.assertProtected(before);
});

test('aliased upgrade control files cannot authorize a process stop', async t => {
  const f = await fixture(t);
  await fsp.link(path.join(f.root, NATIVE_BINDING_FILE), path.join(f.temporary, 'native-binding-hardlink.json'));
  const result = await f.execute(['open-service', f.root]);
  assert.equal(result.code, 2); assert.equal(alive(f.old.pid), true);
  assert.deepEqual(await f.rawCalls(), []); assert.deepEqual(await f.backups(), []);
});
