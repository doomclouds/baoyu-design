import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINDING_FILE, BridgeError, readJson, atomicJson, alive, withLock, resolveCodexRunner, samePath } from './bridge-core.mjs';
import { getWorkerStatus, retryWorkerJob, stopWorker, registerNativeWorker, nextNativeJob, completeNativeJob } from './worker-client.mjs';
import { designSystemSearchEnvironment } from './design-system-search.mjs';
import { createLibraryStore } from '../library/index.mjs';
import { createDesignSystemSync } from '../server/design-system-sync.mjs';
import { UUID } from '../library/safety.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE, NATIVE_BINDING_FILE, loadJobs } from './worker-core.mjs';
import { artworkAppUrl, openArtworkInApp, checkedArtworkDelivery, normalizeControlHints, nativeArtworkForRoot } from './artifact-delivery.mjs';
import { dispatchEditRequest } from './edit-request-dispatch.mjs';

const BRIDGE_FLAGS = new Map([
  ['thread', 'threadId'], ['remote', 'remote'], ['remote-auth-token-env', 'remoteAuthTokenEnv'], ['codex-path', 'codexPath'],
  ['delivery', 'deliveryMode'], ['worker-model', 'workerModel'],
]);
const SWITCHES = new Set(['all', 'wait', 'resolve', 'reopen']);

export function parseBridgeArguments(argv) {
  const forwarded = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(argument);
    if (i > 0 && match && ['no-agent', 'rebind'].includes(match[1])) {
      if (match[2] !== undefined) throw new BridgeError('INVALID_FLAG', `${argument} does not take a value.`);
      options[match[1] === 'no-agent' ? 'noAgent' : 'rebind'] = true;
    } else if (i > 0 && match && BRIDGE_FLAGS.has(match[1])) {
      const value = match[2] ?? argv[++i];
      if (!value || value.startsWith('--')) throw new BridgeError('INVALID_FLAG', `--${match[1]} requires a value.`);
      options[BRIDGE_FLAGS.get(match[1])] = value;
    } else forwarded.push(argument);
  }
  return { forwarded, options };
}

function artifactRoot(skillDir, argv, { allowMissing = false } = {}) {
  let given, rootIndex;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { given = arg; rootIndex = i; break; }
    if (!arg.includes('=') && !SWITCHES.has(arg.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
  }
  if (!given) throw new BridgeError('MISSING_ROOT', 'Give the artifact root after open/serve/stop.');
  let root = path.resolve(given);
  const index = { slides: 'deck.json', design: 'canvas.json', 'design-system': 'design-system.json' }[kindForSkill(skillDir)];
  if (index && path.basename(root) === 'project' && fs.existsSync(path.join(root, index)) && !fs.existsSync(path.join(root, 'project'))) root = path.dirname(root);
  try { return { root: fs.realpathSync(root), rootIndex }; }
  catch {
    if (allowMissing) return { root, rootIndex };
    throw new BridgeError('NOT_FOUND', `Artifact folder does not exist: ${root}`);
  }
}

// Generated packages expose codex-* skills; accept the upstream names only as
// compatibility aliases when reusing a previous local package.
const kindForSkill = (skillDir) => ({ 'codex-slides': 'slides', 'codex-design': 'design', 'codex-design-system': 'design-system', 'codex-dashboard': 'dashboard', 'codex-motion': 'motion' })[path.basename(skillDir).replace(/^claude-/, 'codex-')];

export async function createArtworkForSkill(skillDir, title, { store = createLibraryStore() } = {}) {
  const kind = kindForSkill(skillDir);
  if (!kind) throw new BridgeError('UNSUPPORTED_SKILL', 'Only artwork editor skills can create library artwork.');
  const artwork = await store.create({ kind, title });
  return { id: artwork.id, kind: artwork.kind, title: artwork.title, root: artwork.path, appUrl: artworkAppUrl(artwork.id), navigationRequested: false };
}

export async function checkpointArtworkForSkill(skillDir, givenRoot) {
  const fail = () => new BridgeError('NOT_LIBRARY_ARTIFACT', 'Checkpoint requires an existing active library artwork with matching skill, UUID, artifact manifest, and surrounding library identity. Explicit project folders keep their existing workflow.');
  const expectedKind = kindForSkill(skillDir);
  let root, libraryRoot, id;
  try {
    const supplied = path.resolve(givenRoot);
    const kindDirectory = path.dirname(supplied);
    libraryRoot = path.dirname(kindDirectory);
    id = path.basename(supplied).toLowerCase();
    if (!UUID.test(id) || path.basename(kindDirectory) !== expectedKind) throw fail();
    for (const directory of [supplied, kindDirectory, libraryRoot, path.join(libraryRoot, '_state')]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    }
    for (const file of [path.join(supplied, 'artifact.json'), path.join(libraryRoot, '_state', 'library.json')]) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail();
    }
    const manifest = readJson(path.join(supplied, 'artifact.json'));
    const identity = readJson(path.join(libraryRoot, '_state', 'library.json'));
    if (manifest?.formatVersion !== 1 || manifest.id !== id || manifest.kind !== expectedKind || manifest.deletedAt
      || identity?.version !== 1 || !UUID.test(identity.id)) throw fail();
    root = fs.realpathSync(supplied);
    libraryRoot = fs.realpathSync(libraryRoot);
  } catch { throw fail(); }
  // Match the worker's lock order: job ownership first, then the library lock.
  return withLock(path.join(root, WORKER_LOCK_FILE), async () => {
    const status = await getWorkerStatus(root);
    if (status.counts.active > 0) throw new BridgeError('ARTIFACT_BUSY', 'An active native design job owns this artwork. Its parent must coordinate ownership before an independent AI edit or checkpoint.');
    const store = createLibraryStore({ root: libraryRoot });
    const artwork = await store.get(id);
    if (artwork.kind !== expectedKind || artwork.deleted || !samePath(artwork.path, root)) throw fail();
    return { artifactId: id, root, pendingCount: status.counts.pending, snapshot: await store.snapshot(id, { label: 'Before AI edit' }) };
  }, { timeoutMs: 10_000, staleMs: 0 });
}

