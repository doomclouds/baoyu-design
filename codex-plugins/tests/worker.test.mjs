import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, BINDING_FILE, DELIVERY_FILE, deliveryKey, deliverComment, normalizeEvent, readJson, withLock } from '../source/scripts/bridge-core.mjs';
import { registerNativeWorker, nextNativeJob, completeNativeJob, getWorkerStatus, stopWorker, retryWorkerJob } from '../source/scripts/worker-client.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE, WORKER_LOG_FILE, appendWorkerLog, userRevisionHash } from '../source/scripts/worker-core.mjs';

const PARENT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const childEnv = { CODEX_THREAD_ID: CHILD };
const otherEnv = { CODEX_THREAD_ID: OTHER };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Native queue condition timed out.');
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-native-worker-test-'));
  const skillDir = path.join(root, 'skills', 'codex-design'); await fsp.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
  const binding = { version: 1, root, skillDir, threadId: PARENT, deliveryMode: 'native', token: 'test-binding-token', serverPid: process.pid };
  atomicJson(path.join(root, BINDING_FILE), binding);
  atomicJson(path.join(root, '.artifact-server.json'), { root, kind: 'design', pid: process.pid, url: 'http://127.0.0.1:1/design/test/' });
  const makeThread = (id, text) => ({ id, status: 'open', label: 'Heading', location: { file: 'project/Main.dc.html' }, messages: [{ id: `m-${id}`, author: { kind: 'user' }, text, at: new Date(Date.now() - 1000).toISOString() }] });
  atomicJson(path.join(root, 'comments.json'), { version: 1, threads: [makeThread('c_a', 'Change heading A'), makeThread('c_b', 'Change heading B')] });
  const replies = [];
  const event = (id = 'c_a') => normalizeEvent(readJson(path.join(root, 'comments.json')).threads.find((thread) => thread.id === id));
  const submit = (id = 'c_a') => deliverComment(binding, event(id).data, { env: {} });
  const register = (options = {}) => registerNativeWorker(root, { env: childEnv, ...options });
  const next = (options = {}) => nextNativeJob(root, { env: childEnv, verifyEditor: async () => true, timeoutSeconds: 0, ...options });
  const postReply = async (_binding, id, text, expected) => {
    const doc = readJson(path.join(root, 'comments.json')); const thread = doc.threads.find((thread) => thread.id === id);
    if (userRevisionHash(normalizeEvent(thread)) !== expected || thread.status !== 'open') throw Object.assign(new Error('new user revision'), { code: 'COMMENT_REVISION_CHANGED' });
    thread.messages.push({ author: { kind: 'agent' }, text, at: new Date().toISOString() }); replies.push({ id, text }); atomicJson(path.join(root, 'comments.json'), doc);
  };
  const complete = (id, text, options = {}) => completeNativeJob(root, id, text, { env: childEnv, postReply, ...options });
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
  return { root, binding, replies, event, submit, register, next, complete, postReply };
}

test('native acceptance is persistent without a model process, Codex PATH, registry or main queue', async (t) => {
  const f = await fixture(t); const accepted = await f.submit();
  assert.equal(accepted.accepted, true); assert.equal(accepted.status, 'pending');
  assert.equal(readJson(path.join(f.root, DELIVERY_FILE)).delivered[accepted.jobId].mode, 'native');
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[accepted.jobId].status, 'pending');
  const status = await getWorkerStatus(f.root);
  assert.equal(status.nativeThreadId, null); assert.equal(status.needsResume, true); assert.equal(status.counts.pending, 1);
  assert.equal((await f.submit()).duplicate, true);
});

test('registration rejects the parent, reuses one actual actor ID and requires explicit replacement', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.register({ env: { CODEX_THREAD_ID: PARENT } }), { code: 'PARENT_CANNOT_REGISTER' });
  await assert.rejects(f.register({ env: {} }), { code: 'NATIVE_THREAD_REQUIRED' });
  assert.equal((await f.register()).reused, false); assert.equal((await f.register()).reused, true);
  await assert.rejects(f.register({ env: otherEnv }), { code: 'NATIVE_REPLACEMENT_REQUIRED' });
  assert.equal((await f.register({ env: otherEnv, replace: true })).nativeThreadId, OTHER);
});

