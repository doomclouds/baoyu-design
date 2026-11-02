import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibraryStore } from '../source/library/index.mjs';
import { createEditRequestStore } from '../source/library/edit-requests.mjs';
import { atomicJson, normalizeEvent, readJson } from '../source/scripts/bridge-core.mjs';
import { NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE, userRevisionHash } from '../source/scripts/worker-core.mjs';

const PARENT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const source = fileURLToPath(new URL('../source/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);

async function removeOwned(directory, selected) {
  const relative = path.relative(path.resolve(directory), path.resolve(selected));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  await fs.rm(selected, { recursive: true, force: true });
}

async function packageAt(root, version) {
  await fs.mkdir(root, { recursive: true });
  for (const name of ['scripts', 'library']) await fs.cp(path.join(source, name), path.join(root, name), { recursive: true });
  const skillDir = path.join(root, 'skills/codex-design');
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'A disposable packaged design skill. Read current artwork and check it.');
  await fs.writeFile(path.join(skillDir, 'scripts/codex-artifact.mjs'), "import {runArtifactCommand} from '../../../scripts/artifact-command.mjs';\n");
  await fs.writeFile(path.join(skillDir, 'scripts/artifact.mjs'), '// Disposable checker entry, never executed by this fixture.\n');
  await fs.mkdir(path.join(root, '.codex-plugin'), { recursive: true });
  atomicJson(path.join(root, 'plugin.json'), { name: 'codex-design', version, repository: 'https://github.com/doomclouds/baoyu-design' });
  atomicJson(path.join(root, '.codex-plugin/plugin.json'), { name: 'codex-design', version, skills: './skills/', mcpServers: './mcp.json' });
  atomicJson(path.join(root, 'mcp.json'), { mcpServers: { 'codex-design': { command: 'node', args: ['${PLUGIN_ROOT}/server/index.mjs'] } } });
  await refreshManifest(root);
  return { root, skillDir,
    dispatch: await import(pathToFileURL(path.join(root, 'scripts/edit-request-dispatch.mjs')).href),
    worker: await import(pathToFileURL(path.join(root, 'scripts/worker-client.mjs')).href) };
}

async function refreshManifest(root) {
  const files = {};
  const visit = async (directory, relative = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else if (name !== '.generated-manifest.json') files[name] = hash(await fs.readFile(path.join(directory, entry.name)));
    }
  };
  await visit(root);
  atomicJson(path.join(root, '.generated-manifest.json'), { generator: 'codex-design-build-v1', version: 1, files });
}

