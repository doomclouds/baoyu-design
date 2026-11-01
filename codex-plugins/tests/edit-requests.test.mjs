import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../source/library/index.mjs';
import { createEditRequestStore, requestUri } from '../source/library/edit-requests.mjs';
import { atomicJson, normalizeEvent, withLock } from '../source/scripts/bridge-core.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE, userRevisionHash } from '../source/scripts/worker-core.mjs';
import { getWorkerStatus } from '../source/scripts/worker-client.mjs';

const PARENT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NATIVE_BINDING_FILE = '.codex-design-native-binding.json';
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-edit-request-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(root, { recursive: true, force: true }); });
  const store = createLibraryStore({ root });
  const artifact = await store.create({ kind: 'slides', title: 'Draft artwork' });
  const document = { version: 1, threads: [{ id: 'comment-a', status: 'open', label: 'Cover heading', location: { file: 'project/slides/cover.html', element: '#cover' },
    messages: [{ id: 'user-a', author: { kind: 'user' }, text: '把标题改为“你好” $(literal) `code`', at: '2026-10-31T00:00:00.000Z' }] }] };
  const writeComments = value => fs.writeFile(path.join(artifact.path, 'comments.json'), JSON.stringify(value, null, 2) + '\n');
  await writeComments(document);
  const requests = createEditRequestStore({ store });
  const prepare = () => requests.prepare({ artifactId: artifact.id, commentId: 'comment-a' });
  const dispatchJournal = async (request, changes = {}) => {
    const jobId = `request:${request.id}`;
    atomicJson(path.join(artifact.path, NATIVE_BINDING_FILE), { version: 1, root: artifact.path, threadId: PARENT, nativeParentThreadId: PARENT, deliveryMode: 'native', requestProtocol: 'native-draft-v1' });
    atomicJson(path.join(artifact.path, WORKER_FILE), { version: 1, root: artifact.path, nativeThreadId: CHILD, originThreadId: PARENT, status: 'waiting' });
    const job = { id: jobId, requestId: request.id, event: request.event, capturedUserRevision: request.commentRevision, status: 'pending', phase: 'waiting', queuedAt: new Date().toISOString(), ...changes };
    atomicJson(path.join(artifact.path, WORKER_JOBS_FILE), { version: 1, jobs: { [jobId]: job }, order: [jobId] });
    return { jobId, job };
  };
  return { root, store, artifact, document, requests, prepare, writeComments, dispatchJournal };
}

test('prepare captures one immutable user revision and observational file hashes, without delivery or a worker queue', async t => {
  const f = await fixture(t); const originalComments = await fs.readFile(path.join(f.artifact.path, 'comments.json'), 'utf8');
  const results = await Promise.all(Array.from({ length: 6 }, () => f.prepare()));
  const request = results[0]; assert.ok(results.every(other => other.id === request.id)); assert.equal(request.status, 'draft_ready');
  assert.equal(request.commentRevision, userRevisionHash(normalizeEvent(f.document.threads[0])));
  assert.equal(request.fileRevisions.length, 2); assert.match(request.fileRevisions[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(request.requestUri, requestUri(request.id)); assert.equal('artifactRoot' in request, false);
  assert.equal((await f.requests.requestForModel(request.id)).artifactRoot, f.artifact.path);
  await fs.writeFile(path.join(f.artifact.path, 'project/slides/cover.html'), '<section id="cover">A later edit</section>');
  f.document.threads[0].messages.push({ author: { kind: 'agent' }, text: 'Discussion only', at: '2026-10-31T00:01:00Z' });
  f.document.threads[0].label = 'A later label'; await f.writeComments(f.document);
  const duplicate = await f.prepare(); assert.deepEqual(duplicate, request);
  assert.equal(duplicate.event.data.messages.length, 1); assert.equal(duplicate.event.data.where, 'Cover heading');
  assert.notEqual(await fs.readFile(path.join(f.artifact.path, 'comments.json'), 'utf8'), originalComments, 'only the fixture changed canonical comments');
  for (const name of [WORKER_FILE, WORKER_JOBS_FILE, '.codex-design-delivery.json']) await assert.rejects(fs.access(path.join(f.artifact.path, name)), { code: 'ENOENT' });
  const records = await fs.readdir(path.join(f.root, '_state/edit-requests')); assert.equal(records.length, 1);
});

test('draft failure is visible and retry reuses the request; successful Add alone becomes prepared', async t => {
  const f = await fixture(t), request = await f.prepare();
  assert.equal((await f.requests.project(f.artifact.id, f.document)).threads[0].agent.nativeRequest.status, 'draft_ready');
  const failure = await f.requests.markDraftFailed(request.id, { code: 'NATIVE_OFFLINE', message: 'Native draft was unavailable' });
  assert.equal(failure.status, 'needs_attention'); assert.equal((await f.prepare()).id, request.id);
  let projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'needs_attention');
  const added = await f.requests.markDraftAdded(request.id); assert.equal(added.status, 'prepared'); assert.equal('error' in added, false);
  assert.equal((await f.requests.markDraftAdded(request.id)).draftAddedAt, added.draftAddedAt);
  assert.equal((await f.requests.markDraftFailed(request.id, new Error('late response'))).status, 'prepared');
  projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'prepared');
  assert.equal(f.document.threads[0].agent, undefined, 'projection does not mutate the caller snapshot');
});

