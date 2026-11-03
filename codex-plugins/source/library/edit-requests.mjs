// Native draft requests are durable receipts, never a second worker queue.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LibraryError, UUID, artifactId, relativePath, safePath, readBytes, readJson, atomicJson, locked, statOrNull } from './safety.mjs';
import { INDEX_FILES, contentPath } from './content.mjs';
import { motionCommentLocation } from './motion-location.mjs';
import { BINDING_FILE, normalizeEvent } from '../scripts/bridge-core.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE, userRevisionHash } from '../scripts/worker-core.mjs';
import { getWorkerStatus } from '../scripts/worker-client.mjs';

const DIRECTORY = '_state/edit-requests';
const NATIVE_BINDING_FILE = '.codex-design-native-binding.json';
const MAX_COMMENTS_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const requestId = value => { if (typeof value !== 'string' || !UUID.test(value)) throw new LibraryError('INVALID_ID', 'Expected an edit request UUID.'); return value.toLowerCase(); };
const commentId = value => { if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new LibraryError('INVALID_COMMENT', 'Expected a comment id.'); return value; };
const errorSummary = error => ({ code: String(error?.code || 'DRAFT_FAILED').slice(0, 100), message: String(error?.message || error || 'The native draft could not be updated.').slice(0, 1000) });
export const requestUri = id => `codex-design://edit-requests/${requestId(id)}`;
export const REQUEST_URI = requestUri;

function eventFor(thread, kind) {
  const event = normalizeEvent(thread);
  if (kind === 'motion') {
    if (typeof thread.anchor === 'string' && thread.anchor.length <= 1024) event.data.anchor = thread.anchor;
    const location = motionCommentLocation(thread.anchor);
    if (location) { event.data.anchor = thread.anchor; event.data.file = location.file; event.data.location = location; }
  }
  const canonicalFile = value => {
    relativePath(value);
    // Dashboard annotations name logical DB documents (for example index.html),
    // while the content-only library exposes their db/files/<id>.json records.
    if (kind === 'dashboard' && !contentPath(kind, value) && !value.startsWith('db/') && !value.startsWith('_blobs/')) {
      return /^(?:files|datasets)\//.test(value) ? `db/${value}.json` : `db/files/${value}.json`;
    }
    if (kind === 'motion' && !contentPath(kind, value) && /^(?:film|modules|assets)\//.test(value)) return `db/${value}.json`;
    return value;
  };
  if (event.data.file !== undefined) event.data.file = canonicalFile(event.data.file);
  if (event.data.location?.file !== undefined) event.data.location.file = canonicalFile(event.data.location.file);
  if (event.data.file !== undefined) {
    relativePath(event.data.file);
    if (!contentPath(kind, event.data.file)) throw new LibraryError('CONTENT_ONLY', 'A comment location must identify artwork content.');
  }
  if (event.data.location?.file !== undefined) {
    relativePath(event.data.location.file);
    if (!contentPath(kind, event.data.location.file)) throw new LibraryError('CONTENT_ONLY', 'A comment location must identify artwork content.');
    if (event.data.file !== event.data.location.file) throw new LibraryError('INVALID_COMMENT', 'The comment file and location disagree.');
  }
  // Reject oversized context instead of silently changing the user's request.
  if (Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) throw new LibraryError('LIMIT_EXCEEDED', 'The comment request context is too large.');
  return JSON.parse(JSON.stringify(event));
}

function stateError(record, thread, kind) {
  if (!thread || thread.status !== 'open') return new LibraryError('COMMENT_RESOLVED', 'This comment is no longer open. Prepare a current open comment instead.');
  try { if (userRevisionHash(eventFor(thread, kind)) === record.commentRevision) return null; } catch { /* Invalid replacement context also supersedes the captured request. */ }
  return new LibraryError('COMMENT_REVISION_CHANGED', 'The user changed this comment after the request was prepared. Prepare the current revision instead.');
}

function validateRecord(record, id) {
  if (!record || record.version !== 1 || requestId(record.id) !== id || artifactId(record.artifactId) !== record.artifactId
    || typeof record.commentRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.commentRevision)
    || !record.artifact || record.artifact.id !== record.artifactId || !Array.isArray(record.fileRevisions)
    || !record.event || record.event.kind !== 'comment' || record.event.data?.id !== record.commentId
    || !['draft_ready', 'prepared', 'needs_attention', 'accepted', 'queued', 'superseded'].includes(record.status)) {
    throw new LibraryError('INVALID_STATE', 'The edit request record is invalid.');
  }
  commentId(record.commentId);
  eventFor(record.event.data, record.artifact.kind);
  for (const file of record.fileRevisions) { relativePath(file.path); if (!contentPath(record.artifact.kind, file.path)) throw new LibraryError('INVALID_STATE', 'An edit request includes a non-content file.'); }
  return record;
}

