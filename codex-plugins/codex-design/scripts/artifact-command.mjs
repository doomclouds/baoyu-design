import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINDING_FILE, BridgeError, readJson, atomicJson, alive, withLock, resolveCodexRunner, samePath } from './bridge-core.mjs';
import { getWorkerStatus, retryWorkerJob, stopWorker, registerNativeWorker, nextNativeJob, completeNativeJob } from './worker-client.mjs';
import { designSystemSearchEnvironment } from './design-system-search.mjs';
import { createLibraryStore } from '../library/index.mjs';
import { UUID } from '../library/safety.mjs';
import { WORKER_LOCK_FILE } from './worker-core.mjs';
import { artworkAppUrl, openArtworkInApp, checkedArtworkDelivery, normalizeControlHints } from './artifact-delivery.mjs';

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
const kindForSkill = (skillDir) => ({ 'codex-slides': 'slides', 'codex-design': 'design', 'codex-design-system': 'design-system', 'codex-dashboard': 'dashboard' })[path.basename(skillDir).replace(/^claude-/, 'codex-')];

export async function createArtworkForSkill(skillDir, title, { store = createLibraryStore() } = {}) {
  const kind = kindForSkill(skillDir);
  if (!kind) throw new BridgeError('UNSUPPORTED_SKILL', 'Only the four artwork editor skills can create library artwork.');
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
  const fail = () => new BridgeError('EDITOR_IDENTITY_UNVERIFIED', 'The recorded PID was not confirmed by this plugin editor’s live session endpoint. No process was stopped and its records were preserved; inspect the existing editor/process manually.');
  if (!state || !alive(state.pid) || state.kind !== kind || !samePath(state.root, root)) throw fail();
  try {
    const url = new URL('__codex/editor-session', state.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw fail();
    const session = await response.json();
    if (session.pid !== state.pid || session.kind !== kind || !samePath(session.root, root) || !alive(state.pid)) throw fail();
    return session;
  } catch { throw fail(); }
}

async function stopVerified(script, root, kind, state, env, argv = ['stop', root]) {
  const serverFile = path.join(root, '.artifact-server.json');
  if (state && alive(state.pid)) {
    await verifyEditorInstance(state, root, kind);
    // The original stop uses an OS process signal. Check its exact input again
    // immediately before invoking it; the remaining signal/PID race cannot be
    // made atomic without an authenticated server-side shutdown operation.
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
      if (['open', 'serve'].includes(command)) {
        const { root } = artifactRoot(skillDir, forwarded);
        const state = readJson(path.join(root, '.artifact-server.json'));
        if (state && alive(state.pid)) await verifyEditorInstance(state, root, kindForSkill(skillDir));
      }
      const code = await originalCommand(script, forwarded, env);
      process.exitCode = code;
      return code;
    }
    const deliveryMode = options.deliveryMode === 'worker' ? 'native' : options.deliveryMode ?? 'native';
    if (!['native', 'main'].includes(deliveryMode)) throw new BridgeError('INVALID_DELIVERY_MODE', 'Use --delivery native (default; worker is an alias) or --delivery main for compatibility.');
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
    const code = await withLock(`${bindingFile}.lock`, async () => {
      const previous = readJson(bindingFile);
      let state = readJson(serverFile);
      const running = state && alive(state.pid);
      if (!running) state = null;
      const expectedKind = kindForSkill(skillDir);
      if (running && (state.kind !== expectedKind || !samePath(state.root, root))) throw new BridgeError('EDITOR_CONFLICT', 'A different editor is recorded for this folder; stop it explicitly before opening.');
      if (running) await verifyEditorInstance(state, root, expectedKind);
      const owned = running && previous && previous.serverPid === state.pid && sameTarget(previous, target);
      if (running && !owned) {
        if (!options.rebind) throw new BridgeError('EDITOR_ALREADY_BOUND', 'This running editor is not bound to this Codex chat. Stop it first, or pass --rebind to restart this editor and bind it here.');
        await stopWorker(root);
        const stopCode = await stopVerified(script, root, expectedKind, state, env);
        if (stopCode !== 0) return stopCode;
        const deadline = Date.now() + 6000;
        while (alive(state.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
        if (alive(state.pid)) throw new BridgeError('EDITOR_STILL_RUNNING', 'The previous editor did not stop; its chat binding was preserved.');
        state = null;
      }
      const binding = owned ? previous : { ...target, token: randomUUID(), serverPid: null, createdAt: new Date().toISOString() };
      if (!owned) atomicJson(bindingFile, binding);
      const bridgeEnv = { ...env, CODEX_DESIGN_BRIDGE_NODE: process.execPath, CODEX_DESIGN_BRIDGE_SCRIPT: fileURLToPath(new URL('./send-comment.mjs', import.meta.url)) };
      const forwardedWithHook = [...forwarded, '--agent-hook', hookCommand(binding.token)];
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
