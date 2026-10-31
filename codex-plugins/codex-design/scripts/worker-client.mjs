// Native subagent queue/controller. This module never creates agents, starts a
// model process, sends app-server input, or queues messages to another chat.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BINDING_FILE, BridgeError, atomicJson, alive, readJson, withLock, normalizeEvent, deliveryKey, samePath } from './bridge-core.mjs';
import { WORKER_FILE, WORKER_LOCK_FILE, WORKER_LOG_FILE, loadJobs, saveJobs, appendWorkerLog, matchingReply, publicJob, workerPrompt, userRevisionHash } from './worker-core.mjs';

const nativeMode = (binding) => binding && ['native', 'worker'].includes(binding.deliveryMode);
const registryFile = (root) => path.join(root, WORKER_FILE);
const withJobs = (root, action) => withLock(path.join(root, WORKER_LOCK_FILE), action, { timeoutMs: 10_000, staleMs: 0 });
const saveRegistry = (root, registry) => atomicJson(registryFile(root), registry);
const now = () => new Date().toISOString();

function readRegistry(root) {
  const registry = readJson(registryFile(root));
  if (registry?.url || registry?.token) throw new BridgeError('LEGACY_WORKER_STATE', 'A legacy process-backed worker record remains. Preserve and inspect it before registering a native worker.');
  if (registry && (registry.version !== 1 || !samePath(registry.root, root))) throw new BridgeError('INVALID_WORKER_REGISTRY', 'The native worker registry is invalid.');
  return registry;
}

function callerThread(env) {
  const id = env.CODEX_THREAD_ID;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new BridgeError('NATIVE_THREAD_REQUIRED', 'Run this command inside the real native subagent; CODEX_THREAD_ID must identify its current thread.');
  return id;
}

function bindingFor(root) {
  const binding = readJson(path.join(root, BINDING_FILE));
  if (!nativeMode(binding) || !samePath(binding.root, root)) throw new BridgeError('NO_NATIVE_BINDING', 'Open this artifact with native delivery before registering its native subagent.');
  return binding;
}

function registeredCaller(root, env, { allowPaused = false } = {}) {
  const actor = callerThread(env);
  const binding = bindingFor(root);
  if (actor === binding.threadId) throw new BridgeError('PARENT_CANNOT_REGISTER', 'The origin parent chat cannot act as its own native design subagent. Use a real spawned child.');
  const registry = readRegistry(root);
  if (!registry || registry.nativeThreadId !== actor) throw new BridgeError('WRONG_NATIVE_WORKER', 'This command must run in the artifact’s registered native subagent. The parent decides whether to reuse, resume, or replace that subagent.');
  if (!allowPaused && registry.status === 'paused') throw new BridgeError('WORKER_PAUSED', 'This native listener was paused. Its parent must decide when to resume it.');
  return { actor, binding, registry };
}

function currentRevision(root, event) {
  if (event.kind !== 'comment') return true;
  const doc = readJson(path.join(root, 'comments.json'));
  const thread = doc?.threads?.find((thread) => thread.id === event.data.id);
  if (!thread || thread.status !== 'open') return false;
  try { return userRevisionHash(normalizeEvent(thread)) === userRevisionHash(event); } catch { return false; }
}

function releaseJob(registry, job) {
  if (registry.activeJobId === job.id) delete registry.activeJobId;
  registry.status = 'waiting'; registry.lastSeenAt = now();
}

export async function submitWorkerJob(binding, event, jobId) {
  return await withJobs(binding.root, async () => {
    const current = bindingFor(binding.root);
    if (current.token !== binding.token) throw new BridgeError('INVALID_BINDING', 'The artifact binding changed before accepting this comment.');
    readRegistry(binding.root); // Reject a live/unknown legacy process record.
    if (deliveryKey(binding, event) !== jobId) throw new BridgeError('INVALID_JOB', 'The native event does not match its content id.');
    const state = loadJobs(binding.root);
    const existing = state.jobs[jobId];
    if (existing) return { accepted: true, duplicate: true, jobId, status: existing.status };
    const job = { id: jobId, event, status: 'pending', queuedAt: now(), phase: 'waiting', capturedUserRevision: userRevisionHash(event) };
    state.jobs[jobId] = job; state.order.push(jobId); saveJobs(binding.root, state);
    appendWorkerLog(binding.root, `native job ${jobId} accepted`);
    return { accepted: true, duplicate: false, jobId, status: 'pending' };
  });
}