test('one native worker serializes an artifact and resumes its unfinished active job', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); const b = await f.submit('c_b');
  const first = await f.next(); assert.equal(first.job.id, a.jobId); assert.equal(first.resumed, false);
  const resumed = await f.next(); assert.equal(resumed.job.id, a.jobId); assert.equal(resumed.resumed, true);
  assert.equal((await getWorkerStatus(f.root)).counts.active, 1);
  await f.complete(a.jobId, 'A done');
  assert.equal((await f.next()).job.id, b.jobId); await f.complete(b.jobId, 'B done');
  assert.equal(f.replies.length, 2); assert.equal((await getWorkerStatus(f.root)).counts.completed, 2);
  assert.match(first.request, /registered native Codex subagent/); assert.match(first.request, /worker-complete/);
});

test('different artifacts independently claim native jobs without a shared global queue', async (t) => {
  const a = await fixture(t), b = await fixture(t);
  await Promise.all([a.register(), b.register()]); await Promise.all([a.submit(), b.submit()]);
  const jobs = await Promise.all([a.next(), b.next()]); assert.ok(jobs.every((result) => result.job.status === 'active'));
  assert.equal((await getWorkerStatus(a.root)).counts.active, 1); assert.equal((await getWorkerStatus(b.root)).counts.active, 1);
});

test('worker-next releases its jobs lock while watching and wakes for a persisted comment', async (t) => {
  const f = await fixture(t); await f.register(); const waiting = f.next({ timeoutSeconds: 2 });
  await until(() => readJson(path.join(f.root, WORKER_FILE))?.listener);
  const accepted = await f.submit();
  assert.equal((await waiting).job.id, accepted.jobId);
  assert.equal(fs.existsSync(path.join(f.root, WORKER_LOCK_FILE)), false);
});

test('concurrent worker-next waiters for the same actor are rejected', async (t) => {
  const f = await fixture(t); await f.register(); const waiting = f.next({ timeoutSeconds: 2 });
  await until(() => readJson(path.join(f.root, WORKER_FILE))?.listener);
  await assert.rejects(f.next(), { code: 'NATIVE_ALREADY_LISTENING' });
  await stopWorker(f.root); assert.equal((await waiting).closed, true);
});

test('completion verifies the registered actor and owning job, then replies once', async (t) => {
  const f = await fixture(t); await f.register(); const accepted = await f.submit(); await f.next();
  await assert.rejects(f.complete(accepted.jobId, 'wrong', { env: otherEnv }), { code: 'WRONG_NATIVE_WORKER' });
  assert.equal((await f.complete(accepted.jobId, 'done')).completed, true);
  assert.equal((await f.complete(accepted.jobId, 'done')).duplicate, true); assert.equal(f.replies.length, 1);
});

test('new user revision supersedes A and only B receives the final reply', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const doc = readJson(path.join(f.root, 'comments.json')); doc.threads[0].messages[0].text = 'Request B'; doc.threads[0].messages[0].editedAt = new Date().toISOString(); atomicJson(path.join(f.root, 'comments.json'), doc);
  const b = await f.submit(); assert.notEqual(a.jobId, b.jobId);
  assert.equal((await f.complete(a.jobId, 'A stale')).status, 'superseded'); assert.equal(f.replies.length, 0);
  assert.equal((await f.next()).job.id, b.jobId); await f.complete(b.jobId, 'B final'); assert.deepEqual(f.replies.map((reply) => reply.text), ['B final']);
});

test('CAS failure during the reply CLI window also supersedes A without posting', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const result = await f.complete(a.jobId, 'stale A', { postReply: async (...args) => {
    const doc = readJson(path.join(f.root, 'comments.json')); doc.threads[0].messages[0].editedAt = new Date().toISOString(); atomicJson(path.join(f.root, 'comments.json'), doc); await f.postReply(...args);
  } });
  assert.equal(result.status, 'superseded'); assert.equal(f.replies.length, 0);
});

test('a posted reply recovered from an active journal is not duplicated', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const state = readJson(path.join(f.root, WORKER_JOBS_FILE)); state.jobs[a.jobId].resultText = 'already posted'; state.jobs[a.jobId].phase = 'replying'; atomicJson(path.join(f.root, WORKER_JOBS_FILE), state);
  await f.postReply(f.binding, 'c_a', 'already posted', userRevisionHash(f.event()));
  assert.equal((await f.next()).timedOut, true); assert.equal((await getWorkerStatus(f.root)).counts.completed, 1); assert.equal(f.replies.length, 1);
});

