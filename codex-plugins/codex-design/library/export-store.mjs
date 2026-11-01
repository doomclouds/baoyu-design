import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LibraryError, UUID, atomicJson, locked, readJson } from './safety.mjs';

const MAX_BYTES = 128 * 1024 * 1024;
const PAGE_SIZE = 200;
const MAX_ENTRIES = 20_000;
const TOKEN_MS = 30 * 60 * 1000;
const preferenceFile = '_state/export-location.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => new LibraryError(code, message);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fingerprint = stat => ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].map(key => String(stat[key])).join(':');

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !value || value.length > 32_000 || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value)) {
    throw fail('EXPORT_INVALID_DIRECTORY', 'Choose an existing absolute folder path.');
  }
  return path.resolve(value);
}

function exportInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) {
    throw fail('EXPORT_INVALID_REQUEST', 'A unique export request ID is required.');
  }
  const filename = input.filename;
  if (typeof filename !== 'string' || !filename || filename.length > 240 || process.platform !== 'win32' && Buffer.byteLength(filename) > 240
    || filename === '.' || filename === '..' || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(filename)
    || filename.trim() !== filename || /[. ]$/.test(filename)
    || /^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(filename)) {
    throw fail('EXPORT_INVALID_FILENAME', 'Use a safe filename without path separators or reserved characters.');
  }
  if (typeof input.mimeType !== 'string' || input.mimeType.length > 200
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[a-z0-9= -]+)?$/i.test(input.mimeType)) {
    throw fail('EXPORT_INVALID_CONTENT', 'The export file type is invalid.');
  }
  const hasText = Object.hasOwn(input, 'text'), hasBase64 = Object.hasOwn(input, 'base64');
  if (hasText === hasBase64) throw fail('EXPORT_INVALID_CONTENT', 'Provide exactly one text or base64 export payload.');
  let bytes;
  if (hasText) {
    if (typeof input.text !== 'string' || input.text.length > MAX_BYTES || Buffer.byteLength(input.text) > MAX_BYTES) {
      throw fail('EXPORT_LIMIT_EXCEEDED', 'The export exceeds the 128 MiB save limit.');
    }
    bytes = Buffer.from(input.text, 'utf8');
  } else {
    if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(MAX_BYTES / 3) * 4 || input.base64.length % 4
      || /[^A-Za-z0-9+/=]/.test(input.base64)) {
      throw fail('EXPORT_INVALID_CONTENT', 'The export payload is not bounded, valid base64.');
    }
    const padding = input.base64.endsWith('==') ? 2 : input.base64.endsWith('=') ? 1 : 0;
    const firstPadding = input.base64.indexOf('=');
    if (firstPadding !== -1 && firstPadding !== input.base64.length - padding) throw fail('EXPORT_INVALID_CONTENT', 'The export padding is invalid.');
    bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length > MAX_BYTES || bytes.toString('base64') !== input.base64) throw fail('EXPORT_INVALID_CONTENT', 'The export payload is not canonical base64.');
  }
  if (input.overwriteToken !== undefined && (typeof input.overwriteToken !== 'string' || !UUID.test(input.overwriteToken))) {
    throw fail('EXPORT_INVALID_CONFIRMATION', 'An explicit overwrite confirmation token is required.');
  }
  return { requestId: input.requestId.toLowerCase(), filename, mimeType: input.mimeType, bytes,
    directory: absoluteDirectory(input.directory), overwriteToken: input.overwriteToken };
}