export async function verifyEditorInstance(state, root, kind) {
  const fail = reason => Object.assign(new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'The recorded PID was not confirmed by this plugin editor’s live session endpoint. No process was stopped and its records were preserved; inspect the existing editor/process manually.'), reason ? { reason } : {});
  if (!state || !alive(state.pid) || state.kind !== kind || !samePath(state.root, root)) throw fail();
  let url;
  try {
    const base = new URL(state.url);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw fail();
    url = new URL('__codex/editor-session', base);
  } catch { throw fail(); }
  let response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
  } catch (error) {
    throw fail(refusedConnection(error) ? 'SESSION_CONNECTION_REFUSED' : undefined);
  }
  try {
    if (!response.ok) throw fail();
    const session = await response.json();
    if (session.pid !== state.pid || session.kind !== kind || !samePath(session.root, root) || !alive(state.pid)) throw fail();
    return session;
  } catch { throw fail(); }
}

// A hub process may still serve other artworks after this one is unmounted.
// A timeout, permission response or malformed endpoint never proves shutdown.
export async function editorInstanceStopped(state, root, kind) {
  if (!state || state.kind !== kind || !samePath(state.root, root)) return false;
  if (!alive(state.pid)) return true;
  let url;
  try {
    const base = new URL(state.url);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) return false;
    url = new URL('__codex/editor-session', base);
  } catch { return false; }
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
    return response.status === 404 || response.status === 410;
  } catch (error) { return refusedConnection(error); }
}

// A response, timeout, DNS/reset error or mixed address failure is not proof
// that the recorded service has disappeared. Only exact refused leaves count.
function refusedConnection(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  const next = new Set(seen).add(error);
  if (Array.isArray(error.errors)) return error.errors.length > 0 && error.errors.every(item => refusedConnection(item, next))
    && (error.cause === undefined || refusedConnection(error.cause, next));
  if (error.code === 'ECONNREFUSED') return error.cause === undefined || refusedConnection(error.cause, next);
  return refusedConnection(error.cause, next);
}

function fileSnapshot(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  const bytes = fs.readFileSync(file);
  return { stat, bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

function sameSnapshot(current, captured, { renamed = false } = {}) {
  return current && captured && current.stat.isFile() && !current.stat.isSymbolicLink() && current.stat.nlink === 1
    && current.stat.dev === captured.stat.dev && current.stat.ino === captured.stat.ino
    && (renamed || current.stat.mtimeMs === captured.stat.mtimeMs && current.stat.ctimeMs === captured.stat.ctimeMs)
    && current.hash === captured.hash && current.bytes.equals(captured.bytes);
}

function recoveryPaths(root, { files = true } = {}) {
  const absolute = path.resolve(root), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let directory = path.parse(absolute).root;
  for (const part of parts) {
    directory = path.join(directory, part);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('An artwork directory is aliased.');
  }
  for (const name of files ? ['.artifact-server.json', BINDING_FILE, NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE] : []) {
    const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('An artwork control file is aliased.');
  }
  for (const name of [`${BINDING_FILE}.lock`, WORKER_LOCK_FILE]) {
    for (const lock of [path.join(root, name), path.join(root, name + '.reaper')]) {
      const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('An artwork lock directory is aliased.');
      for (const entry of fs.readdirSync(lock)) {
        const control = fs.lstatSync(path.join(lock, entry));
        if (!control.isFile() || control.isSymbolicLink() || control.nlink !== 1) throw new Error('An artwork lock owner is aliased.');
      }
    }
  }
}

function nativeRecoveryBinding(binding, state, root, kind) {
  return binding?.version === 1 && binding.deliveryMode === 'native' && binding.serverPid === state.pid
    && samePath(binding.root, root) && path.basename(binding.skillDir || '').replace(/^claude-/, 'codex-') === `codex-${kind}`
    && UUID.test(binding.token || '')
    && !['remote', 'remoteAuthTokenEnv', 'workerModel', 'agentHook', 'customHook'].some(key => binding[key] !== undefined);
}

function refuseIncompleteRecovery(root, kind) {
  const binding = readJson(path.join(root, BINDING_FILE));
  if (binding?.deliveryMode !== 'native') return;
  for (const name of fs.readdirSync(root)) {
    const evidence = /^\.artifact-server\.(refused|upgrade)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.exec(name);
    if (!evidence) continue;
    let snapshot, state;
    try {
      snapshot = fileSnapshot(path.join(root, name));
      if (!snapshot?.stat.isFile() || snapshot.stat.isSymbolicLink() || snapshot.stat.nlink !== 1) throw new Error('Aliased recovery evidence.');
      state = JSON.parse(snapshot.bytes);
    } catch { throw new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'Archived editor recovery evidence could not be verified. Its records and binding were preserved.'); }
    if (nativeRecoveryBinding(binding, state, root, kind) && state.kind === kind && samePath(state.root, root)) {
      // An archive is denial evidence, never authority to replay a recovery.
      // A failed raw startup must not become a fresh token/parent on Retry.
      throw new BridgeError('EDITOR_IDENTITY_UNVERIFIED', `The previous data-service ${evidence[1] === 'upgrade' ? 'upgrade' : 'recovery'} did not finish starting. Its archived record and original native binding were preserved; inspect the original startup error before retrying.`);
    }
  }
}

const currentNativeSession = session => session?.nativeSessionVersion === 2 && session.nativeLocalOnly === true;
const legacyNativeSession = session => (session?.nativeSessionVersion === undefined || session.nativeSessionVersion === 1)
  && (session.nativeLocalOnly === undefined || session.nativeLocalOnly === true);

function capturedControls(root) {
  return new Map([NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE, 'comments.json'].map(name => {
    const file = path.join(root, name), stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) {
      throw new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'Native upgrade control files must be ordinary unaliased files.');
    }
    const captured = stat ? fileSnapshot(file) : null;
    return [name, captured];
  }));
}

