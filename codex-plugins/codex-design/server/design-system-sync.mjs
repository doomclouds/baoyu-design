import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LibraryError, UUID, atomicJson, readJson, readBytes, relativePath, safePath, statOrNull } from '../library/safety.mjs';
import { withLock } from '../scripts/bridge-core.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE, WORKER_LOCK_FILE } from '../scripts/worker-core.mjs';

const INDEX = { slides: 'project/deck.json', design: 'project/canvas.json' };
const NAMESPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_DIR = '_state/design-system-sync';
const MAX_FILES = 2000, MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => new LibraryError(code, message);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const recordsOf = index => Array.isArray(index.designSystems) ? index.designSystems : index.designSystems && typeof index.designSystems === 'object' ? Object.values(index.designSystems) : [];

async function assertIdle(root) {
  const jobs = await readJson(root, WORKER_JOBS_FILE, { version: 1, jobs: {}, order: [] });
  if (jobs.version !== 1 || !jobs.jobs || typeof jobs.jobs !== 'object' || Array.isArray(jobs.jobs) || !Array.isArray(jobs.order)
    || Object.values(jobs.jobs).some(job => !job || !['pending', 'active', 'completed', 'failed', 'superseded'].includes(job.status))) {
    throw fail('DS_SYNC_WORKER_STATE_INVALID', 'The artwork task journal cannot be verified; no design-system files were changed.');
  }
  const worker = await readJson(root, WORKER_FILE, null);
  if (worker && (worker.version !== 1 || !['waiting', 'paused', 'active'].includes(worker.status))) {
    throw fail('DS_SYNC_WORKER_STATE_INVALID', 'The artwork worker state cannot be verified.');
  }
  if (worker?.activeJobId || worker?.status === 'active' || Object.values(jobs.jobs).some(job => ['pending', 'active'].includes(job.status))) {
    throw fail('ARTIFACT_BUSY', 'Finish or coordinate the artwork’s active and pending native jobs before syncing its design system.');
  }
}

async function sourceProject(artifact, root, cwd) {
  if (typeof artifact !== 'string' || !artifact) {
    throw Object.assign(fail('DS_SYNC_SOURCE_UNAVAILABLE', 'This installed design system does not name a local source folder.'), { reason: 'none' });
  }
  if (artifact.length > 32000 || /[\u0000-\u001f\u007f]/.test(artifact)) {
    throw fail('DS_SYNC_SOURCE_UNAVAILABLE', 'This installed design system does not name a local source folder.');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(artifact)) {
    throw Object.assign(fail('DS_SYNC_SOURCE_UNAVAILABLE', 'This installed design system names a remote source rather than a local folder.'), { reason: 'remote' });
  }
  const candidates = path.isAbsolute(artifact) ? [artifact] : [path.resolve(cwd, artifact), path.resolve(root, artifact), path.resolve(root, '..', artifact)];
  if (!path.isAbsolute(artifact)) {
    for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
      candidates.push(path.resolve(parent, artifact));
      if (path.dirname(parent) === parent) break;
    }
  }
  for (const candidate of [...new Set(candidates)]) {
    const project = path.basename(candidate) === 'project' ? candidate : path.join(candidate, 'project');
    const info = await statOrNull(project);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) continue;
    const canonical = await fs.realpath(project);
    const index = await statOrNull(await safePath(canonical, 'design-system.json', { mustExist: false }));
    if (index?.isFile()) return canonical;
  }
  throw Object.assign(fail('DS_SYNC_SOURCE_UNAVAILABLE', 'The source folder recorded by this installed design system was not found.'), { reason: 'not-found' });
}

async function installedFiles(root, namespace) {
  const base = `project/ds/${namespace}`;
  await safePath(root, base, { type: 'directory' });
  const files = [];
  const walk = async relative => {
    const directory = await safePath(root, relative, { type: 'directory' });
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      relativePath(child);
      if (entry.isSymbolicLink()) throw fail('SYMLINK_REFUSED', 'Design-system synchronization does not follow symbolic links.');
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        if (files.length >= MAX_FILES) throw fail('DS_SYNC_LIMIT_EXCEEDED', 'The installed design system exceeds the 2000-file comparison limit.');
        files.push(child.slice(base.length + 1));
      } else throw fail('DS_SYNC_INVALID_FILE', 'The installed design system contains a nonregular file.');
    }
  };
  await walk(base);
  return files.sort();
}