test('actual model acceptance is durable and idempotent but never queues work', async t => {
  const f = await fixture(t), request = await f.prepare(); await f.requests.markDraftAdded(request.id);
  const accepted = await f.requests.accept(request.id); assert.equal(accepted.status, 'accepted'); assert.ok(accepted.acceptedAt);
  assert.deepEqual(await f.requests.accept(request.id), accepted);
  for (const name of [WORKER_FILE, WORKER_JOBS_FILE]) await assert.rejects(fs.access(path.join(f.artifact.path, name)), { code: 'ENOENT' });
  assert.equal((await f.requests.project(f.artifact.id, f.document)).threads[0].agent.nativeRequest.status, 'accepted');
});

test('a real model receipt recovers a lost Add acknowledgement without queueing', async t => {
  const f = await fixture(t), request = await f.prepare();
  await f.requests.markDraftFailed(request.id, new Error('The host succeeded but its acknowledgement was lost'));
  const result = await f.requests.accept(request.id); assert.equal(result.status, 'accepted'); assert.ok(result.acceptedAt);
  await assert.rejects(fs.access(path.join(f.artifact.path, WORKER_JOBS_FILE)), { code: 'ENOENT' });
});

test('changed and resolved user comments supersede captured requests and reject acceptance', async t => {
  const f = await fixture(t), first = await f.prepare(); await f.requests.markDraftAdded(first.id);
  f.document.threads[0].messages[0].text = 'A newer user instruction'; f.document.threads[0].messages[0].editedAt = new Date().toISOString(); await f.writeComments(f.document);
  assert.equal((await f.requests.read(first.id)).status, 'superseded');
  await assert.rejects(f.requests.accept(first.id), { code: 'COMMENT_REVISION_CHANGED' });
  const second = await f.prepare(); assert.notEqual(first.id, second.id); assert.equal((await f.requests.read(first.id)).event.data.messages[0].text, first.event.data.messages[0].text);
  await f.requests.markDraftAdded(second.id); f.document.threads[0].status = 'resolved'; await f.writeComments(f.document);
  await assert.rejects(f.requests.accept(second.id), { code: 'COMMENT_RESOLVED' });
  await assert.rejects(f.prepare(), { code: 'COMMENT_RESOLVED' });
  assert.equal((await f.requests.project(f.artifact.id, f.document)).threads[0].agent.nativeRequest.status, 'superseded');
});

test('file changes are observational context and do not reject a still-current accepted comment', async t => {
  const f = await fixture(t), request = await f.prepare(); await f.requests.markDraftAdded(request.id);
  await fs.writeFile(path.join(f.artifact.path, 'project/slides/cover.html'), '<section id="cover">User saved new content</section>');
  const accepted = await f.requests.accept(request.id); assert.equal(accepted.status, 'accepted'); assert.deepEqual(accepted.fileRevisions, request.fileRevisions);
});

test('reopening the same comment revision prepares a new request while its superseded receipt stays terminal', async t => {
  for (const observe of ['read', 'project']) {
    const f = await fixture(t), first = await f.prepare(); await f.requests.markDraftAdded(first.id);
    f.document.threads[0].status = 'resolved'; await f.writeComments(f.document);
    if (observe === 'read') assert.equal((await f.requests.read(first.id)).status, 'superseded');
    else assert.equal((await f.requests.project(f.artifact.id, f.document)).threads[0].agent.nativeRequest.status, 'superseded');
    f.document.threads[0].status = 'open'; await f.writeComments(f.document);
    const reopened = await f.prepare(); assert.notEqual(reopened.id, first.id); assert.equal(reopened.commentRevision, first.commentRevision); assert.equal(reopened.status, 'draft_ready');
    assert.equal((await f.prepare()).id, reopened.id);
    await assert.rejects(f.requests.accept(first.id), { code: 'COMMENT_REVISION_CHANGED' });
    assert.equal((await f.requests.read(first.id)).status, 'superseded');
    await f.requests.markDraftAdded(reopened.id); assert.equal((await f.requests.accept(reopened.id)).status, 'accepted');
  }
});