function controlsUnchanged(root, controls) {
  return [...controls].every(([name, captured]) => {
    const file = path.join(root, name), stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) return false;
    const current = stat ? fileSnapshot(file) : null;
    return captured ? sameSnapshot(current, captured) : current === null;
  });
}

// The caller already owns the CLI binding lock. This lock is deliberately held
// across raw stop/start: a native request cannot claim a writer while its idle
// data runtime is being replaced. Never call the wrapper's public stop here.
async function upgradeLegacyNativeRuntime(script, forwarded, env, skillDir, root, kind, captured, session) {
  let retired = false;
  const refused = () => new BridgeError('EDITOR_IDENTITY_UNVERIFIED', retired
    ? 'The old data service was retired, but its replacement could not be safely verified. Existing controller records and upgrade evidence were retained; inspect them before retrying.'
    : 'The running data service cannot be safely upgraded to the native runtime. Its process, bindings and work were preserved.');
  if (!legacyNativeSession(session)) throw refused();
  const serverFile = path.join(root, '.artifact-server.json'), bindingFile = path.join(root, BINDING_FILE);
  return withLock(path.join(root, WORKER_LOCK_FILE), async () => {
    recoveryPaths(root);
    const old = JSON.parse(captured.bytes);
    const bridgeSnapshot = fileSnapshot(bindingFile), bridge = bridgeSnapshot && JSON.parse(bridgeSnapshot.bytes);
    if (!nativeRecoveryBinding(bridge, old, root, kind) || !path.isAbsolute(bridge.skillDir)
      || bridge.threadId != null && !UUID.test(bridge.threadId) || !sameSnapshot(fileSnapshot(serverFile), captured)) throw refused();
    const protectedFiles = capturedControls(root);
    const status = await getWorkerStatus(root), jobs = loadJobs(root);
    const registry = readJson(path.join(root, WORKER_FILE));
    const native = readJson(path.join(root, NATIVE_BINDING_FILE));
    if (status.counts.active || status.counts.pending || status.listening
      || Object.values(jobs.jobs).some(job => ['active', 'pending'].includes(job?.status))
      || registry?.activeJobId || registry?.listener) {
      throw new BridgeError('ARTIFACT_BUSY', 'Pause the idle native listener and finish or coordinate queued work before upgrading this artwork data service. No process was stopped.');
    }
    if (native && (native.version !== 1 || !samePath(native.root, root) || !['native', 'worker'].includes(native.deliveryMode)
      || native.requestProtocol !== 'native-draft-v1' || !UUID.test(native.threadId ?? '') || !UUID.test(native.token ?? '')
      || native.nativeParentThreadId !== undefined && native.nativeParentThreadId !== native.threadId)) throw refused();
    if (registry && (!['waiting', 'paused'].includes(registry.status) || !UUID.test(registry.nativeThreadId ?? '')
      || !UUID.test(registry.registrationId ?? '') || registry.nativeThreadId === (native ?? bridge).threadId
      || registry.originThreadId !== ((native ?? bridge).threadId ?? null)
      || ['pid', 'url', 'token', 'command'].some(key => Object.hasOwn(registry, key)))) throw refused();
    const rechecked = await verifyEditorInstance(old, root, kind);
    if (!legacyNativeSession(rechecked) || !sameSnapshot(fileSnapshot(serverFile), captured)
      || !sameSnapshot(fileSnapshot(bindingFile), bridgeSnapshot) || !controlsUnchanged(root, protectedFiles)) throw refused();

    // This evidence makes a failed new startup fail closed on a later Retry;
    // an ordinary fresh-open branch cannot silently generate another binding.
    const backup = path.join(root, `.artifact-server.upgrade-${Date.now()}-${randomUUID()}.json`);
    let stopped;
    try { stopped = await originalJsonCommand(script, ['stop', root], env); }
    catch (error) {
      retired = await editorInstanceStopped(old, root, kind);
      if (retired) { recoveryPaths(root, {files: false}); fs.writeFileSync(backup, captured.bytes, {flag: 'wx', mode: 0o600}); }
      throw error;
    }
    retired = await editorInstanceStopped(old, root, kind);
    if (retired) { recoveryPaths(root, {files: false}); fs.writeFileSync(backup, captured.bytes, {flag: 'wx', mode: 0o600}); }
    if (stopped.code !== 0) return stopped.code;
    if (stopped.result?.stopped !== true || stopped.result.pid !== old.pid || !retired
      || fileSnapshot(serverFile) !== null || !sameSnapshot(fileSnapshot(bindingFile), bridgeSnapshot)
      || !controlsUnchanged(root, protectedFiles)) throw refused();
    const started = await originalJsonCommand(script, forwarded, env);
    if (started.code !== 0) return started.code;
    recoveryPaths(root);
    const fresh = readJson(serverFile);
    let health;
    try { health = await verifyEditorInstance(fresh, root, kind); } catch { throw refused(); }
    if (!currentNativeSession(health) || started.result?.pid !== fresh.pid
      || !sameSnapshot(fileSnapshot(bindingFile), bridgeSnapshot) || !controlsUnchanged(root, protectedFiles)) throw refused();
    atomicJson(bindingFile, {...bridge, serverPid: fresh.pid, skillDir});
    process.stdout.write(`${JSON.stringify({...started.result, runtimeUpgraded: true, nativeSessionVersion: 2}, null, 2)}\n`);
    return 0;
  }, {timeoutMs: 10_000, staleMs: 0});
}

