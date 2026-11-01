import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createLibraryStore } from '../source/library/index.mjs';
import { createEditRequestStore } from '../source/library/edit-requests.mjs';
import { dispatchEditRequest, editRequestJobId } from '../source/scripts/edit-request-dispatch.mjs';
import { atomicJson, BINDING_FILE, normalizeEvent, readJson } from '../source/scripts/bridge-core.mjs';
import { NATIVE_BINDING_FILE, WORKER_FILE, WORKER_JOBS_FILE, userRevisionHash } from '../source/scripts/worker-core.mjs';
import { completeNativeJob, getWorkerStatus, nextNativeJob, registerNativeWorker } from '../source/scripts/worker-client.mjs';

const PARENT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const parentEnv = { CODEX_THREAD_ID: PARENT }, childEnv = { CODEX_THREAD_ID: CHILD };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-request-dispatch-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(directory, { recursive: true, force: true }); });
  const store = createLibraryStore({ root: path.join(directory, 'library') });
  const artifact = await store.create({ kind: 'design', title: 'Native draft' });
  const root = artifact.path, skillDir = path.join(directory, 'skills/codex-design');
  await fs.writeFile(path.join(root, 'project/Main.dc.html'), '<main><h1>Current heading</h1></main>');
  await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Use the design skill and check current files.');
  const thread = { id: 'c_native', status: 'open', label: 'Heading', location: { file: 'project/Main.dc.html' }, messages: [{ id: 'm_user', author: { kind: 'user' }, text: 'Change this heading.', at: '2026-11-01T00:00:00.000Z' }] };
  atomicJson(path.join(root, 'comments.json'), { version: 1, threads: [thread] });
  const requests = createEditRequestStore({ store });
  const request = await requests.prepare({ artifactId: artifact.id, commentId: thread.id });
  const dispatch = (options = {}) => dispatchEditRequest(skillDir, root, request.id, { env: parentEnv, store, ...options });
  const accept = async () => { await requests.markDraftAdded(request.id); return requests.accept(request.id); };
  return { directory, root, store, artifact, requests, request, skillDir, dispatch, accept, thread };
}

test('real CLI dispatch requires its own native environment and never accepts a supplied thread flag', async t => {
  const f = await fixture(t); await f.accept();
  const runner = path.join(f.directory, 'cli.mjs');
  const commandUrl = pathToFileURL(fileURLToPath(new URL('../source/scripts/artifact-command.mjs', import.meta.url))).href;
  const storeUrl = pathToFileURL(fileURLToPath(new URL('../source/library/index.mjs', import.meta.url))).href;
  await fs.writeFile(runner, `import {runArtifactCommand} from ${JSON.stringify(commandUrl)};\nimport {createLibraryStore} from ${JSON.stringify(storeUrl)};\nawait runArtifactCommand(process.argv[2], process.argv.slice(4), {libraryStore:createLibraryStore({root:process.argv[3]})});\n`);
  const environment = { ...process.env }; delete environment.CODEX_THREAD_ID;
  const args = [runner, f.skillDir, f.store.root, 'request-dispatch', f.root, f.request.id];
  const missing = spawnSync(process.execPath, args, { env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stderr).error, 'NATIVE_PARENT_REQUIRED');
  const invalid = spawnSync(process.execPath, args, { env: { ...environment, CODEX_THREAD_ID: 'fake' }, encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stderr).error, 'NATIVE_PARENT_REQUIRED');
  const override = spawnSync(process.execPath, [...args, '--thread', PARENT], { env: environment, encoding: 'utf8', windowsHide: true });
  assert.equal(override.status, 2); assert.equal(JSON.parse(override.stderr).error, 'INVALID_REQUEST_DISPATCH_ARGUMENTS');
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)), null);
  const accepted = spawnSync(process.execPath, args, { env: { ...environment, CODEX_THREAD_ID: PARENT }, encoding: 'utf8', windowsHide: true });
  assert.equal(accepted.status, 0, accepted.stderr); assert.equal(JSON.parse(accepted.stdout).originThreadId, PARENT);
});