test('missing captured files reject acceptance and observed supersession cannot revive an old request', async t => {
  const f = await fixture(t), request = await f.prepare();
  const slide = path.join(f.artifact.path, 'project/slides/cover.html'); const contents = await fs.readFile(slide);
  await fs.rm(slide); await assert.rejects(f.requests.accept(request.id), { code: 'NOT_FOUND' });
  await fs.writeFile(slide, contents);
  f.document.threads[0].status = 'resolved'; await f.writeComments(f.document);
  assert.equal((await f.requests.read(request.id)).status, 'superseded');
  f.document.threads[0].status = 'open'; await f.writeComments(f.document);
  await assert.rejects(f.requests.accept(request.id), { code: 'COMMENT_REVISION_CHANGED' });
  assert.equal((await f.requests.read(request.id)).status, 'superseded');
});

test('dispatch requires a real accepted request journal, preserves origin, and is idempotent', async t => {
  const f = await fixture(t), request = await f.prepare();
  await assert.rejects(f.requests.markDispatched(request.id, { jobId: 'request:x', originThreadId: PARENT }), { code: 'REQUEST_NOT_ACCEPTED' });
  await f.requests.markDraftAdded(request.id); await f.requests.accept(request.id);
  await assert.rejects(f.requests.markDispatched(request.id, { jobId: 'request:x', originThreadId: PARENT }), { code: 'INVALID_JOB' });
  const { jobId } = await f.dispatchJournal(request);
  await assert.rejects(f.requests.markDispatched(request.id, { jobId, originThreadId: CHILD }), { code: 'INVALID_JOB' });
  const result = await f.requests.markDispatched(request.id, { jobId, originThreadId: PARENT }); assert.equal(result.status, 'queued'); assert.equal(result.dispatch.jobId, jobId);
  assert.deepEqual(await f.requests.markDispatched(request.id, { jobId, originThreadId: PARENT }), result);
  await assert.rejects(f.requests.markDispatched(request.id, { jobId: 'request:other', originThreadId: PARENT }), { code: 'DISPATCH_CONFLICT' });
});

test('real active work remains working without a listener, then requires completed plus replied', async t => {
  const f = await fixture(t), request = await f.prepare(); await f.requests.markDraftAdded(request.id); await f.requests.accept(request.id);
  const { jobId, job } = await f.dispatchJournal(request, { status: 'active', phase: 'editing' });
  await f.requests.markDispatched(request.id, { jobId, originThreadId: PARENT });
  const status = await getWorkerStatus(f.artifact.path); assert.equal(status.listening, false); assert.equal(status.needsResume, true);
  const before = await fs.readFile(path.join(f.artifact.path, 'comments.json'), 'utf8');
  let projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'working'); assert.equal(projected.threads[0].agent.nativeRequest.phase, 'editing');
  job.status = 'completed'; job.completedAt = new Date().toISOString();
  atomicJson(path.join(f.artifact.path, WORKER_JOBS_FILE), { version: 1, jobs: { [jobId]: job }, order: [jobId] });
  projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'needs_attention');
  job.repliedAt = new Date().toISOString(); job.phase = 'done';
  atomicJson(path.join(f.artifact.path, WORKER_JOBS_FILE), { version: 1, jobs: { [jobId]: job }, order: [jobId] });
  projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'completed');
  assert.equal(await fs.readFile(path.join(f.artifact.path, 'comments.json'), 'utf8'), before);
  assert.equal((await f.requests.read(request.id)).event.data.messages.length, 1);
});

