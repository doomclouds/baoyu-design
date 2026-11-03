// This native-parent command only persists an accepted request in the existing
// serial worker journal. Native agent creation/resume remains the parent's job.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from '../library/index.mjs';
import { createEditRequestStore } from '../library/edit-requests.mjs';
import { UUID } from '../library/safety.mjs';
import { nativeArtworkForRoot } from './artifact-delivery.mjs';
import { BridgeError, alive, atomicJson, normalizeEvent, readJson, samePath, withLock } from './bridge-core.mjs';
import { WORKER_FILE, WORKER_LOCK_FILE, NATIVE_BINDING_FILE, appendWorkerLog, loadJobs, saveJobs, userRevisionHash } from './worker-core.mjs';

const PROTOCOL = 'native-draft-v1';
const kindForSkill = skillDir => ({ 'codex-slides': 'slides', 'codex-design': 'design', 'codex-design-system': 'design-system', 'codex-dashboard': 'dashboard', 'codex-motion': 'motion' })[path.basename(skillDir).replace(/^claude-/, 'codex-')];
const lockOptions = { timeoutMs: 10_000, staleMs: 0 };
const now = () => new Date().toISOString();
const packageName = 'codex-design';
const repository = 'https://github.com/doomclouds/baoyu-design';
const executingModule = fileURLToPath(import.meta.url);
const conflict = message => new BridgeError('BINDING_CONFLICT', message);
const identicalPath = (a, b) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
};

function releaseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) return null;
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}

function olderRelease(previous, current) {
  const a = releaseVersion(previous), b = releaseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index];
  if (!a.pre || !b.pre) return Boolean(a.pre && !b.pre);
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index];
    if (x === undefined || y === undefined) return x === undefined && y !== undefined;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    return nx && ny ? BigInt(x) < BigInt(y) : nx !== ny ? nx : x < y;
  }
  return false;
}

function canonicalFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || path.isAbsolute(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) throw conflict('The plugin package contains an unsafe file path.');
  const file = path.join(root, ...relative.split('/'));
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || !identicalPath(fs.realpathSync(file), file)) throw conflict('Plugin package files must be regular files without aliases.');
  return { file, info };
}