/** App-only Save As operations; no path is written until the user submits Save. */
export function createExportStore({ store, homeDirectory = os.homedir(), fsImpl = fs, now = Date.now, beforeCommit } = {}) {
  if (!store || typeof store.initialize !== 'function' || typeof store._checkRoot !== 'function') throw new TypeError('A LibraryStore is required.');
  const io = fsImpl;
  const ready = async () => { await store.initialize(); await store._checkRoot(); };
  const statOrNull = async file => {
    try { return await io.lstat(file, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const directoryInfo = async input => {
    const requested = absoluteDirectory(input), canonical = await io.realpath(requested);
    const stat = await io.lstat(canonical, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('EXPORT_INVALID_DIRECTORY', 'The selected location is not a real folder.');
    return { requested, canonical, identity: `${stat.dev}:${stat.ino}`, stat };
  };
  const assertDirectory = async info => {
    const current = await directoryInfo(info.requested);
    if (!samePath(current.canonical, info.canonical) || current.identity !== info.identity) {
      throw fail('EXPORT_DIRECTORY_CHANGED', 'The selected folder moved or changed. Choose it again before saving.');
    }
  };
  const targetInfo = async target => {
    const stat = await statOrNull(target);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('EXPORT_UNSAFE_TARGET', 'The destination must be a regular file, not a link or folder.');
    return { fingerprint: fingerprint(stat), size: Number(stat.size), modifiedAt: new Date(Number(stat.mtimeMs)).toISOString() };
  };
  const matchesPayload = async (target, request, contentHash) => {
    const info = await targetInfo(target);
    if (!info || info.size !== request.bytes.length) return false;
    const handle = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || fingerprint(opened) !== info.fingerprint) return false;
      const hash = createHash('sha256').update(request.mimeType + '\0');
      const buffer = Buffer.alloc(64 * 1024);
      for (let position = 0; position < info.size;) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
        if (!bytesRead) return false;
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      return hash.digest('hex') === contentHash && fingerprint(await handle.stat({ bigint: true })) === info.fingerprint;
    } finally { await handle.close(); }
  };
  const receiptPath = id => `_state/export-receipts/${id}.json`;
  const collision = async (request, target, contentHash, existing) => {
    const receipt = { version: 1, requestId: request.requestId, status: 'confirmation', target, contentHash,
      existingFingerprint: existing.fingerprint, overwriteToken: randomUUID(), expiresAt: now() + TOKEN_MS };
    await atomicJson(store.root, receiptPath(request.requestId), receipt);
    return { saved: false, exists: true, path: target, overwriteToken: receipt.overwriteToken,
      existing: { size: existing.size, modifiedAt: existing.modifiedAt } };
  };
  const api = {
    async locations() {
      await ready();
      const candidates = [['home', 'Home', homeDirectory], ['desktop', 'Desktop', path.join(homeDirectory, 'Desktop')],
        ['documents', 'Documents', path.join(homeDirectory, 'Documents')], ['downloads', 'Downloads', path.join(homeDirectory, 'Downloads')]];
      const locations = [];
      for (const [id, label, candidate] of candidates) {
        try {
          const folder = await directoryInfo(candidate);
          if (!locations.some(item => samePath(item.path, folder.canonical))) locations.push({ id, label, path: folder.canonical });
        } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EXPORT_INVALID_DIRECTORY'].includes(error.code)) throw error; }
      }
      let defaultDirectory = locations.find(item => item.id === 'downloads')?.path ?? locations[0]?.path ?? null;
      let preference;
      try { preference = await readJson(store.root, preferenceFile, null); }
      catch (error) { if (error.code !== 'INVALID_STATE') throw error; }
      if (preference?.version === 1 && typeof preference.directory === 'string') {
        try { defaultDirectory = (await directoryInfo(preference.directory)).canonical; } catch {}
      }
      return { locations, defaultDirectory };
    },
    async listDirectory({ path: selected, cursor } = {}) {
      await ready();
      const folder = await directoryInfo(selected), key = sha(folder.canonical), revision = `${folder.stat.ino}:${folder.stat.mtimeNs}`;
      let offset = 0;
      if (cursor !== undefined) {
        let value;
        try {
          if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('cursor');
          value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        } catch { throw fail('EXPORT_INVALID_CURSOR', 'The folder page cursor is invalid.'); }
        if (value.key !== key || value.revision !== revision || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAX_ENTRIES) {
          throw fail('EXPORT_DIRECTORY_CHANGED', 'The folder changed. Refresh it before continuing.');
        }
        offset = value.offset;
      }
      const entries = [];
      let count = 0;
      const directory = await io.opendir(folder.canonical);
      for await (const entry of directory) {
        if (++count > MAX_ENTRIES) throw fail('EXPORT_DIRECTORY_TOO_LARGE', 'This folder contains too many items. Enter a more specific folder path.');
        if (entry.isDirectory() && !entry.isSymbolicLink()) entries.push({ name: entry.name, path: path.join(folder.canonical, entry.name) });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      await assertDirectory(folder);
      if ((await directoryInfo(folder.requested)).stat.mtimeNs !== folder.stat.mtimeNs) throw fail('EXPORT_DIRECTORY_CHANGED', 'The folder changed. Refresh it before continuing.');
      const parentPath = path.dirname(folder.canonical);
      return { path: folder.canonical, parent: parentPath === folder.canonical ? null : parentPath,
        entries: entries.slice(offset, offset + PAGE_SIZE),
        ...(offset + PAGE_SIZE < entries.length ? { nextCursor: Buffer.from(JSON.stringify({ key, revision, offset: offset + PAGE_SIZE })).toString('base64url') } : {}) };
    },
    async save(input) {
      const request = exportInput(input);
      await ready();
      return locked(store.root, async () => {
        const folder = await directoryInfo(request.directory), target = path.join(folder.canonical, request.filename);
        const contentHash = createHash('sha256').update(request.mimeType + '\0').update(request.bytes).digest('hex');
        const previous = await readJson(store.root, receiptPath(request.requestId), null);
        if (previous && (previous.version !== 1 || previous.requestId !== request.requestId || !['confirmation', 'committing', 'saved'].includes(previous.status)
          || typeof previous.target !== 'string' || !path.isAbsolute(previous.target) || !/^[a-f0-9]{64}$/.test(previous.contentHash ?? '')
          || previous.status === 'confirmation' && (!UUID.test(previous.overwriteToken ?? '') || !Number.isSafeInteger(previous.expiresAt)
            || typeof previous.existingFingerprint !== 'string' || previous.existingFingerprint.length > 1000))) {
          throw fail('EXPORT_INVALID_STATE', 'The previous export receipt cannot be verified.');
        }
        if (previous && (!samePath(previous.target, target) || previous.contentHash !== contentHash)) {
          throw fail('EXPORT_REQUEST_CONFLICT', 'This export ID already belongs to different content or a different destination.');
        }
        if (previous?.status === 'saved') {
          if (previous.result?.saved !== true || previous.result.path !== target || previous.result.filename !== request.filename || previous.result.bytes !== request.bytes.length) {
            throw fail('EXPORT_INVALID_STATE', 'The saved export receipt cannot be verified.');
          }
          if (!await matchesPayload(target, request, contentHash)) throw fail('EXPORT_RESULT_CHANGED', 'This export was saved earlier, but the destination has since changed. Start a new export before choosing whether to replace it.');
          return { ...previous.result, duplicate: true };
        }
        if (previous?.status === 'committing' && await matchesPayload(target, request, contentHash)) {
          const result = { saved: true, path: target, filename: request.filename, bytes: request.bytes.length };
          await atomicJson(store.root, receiptPath(request.requestId), { ...previous, status: 'saved', result, savedAt: new Date(now()).toISOString() });
          await atomicJson(store.root, preferenceFile, { version: 1, directory: folder.canonical }).catch(() => {});
          return { ...result, duplicate: true };
        }
        let existing = await targetInfo(target);
        if (existing) {
          if (!request.overwriteToken || previous?.status !== 'confirmation' || previous.overwriteToken !== request.overwriteToken
            || previous.expiresAt < now() || previous.existingFingerprint !== existing.fingerprint) {
            return collision(request, target, contentHash, existing);
          }
        }
        const temporary = path.join(folder.canonical, `.codex-export-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
          await handle.writeFile(request.bytes); await handle.sync(); await handle.close(); handle = null;
          if (beforeCommit) await beforeCommit({ path: target, temporary, replacing: Boolean(existing) });
          await assertDirectory(folder);
          const latest = await targetInfo(target);
          if (existing && (!latest || latest.fingerprint !== existing.fingerprint)) {
            if (latest) return collision(request, target, contentHash, latest);
            throw fail('EXPORT_TARGET_CHANGED', 'The file changed before replacement. Choose the destination again.');
          }
          if (!existing && latest) return collision(request, target, contentHash, latest);
          // The durable intent lets a later process recover the narrow window
          // where publication succeeded but the final receipt/ACK was lost.
          await atomicJson(store.root, receiptPath(request.requestId), { version: 1, requestId: request.requestId, status: 'committing', target, contentHash });
          if (existing) await io.rename(temporary, target);
          else {
            // Exclusive publication never overwrites a file created by another
            // application after the collision check.
            try { await io.link(temporary, target); }
            catch (error) {
              if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(error.code)) await io.copyFile(temporary, target, constants.COPYFILE_EXCL);
              else if (error.code === 'EEXIST') {
                const appeared = await targetInfo(target);
                if (appeared) return collision(request, target, contentHash, appeared);
                throw error;
              } else throw error;
            }
          }
          const result = { saved: true, path: target, filename: request.filename, bytes: request.bytes.length };
          await atomicJson(store.root, receiptPath(request.requestId), { version: 1, requestId: request.requestId, status: 'saved', target, contentHash, result, savedAt: new Date(now()).toISOString() });
          // A preference-write failure must not make a completed export look
          // failed or encourage overwriting its already-saved file again.
          await atomicJson(store.root, preferenceFile, { version: 1, directory: folder.canonical }).catch(() => {});
          return result;
        } finally {
          await handle?.close().catch(() => {});
          // Clean only this operation's unique staging file, and only while
          // its containing folder still has the verified identity.
          try { await assertDirectory(folder); await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); } catch {}
        }
      });
    },
  };
  return api;
}
