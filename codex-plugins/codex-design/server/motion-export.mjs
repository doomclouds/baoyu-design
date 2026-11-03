import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { safePath, UUID } from '../library/safety.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fingerprint = stat => ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].map(key => String(stat[key])).join(':');
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const RETAIN_MS = 30 * 60 * 1000;

function optionsFor(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['height', 'fps', 'quality', 'supersample'].includes(key))) throw fail('INVALID_MOTION_EXPORT', 'Unsupported Motion export options.');
  const options = { ...value };
  if (options.height !== undefined && (!Number.isInteger(options.height) || options.height < 64 || options.height > 4320)) throw fail('INVALID_MOTION_EXPORT', 'Export height must be between 64 and 4320.');
  if (options.fps !== undefined && (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 120)) throw fail('INVALID_MOTION_EXPORT', 'Export frame rate must be between 1 and 120.');
  if (options.quality !== undefined && !['low', 'medium', 'high'].includes(options.quality)) throw fail('INVALID_MOTION_EXPORT', 'Choose low, medium, or high export quality.');
  if (options.supersample !== undefined && typeof options.supersample !== 'boolean') throw fail('INVALID_MOTION_EXPORT', 'Supersampling must be a boolean.');
  return options;
}

/** Own only this process's fixed Motion renderer jobs and opaque export receipts. */
export function createMotionExports({ store, pluginRoot, spawnProcess = spawn, timeoutMs = 60 * 60 * 1000 } = {}) {
  const jobs = new Map();
  let startup = Promise.resolve();
  const serializeStart = action => {
    const previous = startup;
    let release; startup = new Promise(resolve => { release = resolve; });
    return previous.then(action).finally(() => release());
  };
  const view = job => ({ jobId: job.id, status: job.status, ...(job.progress ? { progress: job.progress } : {}),
    ...(job.error ? { error: job.error } : {}), ...(job.resource ? { resource: job.resource } : {}) });
  const owned = (id, artifactId) => {
    const job = jobs.get(id);
    if (!UUID.test(id ?? '') || !job || job.artifactId !== artifactId) throw fail('MOTION_EXPORT_NOT_FOUND', 'This export does not belong to the selected film.');
    return job;
  };
  const terminate = (job, signal = 'SIGTERM') => {
    if (!job.child?.pid || job.closed) return;
    try {
      if (process.platform === 'win32') job.child.kill(signal);
      else process.kill(-job.child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') job.child.kill(signal); }
  };
  const remove = async job => { await fs.rm(job.directory, { recursive: true, force: true }); jobs.delete(job.id); };
  return {
    async operate(record, payload) {
      if (record.kind !== 'motion') throw fail('INVALID_MOTION_EXPORT', 'Only Motion films can use the video renderer.');
      const operation = payload.operation ?? 'start';
      if (operation === 'status') return view(owned(payload.jobId, record.id));
      if (operation === 'cancel') {
        const job = owned(payload.jobId, record.id);
        if (job.status === 'running') {
          job.status = 'cancelled'; terminate(job);
          const force = setTimeout(() => terminate(job, 'SIGKILL'), 1000); force.unref();
        }
        return view(job);
      }
      if (operation !== 'start' || payload.format !== 'mp4') throw fail('INVALID_MOTION_EXPORT', 'Choose an MP4 render or a known export job operation.');
      const options = optionsFor(payload.options);
      return serializeStart(async () => {
      for (const job of jobs.values()) if (job.status !== 'running' && Date.now() - job.finishedAt > RETAIN_MS) await remove(job);
      if ([...jobs.values()].some(job => job.artifactId === record.id && job.status === 'running')) throw fail('MOTION_EXPORT_BUSY', 'This film already has a video export in progress.');
      if ([...jobs.values()].filter(job => job.status === 'running').length >= 2) throw fail('MOTION_EXPORT_BUSY', 'Finish a video export before starting another.');
      const parent = await safePath(store.root, '_state/motion-exports', { mustExist: false });
      await fs.mkdir(parent, { recursive: true });
      await safePath(store.root, '_state/motion-exports', { type: 'directory' });
      const id = randomUUID(), directory = path.join(parent, id);
      await fs.mkdir(directory, { mode: 0o700 });
      const output = path.join(directory, 'film.mp4');
      const script = path.join(pluginRoot, 'skills/codex-motion/scripts/artifact.mjs');
      const args = [script, 'export', record.path, '--out', output, '--quality', options.quality ?? 'high'];
      for (const key of ['height', 'fps']) if (options[key] !== undefined) args.push('--' + key, String(options[key]));
      if (options.supersample) args.push('--supersample');
      const job = { id, artifactId: record.id, directory, output, status: 'running', closed: false, stdout: '', stderr: '' };
      jobs.set(id, job);
      let child;
      try { child = job.child = spawnProcess(process.execPath, args, { cwd: record.path, env: { ...process.env, CODEX_DESIGN_NATIVE_SESSION: '1' }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { await remove(job); throw error; }
      const shutdown = () => terminate(job, 'SIGKILL');
      process.once('exit', shutdown);
      const timer = setTimeout(() => { job.error = { code: 'MOTION_EXPORT_TIMEOUT', message: 'The video renderer exceeded its time limit.' }; terminate(job, 'SIGKILL'); }, timeoutMs); timer.unref();
      child.stdout.on('data', chunk => { job.stdout = (job.stdout + chunk).slice(-65536); });
      child.stderr.on('data', chunk => {
        job.stderr = (job.stderr + chunk).slice(-8000);
        const matches = [...job.stderr.matchAll(/export: ([a-z -]+) (\d+)\/(\d+)/gi)];
        const latest = matches.at(-1);
        if (latest) job.progress = { phase: latest[1].trim(), done: Number(latest[2]), total: Number(latest[3]) };
      });
      child.once('error', error => { job.error = { code: 'MOTION_EXPORT_START_FAILED', message: error.message }; });
      child.once('close', async code => {
        job.closed = true; clearTimeout(timer); process.removeListener('exit', shutdown);
        job.finishedAt = Date.now();
        try {
          if (job.status === 'cancelled') return;
          if (code !== 0 || job.error) {
            let detail; try { detail = JSON.parse(job.stderr.trim().split('\n').at(-1)); } catch {}
            throw fail(job.error?.code || detail?.error || 'MOTION_EXPORT_FAILED', job.error?.message || detail?.message || 'The Motion renderer could not finish the export.');
          }
          const result = JSON.parse(job.stdout.trim());
          if (result.mime !== 'video/mp4' || result.out !== output) throw fail('MOTION_EXPORT_FORMAT', 'The renderer did not produce the requested MP4 format.');
          const file = await safePath(store.root, `_state/motion-exports/${id}/film.mp4`, { type: 'file' });
          const stat = await fs.lstat(file, { bigint: true });
          const size = Number(stat.size);
          if (size < 1 || size > MAX_BYTES || result.bytes !== size) throw fail('MOTION_EXPORT_SIZE', 'The generated movie has an invalid or unsupported size.');
          const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const hash = createHash('sha256').update('video/mp4\0');
            for await (const chunk of handle.createReadStream({ autoClose: false })) {
              if (job.status === 'cancelled') return;
              hash.update(chunk);
            }
            if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(stat)) throw fail('MOTION_EXPORT_CHANGED', 'The generated movie changed before it could be saved.');
            job.source = { path: file, size, mimeType: 'video/mp4', contentHash: hash.digest('hex'), fingerprint: fingerprint(stat) };
          } finally { await handle.close(); }
          if (job.status === 'cancelled') return;
          let stem = record.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/g, '') || 'Motion';
          while (Buffer.byteLength(stem) > 220) stem = Array.from(stem).slice(0, -1).join('');
          if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = 'Motion ' + stem;
          job.resource = { filename: stem + '.mp4', mimeType: 'video/mp4', bytes: size, exportToken: id, artifactId: record.id,
            ...(typeof result.format === 'string' ? { format: result.format } : {}),
            ...(Array.isArray(result.warnings) ? { warnings: result.warnings } : {}) };
          job.status = 'completed';
        } catch (error) { job.status = 'failed'; job.error = { code: error.code || 'MOTION_EXPORT_FAILED', message: String(error.message).slice(0, 2000) }; }
        finally {
          if (job.status !== 'completed') await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
          const expiry = setTimeout(() => { if (jobs.get(id) === job) void remove(job).catch(() => {}); }, RETAIN_MS); expiry.unref();
        }
      });
      return view(job);
      });
    },
    async resolve(token, artifactId) {
      const job = owned(token, artifactId);
      if (job.status !== 'completed' || !job.source || Date.now() - job.finishedAt > RETAIN_MS) throw fail('MOTION_EXPORT_UNAVAILABLE', 'Render the film again before saving it.');
      await safePath(store.root, `_state/motion-exports/${job.id}/film.mp4`, { type: 'file' });
      return { ...job.source };
    },
  };
}