function publicRequest(record, status = record.status) {
  return structuredClone({ id: record.id, requestId: record.id, requestUri: requestUri(record.id), artifactId: record.artifactId,
    commentId: record.commentId, artifact: record.artifact, event: record.event, commentRevision: record.commentRevision,
    fileRevisions: record.fileRevisions, artifactRevision: record.artifactRevision, createdAt: record.createdAt, status,
    ...(record.draftAddedAt ? { draftAddedAt: record.draftAddedAt } : {}), ...(record.draftError ? { error: record.draftError } : {}),
    ...(record.acceptedAt ? { acceptedAt: record.acceptedAt } : {}), ...(record.dispatch ? { dispatch: record.dispatch } : {}),
  });
}

function projection(record, thread, worker, rawJobs) {
  const base = { requestId: record?.id ?? null };
  const revision = record?.commentRevision ?? (() => { try { return userRevisionHash(normalizeEvent(thread)); } catch { return null; } })();
  const job = record ? worker?.jobs.find(job => (record.dispatch ? job.id === record.dispatch.jobId : job.requestId === record.id)
    && rawJobs[job.id]?.requestId === record.id && rawJobs[job.id]?.capturedUserRevision === revision)
    : worker?.jobs.findLast(job => job.commentId === thread.id && rawJobs[job.id]?.capturedUserRevision === revision);
  const currentRevision = (() => { try { return userRevisionHash(normalizeEvent(thread)); } catch { return null; } })();
  // Resolving a completed discussion does not undo a verified historical result.
  if (job?.status === 'completed' && job.repliedAt && currentRevision === revision) return { ...base, status: 'completed', ...(job.phase ? { phase: job.phase } : {}) };
  if (record && (record.status === 'superseded' || stateError(record, thread, record.artifact.kind))) return { ...base, status: 'superseded', message: 'The comment changed or was resolved. Add its current revision to a draft.' };
  // Legacy pending records never authorize replay. A real claimed job remains
  // working even between listener calls; needsResume is not job completion.
  if (job && (record || job.status !== 'pending')) {
    const phase = job.phase ?? rawJobs[job.id]?.phase;
    const detail = phase ? { phase } : {};
    if (phase?.startsWith('awaiting-')) return { ...base, status: 'needs_attention', ...detail,
      message: job.error?.message || 'The native request needs confirmation before editing can continue.' };
    if (job.status === 'active') return { ...base, status: 'working', ...detail };
    if (job.status === 'pending') return { ...base, status: 'queued', ...detail };
    if (job.status === 'failed') return { ...base, status: 'failed', ...detail, ...(job.error?.message ? { message: String(job.error.message).slice(0, 1000) } : {}) };
    if (job.status === 'superseded') return { ...base, status: 'superseded' };
    if (job.status === 'completed' && job.repliedAt) return { ...base, status: 'completed', ...detail };
    return { ...base, status: 'needs_attention', message: 'The worker has not recorded a completed comment reply.' };
  }
  if (record?.dispatch) return { ...base, status: 'needs_attention', message: 'The dispatched native job could not be found. Retry from the accepting chat.' };
  if (record) {
    if (record.status === 'needs_attention') return { ...base, status: 'needs_attention', message: record.draftError?.message || 'The native draft could not be updated. Try adding this request again.' };
    return { ...base, status: record.status, ...(record.status === 'draft_ready' ? { message: 'Ready to add to a native draft.' } : {}) };
  }
  return { ...base, status: 'needs_attention', message: 'This earlier submission has no accepted native request. Add it to a draft to continue.' };
}

