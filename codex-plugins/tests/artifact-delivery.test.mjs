import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from '../source/library/index.mjs';
import { artworkAppUrl, requestAppNavigation, openArtworkInApp, normalizeControlHints } from '../source/scripts/artifact-delivery.mjs';
import { openLocalEditor } from '../source/server/service.mjs';

const run = promisify(execFile);
const packageRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const commandModule = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;
const libraryModule = new URL('../source/library/index.mjs', import.meta.url).href;
const kinds = ['slides', 'design', 'design-system', 'dashboard'];

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-delivery-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(temporary, { recursive: true, force: true }); });
  const libraryRoot = path.join(temporary, '作品 library');
  const store = createLibraryStore({ root: libraryRoot }); await store.initialize();
  const trace = path.join(temporary, 'navigation.jsonl');
  const runner = async kind => {
    const skillDir = path.join(packageRoot, 'skills', `codex-${kind}`);
    const script = path.join(temporary, `${kind}-runner.mjs`);
    await fs.writeFile(script, `import fs from 'node:fs';import{runArtifactCommand}from ${JSON.stringify(commandModule)};import{createLibraryStore}from ${JSON.stringify(libraryModule)};await runArtifactCommand(${JSON.stringify(skillDir)},process.argv.slice(2),{libraryStore:createLibraryStore({root:${JSON.stringify(libraryRoot)}}),navigate:async appUrl=>{fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({appUrl})+'\\n');return{navigationRequested:true}}});`);
    return (...args) => run(process.execPath, [script, ...args], { windowsHide: true, timeout: 25_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CODEX_THREAD_ID: '' } });
  };
  return { temporary, libraryRoot, store, trace, runner };
}

test('all four public open/check commands keep native delivery and never start a service, chat or worker', async t => {
  const f = await fixture(t);
  for (const kind of kinds) {
    const artwork = await f.store.create({ kind, title: `测试 ${kind} %title%` });
    const execute = await f.runner(kind);
    const beforeTrace = await fs.readFile(f.trace, 'utf8').catch(() => '');
    const checked = JSON.parse((await execute('check', artwork.path)).stdout);
    assert.equal(checked.problems, 0); assert.equal(checked.nativeAvailable, true);
    assert.equal(checked.appUrl, artworkAppUrl(artwork.id)); assert.equal(checked.navigationRequested, false);
    assert.match(checked.next, /codex-artifact\.mjs/); assert.match(checked.next, / open /);
    assert.doesNotMatch(checked.next, /127\.0\.0\.1|localhost|(?<!codex-)artifact\.mjs/);
    assert.equal(await fs.readFile(f.trace, 'utf8').catch(() => ''), beforeTrace, 'check must not navigate');
    const opened = JSON.parse((await execute('open', artwork.path)).stdout);
    assert.equal(opened.appUrl, checked.appUrl); assert.equal(opened.navigationRequested, true); assert.equal(opened.renderVerified, false);
    assert.equal(opened.url, undefined);
    assert.deepEqual((await fs.readdir(artwork.path)).sort(), ['artifact.json', kind === 'dashboard' ? 'db' : 'project'].sort());
  }
  assert.equal((await fs.readFile(f.trace, 'utf8')).trim().split('\n').length, 4);
});

test('legacy explicit folders stay in place and require explicit preview/import instead of a web fallback', async t => {
  const f = await fixture(t), record = await f.store.create({ kind: 'slides', title: 'Legacy copy fixture' });
  const legacy = path.join(f.temporary, 'existing project'); await fs.cp(record.path, legacy, { recursive: true });
  const execute = await f.runner('slides'), before = (await fs.readdir(legacy)).sort();
  const checked = JSON.parse((await execute('check', legacy)).stdout);
  assert.equal(checked.problems, 0); assert.equal(checked.nativeAvailable, false); assert.equal(checked.appUrl, null);
  assert.match(checked.next, /explicit import/); assert.match(checked.next, / preview /);
  await assert.rejects(execute('open', legacy), error => {
    const detail = JSON.parse(error.stderr); assert.equal(error.code, 2); assert.equal(detail.error, 'NATIVE_ARTIFACT_REQUIRED');
    assert.equal(detail.navigationRequested, false); assert.equal(detail.appUrl, null); return true;
  });
  assert.deepEqual((await fs.readdir(legacy)).sort(), before); assert.equal((await f.store.list()).length, 1);
  assert.equal(await fs.readFile(f.trace, 'utf8').catch(() => ''), '');
});