export async function registerNativeWorker(root, { env = process.env, name = 'codex-design-worker', replace = false } = {}) {
  root = fs.realpathSync(root);
  const actor = callerThread(env);
  return await withJobs(root, async () => {
    const binding = bindingFor(root);
    if (actor === binding.threadId) throw new BridgeError('PARENT_CANNOT_REGISTER', 'Register a real native child, not the origin parent chat.');
    const previous = readRegistry(root);
    if (previous && previous.nativeThreadId !== actor && !replace) throw new BridgeError('NATIVE_REPLACEMENT_REQUIRED', 'Another native worker is registered. The parent must first interrupt the old worker using native tools, then explicitly register its replacement with --replace.');
    const state = loadJobs(root);
    const replacing = previous && previous.nativeThreadId !== actor;
    if (replacing) {
      for (const job of Object.values(state.jobs)) if (job.status === 'active') { job.status = 'pending'; job.recoveredAt = now(); }
      saveJobs(root, state);
    }
    const registry = {
      version: 1, root, nativeThreadId: actor, originThreadId: binding.threadId ?? null,
      name: String(name).slice(0, 200), registrationId: replacing || !previous ? randomUUID() : previous.registrationId,
      registeredAt: previous && !replacing ? previous.registeredAt : now(), lastSeenAt: now(), status: 'waiting',
      ...(previous && !replacing && previous.activeJobId ? { activeJobId: previous.activeJobId } : {}),
      ...(previous && !replacing && previous.listener ? { listener: previous.listener } : {}),
    };
    saveRegistry(root, registry);
    appendWorkerLog(root, `native worker ${actor} ${replacing ? 'replaced' : previous ? 'reused' : 'registered'}`);
    return { registered: true, reused: Boolean(previous && !replacing), nativeThreadId: actor, name: registry.name };
  });
}

function waitForChange(root, timeoutMs) {
  return new Promise((resolve) => {
    let watcher;
    const finish = () => { clearTimeout(timer); watcher?.close(); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    try {
      watcher = fs.watch(root, (_event, filename) => {
        if (filename && ['.codex-design-worker-jobs.json', BINDING_FILE, '.artifact-server.json'].includes(String(filename))) finish();
      });
      watcher.once('error', finish);
    } catch { /* Timeout still provides bounded polling. */ }
  });
}

async function editorAvailable(root, binding) {
  const state = readJson(path.join(root, '.artifact-server.json'));
  if (!state || state.pid !== binding.serverPid) return false;
  try {
    const { verifyEditorInstance } = await import('./artifact-command.mjs');
    await verifyEditorInstance(state, root, path.basename(binding.skillDir).replace(/^(?:codex|claude)-/, ''));
    return true;
  } catch { return false; }
}

export async function nextNativeJob(root, { env = process.env, timeoutSeconds = 60, verifyEditor = editorAvailable } = {}) {
  root = fs.realpathSync(root);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 300) throw new BridgeError('INVALID_TIMEOUT', 'worker-next timeout must be between 0 and 300 seconds.');
  const initialActor = callerThread(env), initialRegistry = readRegistry(root);
  if (!initialRegistry || initialRegistry.nativeThreadId !== initialActor) throw new BridgeError('WRONG_NATIVE_WORKER', 'Only the registered native subagent may wait for this artifact.');
  if (!nativeMode(readJson(path.join(root, BINDING_FILE)))) return { closed: true, reason: 'editor-closed-or-binding-changed' };
  const initial = registeredCaller(root, env, { allowPaused: true });
  const registrationId = initial.registry.registrationId;
  const listenerId = randomUUID();
  const deadline = Date.now() + timeoutSeconds * 1000;
  try {
    for (;;) {
      const currentBinding = readJson(path.join(root, BINDING_FILE));
      if (!nativeMode(currentBinding) || currentBinding.token !== initial.binding.token || !await verifyEditor(root, currentBinding)) return { closed: true, reason: 'editor-closed-or-binding-changed' };
      const result = await withJobs(root, async () => {
        const currentRegistry = readRegistry(root);
        if (!currentRegistry || currentRegistry.nativeThreadId !== initial.actor || currentRegistry.registrationId !== registrationId) return { closed: true, reason: 'listener-replaced' };
        const { actor, binding, registry } = registeredCaller(root, env, { allowPaused: true });
        if (registry.registrationId !== registrationId || registry.status === 'paused') return { closed: true, reason: 'listener-paused-or-replaced' };
        const otherListener = registry.listener;
        if (otherListener && otherListener.id !== listenerId && otherListener.expiresAt > Date.now() && alive(otherListener.pid)) throw new BridgeError('NATIVE_ALREADY_LISTENING', 'This native worker already has a worker-next process waiting. Poll that process instead of starting another listener.');
        const state = loadJobs(root);
        let job = state.order.map((id) => state.jobs[id]).find((job) => job?.status === 'active');
        if (job && job.ownerThreadId !== actor) throw new BridgeError('NATIVE_ACTIVE_OWNER_CONFLICT', 'An unfinished job still belongs to another native worker; its parent must coordinate replacement.');
        if (job && !currentRevision(root, job.event)) { job.status = 'superseded'; job.completedAt = now(); releaseJob(registry, job); job = null; saveJobs(root, state); }
        if (job && matchingReply(root, job)) {
          job.status = job.resultFailed ? 'failed' : 'completed'; job.completedAt = now(); job.repliedAt ??= job.completedAt;
          if (job.resultFailed) job.error = job.resultError ?? job.error ?? { code: 'NATIVE_JOB_FAILED', message: job.resultText };
          releaseJob(registry, job); job = null; saveJobs(root, state);
        }
        if (!job) {
          for (const id of state.order) {
            const candidate = state.jobs[id];
            if (candidate?.status !== 'pending') continue;
            if (!currentRevision(root, candidate.event)) { candidate.status = 'superseded'; candidate.completedAt = now(); continue; }
            job = candidate; break;
          }
        }
        registry.lastSeenAt = now(); delete registry.listener;
        if (job) {
          const resumed = job.status === 'active';
          job.status = 'active'; job.ownerThreadId = actor; job.registrationId = registrationId; job.startedAt ??= now(); job.lastClaimedAt = now(); delete job.error;
          registry.status = 'active'; registry.activeJobId = job.id;
          saveJobs(root, state); saveRegistry(root, registry);
          return { closed: false, job: publicJob(job), request: workerPrompt(binding, job.event, job.id), event: job.event, capturedUserRevision: job.capturedUserRevision,
            resumed, ...(job.resultText ? { savedResultText: job.resultText, resume: 'complete-saved-result' } : {}) };
        }
        saveJobs(root, state);
        registry.status = 'waiting'; registry.listener = { id: listenerId, pid: process.pid, expiresAt: Date.now() + 5000 };
        saveRegistry(root, registry); return null;
      });
      if (result) return result;
      if (Date.now() >= deadline) return { closed: false, timedOut: true };
      await waitForChange(root, Math.min(1000, Math.max(1, deadline - Date.now())));
    }
  } finally {
    await withJobs(root, async () => {
      const registry = readRegistry(root);
      if (registry?.nativeThreadId === initial.actor && registry.listener?.id === listenerId) { delete registry.listener; registry.lastSeenAt = now(); saveRegistry(root, registry); }
    });
  }
}