// This verifies package consistency and the executing package's ownership, not
// a remote signature. Arbitrary similarly named skill directories are refused.
function packagedSkill(skillDir, kind, { executing = false } = {}) {
  const relativeSkill = `skills/codex-${kind}`;
  const root = path.resolve(skillDir, '../..');
  if (!identicalPath(skillDir, path.join(root, ...relativeSkill.split('/'))) || !identicalPath(fs.realpathSync(root), root)
    || fs.lstatSync(root).isSymbolicLink() || !identicalPath(fs.realpathSync(skillDir), skillDir)) throw conflict('The skill does not belong to a canonical plugin package.');
  if (executing && !identicalPath(path.resolve(executingModule, '../..'), root)) throw conflict('The new skill must belong to the currently executing plugin package.');
  const readPackageJson = relative => {
    const { file, info } = canonicalFile(root, relative);
    if (info.size > 2 * 1024 * 1024) throw conflict('Plugin package metadata is too large.');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const manifest = readPackageJson('.generated-manifest.json');
  const metadata = readPackageJson('plugin.json'), legacy = readPackageJson('.codex-plugin/plugin.json');
  if (manifest.generator !== 'codex-design-build-v1' || manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || metadata.name !== packageName || legacy.name !== packageName || metadata.repository !== repository
    || !releaseVersion(metadata.version) || legacy.version !== metadata.version || legacy.skills !== './skills/' || legacy.mcpServers !== './mcp.json') {
    throw conflict('The skill package identity cannot be verified.');
  }
  const required = ['plugin.json', '.codex-plugin/plugin.json', 'scripts/edit-request-dispatch.mjs', `${relativeSkill}/SKILL.md`,
    `${relativeSkill}/scripts/codex-artifact.mjs`, `${relativeSkill}/scripts/artifact.mjs`];
  if (executing) required.push(path.relative(root, executingModule).split(path.sep).join('/'));
  const entries = Object.entries(manifest.files);
  if (entries.length > 4096 || required.some(file => !Object.hasOwn(manifest.files, file))) throw conflict('The plugin package is incomplete.');
  let bytes = 0;
  for (const [relative, expected] of entries) {
    if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw conflict('The plugin package digest is invalid.');
    const { file, info } = canonicalFile(root, relative);
    bytes += info.size;
    if (bytes > 256 * 1024 * 1024 || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw conflict('The plugin package failed its integrity check.');
  }
  return { root, name: metadata.name, repository: metadata.repository, version: metadata.version, relativeSkill,
    manifestSha256: createHash('sha256').update(fs.readFileSync(path.join(root, '.generated-manifest.json'))).digest('hex') };
}

function managedPreviousRelease(current, oldRoot, env) {
  const codexHome = env.CODEX_HOME === undefined ? path.join(os.homedir(), '.codex') : env.CODEX_HOME;
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) return null;
  const cacheRoot = path.join(path.resolve(codexHome), 'plugins/cache');
  const relative = path.relative(cacheRoot, current.root), parts = relative.split(path.sep);
  if (path.isAbsolute(relative) || parts.length !== 3 || parts.some(part => !part || part === '.' || part === '..')
    || parts[1] !== packageName || parts[2] !== current.version) return null;
  const family = path.dirname(current.root);
  if (!identicalPath(path.dirname(oldRoot), family)) return null;
  if (!identicalPath(fs.realpathSync(family), family) || fs.lstatSync(family).isSymbolicLink()) {
    throw conflict('The managed plugin cache family is aliased.');
  }
  const version = path.basename(oldRoot);
  return olderRelease(version, current.version) ? version : null;
}

// Updaters can leave directory shells after removing old package bytes. Only
// a proven managed family may use this bounded, non-destructive empty-tree check.
function emptyDirectoryTree(root) {
  let entries = 0, empty = true;
  const visit = (directory, depth) => {
    if (depth > 32) throw conflict('The old cache directory shell is too deep to verify.');
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !identicalPath(fs.realpathSync(directory), directory)) {
      throw conflict('The old cache directory shell is aliased.');
    }
    const handle = fs.opendirSync(directory);
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (++entries > 4096) throw conflict('The old cache directory shell is too large to verify.');
        const file = path.join(directory, entry.name), child = fs.lstatSync(file);
        if (child.isSymbolicLink() || !identicalPath(fs.realpathSync(file), file)) throw conflict('The old cache contains an alias.');
        if (child.isDirectory()) visit(file, depth + 1);
        else {
          if (!child.isFile()) throw conflict('The old cache contains an unsafe file.');
          empty = false;
        }
      }
    } finally { handle.closeSync(); }
  };
  visit(root, 0);
  return empty;
}

function upgradedSkill(previousSkill, skillDir, kind, env) {
  try {
    const current = packagedSkill(skillDir, kind, { executing: true });
    if (typeof previousSkill !== 'string' || !path.isAbsolute(previousSkill)) throw conflict('The previous skill path is invalid.');
    const oldRoot = path.resolve(previousSkill, '../..');
    if (!identicalPath(previousSkill, path.join(oldRoot, ...current.relativeSkill.split('/')))) throw conflict('The previous skill has a different artwork kind.');
    const oldInfo = fs.lstatSync(oldRoot, { throwIfNoEntry: false });
    const managedVersion = managedPreviousRelease(current, oldRoot, env);
    let fromVersion, previousBytesVerified;
    let old;
    if (oldInfo) {
      try { old = packagedSkill(previousSkill, kind); }
      catch (error) {
        if (!managedVersion || !emptyDirectoryTree(oldRoot)) throw error;
      }
    }
    if (old) {
      fromVersion = old.version; previousBytesVerified = true;
    } else {
      // Missing bytes, including a verified empty directory shell, cannot be
      // authenticated as an old package. Keep that audit distinction explicit.
      if (!managedVersion) throw conflict('The removed previous package is outside the verified older managed cache family.');
      fromVersion = managedVersion; previousBytesVerified = false;
    }
    if (!olderRelease(fromVersion, current.version)) throw conflict('A skill binding may migrate only to a newer verified plugin release.');
    return { ...current, fromVersion, previousBytesVerified };
  } catch (error) {
    if (error.code === 'BINDING_CONFLICT') throw error;
    throw conflict('The previous and current skill packages could not be verified; their binding and jobs were preserved.');
  }
}

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