test('a failing structural check preserves diagnostics and its exit status while returning the same native artwork identity', async t => {
  const f = await fixture(t), artwork = await f.store.create({ kind: 'slides', title: 'Broken validation fixture' });
  await fs.rm(path.join(artwork.path, 'project/deck.json'));
  const execute = await f.runner('slides');
  await assert.rejects(execute('check', artwork.path), error => {
    assert.equal(error.code, 1);
    const result = JSON.parse(error.stdout);
    assert.equal(result.problems, 1); assert.ok(result.deckProblems[0].includes('deck.json'));
    assert.equal(result.appUrl, artworkAppUrl(artwork.id)); assert.equal(result.navigationRequested, false);
    assert.match(result.next, /codex-artifact\.mjs.* check /);
    return true;
  });
  assert.equal(await fs.readFile(f.trace, 'utf8').catch(() => ''), '');
});

test('Dashboard write-db hints return to the same public check wrapper instead of bypassing native delivery', async t => {
  const f = await fixture(t), artwork = await f.store.create({ kind: 'dashboard', title: 'Dashboard control hints' });
  const execute = await f.runner('dashboard'), batch = path.join(f.temporary, 'batch.json');
  const document = JSON.parse(await fs.readFile(path.join(artwork.path, 'db/files/index.html.json'), 'utf8'));
  await fs.writeFile(batch, JSON.stringify([{ op: 'set', path: 'files/index.html', data: document }]));
  const result = JSON.parse((await execute('write-db', artwork.path, batch)).stdout);
  assert.match(result.next, /codex-artifact\.mjs.* check /);
  assert.doesNotMatch(result.next, /(?<!codex-)artifact\.mjs|127\.0\.0\.1/);
});

test('public help and explicit preview cannot accidentally run the native opener or fall back from it', async t => {
  const f = await fixture(t), skill = path.join(f.temporary, 'skills/codex-design'), legacy = path.join(f.temporary, 'legacy');
  await fs.mkdir(path.join(skill, 'scripts'), { recursive: true }); await fs.mkdir(legacy);
  const canonicalCalls = path.join(f.temporary, 'canonical-calls.jsonl');
  await fs.writeFile(path.join(skill, 'scripts/artifact.mjs'), `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(canonicalCalls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(JSON.stringify({url:'http://127.0.0.1:2345/design/explicit-preview/'}));`);
  const script = path.join(f.temporary, 'preview-runner.mjs');
  await fs.writeFile(script, `import{runArtifactCommand}from ${JSON.stringify(commandModule)};await runArtifactCommand(${JSON.stringify(skill)},process.argv.slice(2),{navigate:async()=>{throw Error('A web preview must not request native navigation')}});`);
  const execute = (...args) => run(process.execPath, [script, ...args], { windowsHide: true, timeout: 10_000 });
  const help = (await execute('--help')).stdout;
  assert.match(help, /request the native Codex Design/); assert.match(help, /preview <root>/);
  assert.equal(await fs.readFile(canonicalCalls, 'utf8').catch(() => ''), '');
  await assert.rejects(execute('open', legacy), error => JSON.parse(error.stderr).error === 'NATIVE_ARTIFACT_REQUIRED');
  assert.equal(await fs.readFile(canonicalCalls, 'utf8').catch(() => ''), '');
  assert.match(JSON.parse((await execute('preview', legacy, '--no-agent')).stdout).url, /^http:\/\/127\.0\.0\.1:/);
  assert.deepEqual(JSON.parse((await fs.readFile(canonicalCalls, 'utf8')).trim()), ['open', legacy]);
});