/** This store does not create chats, send model input, or submit worker jobs. */
export function createEditRequestStore({ store } = {}) {
  if (!store || typeof store._checkRoot !== 'function' || typeof store._raw !== 'function') throw new LibraryError('INVALID_OPTION', 'An initialized library store is required.');
  const ready = () => store._checkRoot();
  const location = async id => { const { record } = await store._raw(artifactId(id)); return { record, root: await store._artifactPath(record) }; };
  const comments = async root => {
    const file = await safePath(root, 'comments.json', { mustExist: false });
    if (!await statOrNull(file)) return { version: 1, threads: [] };
    let value; try { value = JSON.parse((await readBytes(root, 'comments.json', MAX_COMMENTS_BYTES)).toString('utf8')); }
    catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError('INVALID_STATE', 'The canonical comment document is malformed.'); }
    if (!value || !Array.isArray(value.threads)) throw new LibraryError('INVALID_STATE', 'The canonical comment document has no threads.');
    return value;
  };
  const recordPath = id => `${DIRECTORY}/${requestId(id)}.json`;
  const load = async id => {
    id = requestId(id); let value;
    try { value = JSON.parse((await readBytes(store.root, recordPath(id), MAX_REQUEST_BYTES)).toString('utf8')); }
    catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError('INVALID_STATE', 'The edit request record is malformed.'); }
    return validateRecord(value, id);
  };
  const save = async value => {
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_REQUEST_BYTES) throw new LibraryError('LIMIT_EXCEEDED', 'The edit request snapshot is too large.');
    await atomicJson(store.root, recordPath(value.id), value);
  };
  const all = async () => {
    const directory = await safePath(store.root, DIRECTORY, { mustExist: false });
    if (!await statOrNull(directory)) return [];
    await safePath(store.root, DIRECTORY, { type: 'directory' });
    const records = [];
    for (const entry of await fs.readdir(directory)) if (/^[0-9a-f-]{36}\.json$/i.test(entry)) records.push(await load(entry.slice(0, -5)));
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  };
  const current = async record => {
    try { const found = await location(record.artifactId); const document = await comments(found.root); return { ...found, thread: document.threads.find(thread => thread.id === record.commentId) }; }
    catch (error) { if (error.code === 'NOT_FOUND') return null; throw error; }
  };
  const stale = async record => {
    const found = await current(record);
    const error = found ? stateError(record, found.thread, found.record.kind) : new LibraryError('COMMENT_RESOLVED', 'This artifact or comment is no longer active.');
    return { found, error };
  };
  const mutateCurrent = async (id, action) => {
    await ready(); let failure;
    const result = await locked(store.root, async () => {
      const record = await load(id); const check = await stale(record);
      if (check.error || record.status === 'superseded') { record.status = 'superseded'; record.supersededAt ??= now(); await save(record); failure = check.error || new LibraryError('COMMENT_REVISION_CHANGED', 'This superseded request cannot be accepted again. Prepare a new user revision.'); return null; }
      await action(record, check.found); await save(record); return publicRequest(record);
    });
    if (failure) throw failure;
    return result;
  };
  const api = {
    async prepare({ artifactId: id, commentId: idOfComment } = {}) {
      id = artifactId(id); idOfComment = commentId(idOfComment); await ready();
      return locked(store.root, async () => {
        const found = await location(id); const document = await comments(found.root); const thread = document.threads.find(thread => thread.id === idOfComment);
        if (!thread || thread.status !== 'open') throw new LibraryError('COMMENT_RESOLVED', 'Prepare an existing open comment.');
        const event = eventFor(thread, found.record.kind); const commentRevision = userRevisionHash(event);
        const existing = (await all()).findLast(record => record.artifactId === id && record.commentId === idOfComment && record.commentRevision === commentRevision && record.status !== 'superseded');
        if (existing) return publicRequest(existing);
        const observedAt = now(), fileRevisions = [];
        for (const relative of [...new Set([INDEX_FILES[found.record.kind], event.data.file].filter(Boolean))]) {
          const file = await safePath(found.root, relative, { mustExist: false });
          if (!await statOrNull(file)) { fileRevisions.push({ path: relative, missing: true, observedAt }); continue; }
          const bytes = await readBytes(found.root, relative, store.limits.maxFileBytes);
          fileRevisions.push({ path: relative, sha256: sha(bytes), bytes: bytes.length, observedAt });
        }
        const artifact = { id, kind: found.record.kind, title: found.record.title };
        const record = { version: 1, id: randomUUID(), artifactId: id, commentId: idOfComment, artifact, event, commentRevision, fileRevisions,
          artifactRevision: sha(JSON.stringify({ artifact, files: fileRevisions.map(({ observedAt: _at, ...file }) => file) })), createdAt: observedAt, status: 'draft_ready' };
        await save(record); return publicRequest(record);
      });
    },
    async read(id) {
      requestId(id); await ready();
      return locked(store.root, async () => {
        const record = await load(id);
        if ((await stale(record)).error && record.status !== 'superseded') { record.status = 'superseded'; record.supersededAt ??= now(); await save(record); }
        return publicRequest(record);
      });
    },
    async requestForModel(id) {
      const result = await api.read(id); if (result.status === 'superseded') return result;
      const found = await location(result.artifactId); return { ...result, artifactRoot: found.root };
    },
    markDraftAdded: id => mutateCurrent(id, record => {
      if (record.acceptedAt || record.dispatch) return;
      record.draftAddedAt ??= now(); record.status = 'prepared'; delete record.draftError;
    }),
    markDraftFailed: (id, error) => mutateCurrent(id, record => {
      if (record.acceptedAt || record.dispatch || record.draftAddedAt) return;
      record.status = 'needs_attention'; record.draftError = errorSummary(error);
    }),
    accept: id => mutateCurrent(id, async (record, found) => {
      // Receipt in the real parent is stronger evidence than the UI's Add
      // acknowledgement, which can be lost after the native draft succeeded.
      for (const file of record.fileRevisions) await safePath(found.root, file.path, { type: 'file' });
      record.acceptedAt ??= now(); if (!record.dispatch) record.status = 'accepted';
    }),
    // The native parent integration holds binding/worker locks when calling
    // this method. Only take the library lock here, in that established order.
    markDispatched: (id, { jobId, originThreadId } = {}) => mutateCurrent(id, async (record, found) => {
      if (!record.acceptedAt) throw new LibraryError('REQUEST_NOT_ACCEPTED', 'The real parent must accept this request before dispatch.');
      if (typeof jobId !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(jobId) || typeof originThreadId !== 'string' || !UUID.test(originThreadId)) throw new LibraryError('INVALID_JOB', 'Expected a native job id and a verified origin thread UUID.');
      if (record.dispatch) {
        if (record.dispatch.jobId !== jobId || record.dispatch.originThreadId !== originThreadId) throw new LibraryError('DISPATCH_CONFLICT', 'This request already belongs to another native dispatch.');
        return;
      }
      const binding = await readJson(found.root, NATIVE_BINDING_FILE, null);
      const state = await readJson(found.root, WORKER_JOBS_FILE, null); const job = state?.jobs?.[jobId];
      if (binding?.threadId !== originThreadId || !['native', 'worker'].includes(binding?.deliveryMode) || !job || job.requestId !== record.id
        || job.event?.kind !== 'comment' || job.event.data?.id !== record.commentId || job.capturedUserRevision !== record.commentRevision) throw new LibraryError('INVALID_JOB', 'The native journal does not contain this accepted request and origin.');
      record.dispatch = { jobId, originThreadId, dispatchedAt: now() }; record.status = 'queued';
    }),
    async project(id, canonicalSnapshot) {
      id = artifactId(id); await ready();
      if (!canonicalSnapshot || !Array.isArray(canonicalSnapshot.threads)) throw new LibraryError('INVALID_COMMENT', 'Expected a canonical comment snapshot.');
      const found = await location(id);
      // Validate the stable artifact root above, rather than realpath an
      // ephemeral lock that another contender can remove between checks.
      const lockPath = path.join(found.root, WORKER_LOCK_FILE);
      if ((await statOrNull(lockPath))?.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'The worker lock must be a real directory.');
      // Worker journals are atomically replaced. A status read must not take
      // the execution lock: completion can hold it while waiting for a reply.
      // Otherwise the comment UI could time out exactly when results arrive.
        let worker, rawJobs = {};
        try {
          for (const file of [WORKER_FILE, WORKER_JOBS_FILE, BINDING_FILE, NATIVE_BINDING_FILE]) await safePath(found.root, file, { mustExist: false });
          worker = await getWorkerStatus(found.root); rawJobs = (await readJson(found.root, WORKER_JOBS_FILE, { jobs: {} })).jobs || {};
        } catch (error) { if (error.code === 'SYMLINK_REFUSED' || error.code === 'INVALID_PATH') throw error; }
        return locked(store.root, async () => {
          const records = (await all()).filter(record => record.artifactId === id); const snapshot = structuredClone(canonicalSnapshot);
          for (const thread of snapshot.threads) {
            const related = records.filter(record => record.commentId === thread.id);
            for (const old of related) if (old.status !== 'superseded' && stateError(old, thread, found.record.kind)) { old.status = 'superseded'; old.supersededAt ??= now(); await save(old); }
            const record = related.findLast(record => !stateError(record, thread, found.record.kind)) ?? related.at(-1);
            const legacy = ['delivered', 'pending', 'working', 'queued', 'failed'].includes(thread.agent?.status);
            if (!record && !legacy) continue;
            thread.agent = { ...thread.agent, ...(record ? { sentAt: record.createdAt } : {}), nativeRequest: projection(record, thread, worker, rawJobs) };
          }
          return snapshot;
        });
    },
  };
  return api;
}