test('resuming a worker supersedes stale active A before claiming current user revision B', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const doc = readJson(path.join(f.root, 'comments.json')); doc.threads[0].messages[0].text = 'Newer B request'; doc.threads[0].messages[0].editedAt = new Date().toISOString(); atomicJson(path.join(f.root, 'comments.json'), doc);
  const b = await f.submit(); const resumed = await f.next();
  assert.equal(resumed.job.id, b.jobId); assert.equal(resumed.resumed, false); assert.match(resumed.request, /Newer B request/);
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[a.jobId].status, 'superseded');
});

test('recovery of an already posted failure remains failed with its original error', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const state = readJson(path.join(f.root, WORKER_JOBS_FILE));
  Object.assign(state.jobs[a.jobId], { resultText: '未完成：字体不可用', resultFailed: true, resultError: { code: 'FONT_MISSING', message: 'font unavailable' }, phase: 'replying' });
  atomicJson(path.join(f.root, WORKER_JOBS_FILE), state); await f.postReply(f.binding, 'c_a', '未完成：字体不可用', userRevisionHash(f.event()));
  assert.equal((await f.next()).timedOut, true);
  const status = await getWorkerStatus(f.root); assert.equal(status.counts.failed, 1); assert.equal(status.counts.completed, 0); assert.equal(status.jobs[0].error.code, 'FONT_MISSING'); assert.equal(f.replies.length, 1);
});

test('a registered listener starting after editor shutdown returns closed', async (t) => {
  const f = await fixture(t); await f.register(); await fsp.rm(path.join(f.root, BINDING_FILE));
  assert.equal((await f.next()).closed, true);
});

test('explicit failure remains failed, is visible in its reply and can be retried', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const failed = await f.complete(a.jobId, JSON.stringify({ text: '未完成：需要可用的字体。', status: 'failed', error: { code: 'FONT_MISSING', message: 'font unavailable' } }));
  assert.equal(failed.status, 'failed'); assert.equal(failed.completed, false); assert.match(f.replies[0].text, /未完成/);
  assert.equal((await getWorkerStatus(f.root)).jobs[0].error.code, 'FONT_MISSING');
  assert.equal((await retryWorkerJob(f.root, a.jobId)).status, 'pending'); await f.next(); await f.complete(a.jobId, 'now done'); assert.equal(f.replies.length, 2);
});

test('complete stores the full response but posts fewer than 10000 UTF-16 code units', async (t) => {
  const f = await fixture(t); await f.register(); const a = await f.submit(); await f.next();
  const text = '中文😀'.repeat(4000); await f.complete(a.jobId, text);
  assert.ok(f.replies[0].text.length < 10000);
  assert.equal(readJson(path.join(f.root, WORKER_JOBS_FILE)).jobs[a.jobId].fullResultText, text);
});

test('pause ends a waiting listener and honestly reports that an active native agent needs native interruption', async (t) => {
  const f = await fixture(t); await f.register(); const waiting = f.next({ timeoutSeconds: 2 }); await until(() => readJson(path.join(f.root, WORKER_FILE))?.listener);
  const paused = await stopWorker(f.root); assert.equal(paused.interruptRequired, false); assert.equal((await waiting).closed, true);
  await f.register(); await f.submit(); await f.next(); const activeStop = await stopWorker(f.root);
  assert.equal(activeStop.interruptRequired, true); assert.equal(activeStop.nativeThreadId, CHILD); assert.match(activeStop.note, /parent must use native agent tools/);
  assert.equal((await getWorkerStatus(f.root)).counts.pending, 1);
});

test('replacement closes the old listener without externally messaging either agent', async (t) => {
  const f = await fixture(t); await f.register(); const waiting = f.next({ timeoutSeconds: 2 }); await until(() => readJson(path.join(f.root, WORKER_FILE))?.listener);
  await f.register({ env: otherEnv, replace: true }); assert.equal((await waiting).closed, true);
  assert.equal((await getWorkerStatus(f.root)).nativeThreadId, OTHER);
});