export function postNativeReply(binding, id, text, expectedRevision, { env = process.env, timeoutMs = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(binding.skillDir, 'scripts', 'codex-artifact.mjs'), 'comment-reply', binding.root, id, '-'], {
      cwd: binding.root, env: { ...env, CODEX_DESIGN_EXPECTED_USER_REVISION: expectedRevision }, windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); }); child.stdin.on('error', () => {});
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new BridgeError('WORKER_REPLY_TIMEOUT', 'The saved reply CLI timed out; inspect the existing comment before retrying.'));
      if (code !== 0) {
        let detail; for (const line of stderr.trim().split('\n').reverse()) { try { detail = JSON.parse(line); break; } catch {} }
        return reject(new BridgeError(detail?.error ?? 'WORKER_REPLY_FAILED', detail?.message ?? stderr.trim()));
      }
      resolve();
    });
    child.stdin.end(text);
  });
}

function resultInput(input) {
  let text = String(input).trim(), failed = false, error;
  if (text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch { /* Ordinary prose beginning with a brace remains prose. */ }
    if (data) {
      if (typeof data.text !== 'string') throw new BridgeError('INVALID_WORKER_RESULT', 'JSON completion needs a text field.');
      text = data.text.trim(); failed = data.status === 'failed' || data.failed === true || data.success === false;
      if (failed) error = { code: data.error?.code ?? 'NATIVE_JOB_FAILED', message: String(data.error?.message ?? data.error ?? text).slice(0, 3000) };
    }
  }
  if (!text) throw new BridgeError('EMPTY_WORKER_RESULT', 'Provide a concise, honest completion reply on stdin.');
  const fullText = text;
  if (text.length > 9000) { text = text.slice(0, 9000); if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); text += '\n\n[回复已截取，完整结果保存在本地任务记录。]'; }
  return { text, fullText, failed, error };
}