test('prepared drafts remain unqueued; accepted requests queue exactly once with immutable context', async t => {
  const f = await fixture(t); await f.requests.markDraftAdded(f.request.id);
  await assert.rejects(f.dispatch(), { code: 'REQUEST_NOT_ACCEPTED' });
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)), null);
  await f.requests.accept(f.request.id);
  const [first, second] = await Promise.all([f.dispatch(), f.dispatch()]);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true); assert.equal(first.jobId, editRequestJobId(f.request.id));
  const state = readJson(path.join(f.root, WORKER_JOBS_FILE)), job = state.jobs[first.jobId];
  assert.deepEqual(state.order, [first.jobId]); assert.equal(job.requestId, f.request.id); assert.deepEqual(job.event, f.request.event);
  assert.deepEqual(job.capturedRequest.fileRevisions, f.request.fileRevisions);
  assert.equal((await f.requests.read(f.request.id)).status, 'queued');
  assert.equal(readJson(path.join(f.root, NATIVE_BINDING_FILE)).requestProtocol, 'native-draft-v1');
  assert.equal(readJson(path.join(f.root, BINDING_FILE)), null); assert.equal(readJson(path.join(f.root, WORKER_FILE)), null);
});

test('dispatch recovers a crash between journal publication and receipt update without queueing twice', async t => {
  const f = await fixture(t); await f.accept();
  await assert.rejects(f.dispatch({ requests: { ...f.requests, markDispatched: async () => { throw Object.assign(new Error('interrupted receipt write'), { code: 'INTERRUPTED' }); } } }), { code: 'INTERRUPTED' });
  assert.equal((await f.requests.read(f.request.id)).status, 'accepted');
  const recovered = await f.dispatch(); assert.equal(recovered.duplicate, true);
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)).order.length, 1);
  assert.equal((await f.requests.read(f.request.id)).dispatch.jobId, recovered.jobId);
});

test('changed and resolved captured comments cannot publish a worker job', async t => {
  for (const resolved of [false, true]) {
    const f = await fixture(t); await f.accept();
    if (resolved) f.thread.status = 'resolved'; else f.thread.messages[0].text = 'New user revision';
    atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
    await assert.rejects(f.dispatch(), { code: 'REQUEST_NOT_ACCEPTED' });
    assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)), null);
    assert.equal(readJson(path.join(f.root, NATIVE_BINDING_FILE)), null);
  }
});

test('a request cannot be dispatched against another artifact or another library root', async t => {
  const f = await fixture(t); await f.accept();
  const other = await f.store.create({ kind: 'design', title: 'Different artwork' });
  await assert.rejects(dispatchEditRequest(f.skillDir, other.path, f.request.id, { env: parentEnv, store: f.store }), { code: 'REQUEST_ARTIFACT_MISMATCH' });
  const wrongStore = createLibraryStore({ root: path.join(f.directory, 'other-library') });
  await assert.rejects(dispatchEditRequest(f.skillDir, f.root, f.request.id, { env: parentEnv, store: wrongStore }), { code: 'NOT_LIBRARY_ARTIFACT' });
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)), null);
});

test('dispatch rechecks current files without treating an intervening content edit as a stale comment', async t => {
  const missing = await fixture(t); await missing.accept();
  await fs.rm(path.join(missing.root, 'project/Main.dc.html'));
  await assert.rejects(missing.dispatch(), { code: 'NOT_FOUND' });
  assert.equal(readJson(path.join(missing.root, WORKER_JOBS_FILE)), null);
  const changed = await fixture(t); await changed.accept();
  await fs.writeFile(path.join(changed.root, 'project/Main.dc.html'), '<h1>User edited the file after preparing the request</h1>');
  const result = await changed.dispatch();
  assert.equal(result.status, 'pending');
  assert.deepEqual(readJson(path.join(changed.root, WORKER_JOBS_FILE)).jobs[result.jobId].capturedRequest.fileRevisions, changed.request.fileRevisions);
});