// Called only by the existing CLI binding-lock owner. The worker lock protects
// the empty-queue decision and rename, not the subsequent service startup.
async function recoverRefusedEditor(script, forwarded, env, skillDir, root, kind, captured, originalError) {
  if (originalError?.code !== 'EDITOR_IDENTITY_UNVERIFIED' || originalError.reason !== 'SESSION_CONNECTION_REFUSED') throw originalError;
  const serverFile = path.join(root, '.artifact-server.json'), bindingFile = path.join(root, BINDING_FILE);
  let bindingSnapshot, binding;
  try {
    recoveryPaths(root);
    const state = JSON.parse(captured.bytes);
    recoveryPaths(state.root);
    bindingSnapshot = fileSnapshot(bindingFile);
    binding = bindingSnapshot && JSON.parse(bindingSnapshot.bytes);
    if (!nativeRecoveryBinding(binding, state, root, kind) || !sameSnapshot(fileSnapshot(serverFile), captured)) throw originalError;
    recoveryPaths(binding.root);
    await withLock(path.join(root, WORKER_LOCK_FILE), async () => {
      recoveryPaths(root);
      if (!sameSnapshot(fileSnapshot(serverFile), captured) || !sameSnapshot(fileSnapshot(bindingFile), bindingSnapshot)) throw originalError;
      // Recheck the endpoint while both ownership fences are held. Merely
      // replaying a caller's earlier refused error cannot authorize a rename.
      let stillRefused = false;
      try { await verifyEditorInstance(state, root, kind); }
      catch (error) { if (error.reason !== 'SESSION_CONNECTION_REFUSED') throw originalError; stillRefused = true; }
      if (!stillRefused) throw originalError;
      const status = await getWorkerStatus(root), jobs = loadJobs(root);
      const registry = readJson(path.join(root, WORKER_FILE));
      const nativeBinding = readJson(path.join(root, NATIVE_BINDING_FILE));
      if (status.counts.active || status.counts.pending || Object.values(jobs.jobs).some(job => ['active', 'pending'].includes(job?.status))
        || registry && (registry.activeJobId || !['waiting', 'paused'].includes(registry.status)
          || ['pid', 'url', 'token', 'command'].some(key => Object.hasOwn(registry, key)))
        || nativeBinding && !samePath(nativeBinding.root, root)) throw originalError;
      if (nativeBinding) recoveryPaths(nativeBinding.root);
      recoveryPaths(root);
      if (!sameSnapshot(fileSnapshot(serverFile), captured) || !sameSnapshot(fileSnapshot(bindingFile), bindingSnapshot)) throw originalError;
      const backup = path.join(root, `.artifact-server.refused-${Date.now()}-${randomUUID()}.json`);
      // Cooperative CLI writers hold the binding lock. Recheck the archived
      // object too: never start or restore over an unexpected external writer.
      fs.renameSync(serverFile, backup);
      if (!sameSnapshot(fileSnapshot(backup), captured, { renamed: true })) throw originalError;
    }, { timeoutMs: 10_000, staleMs: 0 });
  } catch { throw originalError; }

  // The binding startup lock remains held. Invoke the original short-lived
  // open command, not this wrapper (which would recursively acquire the lock).
  // Native Add to chat intercepts comment delivery before the legacy hook.
  const started = await originalJsonCommand(script, forwarded, env);
  if (started.code !== 0) return started.code;
  try {
    recoveryPaths(root);
    const fresh = readJson(serverFile);
    const health = await verifyEditorInstance(fresh, root, kind);
    if (env.CODEX_DESIGN_NATIVE_SESSION === '1' && !currentNativeSession(health)) throw originalError;
    if (fresh.pid === JSON.parse(captured.bytes).pid || started.result?.pid !== fresh.pid || !sameSnapshot(fileSnapshot(bindingFile), bindingSnapshot)) throw originalError;
    // Change only data-runtime coordinates. Token, parent and native binding
    // remain owned by their existing controller and are never rebound here.
    atomicJson(bindingFile, { ...binding, serverPid: fresh.pid, skillDir });
  } catch { throw originalError; }
  process.stdout.write(`${JSON.stringify({ ...started.result, recovered: true }, null, 2)}\n`);
  return 0;
}

async function stopVerified(script, root, kind, state, env, argv = ['stop', root]) {
  const serverFile = path.join(root, '.artifact-server.json');
  if (state && alive(state.pid)) {
    await verifyEditorInstance(state, root, kind);
    // Check the exact record immediately before the upstream stop unmounts
    // this artwork (or signals an older standalone editor).
    if (JSON.stringify(readJson(serverFile)) !== JSON.stringify(state)) {
      throw new BridgeError('EDITOR_STATE_CHANGED', 'The editor record changed during identity verification. No process was stopped; retry after inspecting it.');
    }
  }
  return await originalCommand(script, argv, env);
}

