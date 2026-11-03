import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safePath, UUID } from '../library/safety.mjs';
import { isValidBase64 } from '../scripts/base64.mjs';
import { packageFilename } from '../ui/library-transfer.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const MAX_CHUNK = 1024 * 1024;
const RETAIN_MS = 30 * 60 * 1000;
const fingerprint = stat => ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].map(key => String(stat[key])).join(':');

/** Stream portable packages through bounded messages, never browser-supplied paths. */
export function createArtifactTransfers({ store } = {}) {
  const uploads = new Map(), exports = new Map();
  const relative = job => `_state/artifact-transfers/${job.id}`;
  const directory = async job => safePath(store.root, relative(job), { type: 'directory', mustExist: false });
  const remove = async job => {
    await fs.rm(await directory(job), { recursive: true, force: true });
    job.removed = true;
  };
  const failed = async (job, error) => {
    try { await remove(job); }
    catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], `The package operation failed and staging cleanup failed (${cleanup.code || 'UNKNOWN'}).`, { cause: error }), { code: error.code || 'TRANSFER_FAILED' }); }
    throw error;
  };
  const prune = async () => {
    for (const records of [uploads, exports]) for (const job of records.values()) {
      if (job.busy || Date.now() - job.updatedAt <= RETAIN_MS) continue;
      if (!job.removed) await remove(job);
      records.delete(job.id);
    }
  };
  const create = async id => {
    await store.initialize();
    const parent = await safePath(store.root, '_state/artifact-transfers', { mustExist: false });
    await fs.mkdir(parent, { recursive: true });
    await safePath(store.root, '_state/artifact-transfers', { type: 'directory' });
    const target = path.join(parent, id);
    await fs.mkdir(target, { mode: 0o700 });
    return path.join(target, 'package.json');
  };
  const owned = id => {
    const job = UUID.test(id ?? '') && uploads.get(id);
    if (!job) throw fail('TRANSFER_NOT_FOUND', 'This upload does not belong to the current library session.');
    return job;
  };
  const locked = async (job, run) => {
    if (job.busy) throw fail('TRANSFER_BUSY', 'Wait for the current package operation to finish.');
    job.busy = true;
    try { return await run(); }
    finally { job.busy = false; job.updatedAt = Date.now(); }
  };
  const receipt = job => ({ transferId: job.id, status: job.status, offset: job.offset });
  return {
    async export(record) {
      await prune();
      const bundle = await store.exportArtifact(record.id);
      const text = JSON.stringify(bundle), bytes = Buffer.byteLength(text);
      if (bytes > store.limits.maxBundleBytes) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds its configured size limit.');
      const job = { id: randomUUID(), artifactId: record.id, status: 'writing', updatedAt: Date.now() };
      try {
        const file = await create(job.id);
        await fs.writeFile(file, text, { mode: 0o600, flag: 'wx' });
        const stat = await fs.lstat(file, { bigint: true });
        job.source = { path: file, size: bytes, mimeType: 'application/json', contentHash: createHash('sha256').update('application/json\0').update(text).digest('hex'), fingerprint: fingerprint(stat) };
        job.status = 'completed'; exports.set(job.id, job);
        return { filename: packageFilename(bundle.title), mimeType: 'application/json', bytes, exportToken: job.id, artifactId: record.id };
      } catch (error) { return failed(job, error); }
    },
    async resolve(token, artifactId) {
      const job = UUID.test(token ?? '') && exports.get(token);
      if (!job || job.artifactId !== artifactId || Date.now() - job.updatedAt > RETAIN_MS) throw fail('TRANSFER_NOT_FOUND', 'Export this artwork again before saving its package.');
      const file = await safePath(store.root, relative(job) + '/package.json', { type: 'file' });
      const stat = await fs.lstat(file, { bigint: true });
      if (fingerprint(stat) !== job.source.fingerprint || stat.nlink !== 1n) throw fail('TRANSFER_CHANGED', 'The exported package changed before it could be saved.');
      job.updatedAt = Date.now();
      return { ...job.source };
    },
    async operate(payload = {}) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('INVALID_TRANSFER', 'Choose a package upload operation.');
      const keys = { start: ['operation', 'bytes'], write: ['operation', 'transferId', 'offset', 'base64'], finish: ['operation', 'transferId'], cancel: ['operation', 'transferId'] }[payload.operation];
      if (!keys || Object.keys(payload).some(key => !keys.includes(key))) throw fail('INVALID_TRANSFER', 'Unsupported package upload arguments.');
      if (payload.operation === 'start') {
        if (!Number.isSafeInteger(payload.bytes) || payload.bytes < 1 || payload.bytes > store.limits.maxBundleBytes) throw fail('TRANSFER_TOO_LARGE', 'The selected package exceeds its configured size limit.');
        await prune();
        if ([...uploads.values()].filter(job => job.status !== 'completed').length >= 2) throw fail('TRANSFER_BUSY', 'Finish the current package uploads first.');
        const job = { id: randomUUID(), expected: payload.bytes, offset: 0, status: 'receiving', updatedAt: Date.now(), busy: true };
        uploads.set(job.id, job);
        try { job.file = await create(job.id); await fs.writeFile(job.file, '', { mode: 0o600, flag: 'wx' }); return receipt(job); }
        catch (error) { uploads.delete(job.id); return failed(job, error); }
        finally { job.busy = false; }
      }
      const job = owned(payload.transferId);
      return locked(job, async () => {
        if (payload.operation === 'cancel') {
          if (job.status === 'completed') return { cancelled: false, artifactId: job.record.id };
          await remove(job); uploads.delete(job.id); return { cancelled: true };
        }
        if (job.status === 'completed') {
          if (payload.operation === 'finish') return job.record;
          throw fail('INVALID_TRANSFER', 'This package was already imported.');
        }
        try {
          const file = await safePath(store.root, relative(job) + '/package.json', { type: 'file' });
          const handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== job.offset) throw fail('TRANSFER_CHANGED', 'The upload file changed outside its current operation.');
            if (payload.operation === 'write') {
              if (payload.offset !== job.offset || !Number.isSafeInteger(payload.offset)) throw fail('TRANSFER_OFFSET', 'The upload chunk does not match the current file offset.');
              if (typeof payload.base64 !== 'string' || payload.base64.length < 1 || payload.base64.length > MAX_CHUNK || !isValidBase64(payload.base64)) throw fail('INVALID_TRANSFER', 'The package chunk has invalid or oversized encoding.');
              const data = Buffer.from(payload.base64, 'base64');
              if (data.toString('base64') !== payload.base64 || job.offset + data.length > job.expected) throw fail('TRANSFER_TOO_LARGE', 'The package chunk exceeds the selected file size.');
              let offset = 0;
              while (offset < data.length) {
                const { bytesWritten } = await handle.write(data, offset, data.length - offset, job.offset + offset);
                if (!bytesWritten) throw fail('TRANSFER_WRITE_FAILED', 'The upload chunk could not be written.');
                offset += bytesWritten;
              }
              job.offset += data.length;
              return receipt(job);
            }
            if (job.offset !== job.expected) throw fail('TRANSFER_INCOMPLETE', 'Upload the complete package before importing it.');
          } finally { await handle.close(); }
          job.record = await store.importArtifact({ sourcePath: file });
          job.status = 'completed';
          await remove(job);
          return job.record;
        } catch (error) {
          if (job.status === 'completed') throw error;
          uploads.delete(job.id); return failed(job, error);
        }
      });
    },
  };
}