test('dispatch preserves unrelated UI service binding and refuses active or listening native ownership', async t => {
  for (const listening of [false, true]) {
    const f = await fixture(t); await f.accept();
    const uiBinding = { version: 1, root: f.root, threadId: null, token: 'ui-service-token', deliveryMode: 'native' };
    atomicJson(path.join(f.root, BINDING_FILE), uiBinding);
    const registry = { version: 1, root: f.root, nativeThreadId: CHILD, originThreadId: OTHER, registrationId: 'old', status: listening ? 'waiting' : 'active', ...(listening ? { listener: { id: 'live-listener', pid: process.pid, expiresAt: Date.now() + 60_000 } } : { activeJobId: 'existing' }) };
    atomicJson(path.join(f.root, WORKER_FILE), registry);
    const state = { version: 1, order: listening ? [] : ['existing'], jobs: listening ? {} : { existing: { id: 'existing', status: 'active', event: normalizeEvent(f.thread), ownerThreadId: CHILD } } };
    atomicJson(path.join(f.root, WORKER_JOBS_FILE), state);
    await assert.rejects(f.dispatch(), { code: 'ARTIFACT_BUSY' });
    assert.deepEqual(readJson(path.join(f.root, BINDING_FILE)), uiBinding); assert.deepEqual(readJson(path.join(f.root, WORKER_FILE)), registry);
    assert.deepEqual(readJson(path.join(f.root, WORKER_JOBS_FILE)), JSON.parse(JSON.stringify(state))); assert.equal(readJson(path.join(f.root, NATIVE_BINDING_FILE)), null);
  }
});

test('idle ownership can move to the actual new parent while the old child must be explicitly registered', async t => {
  const f = await fixture(t); await f.accept();
  atomicJson(path.join(f.root, NATIVE_BINDING_FILE), { version: 1, root: f.root, skillDir: f.skillDir, threadId: OTHER, nativeParentThreadId: OTHER, deliveryMode: 'native', token: 'old-token', requestProtocol: 'native-draft-v1' });
  atomicJson(path.join(f.root, WORKER_FILE), { version: 1, root: f.root, nativeThreadId: CHILD, originThreadId: OTHER, registrationId: 'old', status: 'waiting' });
  const result = await f.dispatch(); assert.equal(result.requiresRegistration, true); assert.equal(result.nativeThreadId, CHILD);
  assert.equal(readJson(path.join(f.root, NATIVE_BINDING_FILE)).threadId, PARENT);
  assert.equal(readJson(path.join(f.root, WORKER_FILE)).originThreadId, OTHER);
  await assert.rejects(nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 }), { code: 'NATIVE_PARENT_CHANGED' });
  await registerNativeWorker(f.root, { env: childEnv });
  assert.equal(readJson(path.join(f.root, WORKER_FILE)).originThreadId, PARENT);
});

test('native draft workers retain unconfirmed legacy pending jobs and survive UI service restarts', async t => {
  const f = await fixture(t); await f.accept();
  const event = normalizeEvent(f.thread);
  atomicJson(path.join(f.root, WORKER_JOBS_FILE), { version: 1, order: ['legacy'], jobs: { legacy: { id: 'legacy', status: 'pending', queuedAt: '2026-11-01T00:00:00.000Z', phase: 'waiting', event, capturedUserRevision: userRevisionHash(event) } } });
  const dispatched = await f.dispatch(); await registerNativeWorker(f.root, { env: childEnv });
  atomicJson(path.join(f.root, BINDING_FILE), { deliveryMode: 'main', token: 'new-ui-token', threadId: null });
  const next = await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 });
  assert.equal(next.job.id, dispatched.jobId); assert.equal(next.job.requestId, f.request.id); assert.equal(next.job.phase, 'editing');
  assert.match(next.request, /CURRENT artifact files/); assert.match(next.request, /fileRevisions/); assert.match(next.request, /worker-complete/);
  assert.match(next.request, /held or needsConfirmation, stop content editing/);
  const legacy = readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs.legacy;
  assert.equal(legacy.status, 'pending'); assert.equal(legacy.phase, 'awaiting-user-confirmation');
  const status = await getWorkerStatus(f.root); assert.equal(status.counts.active, 1); assert.equal(status.listening, false);
  let replies = 0;
  const options = { env: childEnv, postReply: async () => { replies++; } };
  await completeNativeJob(f.root, next.job.id, 'Updated and checked.', options);
  await completeNativeJob(f.root, next.job.id, 'Updated and checked.', options);
  assert.equal(replies, 1); assert.equal((await f.dispatch()).duplicate, true);
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).timedOut, true);
});