test('missing/corrupt lock owners retain an initialization grace even with staleMs zero', async (t) => {
  const f = await fixture(t); const lock = path.join(f.root, 'initializing.lock'); await fsp.mkdir(lock);
  let entered = false;
  await assert.rejects(withLock(lock, async () => { entered = true; }, { staleMs: 0, timeoutMs: 60, initializationGraceMs: 1000 }), { code: 'BRIDGE_BUSY' });
  assert.equal(entered, false); await fsp.rmdir(lock);
  await Promise.all(Array.from({ length: 8 }, () => withLock(lock, async () => { assert.equal(entered, false); entered = true; await delay(5); entered = false; }, { staleMs: 0 })));
});

test('a crashed ownerless or dead-owned reaper can be recovered after its initialization grace', async (t) => {
  const f = await fixture(t);
  for (const kind of ['empty', 'dead-owner', 'corrupt-owner']) {
    const lock = path.join(f.root, `crashed-${kind}.lock`), reaper = `${lock}.reaper`;
    await fsp.mkdir(lock); atomicJson(path.join(lock, 'owner.json'), { pid: 2147483647, token: 'dead-lock-owner', at: 0 });
    await fsp.mkdir(reaper);
    if (kind === 'dead-owner') atomicJson(path.join(reaper, 'owner-dead-reaper.json'), { pid: 2147483647, token: 'dead-reaper', at: 0 });
    if (kind === 'corrupt-owner') await fsp.writeFile(path.join(reaper, 'owner-corrupt.json'), '{incomplete');
    await fsp.utimes(reaper, new Date(0), new Date(0));
    let entered = 0;
    await withLock(lock, async () => { entered++; }, { staleMs: 0, timeoutMs: 500, initializationGraceMs: 50 });
    assert.equal(entered, 1); assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(reaper), false);
  }
});

test('a live reaper owner is never displaced even when its timestamp is old', async (t) => {
  const f = await fixture(t); const lock = path.join(f.root, 'live-reaper.lock'), reaper = `${lock}.reaper`;
  await fsp.mkdir(lock); atomicJson(path.join(lock, 'owner.json'), { pid: 2147483647, token: 'dead-lock', at: 0 });
  await fsp.mkdir(reaper); const marker = path.join(reaper, 'owner-live-reaper.json');
  atomicJson(marker, { pid: process.pid, token: 'live-reaper', at: 0 }); await fsp.utimes(reaper, new Date(0), new Date(0));
  const before = await fsp.readFile(marker, 'utf8'); let entered = false;
  await assert.rejects(withLock(lock, async () => { entered = true; }, { staleMs: 0, timeoutMs: 70, initializationGraceMs: 1 }), { code: 'BRIDGE_BUSY' });
  assert.equal(entered, false); assert.equal(await fsp.readFile(marker, 'utf8'), before); assert.equal(fs.existsSync(lock), true);
});

test('multiple contenders recovering a crashed reaper still admit only one lock owner', async (t) => {
  const f = await fixture(t); const lock = path.join(f.root, 'concurrent-recovery.lock'), reaper = `${lock}.reaper`;
  await fsp.mkdir(lock); atomicJson(path.join(lock, 'owner.json'), { pid: 2147483647, token: 'dead-lock', at: 0 });
  await fsp.mkdir(reaper); await fsp.utimes(reaper, new Date(0), new Date(0));
  let active = 0, maximum = 0, completed = 0;
  await Promise.all(Array.from({ length: 8 }, () => withLock(lock, async () => {
    active++; maximum = Math.max(maximum, active); await delay(8); active--; completed++;
  }, { staleMs: 0, timeoutMs: 2000, initializationGraceMs: 10 })));
  assert.equal(maximum, 1); assert.equal(completed, 8); assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(reaper), false);
});

test('logs are bounded and no native production module imports a model/HTTP worker daemon', async (t) => {
  const f = await fixture(t); await fsp.writeFile(path.join(f.root, WORKER_LOG_FILE), 'x'.repeat(300000)); appendWorkerLog(f.root, 'next'); assert.ok((await fsp.stat(path.join(f.root, WORKER_LOG_FILE))).size < 140000);
  const source = await fsp.readFile(new URL('../source/scripts/worker-client.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('worker-rpc.mjs'), false); assert.equal(source.includes('http.createServer'), false); assert.equal(source.includes("'queue'"), false);
});
