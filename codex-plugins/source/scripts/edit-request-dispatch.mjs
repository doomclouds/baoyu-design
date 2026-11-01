// This native-parent command only persists an accepted request in the existing
// serial worker journal. Native agent creation/resume remains the parent's job.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLibraryStore } from '../library/index.mjs';
import { createEditRequestStore } from '../library/edit-requests.mjs';
import { UUID } from '../library/safety.mjs';
import { nativeArtworkForRoot } from './artifact-delivery.mjs';
import { BridgeError, alive, atomicJson, normalizeEvent, readJson, samePath, withLock } from './bridge-core.mjs';
import { WORKER_FILE, WORKER_LOCK_FILE, NATIVE_BINDING_FILE, appendWorkerLog, loadJobs, saveJobs, userRevisionHash } from './worker-core.mjs';

const PROTOCOL = 'native-draft-v1';
const kindForSkill = skillDir => ({ 'codex-slides': 'slides', 'codex-design': 'design', 'codex-design-system': 'design-system', 'codex-dashboard': 'dashboard' })[path.basename(skillDir).replace(/^claude-/, 'codex-')];
const lockOptions = { timeoutMs: 10_000, staleMs: 0 };
const now = () => new Date().toISOString();

function parentThread(env) {
  const id = env.CODEX_THREAD_ID;
  if (typeof id !== 'string' || !UUID.test(id)) throw new BridgeError('NATIVE_PARENT_REQUIRED', 'Run request-dispatch in the real native parent chat. CODEX_THREAD_ID must be its actual current thread; do not supply or invent another thread id.');
  return id;
}

function readNativeRegistry(root) {
  const registry = readJson(path.join(root, WORKER_FILE));
  if (registry?.url || registry?.token) throw new BridgeError('LEGACY_WORKER_STATE', 'A legacy process-backed worker record remains. Its processes and records were preserved.');
  if (registry && (registry.version !== 1 || !samePath(registry.root, root))) throw new BridgeError('INVALID_WORKER_REGISTRY', 'The native worker registry is invalid.');
  return registry;
}

function checkControlFiles(root) {
  for (const name of [NATIVE_BINDING_FILE, `${NATIVE_BINDING_FILE}.lock`, WORKER_FILE, WORKER_LOCK_FILE, '.codex-design-worker-jobs.json', 'comments.json']) {
    const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new BridgeError('SYMLINK_REFUSED', 'Native request control files and locks must remain inside the real artwork directory.');
  }
}

function currentComment(root, request) {
  const doc = readJson(path.join(root, 'comments.json'));
  const thread = doc?.threads?.find(item => item.id === request.commentId);
  if (!thread || thread.status !== 'open') throw new BridgeError('COMMENT_RESOLVED', 'This captured comment is no longer open. Prepare a current request before dispatching.');
  if (userRevisionHash(normalizeEvent(thread)) !== request.commentRevision) throw new BridgeError('COMMENT_REVISION_CHANGED', 'The user comment changed after this request was captured. Prepare a current request before dispatching.');
}

function safeBinding(root, skillDir, actor, state, registry) {
  const previous = readJson(path.join(root, NATIVE_BINDING_FILE));
  if (registry?.nativeThreadId === actor) throw new BridgeError('CHILD_CANNOT_DISPATCH', 'The registered native child cannot dispatch as its own parent. Run this command in the actual origin parent chat.');
  if (previous && (previous.version !== 1 || !samePath(previous.root, root) || !samePath(previous.skillDir, skillDir)
    || previous.requestProtocol !== PROTOCOL || !UUID.test(previous.threadId ?? '') || !['native', 'worker'].includes(previous.deliveryMode) || typeof previous.token !== 'string' || !previous.token)) {
    throw new BridgeError('BINDING_CONFLICT', 'This artwork already has a different delivery binding. Its editor, listener and jobs were preserved.');
  }
  const active = Object.values(state.jobs).some(job => job?.status === 'active');
  const listening = registry?.listener && registry.listener.expiresAt > Date.now() && alive(registry.listener.pid);
  const sameParent = previous?.threadId === actor && (!registry || registry.originThreadId === actor);
  if (!sameParent && (active || listening || registry?.activeJobId || registry?.status === 'active')) {
    throw new BridgeError('ARTIFACT_BUSY', 'An existing native job or listener owns this artwork. Its parent must coordinate it before changing the request protocol.');
  }
  return previous?.threadId === actor ? previous : {
    version: 1, root, skillDir, threadId: actor, nativeParentThreadId: actor, deliveryMode: 'native', token: randomUUID(), createdAt: now(),
    requestProtocol: PROTOCOL,
  };
}

export function editRequestJobId(requestId) {
  if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new BridgeError('INVALID_REQUEST_ID', 'Expected an edit request UUID.');
  return `request:${requestId.toLowerCase()}`;
}

