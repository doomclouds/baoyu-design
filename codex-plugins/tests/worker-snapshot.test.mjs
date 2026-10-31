import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../source/library/index.mjs';
import { locked } from '../source/library/safety.mjs';
import { atomicJson, BINDING_FILE, deliverComment, readJson } from '../source/scripts/bridge-core.mjs';
import { registerNativeWorker, nextNativeJob, completeNativeJob, getWorkerStatus } from '../source/scripts/worker-client.mjs';

const PARENT = '11111111-2222-4333-8444-555555555555';
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const env = { CODEX_THREAD_ID: CHILD };
async function fixture(t, { guarded = false } = {}) {
  const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-worker-snapshot-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), libraryRoot); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(libraryRoot, { recursive: true, force: true }); });
  const store = createLibraryStore({ root: libraryRoot, ...(guarded ? { isBusy: async record => (await getWorkerStatus(record.path)).counts.active > 0 } : {}) });
  const record = await store.create({ kind: 'slides', title: 'AI checkpoint' });
  const root = record.path, slide = path.join(root, 'project/slides/cover.html');
  const binding = { version: 1, root, skillDir: path.join(libraryRoot, 'skills/codex-slides'), threadId: PARENT, deliveryMode: 'native', token: 'worker-snapshot-token', serverPid: process.pid };
  atomicJson(path.join(root, BINDING_FILE), binding);
  await registerNativeWorker(root, { env });
  return { store, record, root, slide, libraryRoot,
    submit: (id = 'first') => deliverComment(binding, { request: { id, text: 'Revise this artwork.' } }),
    next: () => nextNativeJob(root, { env, timeoutSeconds: 0, verifyEditor: async () => true }),
  };
}

test('a native library job receives one real pre-AI restore point, reused after interruption', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.slide, '<section id="cover"><h1>Before AI</h1></section>');
  const accepted = await f.submit();
  const first = await f.next();
  assert.equal(first.job.id, accepted.jobId); assert.equal(first.job.status, 'active');
  assert.equal(first.job.restorePoint.artifactId, f.record.id);
  assert.equal(first.job.restorePoint.label, 'Before AI edit');
  await fs.writeFile(f.slide, '<section id="cover"><h1>Partly edited</h1></section>');
  const resumed = await f.next();
  assert.equal(resumed.resumed, true); assert.equal(resumed.job.restorePoint.id, first.job.restorePoint.id);
  assert.equal((await f.store.listSnapshots(f.record.id)).length, 1);
  await completeNativeJob(f.root, accepted.jobId, 'Completed.', { env });
  await f.store.restoreSnapshot(f.record.id, first.job.restorePoint.id);
  assert.match(await fs.readFile(f.slide, 'utf8'), /Before AI/);
  const second = await f.submit('second');
  assert.notEqual((await f.next()).job.restorePoint.id, first.job.restorePoint.id);
  assert.notEqual(second.jobId, accepted.jobId);
});

test('failed pre-AI snapshot leaves a visible pending job and never delivers an editable request', async t => {
  const f = await fixture(t), deck = path.join(f.root, 'project/deck.json');
  const original = await fs.readFile(deck, 'utf8');
  await f.submit(); await fs.writeFile(deck, '{broken native index');
  await assert.rejects(f.next(), { code: 'RESTORE_POINT_FAILED' });
  const status = await getWorkerStatus(f.root);
  assert.equal(status.counts.active, 0); assert.equal(status.counts.pending, 1);
  assert.equal(status.jobs[0].error.code, 'RESTORE_POINT_FAILED');
  assert.equal((await f.store.listSnapshots(f.record.id)).length, 0);
  await fs.writeFile(deck, original);
  assert.ok((await f.next()).job.restorePoint.id);
});

test('preparing a recovery point reserves native ownership before waiting on the library lock', async t => {
  const f = await fixture(t, { guarded: true });
  await f.submit();
  let unlock, entered;
  const gate = new Promise(resolve => { unlock = resolve; });
  const held = new Promise(resolve => { entered = resolve; });
  const holding = locked(f.libraryRoot, async () => { entered(); await gate; });
  await held;
  const next = f.next();
  const deadline = Date.now() + 2000;
  while ((await getWorkerStatus(f.root)).counts.active === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await getWorkerStatus(f.root)).counts.active, 1);
  const trash = f.store.trash(f.record.id);
  const refused = assert.rejects(trash, { code: 'ARTIFACT_BUSY' });
  unlock(); await holding;
  assert.ok((await next).job.restorePoint.id);
  await refused;
  assert.equal((await f.store.get(f.record.id)).deleted, false);
});