async function inspect(record, namespace, cwd, capture = false) {
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) throw fail('DS_SYNC_INVALID_NAMESPACE', 'Select one installed design-system namespace.');
  const indexFile = INDEX[record.kind];
  const indexBytes = await readBytes(record.path, indexFile, 2 * 1024 * 1024);
  let index;
  try { index = JSON.parse(indexBytes.toString('utf8')); } catch { throw fail('DS_SYNC_INVALID_INDEX', 'The artwork index is not valid JSON.'); }
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw fail('DS_SYNC_INVALID_INDEX', 'The artwork index must be a JSON object.');
  const installed = recordsOf(index).filter(item => item?.namespace === namespace);
  if (installed.length !== 1) throw fail('DS_SYNC_INVALID_NAMESPACE', 'The artwork must contain exactly one record for the selected design-system namespace.');
  const selected = installed[0];
  const project = await sourceProject(selected.artifact, record.path, cwd);
  const sourceIndex = await readBytes(project, 'design-system.json', 2 * 1024 * 1024);
  const changed = [], removed = [], revisions = [], replacements = [];
  let destinationBytes = 0, sourceBytes = 0;
  for (const relative of await installedFiles(record.path, namespace)) {
    const destination = `project/ds/${namespace}/${relative}`;
    const before = await readBytes(record.path, destination, MAX_FILE_BYTES);
    destinationBytes += before.length;
    const sourceFile = await safePath(project, relative, { mustExist: false });
    const info = await statOrNull(sourceFile);
    if (info && !info.isFile()) throw fail('DS_SYNC_INVALID_FILE', 'A source file changed into a nonregular path.');
    const after = info ? await readBytes(project, relative, MAX_FILE_BYTES) : null;
    sourceBytes += after?.length || 0;
    if (destinationBytes > MAX_TOTAL_BYTES || sourceBytes > MAX_TOTAL_BYTES) throw fail('DS_SYNC_LIMIT_EXCEEDED', 'The design-system comparison exceeds the 128 MiB content limit.');
    const oldHash = sha(before), newHash = after === null ? null : sha(after);
    revisions.push([relative, oldHash, newHash]);
    if (after === null) removed.push(relative);
    else if (oldHash !== newHash) {
      changed.push(relative);
      if (capture) replacements.push({ destination, before, after, oldHash, newHash });
    }
  }
  const fingerprint = sha(JSON.stringify({ index: sha(indexBytes), sourceIndex: sha(sourceIndex), project, revisions }));
  return { namespace, source: path.dirname(project), title: typeof selected.title === 'string' ? selected.title : namespace,
    state: changed.length ? 'behind' : 'current', changed, removed, fingerprint, indexFile, indexBytes, index, selected, replacements };
}

