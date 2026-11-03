import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createMotionExports } from '../source/server/motion-export.mjs';
import { createLibraryStore } from '../source/library/index.mjs';
import { createExportStore } from '../source/library/export-store.mjs';
import { motionCommentLocation } from '../source/library/motion-location.mjs';

async function fixture(t, { slow = false, mime = 'video/mp4', size = 8192 } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-motion-render-')));
  const store = createLibraryStore({ root: path.join(directory, 'library') }); await store.initialize();
  const record = await store.create({ kind: 'motion', title: '中文 Motion QA' });
  const scripts = path.join(directory, 'plugin/skills/codex-motion/scripts'); await fs.mkdir(scripts, { recursive: true });
  const source = `import fs from 'node:fs';const out=process.argv[process.argv.indexOf('--out')+1];${slow ? 'setInterval(()=>{},1000);' : `fs.writeFileSync(out,Buffer.from('ftypisom'));fs.truncateSync(out,${size});console.log(JSON.stringify({out,bytes:${size},mime:${JSON.stringify(mime)}}));`}`;
  await fs.writeFile(path.join(scripts, 'artifact.mjs'), source);
  let childFinished;
  const childClosed = new Promise(resolve => { childFinished = resolve; });
  const exports = createMotionExports({ store, pluginRoot: path.join(directory, 'plugin'), spawnProcess(command, args, options) {
    const child = spawn(command, args, options); child.once('close', childFinished); return child;
  } });
  const destination = path.join(directory, 'saved'); await fs.mkdir(destination);
  const saves = createExportStore({ store, resolveSource: (token, id) => exports.resolve(token, id) });
  const started = [];
  t.after(async () => {
    for (const job of started) await exports.operate(record, { operation: 'cancel', jobId: job }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const start = async options => { const job = await exports.operate(record, { operation: 'start', format: 'mp4', options }); started.push(job.jobId); return job; };
  const untilDone = async id => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const job = await exports.operate(record, { operation: 'status', jobId: id });
      if (job.status !== 'running') return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('renderer fixture did not finish');
  };
  return { directory, store, record, exports, saves, destination, start, untilDone, childClosed };
}

test('native Motion jobs return only an artwork-bound receipt and Save As copies every rendered byte', async t => {
  const f = await fixture(t), started = await f.start({ height: 720, fps: 30, quality: 'high' });
  assert.equal(started.status, 'running');
  const job = await f.untilDone(started.jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.equal(job.resource.artifactId, f.record.id); assert.equal(job.resource.bytes, 8192);
  assert.equal(job.resource.mimeType, 'video/mp4');
  assert.equal(Object.hasOwn(job.resource, 'path'), false); assert.equal(Object.hasOwn(job.resource, 'base64'), false);
  await assert.rejects(f.exports.resolve(started.jobId, randomUUID()), { code: 'MOTION_EXPORT_NOT_FOUND' });
  const requestId = randomUUID(), payload = { ...job.resource, requestId, directory: f.destination };
  const saved = await f.saves.save(payload);
  assert.equal(saved.saved, true); assert.equal(saved.bytes, 8192);
  assert.deepEqual(await fs.readFile(saved.path), await fs.readFile((await f.exports.resolve(started.jobId, f.record.id)).path));
  assert.equal((await f.saves.save(payload)).duplicate, true);
  await assert.rejects(f.saves.save({ ...payload, requestId: randomUUID(), text: 'injected' }), { code: 'EXPORT_INVALID_CONTENT' });
});

test('a rendered movie larger than the inline save limit streams through an opaque receipt', async t => {
  const size = 129 * 1024 * 1024;
  const f = await fixture(t, { size }), job = await f.untilDone((await f.start()).jobId);
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const saved = await f.saves.save({ ...job.resource, requestId: randomUUID(), directory: f.destination });
  assert.equal(saved.bytes, size); assert.equal((await fs.stat(saved.path)).size, size);
  const handle = await fs.open(saved.path); const prefix = Buffer.alloc(8);
  try { await handle.read(prefix, 0, 8, 0); assert.equal(prefix.toString(), 'ftypisom'); } finally { await handle.close(); }
});

test('a changed rendered source cannot replace an existing destination', async t => {
  const f = await fixture(t), job = await f.untilDone((await f.start()).jobId);
  const target = path.join(f.destination, job.resource.filename); await fs.writeFile(target, 'Keep the existing movie.');
  const payload = { ...job.resource, requestId: randomUUID(), directory: f.destination };
  const collision = await f.saves.save(payload); assert.equal(collision.exists, true);
  const source = await f.exports.resolve(job.jobId, f.record.id); await fs.writeFile(source.path, 'Changed source.');
  await assert.rejects(f.saves.save({ ...payload, overwriteToken: collision.overwriteToken }), { code: 'EXPORT_SOURCE_CHANGED' });
  assert.equal(await fs.readFile(target, 'utf8'), 'Keep the existing movie.');
  assert.deepEqual(await fs.readdir(f.destination), [job.resource.filename]);
});

test('cancel is scoped to the selected film and stops its renderer without producing an export receipt', async t => {
  const f = await fixture(t, { slow: true }), started = await f.start();
  await assert.rejects(f.exports.operate({ ...f.record, id: randomUUID() }, { operation: 'cancel', jobId: started.jobId }), { code: 'MOTION_EXPORT_NOT_FOUND' });
  await assert.rejects(f.start(), { code: 'MOTION_EXPORT_BUSY' });
  assert.equal((await f.exports.operate(f.record, { operation: 'cancel', jobId: started.jobId })).status, 'cancelled');
  await assert.rejects(f.exports.resolve(started.jobId, f.record.id), { code: 'MOTION_EXPORT_UNAVAILABLE' });
});

test('simultaneous starts admit only one renderer for the same film', async t => {
  const f = await fixture(t, { slow: true });
  const results = await Promise.allSettled([f.start(), f.start(), f.start()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'MOTION_EXPORT_BUSY');
});

test('cancellation after renderer exit cannot be changed into completed while its file is verified', async t => {
  const f = await fixture(t), started = await f.start();
  await f.childClosed;
  assert.equal((await f.exports.operate(f.record, { operation: 'cancel', jobId: started.jobId })).status, 'cancelled');
  const output = path.join(f.store.root, '_state/motion-exports', started.jobId, 'film.mp4');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await fs.access(output); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
  const result = await f.exports.operate(f.record, { operation: 'status', jobId: started.jobId });
  assert.equal(result.status, 'cancelled'); assert.equal(result.resource, undefined);
});

test('saved and committing receipts recover after restart without the old in-memory render token', async t => {
  const f = await fixture(t), job = await f.untilDone((await f.start()).jobId);
  const payload = { ...job.resource, requestId: randomUUID(), directory: f.destination };
  const saved = await f.saves.save(payload);
  const restarted = createExportStore({ store: f.store, resolveSource: async () => { throw Object.assign(new Error('The old process is gone.'), { code: 'MOTION_EXPORT_NOT_FOUND' }); } });
  assert.equal((await restarted.save(payload)).duplicate, true);
  const receiptFile = path.join(f.store.root, '_state/export-receipts', payload.requestId + '.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.status = 'committing'; delete receipt.result;
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  const recovered = await restarted.save(payload);
  assert.equal(recovered.saved, true); assert.equal(recovered.duplicate, true);
  assert.equal(await fs.readFile(saved.path, 'base64'), await fs.readFile((await f.exports.resolve(job.jobId, f.record.id)).path, 'base64'));
  await assert.rejects(restarted.save({ ...payload, exportToken: randomUUID() }), { code: 'EXPORT_REQUEST_CONFLICT' });
});

test('unsupported renderer input and a different returned format fail explicitly', async t => {
  const f = await fixture(t, { mime: 'video/webm' });
  for (const options of [{ height: '../file' }, { fps: 999 }, { quality: 'script' }, { out: '/private/path' }]) await assert.rejects(f.start(options), { code: 'INVALID_MOTION_EXPORT' });
  await assert.rejects(f.exports.operate({ ...f.record, kind: 'design' }, { operation: 'start', format: 'mp4' }), { code: 'INVALID_MOTION_EXPORT' });
  const job = await f.untilDone((await f.start()).jobId);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'MOTION_EXPORT_FORMAT');
});

test('native Motion comment locations preserve authored time, ranges and normalized frame coordinates', () => {
  const root = 'animation-v1:nth-of-type(1) > at-1250ms:nth-of-type(1) > ';
  const point = motionCommentLocation(root + 'x2500-y7500:nth-of-type(1) > w5000-h4000:nth-of-type(1)');
  assert.equal(point.time, 1.25); assert.equal(point.coordinateSpace, 'authored');
  assert.equal(point.x, .25); assert.equal(point.y, .75); assert.equal(point.width, .5); assert.equal(point.height, .25);
  const range = motionCommentLocation(root + 'to-3000ms:nth-of-type(1)');
  assert.equal(range.timeEnd, 3); assert.equal(Object.hasOwn(range, 'x'), false);
  assert.equal(range.file, 'db/film/script.json'); assert.equal(range.anchor, root + 'to-3000ms:nth-of-type(1)');
  assert.equal(motionCommentLocation(root + 'to-1300ms:nth-of-type(1)'), null);
  assert.equal(motionCommentLocation('javascript:run()'), null);
});