export function hookCommand(token, platform = process.platform) {
  if (!/^[a-zA-Z0-9-]+$/.test(token)) throw new BridgeError('INVALID_BINDING', 'Invalid bridge token.');
  return platform === 'win32'
    ? `"%CODEX_DESIGN_BRIDGE_NODE%" "%CODEX_DESIGN_BRIDGE_SCRIPT%" --binding-token ${token}`
    : `"$CODEX_DESIGN_BRIDGE_NODE" "$CODEX_DESIGN_BRIDGE_SCRIPT" --binding-token ${token}`;
}

function originalCommand(script, argv, env, onStart) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], { env, shell: false, windowsHide: true, stdio: 'inherit' });
    onStart?.(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function originalJsonCommand(script, argv, env, maximum = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argv], { env, shell: false, windowsHide: true, stdio: ['inherit', 'pipe', 'inherit'] });
    let output = '', size = 0, failed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maximum) { failed = true; child.kill(); reject(new BridgeError('CLI_RESPONSE_TOO_LARGE', 'The artifact command returned too much structured output.')); }
      else output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (failed) return;
      const exitCode = code ?? (signal ? 1 : 0);
      if (!output.trim() && exitCode !== 0) return resolve({ code: exitCode, result: null });
      try { resolve({ code: exitCode, result: JSON.parse(output.trim().replace(/^\uFEFF/, '')) }); }
      catch { reject(new BridgeError('INVALID_CLI_RESPONSE', 'The artifact command did not return valid structured output.')); }
    });
  });
}

function publicHelp(skillDir) {
  return `${path.basename(skillDir)} — Codex Design artwork commands
  create <title>          create in the global artwork library; returns appUrl
  check <root>            validate files; native delivery metadata is included
  open <library-root>     request the native Codex Design artwork tab
  preview <root>          explicitly start an independent local web editor
  checkpoint <root>       save a recovery point before independent AI edits
  request-dispatch <root> <requestId>  native parent: queue one accepted edit request
  open-service <root>     internal: start/reuse the local data service for MCP
  serve-service <root>    internal: run that data service in the foreground
  stop <root>             explicitly stop a verified local editor service
Other format, upload, database and comment commands keep their existing arguments.
Native open does not start a model, chat, worker or data server. navigationRequested
means the OS accepted the request; verify the native tab before claiming rendering.
Folders outside the library require an explicit import or preview; they are never
silently copied, moved, or opened as a web fallback.
`;
}

const sameTarget = (a, b) => ['remote', 'remoteAuthTokenEnv', 'codexPath', 'skillDir', 'deliveryMode', 'workerModel'].every((key) => (a[key] ?? null) === (b[key] ?? null))
  && (['native', 'worker'].includes(b.deliveryMode) || a.threadId === b.threadId);

function workerArguments(argv) {
  const positional = [], flags = {};
  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const match = /^--([^=]+)(?:=(.*))?$/s.exec(argument);
    if (match[1] === 'replace' && match[2] === undefined) { flags.replace = true; continue; }
    if (!['name', 'timeout'].includes(match[1])) throw new BridgeError('INVALID_WORKER_FLAG', `Unsupported native worker option: ${argument}`);
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) throw new BridgeError('INVALID_WORKER_FLAG', `${argument} requires a value.`);
    flags[match[1]] = value;
  }
  return { positional, flags };
}