export async function completeNativeJob(root, jobId, input, { env = process.env, postReply = postNativeReply } = {}) {
  root = fs.realpathSync(root);
  const submitted = resultInput(input);
  return await withJobs(root, async () => {
    const { actor, binding, registry } = registeredCaller(root, env);
    const state = loadJobs(root); const job = state.jobs[jobId];
    if (!job || job.ownerThreadId !== actor || job.registrationId !== registry.registrationId) throw new BridgeError('WRONG_JOB_OWNER', 'Only the native worker that claimed this job may complete it.');
    if (['completed', 'superseded'].includes(job.status)) return { completed: job.status === 'completed', duplicate: true, jobId, status: job.status };
    if (job.status !== 'active') throw new BridgeError('JOB_NOT_ACTIVE', 'Claim or retry this job before completing it.');
    job.resultText = submitted.text; job.fullResultText = submitted.fullText; job.resultFailed = submitted.failed; job.phase = 'replying';
    if (submitted.failed) job.resultError = submitted.error; else delete job.resultError;
    saveJobs(root, state);
    if (!currentRevision(root, job.event)) {
      job.status = 'superseded'; job.completedAt = now(); releaseJob(registry, job); saveJobs(root, state); saveRegistry(root, registry);
      return { completed: false, jobId, status: 'superseded' };
    }
    try {
      if (job.event.kind === 'comment' && !matchingReply(root, job)) { await postReply(binding, job.event.data.id, job.resultText, job.capturedUserRevision, { env }); job.repliedAt = now(); }
      job.status = submitted.failed ? 'failed' : 'completed'; job.completedAt = now();
      if (submitted.failed) job.error = submitted.error; else delete job.error;
    } catch (error) {
      if (error.code === 'COMMENT_REVISION_CHANGED') { job.status = 'superseded'; job.completedAt = now(); }
      else { job.status = 'failed'; job.error = { code: error.code ?? 'WORKER_REPLY_FAILED', message: String(error.message).slice(-3000) }; }
    }
    releaseJob(registry, job); saveJobs(root, state); saveRegistry(root, registry); appendWorkerLog(root, `native job ${jobId} ${job.status}`);
    return { completed: job.status === 'completed', jobId, status: job.status, ...(job.error ? { error: job.error } : {}) };
  });
}

export async function getWorkerStatus(root) {
  const registry = readRegistry(root); const binding = readJson(path.join(root, BINDING_FILE)); const state = loadJobs(root);
  const jobs = state.order.map((id) => state.jobs[id]).filter(Boolean).map(publicJob);
  const counts = Object.fromEntries(['pending', 'active', 'completed', 'failed', 'superseded'].map((status) => [status, jobs.filter((job) => job.status === status).length]));
  const listening = Boolean(registry?.listener && registry.listener.expiresAt > Date.now() && alive(registry.listener.pid));
  return { mode: 'native', running: listening, listening, nativeThreadId: registry?.nativeThreadId ?? null,
    name: registry?.name ?? null, status: registry?.status ?? 'unregistered', originThreadId: binding?.threadId ?? null,
    needsResume: (counts.pending > 0 || counts.active > 0) && !listening, counts, jobs,
    note: 'Local listener presence is not native agent liveness. The parent checks the real native agent before deciding to resume or replace it.',
    ...(registry?.lastSeenAt ? { lastSeenAt: registry.lastSeenAt } : {}), log: path.join(root, WORKER_LOG_FILE) };
}

export async function stopWorker(root) {
  return await withJobs(root, async () => {
    const registry = readRegistry(root); const state = loadJobs(root);
    if (!registry) return { paused: false, interruptRequired: false, nativeThreadId: null };
    let active = false;
    for (const job of Object.values(state.jobs)) if (job.status === 'active') { active = true; job.status = 'pending'; job.pausedAt = now(); }
    registry.status = 'paused'; registry.pausedAt = now(); delete registry.listener; delete registry.activeJobId;
    saveJobs(root, state); saveRegistry(root, registry);
    return { paused: true, nativeThreadId: registry.nativeThreadId, interruptRequired: active,
      note: 'This pauses the local listener only. The parent must use native agent tools to interrupt a child that is still editing.' };
  });
}

export async function retryWorkerJob(root, jobId) {
  return await withJobs(root, async () => {
    bindingFor(root); const state = loadJobs(root); const job = state.jobs[jobId];
    if (!job) throw new BridgeError('UNKNOWN_JOB', 'No such native worker job.');
    if (job.status !== 'failed') return { accepted: true, duplicate: true, jobId, status: job.status };
    job.status = 'pending'; job.retriedAt = now(); delete job.error; delete job.resultText; delete job.fullResultText; delete job.resultFailed; delete job.resultError;
    saveJobs(root, state); return { accepted: true, duplicate: false, jobId, status: 'pending' };
  });
}