export async function dispatchEditRequest(skillDir, givenRoot, requestId, { env = process.env, store = createLibraryStore(), requests = createEditRequestStore({ store }) } = {}) {
  const actor = parentThread(env);
  const jobId = editRequestJobId(requestId);
  requestId = requestId.toLowerCase();
  skillDir = fs.realpathSync(skillDir);
  // Validate the supplied path before canonicalizing so a symlink cannot hide
  // an alias into another artwork or another library.
  const suppliedRoot = path.resolve(givenRoot);
  const artwork = nativeArtworkForRoot(suppliedRoot, kindForSkill(skillDir), { libraryRoot: store.root });
  if (!artwork) throw new BridgeError('NOT_LIBRARY_ARTIFACT', 'Request dispatch requires this skill’s active artwork in the matching library.');
  const root = fs.realpathSync(suppliedRoot);
  checkControlFiles(root);
  return withLock(path.join(root, `${NATIVE_BINDING_FILE}.lock`), () => withLock(path.join(root, WORKER_LOCK_FILE), async () => {
    // Library methods acquire only their own lock, after binding/worker locks.
    const record = await store.get(artwork.id);
    if (record.deleted || record.kind !== artwork.kind || !samePath(record.path, root)) throw new BridgeError('ARTIFACT_UNAVAILABLE', 'The artwork no longer belongs to its active library location.');
    const request = await requests.read(requestId);
    if (request.artifactId !== artwork.id || request.artifact?.kind !== artwork.kind) throw new BridgeError('REQUEST_ARTIFACT_MISMATCH', 'This request belongs to a different artwork.');
    const state = loadJobs(root), registry = readNativeRegistry(root);
    const binding = safeBinding(root, skillDir, actor, state, registry);
    const existing = state.jobs[jobId];
    if (existing) {
      if (existing.requestId !== requestId || existing.event?.data?.id !== request.commentId || existing.capturedUserRevision !== request.commentRevision) throw new BridgeError('REQUEST_JOB_CONFLICT', 'The persisted request job disagrees with the captured request. Preserve both records for inspection.');
      // Recover a crash after saveJobs and before the receipt update without
      // ever publishing another queue entry or repeating an edit.
      if (!request.dispatch && request.status === 'accepted') {
        if (existing.originThreadId !== actor) throw new BridgeError('REQUEST_ORIGIN_CONFLICT', 'Recover this accepted request from its original native parent; the captured job was preserved.');
        await requests.markDispatched(requestId, { jobId, originThreadId: actor });
      }
      return { accepted: true, duplicate: true, requestId, artifactId: artwork.id, jobId, status: existing.status,
        phase: existing.phase, originThreadId: existing.originThreadId ?? request.dispatch?.originThreadId ?? actor, nativeThreadId: registry?.nativeThreadId ?? null,
        requiresRegistration: !registry || registry.originThreadId !== actor || registry.status === 'paused' };
    }
    if (request.dispatch || request.status === 'queued') throw new BridgeError('REQUEST_JOB_MISSING', 'This request was already dispatched but its worker job is missing. Preserve its receipt; do not repeat the edit.');
    if (request.status !== 'accepted') throw new BridgeError('REQUEST_NOT_ACCEPTED', 'Only an explicitly accepted current edit request can be dispatched. Adding a composer draft does not queue an edit.');
    // Acceptance may precede this local command by an arbitrary amount of
    // time. Recheck the canonical comment and referenced file safety now.
    await requests.accept(requestId);
    currentComment(root, request);
    if (request.event?.kind !== 'comment' || request.event.data?.id !== request.commentId || userRevisionHash(request.event) !== request.commentRevision) throw new BridgeError('INVALID_REQUEST_EVENT', 'The captured request event does not match its comment revision.');
    atomicJson(path.join(root, NATIVE_BINDING_FILE), binding);
    const capturedRequest = structuredClone({ requestId, artifact: request.artifact, commentRevision: request.commentRevision,
      fileRevisions: request.fileRevisions, artifactRevision: request.artifactRevision, createdAt: request.createdAt });
    const job = { id: jobId, requestId, event: structuredClone(request.event), capturedRequest,
      capturedUserRevision: request.commentRevision, originThreadId: actor, status: 'pending', phase: 'waiting', queuedAt: now() };
    state.jobs[jobId] = job; state.order.push(jobId); saveJobs(root, state);
    await requests.markDispatched(requestId, { jobId, originThreadId: actor });
    appendWorkerLog(root, `native request ${requestId} queued as ${jobId}`);
    return { accepted: true, duplicate: false, requestId, artifactId: artwork.id, jobId, status: job.status,
      phase: job.phase, originThreadId: actor, nativeThreadId: registry?.nativeThreadId ?? null,
      requiresRegistration: !registry || registry.originThreadId !== actor || registry.status === 'paused',
      next: 'The real parent uses native agent tools to inspect and reuse, resume, or create the artwork child. This command does not start or message a model.' };
  }, lockOptions), lockOptions);
}