test('legacy delivered and unclaimed pending jobs need attention without automatic replay', async t => {
  const f = await fixture(t); f.document.threads[0].agent = { status: 'delivered', deliveredAt: '2026-10-31T00:00:01Z' }; await f.writeComments(f.document);
  let projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'needs_attention');
  const jobId = 'legacy-job'; const event = normalizeEvent(f.document.threads[0]);
  const job = { id: jobId, event, capturedUserRevision: userRevisionHash(event), status: 'pending', queuedAt: new Date().toISOString() };
  atomicJson(path.join(f.artifact.path, WORKER_JOBS_FILE), { version: 1, jobs: { [jobId]: job }, order: [jobId] });
  const journalBefore = await fs.readFile(path.join(f.artifact.path, WORKER_JOBS_FILE), 'utf8');
  projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'needs_attention');
  assert.equal(projected.threads[0].agent.nativeRequest.requestId, null); assert.equal(projected.threads[0].agent.status, 'delivered');
  assert.equal(await fs.readFile(path.join(f.artifact.path, WORKER_JOBS_FILE), 'utf8'), journalBefore);
  await assert.rejects(fs.access(path.join(f.root, '_state/edit-requests')), { code: 'ENOENT' });
});

test('an unrelated legacy active job cannot make a newly accepted request look dispatched', async t => {
  const f = await fixture(t), request = await f.prepare(); await f.requests.accept(request.id);
  const job = { id: 'legacy', event: request.event, capturedUserRevision: request.commentRevision, status: 'active', phase: 'editing', queuedAt: new Date().toISOString() };
  atomicJson(path.join(f.artifact.path, WORKER_JOBS_FILE), { version: 1, jobs: { legacy: job }, order: ['legacy'] });
  const projected = await f.requests.project(f.artifact.id, f.document);
  assert.equal(projected.threads[0].agent.nativeRequest.status, 'accepted'); assert.equal(projected.threads[0].agent.sentAt, request.createdAt);
  assert.equal((await f.requests.read(request.id)).dispatch, undefined);
});

test('failed native work stays failed and an explicit same-job retry becomes queued', async t => {
  const f = await fixture(t), request = await f.prepare(); await f.requests.markDraftAdded(request.id); await f.requests.accept(request.id);
  const { jobId, job } = await f.dispatchJournal(request, { status: 'failed', phase: 'replying', error: { code: 'FONT_MISSING', message: 'Font unavailable' } });
  await f.requests.markDispatched(request.id, { jobId, originThreadId: PARENT });
  let projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'failed'); assert.equal(projected.threads[0].agent.nativeRequest.message, 'Font unavailable');
  job.status = 'pending'; job.phase = 'waiting'; delete job.error;
  atomicJson(path.join(f.artifact.path, WORKER_JOBS_FILE), { version: 1, jobs: { [jobId]: job }, order: [jobId] });
  await f.requests.markDispatched(request.id, { jobId, originThreadId: PARENT });
  projected = await f.requests.project(f.artifact.id, f.document); assert.equal(projected.threads[0].agent.nativeRequest.status, 'queued');
});

test('UUIDs and canonical location paths cannot escape authorized content', async t => {
  const f = await fixture(t);
  for (const id of ['../escape', 'x', '/etc/passwd', '11111111-2222-4333-8444-555555555555/extra']) {
    await assert.rejects(f.requests.read(id), { code: 'INVALID_ID' }); assert.throws(() => requestUri(id), { code: 'INVALID_ID' });
  }
  await assert.rejects(f.requests.prepare({ artifactId: '..', commentId: 'comment-a' }), { code: 'INVALID_ID' });
  for (const file of ['../escape', 'project/../../escape', 'C:/escape', 'project\\escape', '_state/bindings.json', 'comments.json']) {
    f.document.threads[0].location.file = file; await f.writeComments(f.document);
    await assert.rejects(f.prepare(), error => ['INVALID_PATH', 'CONTENT_ONLY'].includes(error.code), file);
  }
  f.document.threads[0].file = 'project/slides/cover.html'; f.document.threads[0].location.file = '../hidden'; await f.writeComments(f.document);
  await assert.rejects(f.prepare(), { code: 'INVALID_PATH' });
});

test('oversized comment context is rejected without truncation or a partially prepared record', async t => {
  const f = await fixture(t); f.document.threads[0].messages[0].text = '大'.repeat(100_000); await f.writeComments(f.document);
  await assert.rejects(f.prepare(), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(fs.access(path.join(f.root, '_state/edit-requests')), { code: 'ENOENT' });
});

test('comment projection stays responsive while the native execution lock is held', async t => {
  const f = await fixture(t);
  const request = await f.prepare(); await f.requests.markDraftAdded(request.id);
  await withLock(path.join(f.artifact.path, WORKER_LOCK_FILE), async () => {
    const snapshot = await f.requests.project(f.artifact.id, f.document);
    assert.equal(snapshot.threads[0].agent.nativeRequest.status, 'prepared');
  }, { timeoutMs: 1000, staleMs: 0 });
});