async function replaceBytes(root, relative, bytes) {
  const file = await safePath(root, relative, { type: 'file' });
  const temporary = `${file}.${randomUUID()}.ds-sync.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: (await fs.stat(file)).mode & 0o777 });
    await safePath(root, relative, { type: 'file' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Confirm a bounded diff before overwriting an artwork's installed system copy. */
export function createDesignSystemSync({ store, cwd = process.cwd(), now = Date.now, ttlMs = 5 * 60 * 1000 } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.snapshot !== 'function') throw new TypeError('A design library store is required.');
  if (!path.isAbsolute(cwd) || typeof now !== 'function' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('Use an absolute resolution directory and a positive confirmation lifetime.');
  const current = async supplied => {
    await store.initialize();
    if (!supplied || !UUID.test(supplied.id || '') || !INDEX[supplied.kind] || typeof supplied.path !== 'string') throw fail('DS_SYNC_INVALID_ARTIFACT', 'Design-system sync requires an existing Slides or Canvas artwork.');
    const record = await store.get(supplied.id);
    if (record.deleted || record.kind !== supplied.kind || record.contentStatus !== 'ok'
      || !samePath(await fs.realpath(record.path), await fs.realpath(supplied.path))) throw fail('DS_SYNC_INVALID_ARTIFACT', 'The artwork identity or content changed.');
    return { ...record, path: await fs.realpath(record.path) };
  };
  const lock = async (supplied, action) => {
    const record = await current(supplied);
    const lockPath = await safePath(record.path, WORKER_LOCK_FILE, { mustExist: false });
    return withLock(lockPath, async () => {
      const fresh = await current(record);
      await assertIdle(fresh.path);
      return action(fresh);
    }, { timeoutMs: 10000, staleMs: 0 });
  };
  const tokenFile = token => {
    if (typeof token !== 'string' || !UUID.test(token)) throw fail('DS_SYNC_INVALID_TOKEN', 'An explicit design-system confirmation token is required.');
    return `${TOKEN_DIR}/${token.toLowerCase()}.json`;
  };
  return {
    async status(supplied, namespace) {
      const record = await current(supplied);
      try {
        const diff = await inspect(record, namespace, cwd);
        return { state: diff.state, changed: diff.changed.length, removed: diff.removed.length, canSync: true };
      } catch (error) {
        if (error.code === 'DS_SYNC_SOURCE_UNAVAILABLE' && ['none', 'remote', 'not-found'].includes(error.reason)) {
          return { state: 'unknown', changed: 0, removed: 0, reason: error.reason };
        }
        throw error;
      }
    },
    async prepare(supplied, namespace) {
      return lock(supplied, async record => {
        const diff = await inspect(record, namespace, cwd);
        const confirmationToken = randomUUID();
        await atomicJson(store.root, tokenFile(confirmationToken), { version: 1, artifactId: record.id, kind: record.kind, root: record.path,
          namespace, cwd, fingerprint: diff.fingerprint, expiresAt: now() + ttlMs });
        return { confirmationToken, namespace, changed: diff.changed, removed: diff.removed, source: diff.source, title: diff.title, state: diff.state, canSync: true };
      });
    },
    async apply(supplied, confirmationToken) {
      return lock(supplied, async record => {
        const relative = tokenFile(confirmationToken);
        let token;
        try { token = JSON.parse((await readBytes(store.root, relative, 1024 * 1024)).toString('utf8')); }
        catch (cause) { if (cause.code === 'SYMLINK_REFUSED') throw cause; throw fail('DS_SYNC_INVALID_TOKEN', 'The confirmation is missing, invalid or already used. Prepare the changes again.'); }
        if (token?.version !== 1 || token.artifactId !== record.id || token.kind !== record.kind || token.root !== record.path
          || !NAMESPACE.test(token.namespace || '') || typeof token.cwd !== 'string' || !path.isAbsolute(token.cwd)
          || !/^[a-f0-9]{64}$/.test(token.fingerprint || '') || !Number.isFinite(token.expiresAt)) throw fail('DS_SYNC_INVALID_TOKEN', 'The confirmation does not belong to this artwork.');
        await fs.rm(await safePath(store.root, relative, { type: 'file' }));
        if (token.expiresAt <= now()) throw fail('DS_SYNC_CONFIRMATION_EXPIRED', 'The design-system confirmation expired. Review the current changes again.');
        const diff = await inspect(record, token.namespace, token.cwd, true);
        if (diff.fingerprint !== token.fingerprint) throw fail('DS_SYNC_STALE', 'The source, installed copy or artwork index changed after review. Prepare and confirm the new diff.');
        if (!diff.changed.length) return { copied: 0, state: diff.state, changed: 0, removed: diff.removed.length, canSync: true, snapshotId: null };
        const snapshot = await store.snapshot(record.id, { label: `Before design-system sync: ${token.namespace}` });
        const written = [];
        try {
          await assertIdle(record.path);
          if ((await inspect(record, token.namespace, token.cwd)).fingerprint !== token.fingerprint) throw fail('DS_SYNC_STALE', 'The design-system files changed while the recovery point was saved. Review again.');
          for (const replacement of diff.replacements) {
            if (sha(await readBytes(record.path, replacement.destination, MAX_FILE_BYTES)) !== replacement.oldHash) throw fail('DS_SYNC_STALE', 'An installed file changed before it could be replaced. Review again.');
            await replaceBytes(record.path, replacement.destination, replacement.after);
            written.push(replacement);
          }
          if (sha(await readBytes(record.path, diff.indexFile, 2 * 1024 * 1024)) !== sha(diff.indexBytes)) throw fail('DS_SYNC_STALE', 'The artwork index changed before synchronization finished.');
          diff.selected.copiedAt = new Date(now()).toISOString();
          const original = diff.indexBytes.toString('utf8');
          const indent = /^\{\n/.test(original) ? /\n( +|\t)"/.exec(original)?.[1] ?? 2 : undefined;
          await replaceBytes(record.path, diff.indexFile, Buffer.from(JSON.stringify(diff.index, null, indent) + (original.endsWith('\n') ? '\n' : '')));
        } catch (cause) {
          // Undo only bytes this operation still owns; preserve later user edits.
          for (const replacement of written.reverse()) {
            try { if (sha(await readBytes(record.path, replacement.destination, MAX_FILE_BYTES)) === replacement.newHash) await replaceBytes(record.path, replacement.destination, replacement.before); } catch { /* The recovery point remains available. */ }
          }
          throw Object.assign(fail(cause.code || 'DS_SYNC_APPLY_FAILED', `Design-system synchronization did not complete. The pre-sync recovery point is ${snapshot.id}. ${cause.message}`), { snapshotId: snapshot.id });
        }
        return { copied: diff.changed.length, state: 'current', changed: 0, removed: diff.removed.length, canSync: true, snapshotId: snapshot.id };
      });
    },
  };
}
