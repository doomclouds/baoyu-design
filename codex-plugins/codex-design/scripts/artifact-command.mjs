import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BINDING_FILE, BridgeError, readJson, atomicJson, alive, withLock, resolveCodexRunner, samePath } from './bridge-core.mjs';

const BRIDGE_FLAGS = new Map([
  ['thread', 'threadId'], ['remote', 'remote'], ['remote-auth-token-env', 'remoteAuthTokenEnv'], ['codex-path', 'codexPath'],
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

const sameTarget = (a, b) => ['threadId', 'remote', 'remoteAuthTokenEnv', 'codexPath', 'skillDir'].every((key) => (a[key] ?? null) === (b[key] ?? null));

export async function runArtifactCommand(skillDir, argv, { env = process.env, startupTimeoutMs = 20_000 } = {}) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new BridgeError('NODE_VERSION', 'Codex Design requires Node.js 22 or later.');
    skillDir = fs.realpathSync(skillDir);
    const script = path.join(skillDir, 'scripts', 'artifact.mjs');
    const { forwarded, options } = parseBridgeArguments(argv);
    const command = forwarded[0];
    const customHook = forwarded.some((arg) => arg === '--agent-hook' || arg.startsWith('--agent-hook='));
    if (command === 'stop') {
      const { root, rootIndex } = artifactRoot(skillDir, forwarded, { allowMissing: true });
      forwarded[rootIndex] = root;
      const code = !fs.existsSync(root) ? await originalCommand(script, forwarded, env) : await withLock(path.join(root, `${BINDING_FILE}.lock`), async () => {
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
    const threadId = options.threadId ?? env.CODEX_THREAD_ID;
    if (!threadId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
      throw new BridgeError('NO_CODEX_THREAD', 'Open this editor from Codex, pass --thread <session UUID>, or use --no-agent to open without comment delivery.');
    }
    if (options.codexPath) options.codexPath = fs.realpathSync(path.resolve(options.codexPath));
    resolveCodexRunner({ codexPath: options.codexPath, env });
    const { root, rootIndex } = artifactRoot(skillDir, forwarded);
    forwarded[rootIndex] = root;
    const target = { version: 1, root, skillDir, threadId, ...Object.fromEntries(['remote', 'remoteAuthTokenEnv', 'codexPath'].filter((key) => options[key]).map((key) => [key, options[key]])) };
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
    process.stderr.write(`${JSON.stringify({ error: error.code ?? 'CODEX_DESIGN_ERROR', message: error.message })}\n`);
    process.exitCode = 2;
    return 2;
  }
}