test('the same real parent can append an accepted request while its child owns an active job without a listener', async t => {
  const f = await fixture(t); await f.accept(); const first = await f.dispatch();
  await registerNativeWorker(f.root, { env: childEnv });
  await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 });
  const document = readJson(path.join(f.root, 'comments.json'));
  document.threads.push({ ...f.thread, id: 'c_next', messages: [{ ...f.thread.messages[0], text: 'A second accepted request' }] });
  atomicJson(path.join(f.root, 'comments.json'), document);
  const second = await f.requests.prepare({ artifactId: f.artifact.id, commentId: 'c_next' });
  await f.requests.accept(second.id);
  const bindingBefore = readJson(path.join(f.root, NATIVE_BINDING_FILE)), registryBefore = readJson(path.join(f.root, WORKER_FILE));
  const queued = await dispatchEditRequest(f.skillDir, f.root, second.id, { env: parentEnv, store: f.store });
  assert.equal(queued.status, 'pending'); assert.equal(queued.requiresRegistration, false);
  assert.deepEqual(readJson(path.join(f.root, NATIVE_BINDING_FILE)), bindingBefore);
  assert.deepEqual(readJson(path.join(f.root, WORKER_FILE)), registryBefore);
  const status = await getWorkerStatus(f.root);
  assert.equal(status.counts.active, 1); assert.equal(status.counts.pending, 1); assert.equal(status.listening, false);
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).job.id, first.jobId);
});

test('a persistently superseded request cannot claim its pending job after the same comment is reopened', async t => {
  const f = await fixture(t); await f.accept(); const queued = await f.dispatch();
  await registerNativeWorker(f.root, { env: childEnv });
  f.thread.status = 'resolved';
  atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
  assert.equal((await f.requests.read(f.request.id)).status, 'superseded');
  f.thread.status = 'open';
  atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).timedOut, true);
  const job = readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[queued.jobId];
  assert.equal(job.status, 'superseded'); assert.equal(job.phase, 'superseded'); assert.equal(job.startedAt, undefined);
  const fresh = await f.requests.prepare({ artifactId: f.artifact.id, commentId: f.thread.id });
  assert.notEqual(fresh.id, f.request.id);
  await f.requests.accept(fresh.id);
  const dispatched = await dispatchEditRequest(f.skillDir, f.root, fresh.id, { env: parentEnv, store: f.store });
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).job.id, dispatched.jobId);
});

test('an orphan published job waits for its parent receipt before an existing native listener may claim it', async t => {
  const f = await fixture(t); await f.accept();
  await assert.rejects(f.dispatch({ requests: { ...f.requests, markDispatched: async () => { throw Object.assign(new Error('crashed before receipt'), { code: 'INTERRUPTED' }); } } }), { code: 'INTERRUPTED' });
  await registerNativeWorker(f.root, { env: childEnv });
  const next = await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 });
  assert.equal(next.timedOut, true);
  const jobId = editRequestJobId(f.request.id), before = readJson(path.join(f.root, WORKER_JOBS_FILE));
  assert.equal(before.jobs[jobId].status, 'pending'); assert.equal(before.jobs[jobId].phase, 'awaiting-dispatch-receipt');
  assert.equal(before.jobs[jobId].startedAt, undefined); assert.equal((await f.store.listSnapshots(f.artifact.id)).length, 0);
  assert.equal((await f.requests.read(f.request.id)).status, 'accepted');
  assert.equal((await f.dispatch()).duplicate, true);
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).job.id, jobId);
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)).order.length, 1);
});