test('native open preserves existing service and worker records even when their task is active', async t => {
  const f = await fixture(t), record = await f.store.create({ kind: 'design', title: 'Active work' });
  const files = ['.artifact-server.json', '.codex-design-bridge.json', '.codex-design-worker-jobs.json'];
  for (const name of files) await fs.writeFile(path.join(record.path, name), JSON.stringify({ pid: process.pid, token: 'preserve', active: true }));
  const before = await Promise.all(files.map(name => fs.readFile(path.join(record.path, name), 'utf8')));
  const skillDir = path.join(packageRoot, 'skills/codex-design'); let calls = 0;
  const result = await openArtworkInApp(skillDir, record.path, 'design', { libraryRoot: f.libraryRoot, navigate: async () => { calls++; } });
  assert.equal(result.navigationRequested, true); assert.equal(calls, 1);
  assert.deepEqual(await Promise.all(files.map(name => fs.readFile(path.join(record.path, name), 'utf8'))), before);
});

test('native OS launch is shell-free, portable and preserves the percent-encoded URI as data', async () => {
  const uri = artworkAppUrl('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  for (const platform of ['win32', 'darwin', 'linux']) {
    let actual;
    const result = await requestAppNavigation(uri, { platform, env: { SystemRoot: 'D:\\Windows' }, spawnProcess(command, args, options) {
      actual = { command, args, options }; const child = new EventEmitter(); child.kill = () => {};
      queueMicrotask(() => child.emit('close', 0)); return child;
    } });
    assert.equal(actual.options.shell, false); assert.equal(actual.options.windowsHide, true);
    assert.equal(result.navigationRequested, true); assert.equal(result.renderVerified, false);
    if (platform === 'win32') {
      assert.match(actual.command, /^D:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      assert.equal(actual.options.env.CODEX_DESIGN_OPEN_URI, uri); assert.ok(!actual.args.includes(uri));
      assert.ok(!actual.args.some(arg => /cmd(?:\.exe)?/i.test(arg))); assert.ok(uri.includes('%2Fartifacts%2F'));
    } else assert.equal(actual.args[0], uri);
  }
  assert.throws(() => requestAppNavigation('https://example.com/'), { code: 'INVALID_APP_URL' });
});

test('failed OS navigation keeps the native appUrl and never falls back to an HTTP service', async t => {
  const f = await fixture(t), record = await f.store.create({ kind: 'dashboard', title: 'Navigation failure' });
  await assert.rejects(openArtworkInApp('codex-dashboard', record.path, 'dashboard', { libraryRoot: f.libraryRoot, navigate: async () => { throw Object.assign(new Error('No app handler'), { code: 'APP_NAVIGATION_FAILED' }); } }), error => {
    assert.equal(error.appUrl, artworkAppUrl(record.id)); assert.equal(error.navigationRequested, false); return true;
  });
  assert.deepEqual((await fs.readdir(record.path)).sort(), ['artifact.json', 'db']);
});

test('only command hints are normalized; upload URLs and source data are preserved', () => {
  const skillDir = path.resolve('temporary skill'), raw = path.join(skillDir, 'scripts/artifact.mjs');
  const source = { url: '/_blob/0123456789abcdef0123456789abcdef', source: { url: 'https://example.com/data.csv' }, next: `Run node ${JSON.stringify(raw)} check root.` };
  const output = normalizeControlHints(source, raw, skillDir, 'root');
  assert.match(output.next, /codex-artifact\.mjs/); assert.equal(output.url, source.url); assert.equal(output.source, source.source);
  assert.equal(source.next.includes('codex-artifact'), false);
});

test('MCP internal startup uses open-service and retains native delivery without invoking the public opener', async t => {
  const f = await fixture(t), record = await f.store.create({ kind: 'slides', title: 'Internal startup' });
  let args;
  const result = await openLocalEditor(record, { pluginRoot: packageRoot, spawnProcess(_command, argv, options) {
    args = argv; assert.equal(options.shell, false); const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:1234/slides/grant/' })); child.emit('close', 0); }); return child;
  } });
  assert.equal(args[1], 'open-service'); assert.deepEqual(args.slice(2), [record.path, '--delivery', 'native']);
  assert.equal(result.delivery, 'native'); assert.match(result.url, /^http:\/\/127\.0\.0\.1:/);
});