async function fixture(t, { oldVersion = '1.2.0', newVersion = '1.3.0', portable = false, marketplace = 'codex-design-marketplace' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-request-upgrade-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const home = path.join(directory, 'Home 目录/.codex');
  const family = portable ? path.join(directory, 'portable packages') : path.join(home, 'plugins/cache', marketplace, 'codex-design');
  const old = await packageAt(path.join(family, portable ? 'old complete package' : oldVersion), oldVersion);
  const current = await packageAt(path.join(family, portable ? 'new complete package' : newVersion), newVersion);
  const env = { CODEX_THREAD_ID: PARENT, CODEX_HOME: home }, childEnv = { CODEX_THREAD_ID: CHILD };
  const store = createLibraryStore({ root: path.join(directory, 'Library') });
  const artifact = await store.create({ kind: 'design', title: 'Upgrade QA' });
  const root = artifact.path;
  await fs.writeFile(path.join(root, 'project/Main.dc.html'), '<main><h1>Current fixture content</h1></main>');
  const thread = (id, text) => ({ id, status: 'open', location: { file: 'project/Main.dc.html' }, label: 'Heading',
    messages: [{ id: 'm_' + id, author: { kind: 'user' }, text, at: '2026-11-02T00:00:00.000Z' }] });
  atomicJson(path.join(root, 'comments.json'), { version: 1, threads: [thread('c_done', 'Earlier accepted fixture request.'), thread('c_next', 'The separately submitted next request.')] });
  const requests = createEditRequestStore({ store });
  const done = await requests.prepare({ artifactId: artifact.id, commentId: 'c_done' });
  await requests.accept(done.id);
  const queued = await old.dispatch.dispatchEditRequest(old.skillDir, root, done.id, { env, store });
  await old.worker.registerNativeWorker(root, { env: childEnv });
  await old.worker.nextNativeJob(root, { env: childEnv, timeoutSeconds: 0 });
  const replies = [];
  const postReply = async (_binding, id, text, expected) => {
    const comments = readJson(path.join(root, 'comments.json'));
    const comment = comments.threads.find(item => item.id === id);
    assert.equal(userRevisionHash(normalizeEvent(comment)), expected);
    comment.messages.push({ author: { kind: 'agent' }, text, at: new Date().toISOString() });
    atomicJson(path.join(root, 'comments.json'), comments); replies.push({ id, text });
  };
  await old.worker.completeNativeJob(root, queued.jobId, 'Earlier fixture request completed.', { env: childEnv, postReply });
  const request = await requests.prepare({ artifactId: artifact.id, commentId: 'c_next' });
  await requests.markDraftAdded(request.id);
  return { directory, home, family, old, current, env, childEnv, store, artifact, root, requests, request, done, queued, replies, postReply,
    dispatch: options => current.dispatch.dispatchEditRequest(current.skillDir, root, request.id, { env, store, ...options }),
    accept: () => requests.accept(request.id),
    binding: () => readJson(path.join(root, NATIVE_BINDING_FILE)),
    registry: () => readJson(path.join(root, WORKER_FILE)),
    jobs: () => readJson(path.join(root, WORKER_JOBS_FILE)),
    removeOld: () => removeOwned(directory, old.root) };
}

async function controlBytes(f) {
  return Promise.all([NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE].map(name => fs.readFile(path.join(f.root, name), 'utf8')));
}

async function oldDirectoryShell(f, tree = false) {
  await f.removeOld();
  await fs.mkdir(tree ? path.join(f.old.root, 'skills/codex-design/scripts') : f.old.root, { recursive: true });
  if (tree) await fs.mkdir(path.join(f.old.root, '.codex-plugin'));
}

async function directoryIdentities(root) {
  const entries = [];
  const visit = async directory => {
    const info = await fs.lstat(directory);
    assert.equal(info.isDirectory(), true); assert.equal(info.isSymbolicLink(), false);
    entries.push({ path: path.relative(root, directory), dev: info.dev, ino: info.ino });
    for (const entry of await fs.readdir(directory)) await visit(path.join(directory, entry));
  };
  await visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

test('actual current CLI dispatch upgrades flat and nested empty old 0.5.2 cache shells without deleting them', async t => {
  for (const tree of [false, true]) {
    const f = await fixture(t, { oldVersion: '0.5.2', newVersion: '0.5.3', marketplace: tree ? 'custom-design-market' : 'codex-design-marketplace' });
    await oldDirectoryShell(f, tree); await f.accept();
    const directories = await directoryIdentities(f.old.root), oldBinding = f.binding(), oldRegistry = f.registry();
    const cli = path.join(f.current.skillDir, 'scripts/codex-artifact.mjs');
    // Use the real packaged command entry/dispatcher. Only the fixture library
    // root is injected, so this child process cannot initialize the user's library.
    await fs.writeFile(cli, "import {runArtifactCommand} from '../../../scripts/artifact-command.mjs';\n"
      + "import {createLibraryStore} from '../../../library/index.mjs';\nimport {fileURLToPath} from 'node:url';\n"
      + `await runArtifactCommand(fileURLToPath(new URL('../',import.meta.url)),process.argv.slice(2),{libraryStore:createLibraryStore({root:${JSON.stringify(f.store.root)}})});\n`);
    await refreshManifest(f.current.root);
    const output = await execute(process.execPath, [cli, 'request-dispatch', f.root, f.request.id], {
      env: { ...process.env, ...f.env }, windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(output.stdout);
    assert.equal(result.accepted, true); assert.equal(result.duplicate, false); assert.equal(result.skillPackageUpgraded, true);
    assert.equal(result.previousPackageBytesVerified, false); assert.equal(result.requiresRegistration, true);
    assert.equal(result.jobId, 'request:' + f.request.id); assert.equal(result.originThreadId, PARENT);
    assert.equal(f.binding().skillDir, f.current.skillDir); assert.equal(f.binding().token, oldBinding.token);
    assert.equal(f.binding().skillUpgrade.fromVersion, '0.5.2'); assert.deepEqual(f.registry(), oldRegistry);
    assert.equal(f.jobs().jobs[f.queued.jobId].status, 'completed'); assert.equal(f.jobs().order.length, 2);
    assert.deepEqual(await directoryIdentities(f.old.root), directories, 'the updater shell is neither deleted nor reconstructed');
    assert.equal((await f.requests.read(f.request.id)).dispatch.jobId, result.jobId);
  }
});

test('an unsent prepared request cannot migrate or remove an exactly empty cache shell', async t => {
  const f = await fixture(t); await oldDirectoryShell(f, true);
  const before = await controlBytes(f), directories = await directoryIdentities(f.old.root);
  await assert.rejects(f.dispatch(), { code: 'REQUEST_NOT_ACCEPTED' });
  assert.deepEqual(await controlBytes(f), before); assert.deepEqual(await directoryIdentities(f.old.root), directories);
  assert.equal((await f.requests.read(f.request.id)).status, 'prepared');
});

test('dot files, zero-byte files, metadata remnants and hardlinked files are not empty updater shells', async t => {
  for (const mode of ['dot-file', 'zero-byte', 'metadata', 'hardlink']) {
    const f = await fixture(t); await oldDirectoryShell(f, true); await f.accept();
    const selected = path.join(f.old.root, mode === 'dot-file' ? '.keep' : mode === 'metadata' ? '.generated-manifest.json' : 'skills/codex-design/scripts/residue.mjs');
    if (mode === 'hardlink') {
      const original = path.join(f.directory, 'outside-shell-sentinel'); await fs.writeFile(original, ''); await fs.link(original, selected);
    } else await fs.writeFile(selected, '');
    const before = await controlBytes(f), identity = await fs.lstat(selected);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' });
    assert.deepEqual(await controlBytes(f), before); assert.equal((await fs.lstat(selected)).ino, identity.ino);
    assert.equal((await fs.readFile(selected)).length, 0, 'no remnant file is deleted to make recovery pass');
  }
});

test('a nonempty old package with changed owned bytes keeps its integrity refusal', async t => {
  const f = await fixture(t); await f.accept();
  await fs.appendFile(path.join(f.old.skillDir, 'SKILL.md'), '\nChanged old package bytes.');
  const before = await controlBytes(f);
  await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' });
  assert.deepEqual(await controlBytes(f), before);
});

test('empty-looking old root and nested junctions cannot authorize the removed-cache fallback', async t => {
  for (const nested of [false, true]) {
    const f = await fixture(t); await oldDirectoryShell(f); await f.accept();
    const target = path.join(f.directory, 'unrelated-empty-directory'); await fs.mkdir(target);
    const link = nested ? path.join(f.old.root, 'skills') : f.old.root;
    if (!nested) await fs.rmdir(f.old.root);
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' });
    assert.deepEqual(await controlBytes(f), before); assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.deepEqual(await fs.readdir(target), []);
  }
});

test('empty portable, different-family and non-older cache shells still need their original package proof', async t => {
  for (const mode of ['portable', 'different-family', 'not-older']) {
    const f = await fixture(t, { portable: mode === 'portable' }); await oldDirectoryShell(f, true); await f.accept();
    if (mode !== 'portable') {
      const oldRoot = mode === 'different-family' ? path.join(f.home, 'plugins/cache/unrelated-market/codex-design/1.2.0') : path.join(f.family, '1.3.0+old');
      await fs.mkdir(path.join(oldRoot, 'skills/codex-design/scripts'), { recursive: true });
      atomicJson(path.join(f.root, NATIVE_BINDING_FILE), { ...f.binding(), skillDir: path.join(oldRoot, 'skills/codex-design') });
    }
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' }); assert.deepEqual(await controlBytes(f), before);
  }
});

test('a prepared request cannot migrate a removed-cache binding or reuse the earlier completed receipt', async t => {
  const f = await fixture(t); await f.removeOld();
  const before = await controlBytes(f);
  await assert.rejects(f.dispatch(), { code: 'REQUEST_NOT_ACCEPTED' });
  assert.deepEqual(await controlBytes(f), before);
  const request = await f.requests.read(f.request.id);
  assert.equal(request.status, 'prepared'); assert.equal(request.acceptedAt, undefined); assert.equal(request.dispatch, undefined);
  assert.equal(f.jobs().order.length, 1); assert.equal(f.jobs().jobs[f.queued.jobId].status, 'completed');
});

test('the accepted same request ID upgrades only its verified removed managed-cache skill and completes through the same native child', async t => {
  const f = await fixture(t); await f.removeOld(); await f.accept();
  const binding = f.binding(), registry = f.registry(), completed = f.jobs().jobs[f.queued.jobId];
  const first = await f.dispatch();
  assert.equal(first.skillPackageUpgraded, true); assert.equal(first.previousPackageBytesVerified, false); assert.equal(first.requiresRegistration, true);
  const upgraded = f.binding();
  assert.equal(upgraded.skillDir, f.current.skillDir); assert.equal(upgraded.threadId, binding.threadId); assert.equal(upgraded.nativeParentThreadId, binding.nativeParentThreadId);
  assert.equal(upgraded.token, binding.token); assert.equal(upgraded.createdAt, binding.createdAt);
  assert.deepEqual(f.registry(), registry); assert.deepEqual(f.jobs().jobs[f.queued.jobId], completed);
  assert.equal(upgraded.skillPackage.version, '1.3.0'); assert.equal(upgraded.skillUpgrade.fromVersion, '1.2.0');
  const receipt = await f.requests.read(f.request.id);
  assert.equal(receipt.id, f.request.id); assert.equal(receipt.dispatch.jobId, 'request:' + f.request.id); assert.notEqual(receipt.dispatch.jobId, f.queued.jobId);
  assert.equal((await f.dispatch()).duplicate, true); assert.equal(f.jobs().order.length, 2);
  const registration = await f.current.worker.registerNativeWorker(f.root, { env: f.childEnv });
  assert.equal(registration.reused, true); assert.equal(registration.nativeThreadId, CHILD); assert.equal(f.registry().registrationId, registry.registrationId);
  const next = await f.current.worker.nextNativeJob(f.root, { env: f.childEnv, timeoutSeconds: 0 });
  assert.equal(next.job.requestId, f.request.id); assert.ok(next.request.includes(f.current.skillDir.replaceAll('\\', '\\\\')));
  await f.current.worker.completeNativeJob(f.root, next.job.id, 'New independently accepted fixture request completed.', { env: f.childEnv, postReply: f.postReply });
  await f.current.worker.completeNativeJob(f.root, next.job.id, 'New independently accepted fixture request completed.', { env: f.childEnv, postReply: f.postReply });
  assert.equal(f.replies.filter(item => item.id === 'c_next').length, 1);
  assert.equal(f.jobs().jobs[next.job.id].status, 'completed');
});

test('complete verified portable packages can upgrade without pretending to be a managed cache', async t => {
  const f = await fixture(t, { portable: true }); await f.accept();
  const result = await f.dispatch();
  assert.equal(result.skillPackageUpgraded, true); assert.equal(result.previousPackageBytesVerified, true);
  assert.equal(f.binding().skillDir, f.current.skillDir);
});

test('a custom marketplace derives its managed cache family without a fixed marketplace display name', async t => {
  const f = await fixture(t, { marketplace: 'my-design-market' }); await f.removeOld(); await f.accept();
  const result = await f.dispatch();
  assert.equal(result.skillPackageUpgraded, true); assert.equal(result.previousPackageBytesVerified, false);
  assert.equal(f.binding().skillDir, f.current.skillDir);
});

test('a coherent fully idle old parent can hand off an upgraded package to the actual new parent without rebinding its child', async t => {
  const f = await fixture(t); await f.removeOld(); await f.accept();
  const oldBinding = f.binding(), registry = f.registry(), completed = f.jobs().jobs[f.queued.jobId];
  const result = await f.dispatch({ env: { ...f.env, CODEX_THREAD_ID: OTHER } });
  assert.equal(result.skillPackageUpgraded, true); assert.equal(result.originThreadId, OTHER); assert.equal(result.requiresRegistration, true);
  const binding = f.binding();
  assert.equal(binding.threadId, OTHER); assert.equal(binding.nativeParentThreadId, OTHER); assert.notEqual(binding.token, oldBinding.token);
  assert.equal(binding.skillDir, f.current.skillDir);
  assert.deepEqual(f.registry(), registry); assert.deepEqual(f.jobs().jobs[f.queued.jobId], completed);
  assert.equal((await f.requests.read(f.done.id)).dispatch.originThreadId, PARENT);
  assert.equal((await f.requests.read(f.request.id)).dispatch.originThreadId, OTHER);
  await assert.rejects(f.current.worker.nextNativeJob(f.root, { env: f.childEnv, timeoutSeconds: 0 }), { code: 'NATIVE_PARENT_CHANGED' });
  const registered = await f.current.worker.registerNativeWorker(f.root, { env: f.childEnv });
  assert.equal(registered.reused, true); assert.equal(registered.nativeThreadId, CHILD); assert.equal(f.registry().registrationId, registry.registrationId);
  const next = await f.current.worker.nextNativeJob(f.root, { env: f.childEnv, timeoutSeconds: 0 });
  assert.equal(next.job.requestId, f.request.id); assert.equal(f.registry().originThreadId, OTHER);
  await f.current.worker.completeNativeJob(f.root, next.job.id, 'The new parent fixture request completed.', { env: f.childEnv, postReply: f.postReply });
  assert.equal(f.replies.filter(item => item.id === 'c_next').length, 1);
});

test('a completed historical request is never replayed as an upgrade or a new queue receipt', async t => {
  const f = await fixture(t); await f.removeOld();
  const before = await controlBytes(f);
  const result = await f.current.dispatch.dispatchEditRequest(f.current.skillDir, f.root, f.done.id, { env: f.env, store: f.store });
  assert.equal(result.duplicate, true); assert.equal(result.status, 'completed');
  assert.deepEqual(await controlBytes(f), before); assert.equal((await f.requests.read(f.request.id)).status, 'prepared');
});

test('migration refuses active jobs, live listeners and reserved writer states without changing ownership', async t => {
  for (const mode of ['job', 'listener', 'active-id', 'active-status', 'handoff-listener']) {
    const f = await fixture(t); await f.accept();
    const registry = f.registry(), jobs = f.jobs();
    if (mode === 'job') jobs.jobs[f.queued.jobId].status = 'active';
    if (mode.endsWith('listener')) registry.listener = { id: 'fixture-listener', pid: process.pid, expiresAt: Date.now() + 60_000 };
    if (mode === 'active-id') registry.activeJobId = f.queued.jobId;
    if (mode === 'active-status') registry.status = 'active';
    atomicJson(path.join(f.root, WORKER_FILE), registry); atomicJson(path.join(f.root, WORKER_JOBS_FILE), jobs);
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(mode === 'handoff-listener' ? { env: { ...f.env, CODEX_THREAD_ID: OTHER } } : {}), { code: 'ARTIFACT_BUSY' }); assert.deepEqual(await controlBytes(f), before);
  }
});

test('migration rejects inconsistent parent metadata and a child attempting to dispatch as a parent', async t => {
  for (const field of ['threadId', 'nativeParentThreadId', 'registry-origin', 'child-caller']) {
    const f = await fixture(t); await f.accept();
    if (field === 'registry-origin') atomicJson(path.join(f.root, WORKER_FILE), { ...f.registry(), originThreadId: OTHER });
    else if (field !== 'child-caller') atomicJson(path.join(f.root, NATIVE_BINDING_FILE), { ...f.binding(), [field]: OTHER });
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(field === 'child-caller' ? { env: { ...f.env, CODEX_THREAD_ID: CHILD } } : {}), { code: field === 'child-caller' ? 'CHILD_CANNOT_DISPATCH' : 'BINDING_CONFLICT' });
    assert.deepEqual(await controlBytes(f), before);
  }
});

test('migration refuses another kind, wrong repository, changed files and missing manifests', async t => {
  for (const mode of ['kind', 'repository', 'hash', 'manifest']) {
    const f = await fixture(t); await f.accept();
    if (mode === 'kind') atomicJson(path.join(f.root, NATIVE_BINDING_FILE), { ...f.binding(), skillDir: path.join(f.old.root, 'skills/codex-slides') });
    if (mode === 'repository') { atomicJson(path.join(f.old.root, 'plugin.json'), { name: 'codex-design', version: '1.2.0', repository: 'https://example.com/unrelated' }); await refreshManifest(f.old.root); }
    if (mode === 'hash') await fs.appendFile(path.join(f.current.skillDir, 'SKILL.md'), '\nUnverified package edit.');
    if (mode === 'manifest') await fs.unlink(path.join(f.old.root, '.generated-manifest.json'));
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' }); assert.deepEqual(await controlBytes(f), before);
  }
});

test('a supplied similarly named package must be the one executing this dispatcher', async t => {
  const f = await fixture(t); await f.accept();
  const unrelated = await packageAt(path.join(f.directory, 'unrelated complete copy'), '1.3.0');
  const before = await controlBytes(f);
  await assert.rejects(f.current.dispatch.dispatchEditRequest(unrelated.skillDir, f.root, f.request.id, { env: f.env, store: f.store }), { code: 'BINDING_CONFLICT' });
  assert.deepEqual(await controlBytes(f), before);
});

test('missing old packages need the exact managed family, not a portable clone or similarly named sibling', async t => {
  for (const mode of ['portable', 'fake-family', 'different-marketplace']) {
    const f = await fixture(t, { portable: mode === 'portable' }); await f.removeOld(); await f.accept();
    if (mode !== 'portable') {
      const family = mode === 'fake-family' ? path.join(f.directory, 'fake/plugins/cache/codex-design-marketplace/codex-design') : path.join(f.home, 'plugins/cache/unrelated-marketplace/codex-design');
      atomicJson(path.join(f.root, NATIVE_BINDING_FILE), { ...f.binding(), skillDir: path.join(family, '1.2.0/skills/codex-design') });
    }
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' }); assert.deepEqual(await controlBytes(f), before);
  }
});

test('same releases, downgrades and invalid old version directories cannot use removed-cache fallback', async t => {
  for (const oldVersion of ['1.3.0', '1.4.0', '01.2.0']) {
    const f = await fixture(t, { oldVersion });
    // The same-release case needs a distinct old directory so its fixture can
    // simulate a stale relocation without deleting the executing package.
    if (oldVersion === '1.3.0') {
      atomicJson(path.join(f.root, NATIVE_BINDING_FILE), { ...f.binding(), skillDir: path.join(f.family, '1.3.0+old/skills/codex-design') });
    } else await f.removeOld();
    await f.accept(); const before = await controlBytes(f);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' }); assert.deepEqual(await controlBytes(f), before);
  }
});

test('old package junctions and new package file aliases are rejected without following them into a migration', async t => {
  for (const mode of ['old-root', 'old-alias-current', 'new-file-parent']) {
    const f = await fixture(t); await f.accept();
    const selected = mode.startsWith('old-') ? f.old.root : path.join(f.current.skillDir, 'scripts');
    const backing = path.join(f.directory, mode + '-backing');
    assert.ok(path.relative(f.directory, selected) && !path.relative(f.directory, selected).startsWith('..'));
    await fs.rename(selected, backing);
    await fs.symlink(mode === 'old-alias-current' ? f.current.root : backing, selected, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await controlBytes(f);
    await assert.rejects(f.dispatch(), { code: 'BINDING_CONFLICT' }); assert.deepEqual(await controlBytes(f), before);
  }
});