test('a mismatched persisted receipt holds the job for parent confirmation', async t => {
  for (const field of ['jobId', 'originThreadId']) {
    const f = await fixture(t); await f.accept(); const queued = await f.dispatch();
    const file = path.join(f.store.root, '_state/edit-requests', `${f.request.id}.json`);
    const request = readJson(file); request.dispatch[field] = field === 'jobId' ? 'different-job' : OTHER; atomicJson(file, request);
    await registerNativeWorker(f.root, { env: childEnv });
    assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).timedOut, true);
    const job = readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[queued.jobId];
    assert.equal(job.status, 'pending'); assert.equal(job.phase, 'awaiting-user-confirmation'); assert.equal(job.startedAt, undefined);
  }
});

test('a persistently superseded request cannot resume its active job after the same comment is reopened', async t => {
  const f = await fixture(t); await f.accept(); const queued = await f.dispatch();
  await registerNativeWorker(f.root, { env: childEnv });
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).job.id, queued.jobId);
  f.thread.status = 'resolved';
  atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
  assert.equal((await f.requests.read(f.request.id)).status, 'superseded');
  f.thread.status = 'open';
  atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
  assert.equal((await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 })).timedOut, true);
  const job = readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[queued.jobId];
  assert.equal(job.status, 'superseded'); assert.equal(job.phase, 'superseded');
  assert.equal(readJson(path.join(f.root, WORKER_FILE)).activeJobId, undefined);
});

test('a persistently superseded active request cannot post its old reply after the same comment is reopened', async t => {
  const f = await fixture(t); await f.accept(); const queued = await f.dispatch();
  await registerNativeWorker(f.root, { env: childEnv });
  await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 });
  f.thread.status = 'resolved';
  atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
  assert.equal((await f.requests.read(f.request.id)).status, 'superseded');
  f.thread.status = 'open';
  atomicJson(path.join(f.root, 'comments.json'), { version: 1, threads: [f.thread] });
  let replies = 0;
  const options = { env: childEnv, postReply: async () => { replies++; } };
  const completion = await completeNativeJob(f.root, queued.jobId, 'This old reply must not be posted.', options);
  assert.equal(completion.completed, false); assert.equal(completion.status, 'superseded'); assert.equal(replies, 0);
  const repeated = await completeNativeJob(f.root, queued.jobId, '', options);
  assert.equal(repeated.duplicate, true); assert.equal(repeated.status, 'superseded'); assert.equal(replies, 0);
  assert.equal(readJson(path.join(f.root, WORKER_FILE)).activeJobId, undefined);
});

test('an unverified active receipt keeps ownership and honestly holds both resume and completion', async t => {
  const f = await fixture(t); await f.accept(); const queued = await f.dispatch();
  await registerNativeWorker(f.root, { env: childEnv });
  await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 });
  const file = path.join(f.store.root, '_state/edit-requests', `${f.request.id}.json`);
  const request = readJson(file); request.dispatch.originThreadId = OTHER; atomicJson(file, request);
  const registry = readJson(path.join(f.root, WORKER_FILE));
  const resumed = await nextNativeJob(f.root, { env: childEnv, timeoutSeconds: 0 });
  assert.equal(resumed.held, true); assert.equal(resumed.needsConfirmation, true); assert.equal(resumed.request, undefined);
  assert.equal(resumed.job.status, 'active'); assert.equal(resumed.job.phase, 'awaiting-user-confirmation');
  assert.match(resumed.error.message, /Stop content editing/);
  let replies = 0;
  const completed = await completeNativeJob(f.root, queued.jobId, 'Must not post while held.', { env: childEnv, postReply: async () => { replies++; } });
  assert.equal(completed.held, true); assert.equal(completed.status, 'active'); assert.equal(completed.phase, 'awaiting-user-confirmation');
  assert.equal(replies, 0);
  const preserved = readJson(path.join(f.root, WORKER_FILE)), job = readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[queued.jobId];
  assert.equal(preserved.activeJobId, registry.activeJobId); assert.equal(preserved.nativeThreadId, registry.nativeThreadId);
  assert.equal(job.ownerThreadId, CHILD); assert.equal(job.registrationId, registry.registrationId);
  assert.equal(job.resultText, undefined); assert.equal(job.error.code, 'NATIVE_REQUEST_CONFIRMATION_REQUIRED');
});