function safeBinding(root, skillDir, actor, state, registry, env) {
  const previous = readJson(path.join(root, NATIVE_BINDING_FILE));
  if (registry?.nativeThreadId === actor) throw new BridgeError('CHILD_CANNOT_DISPATCH', 'The registered native child cannot dispatch as its own parent. Run this command in the actual origin parent chat.');
  if (previous && (previous.version !== 1 || !samePath(previous.root, root) || typeof previous.skillDir !== 'string' || !path.isAbsolute(previous.skillDir)
    || previous.requestProtocol !== PROTOCOL || !UUID.test(previous.threadId ?? '') || !['native', 'worker'].includes(previous.deliveryMode) || typeof previous.token !== 'string' || !previous.token)) {
    throw new BridgeError('BINDING_CONFLICT', 'This artwork already has a different delivery binding. Its editor, listener and jobs were preserved.');
  }
  const active = Object.values(state.jobs).some(job => job?.status === 'active');
  const listening = registry?.listener && registry.listener.expiresAt > Date.now() && alive(registry.listener.pid);
  const sameParent = previous?.threadId === actor && (!registry || registry.originThreadId === actor);
  if (previous && !identicalPath(previous.skillDir, skillDir)) {
    if (previous.nativeParentThreadId !== previous.threadId || registry && (registry.originThreadId !== previous.threadId
      || !UUID.test(registry.nativeThreadId ?? '') || typeof registry.registrationId !== 'string' || !registry.registrationId)) {
      throw conflict('The existing native parent ownership is inconsistent; preserve it before upgrading this artwork skill binding.');
    }
    if (active || listening || registry?.activeJobId || registry?.status === 'active') {
      throw new BridgeError('ARTIFACT_BUSY', 'Pause the idle native listener before upgrading its skill package. An active writer or listener still owns this artwork.');
    }
    if (registry && !['waiting', 'paused'].includes(registry.status)) throw conflict('The native worker state cannot be verified for a skill upgrade.');
    const upgraded = upgradedSkill(previous.skillDir, skillDir, kindForSkill(skillDir), env);
    const next = previous.threadId === actor ? { ...previous, skillDir } : {
      version: 1, root, skillDir, threadId: actor, nativeParentThreadId: actor, deliveryMode: 'native', token: randomUUID(), createdAt: now(), requestProtocol: PROTOCOL,
    };
    return { binding: { ...next, skillPackage: { name: upgraded.name, repository: upgraded.repository, version: upgraded.version,
      relativeSkill: upgraded.relativeSkill, manifestSha256: upgraded.manifestSha256 },
      skillUpgrade: { fromVersion: upgraded.fromVersion, previousBytesVerified: upgraded.previousBytesVerified, at: now() } }, upgraded: true };
  }
  if (!sameParent && (active || listening || registry?.activeJobId || registry?.status === 'active')) {
    throw new BridgeError('ARTIFACT_BUSY', 'An existing native job or listener owns this artwork. Its parent must coordinate it before changing the request protocol.');
  }
  return { binding: previous?.threadId === actor ? previous : {
    version: 1, root, skillDir, threadId: actor, nativeParentThreadId: actor, deliveryMode: 'native', token: randomUUID(), createdAt: now(),
    requestProtocol: PROTOCOL,
  }, upgraded: false };
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
    const { binding, upgraded } = safeBinding(root, skillDir, actor, state, registry, env);
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
        requiresRegistration: upgraded || !registry || registry.originThreadId !== actor || registry.status === 'paused' };
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
      requiresRegistration: upgraded || !registry || registry.originThreadId !== actor || registry.status === 'paused',
      ...(upgraded ? { skillPackageUpgraded: true, previousPackageBytesVerified: binding.skillUpgrade.previousBytesVerified } : {}),
      next: 'The real parent uses native agent tools to inspect and reuse, resume, or create the artwork child. This command does not start or message a model.' };
  }, lockOptions), lockOptions);
}