async function completionInput() {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new BridgeError('WORKER_RESULT_TOO_LARGE', 'A native completion cannot exceed 1 MiB.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runArtifactCommand(skillDir, argv, { env = process.env, startupTimeoutMs = 20_000, libraryStore, navigate } = {}) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new BridgeError('NODE_VERSION', 'Codex Design requires Node.js 22 or later.');
    skillDir = fs.realpathSync(skillDir);
    const script = path.join(skillDir, 'scripts', 'artifact.mjs');
    const { forwarded, options } = parseBridgeArguments(argv);
    let command = forwarded[0];
    const internalOpen = command === 'open-service';
    const nativeService = internalOpen || command === 'serve-service';
    if (nativeService) env = { ...env, CODEX_DESIGN_NATIVE_SESSION: '1' };
    if (['share', 'archive'].includes(command) || forwarded.some(value => /^--lan(?:=|$)/.test(value))) {
      throw new BridgeError('UNSUPPORTED_NATIVE_WORKFLOW', 'Use the Codex Design artwork tab and its content-only Export action. Network sharing and raw folder archives are not part of this plugin workflow.');
    }
    if (!command || ['--help', '-h', 'help'].includes(command)) {
      process.stdout.write(publicHelp(skillDir)); process.exitCode = 0; return 0;
    }
    if (command === 'create') {
      if (forwarded.length !== 2 || Object.keys(options).length) throw new BridgeError('INVALID_CREATE_ARGUMENTS', 'Use create <title> with one quoted artwork title. Existing explicit artifact roots use the usual file workflow.');
      const result = await createArtworkForSkill(skillDir, forwarded[1], { store: libraryStore });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
      return 0;
    }
    if (command === 'open') {
      if (forwarded.length !== 2 || Object.keys(options).length) throw new BridgeError('INVALID_NATIVE_OPEN_ARGUMENTS', 'Use open <library-artifact-root> for the native artwork tab. Use explicit preview or internal open-service for data-service flags.');
      const { root } = artifactRoot(skillDir, forwarded);
      const result = await openArtworkInApp(skillDir, root, kindForSkill(skillDir), { libraryRoot: libraryStore?.root, navigate });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = 0; return 0;
    }
    if (command === 'check') {
      if (Object.keys(options).length) throw new BridgeError('INVALID_CHECK_ARGUMENTS', 'Comment-delivery flags do not apply to check.');
      const { root, rootIndex } = artifactRoot(skillDir, forwarded);
      forwarded[rootIndex] = root;
      const checked = await originalJsonCommand(script, forwarded, env);
      if (checked.result !== null) process.stdout.write(`${JSON.stringify(checkedArtworkDelivery(checked.result, {
        skillDir, root, kind: kindForSkill(skillDir), libraryRoot: libraryStore?.root,
      }), null, 2)}\n`);
      process.exitCode = checked.code; return checked.code;
    }
    if (command === 'ds-sync') {
      const { root } = artifactRoot(skillDir, forwarded), kind = kindForSkill(skillDir);
      if (!['slides', 'design'].includes(kind) || Object.keys(options).length) throw new BridgeError('SYSTEM_SYNC_INVALID_REQUEST', 'Design system synchronization is available for slides and canvases.');
      const arguments_ = forwarded.slice(2), confirming = arguments_.indexOf('--confirm');
      const checkOnly = arguments_.includes('--check');
      const namespace = arguments_.find((value, index) => !value.startsWith('--') && !(confirming >= 0 && index === confirming + 1));
      const token = confirming < 0 ? null : arguments_[confirming + 1];
      const recognized = arguments_.filter((value, index) => value !== '--check' && value !== '--confirm' && !(confirming >= 0 && index === confirming + 1) && value !== namespace);
      if (recognized.length || confirming >= 0 && (!token || !UUID.test(token)) || confirming >= 0 && checkOnly || confirming < 0 && !checkOnly) throw new BridgeError('SYSTEM_SYNC_CONFIRMATION_REQUIRED', 'Use ds-sync <root> [namespace] --check to review, then ds-sync <root> --confirm <confirmationToken>.');
      const store = libraryStore ?? createLibraryStore({ root: path.dirname(path.dirname(root)) });
      const artwork = nativeArtworkForRoot(root, kind, { libraryRoot: store.root });
      if (!artwork) throw new BridgeError('NOT_LIBRARY_ARTIFACT', 'Import this artwork into the library before synchronizing its design systems.');
      const record = await store.get(artwork.id), sync = createDesignSystemSync({ store });
      if (confirming >= 0) {
        const result = await sync.apply(record, token); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exitCode = 0; return 0;
      }
      const indexName = kind === 'slides' ? 'deck.json' : 'canvas.json';
      const index = readJson(path.join(root, 'project', indexName));
      const installed = Array.isArray(index?.designSystems) ? index.designSystems : Object.values(index?.designSystems ?? {});
      const namespaces = namespace ? [namespace] : installed.map(item => item?.namespace).filter(value => typeof value === 'string');
      const systems = [];
      for (const name of namespaces) systems.push(await sync.prepare(record, name));
      process.stdout.write(JSON.stringify({ root, systems, next: 'Use ds-sync <root> --confirm <confirmationToken> only after reviewing its listed files.' }, null, 2) + '\n');
      const code = systems.some(item => item.changed.length || item.removed.length) ? 1 : 0; process.exitCode = code; return code;
    }
    if (['upload', 'write-db'].includes(command)) {
      const { root, rootIndex } = artifactRoot(skillDir, forwarded, { allowMissing: true });
      forwarded[rootIndex] = root;
      const output = await originalJsonCommand(script, forwarded, env);
      if (output.result !== null) process.stdout.write(`${JSON.stringify(normalizeControlHints(output.result, script, skillDir, root), null, 2)}\n`);
      process.exitCode = output.code; return output.code;
    }
    if (command === 'serve') throw new BridgeError('EXPLICIT_SERVICE_COMMAND', 'Use serve-service for the foreground internal data server, preview for an explicitly requested web editor, or open for Codex Design.');
    if (['preview', 'open-service', 'serve-service'].includes(command)) {
      command = command === 'serve-service' ? 'serve' : 'open';
      forwarded[0] = command;
    }
    if (command === 'checkpoint') {
      if (forwarded.length !== 2 || Object.keys(options).length) throw new BridgeError('INVALID_CHECKPOINT_ARGUMENTS', 'Use checkpoint <existing-library-artifact-root>.');
      const result = await checkpointArtworkForSkill(skillDir, forwarded[1]);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
      return 0;
    }
    if (command === 'request-dispatch') {
      if (forwarded.length !== 3 || Object.keys(options).length || forwarded.slice(1).some(arg => arg.startsWith('--'))) throw new BridgeError('INVALID_REQUEST_DISPATCH_ARGUMENTS', 'Use request-dispatch <library-artifact-root> <requestId> in the real native parent environment.');
      const result = await dispatchEditRequest(skillDir, forwarded[1], forwarded[2], { env, ...(libraryStore ? { store: libraryStore } : {}) });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = 0; return 0;
    }
    if (command === 'list') env = designSystemSearchEnvironment(env);
    const customHook = forwarded.some((arg) => arg === '--agent-hook' || arg.startsWith('--agent-hook='));
    if (['worker-status', 'worker-retry', 'worker-register', 'worker-next', 'worker-complete', 'worker-stop'].includes(command)) {
      const { root } = artifactRoot(skillDir, forwarded);
      const parsed = workerArguments(forwarded);
      let result;
      if (command === 'worker-status') result = await getWorkerStatus(root);
      else if (command === 'worker-register') result = await registerNativeWorker(root, { env, name: parsed.flags.name, replace: Boolean(parsed.flags.replace) });
      else if (command === 'worker-next') result = await nextNativeJob(root, { env, timeoutSeconds: parsed.flags.timeout === undefined ? 60 : Number(parsed.flags.timeout) });
      else if (command === 'worker-stop') result = await stopWorker(root);
      else {
        const jobId = parsed.positional[1];
        if (!jobId) throw new BridgeError('MISSING_JOB', 'Give the native worker job id after its artifact root.');
        if (command === 'worker-retry') result = await retryWorkerJob(root, jobId);
        else {
          if (parsed.positional[2] !== '-') throw new BridgeError('WORKER_STDIN_REQUIRED', 'Use worker-complete <root> <jobId> - and pass text or JSON {text,status?} on stdin.');
          result = await completeNativeJob(root, jobId, await completionInput(), { env });
        }
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); const code = result.status === 'failed' ? 1 : 0; process.exitCode = code; return code;
    }
    if (command === 'stop') {
      const { root, rootIndex } = artifactRoot(skillDir, forwarded, { allowMissing: true });
      forwarded[rootIndex] = root;
      const code = !fs.existsSync(root) ? await originalCommand(script, forwarded, env) : await withLock(path.join(root, `${BINDING_FILE}.lock`), async () => {
        const nativeStop = await stopWorker(root);
        if (nativeStop.interruptRequired) process.stderr.write(`${JSON.stringify({ warning: 'NATIVE_INTERRUPT_REQUIRED', ...nativeStop })}\n`);
        const result = await stopVerified(script, root, kindForSkill(skillDir), readJson(path.join(root, '.artifact-server.json')), env, forwarded);
        if (result === 0 && !alive(readJson(path.join(root, '.artifact-server.json'))?.pid)) fs.rmSync(path.join(root, BINDING_FILE), { force: true });
        return result;
      });
      process.exitCode = code;
      return code;
    }
    if (!['open', 'serve'].includes(command) || options.noAgent || customHook) {
      if (command === 'open') {
        const { root, rootIndex } = artifactRoot(skillDir, forwarded);
        forwarded[rootIndex] = root;
        try { recoveryPaths(root, { files: false }); }
        catch { throw new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'The artwork startup lock directories are aliased; their records were preserved.'); }
        return await withLock(path.join(root, `${BINDING_FILE}.lock`), async () => {
          const captured = fileSnapshot(path.join(root, '.artifact-server.json'));
          const state = captured && readJson(path.join(root, '.artifact-server.json'));
          if (state && alive(state.pid)) {
            let session;
            try { session = await verifyEditorInstance(state, root, kindForSkill(skillDir)); }
            catch (error) {
              if (internalOpen && !customHook && captured && options.noAgent) {
                const code = await recoverRefusedEditor(script, forwarded, env, skillDir, root, kindForSkill(skillDir), captured, error);
                process.exitCode = code; return code;
              }
              throw error;
            }
            if (nativeService && !currentNativeSession(session)) {
              if (!internalOpen || customHook || !options.noAgent || options.deliveryMode && !['native', 'worker'].includes(options.deliveryMode)) {
                throw new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'This data service is not the required native runtime. Only an idle native internal open can upgrade it.');
              }
              const code = await upgradeLegacyNativeRuntime(script, forwarded, env, skillDir, root, kindForSkill(skillDir), captured, session);
              process.exitCode = code; return code;
            }
          }
          if (!state || !alive(state.pid)) refuseIncompleteRecovery(root, kindForSkill(skillDir));
          const code = await originalCommand(script, forwarded, env);
          process.exitCode = code; return code;
        });
      }
      if (['open', 'serve'].includes(command)) {
        const { root } = artifactRoot(skillDir, forwarded);
        const state = readJson(path.join(root, '.artifact-server.json'));
        if (state && alive(state.pid)) {
          const session = await verifyEditorInstance(state, root, kindForSkill(skillDir));
          if (nativeService && !currentNativeSession(session)) throw new BridgeError('EDITOR_RUNTIME_UPGRADE_REQUIRED', 'Use the internal open-service command to upgrade an idle native runtime before serving it in the foreground.');
        }
      }
      const code = await originalCommand(script, forwarded, env);
      process.exitCode = code;
      return code;
    }
    const deliveryMode = options.deliveryMode === 'worker' ? 'native' : options.deliveryMode ?? 'native';
    if (!['native', 'main'].includes(deliveryMode)) throw new BridgeError('INVALID_DELIVERY_MODE', 'Use --delivery native (default; worker is an alias).');
    if (deliveryMode === 'main') throw new BridgeError('LEGACY_DELIVERY_UNAVAILABLE', 'Use native comment drafts and explicit native-parent dispatch. Automatic hook delivery is no longer available.');
    if (deliveryMode === 'native' && (options.remote || options.remoteAuthTokenEnv || options.workerModel)) throw new BridgeError('NATIVE_AGENT_OPTIONS', 'The parent creates/resumes native agents using native tools and chooses their model there. Remote queue/model-process options do not apply to native delivery.');
    const threadId = options.threadId ?? (env.CODEX_THREAD_ID || null);
    if ((deliveryMode === 'main' && !threadId) || (threadId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))) {
      throw new BridgeError('NO_CODEX_THREAD', 'Open this editor from Codex, pass --thread <session UUID>, or use --no-agent to open without comment delivery.');
    }
    if (options.codexPath) options.codexPath = fs.realpathSync(path.resolve(options.codexPath));
    if (deliveryMode === 'main') resolveCodexRunner({ codexPath: options.codexPath, env });
    const { root, rootIndex } = artifactRoot(skillDir, forwarded);
    forwarded[rootIndex] = root;
    const target = { version: 1, root, skillDir, threadId, deliveryMode, ...Object.fromEntries(['remote', 'remoteAuthTokenEnv', 'codexPath', 'workerModel'].filter((key) => options[key]).map((key) => [key, options[key]])) };
    const bindingFile = path.join(root, BINDING_FILE);
    const serverFile = path.join(root, '.artifact-server.json');
    let runningPromise;
    try { recoveryPaths(root, { files: false }); }
    catch { throw new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'The artwork startup lock directories are aliased; their records were preserved.'); }
    const code = await withLock(`${bindingFile}.lock`, async () => {
      const previous = readJson(bindingFile);
      const captured = fileSnapshot(serverFile);
      let state = readJson(serverFile);
      const running = state && alive(state.pid);
      if (!running) refuseIncompleteRecovery(root, kindForSkill(skillDir));
      if (!running) state = null;
      const expectedKind = kindForSkill(skillDir);
      if (running && (state.kind !== expectedKind || !samePath(state.root, root))) throw new BridgeError('EDITOR_CONFLICT', 'A different editor is recorded for this folder; stop it explicitly before opening.');
      if (running) {
        let session;
        try { session = await verifyEditorInstance(state, root, expectedKind); }
        catch (error) {
          if (!internalOpen || command !== 'open' || !captured) throw error;
          return await recoverRefusedEditor(script, forwarded, env, skillDir, root, expectedKind, captured, error);
        }
        if (nativeService && !currentNativeSession(session)) {
          if (!internalOpen || command !== 'open' || deliveryMode !== 'native' || !captured) {
            throw new BridgeError('EDITOR_RUNTIME_UPGRADE_REQUIRED', 'Use the internal open-service command to upgrade an idle native runtime before serving it in the foreground.');
          }
          return await upgradeLegacyNativeRuntime(script, forwarded, env, skillDir, root, expectedKind, captured, session);
        }
      }
      const owned = running && previous && previous.serverPid === state.pid && sameTarget(previous, target);
      if (running && !owned) {
        if (!options.rebind) throw new BridgeError('EDITOR_ALREADY_BOUND', 'This running editor is not bound to this Codex chat. Stop it first, or pass --rebind to restart this editor and bind it here.');
        await stopWorker(root);
        const stopCode = await stopVerified(script, root, expectedKind, state, env);
        if (stopCode !== 0) return stopCode;
        const deadline = Date.now() + 6000;
        while (!await editorInstanceStopped(state, root, expectedKind) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        if (fs.existsSync(serverFile) || !await editorInstanceStopped(state, root, expectedKind)) throw new BridgeError('EDITOR_STILL_RUNNING', 'The previous editor did not stop; its chat binding was preserved.');
        state = null;
      }
      const binding = owned ? previous : { ...target, token: randomUUID(), serverPid: null, createdAt: new Date().toISOString() };
      if (!owned) atomicJson(bindingFile, binding);
      const bridgeEnv = { ...env, CODEX_DESIGN_BRIDGE_NODE: process.execPath, CODEX_DESIGN_BRIDGE_SCRIPT: fileURLToPath(new URL('./send-comment.mjs', import.meta.url)) };
      const forwardedWithHook = deliveryMode === 'main' ? [...forwarded, '--agent-hook', hookCommand(binding.token)] : forwarded;
      const startup = new Promise((resolve, reject) => {
        runningPromise = originalCommand(script, forwardedWithHook, bridgeEnv, (child) => {
          let done = false;
          const finish = (error) => { if (done) return; done = true; clearInterval(poll); clearTimeout(startupTimer); error ? reject(error) : resolve(); };
          const startupTimer = setTimeout(() => {
            child.kill();
            const force = setTimeout(() => child.kill('SIGKILL'), 1000);
            force.unref();
            try {
              if (!owned && readJson(bindingFile)?.token === binding.token && !alive(readJson(serverFile)?.pid)) fs.rmSync(bindingFile, { force: true });
              finish(new BridgeError('EDITOR_STARTUP_TIMEOUT', `The editor did not publish server state within ${startupTimeoutMs} ms; its Codex startup was stopped.`));
            } catch (error) { finish(error); }
          }, startupTimeoutMs);
          let probing = false;
          const poll = setInterval(async () => {
            if (done || probing) return;
            probing = true;
            try {
              const live = readJson(serverFile);
              if (live && alive(live.pid) && (!state || live.pid === state.pid)) {
                await verifyEditorInstance(live, root, expectedKind);
                if (done) return;
                atomicJson(bindingFile, { ...binding, serverPid: live.pid });
                finish();
              }
            } catch (error) { finish(error); }
            finally { probing = false; }
          }, 50);
          child.once('exit', async () => {
            try {
              const live = readJson(serverFile);
              if (live && alive(live.pid)) {
                await verifyEditorInstance(live, root, expectedKind);
                if (!done) atomicJson(bindingFile, { ...binding, serverPid: live.pid });
              }
              else if (!owned && readJson(bindingFile)?.token === binding.token) fs.rmSync(bindingFile, { force: true });
              finish();
            } catch (error) { finish(error); }
          });
          child.once('error', finish);
        });
        runningPromise.catch(reject);
      });
      await startup;
      return command === 'serve' ? null : await runningPromise;
    });
    const finalCode = code === null ? await runningPromise : code;
    process.exitCode = finalCode;
    return finalCode;
  } catch (error) {
    const detail = { error: error.code ?? 'CODEX_DESIGN_ERROR', message: error.message };
    for (const key of ['appUrl', 'nativeAvailable', 'navigationRequested', 'renderVerified', 'next']) if (Object.hasOwn(error, key)) detail[key] = error[key];
    process.stderr.write(`${JSON.stringify(detail)}\n`);
    process.exitCode = 2;
    return 2;
  }
}
