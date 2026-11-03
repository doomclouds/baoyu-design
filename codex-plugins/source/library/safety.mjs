import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from '../scripts/bridge-core.mjs';

export class LibraryError extends Error {
  constructor(code, message, details) { super(message); this.name = 'LibraryError'; this.code = code; if (details !== undefined) this.details = details; }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const KINDS = Object.freeze(['slides', 'design', 'design-system', 'dashboard', 'motion']);
export function artifactId(id) { if (typeof id !== 'string' || !UUID.test(id)) throw new LibraryError('INVALID_ID', 'Expected a persistent artifact UUID.'); return id.toLowerCase(); }
export function artifactKind(kind) { if (!KINDS.includes(kind)) throw new LibraryError('INVALID_KIND', 'Unknown artifact kind.'); return kind; }
export function titleText(title) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(title)) throw new LibraryError('INVALID_TITLE', 'A title must be one nonempty line of at most 200 characters.');
  return title.trim();
}
export function relativePath(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || relative.includes('\\') || path.isAbsolute(relative) || /[\u0000-\u001f\u007f:%]/.test(relative)) throw new LibraryError('INVALID_PATH', 'Expected a package-relative path.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.trimEnd() !== part || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new LibraryError('INVALID_PATH', 'Unsafe path segment.');
  return parts.join('/');
}
export function within(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new LibraryError('INVALID_PATH', 'The path leaves its authorized root.');
  return target;
}
export async function statOrNull(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

export async function safePath(root, relative, { mustExist = true, type } = {}) {
  relativePath(relative);
  const rootStat = await statOrNull(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'The authorized root must be a real directory.');
  const realRoot = await fs.realpath(root);
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = within(root, path.join(cursor, parts[i]));
    const info = await statOrNull(cursor);
    if (!info) { if (mustExist) throw new LibraryError('NOT_FOUND', 'The requested path is missing.', { path: relative }); return cursorFor(root, parts); }
    if (info.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'Symbolic links are not accepted in library paths.', { path: relative });
    if (i < parts.length - 1 && !info.isDirectory()) throw new LibraryError('INVALID_PATH', 'A parent path is not a directory.');
    within(realRoot, await fs.realpath(cursor));
    if (i === parts.length - 1 && type === 'file' && !info.isFile()) throw new LibraryError('INVALID_PATH', 'The requested path is not a regular file.');
    if (i === parts.length - 1 && type === 'directory' && !info.isDirectory()) throw new LibraryError('INVALID_PATH', 'The requested path is not a directory.');
  }
  return cursor;
}
const cursorFor = (root, parts) => within(root, path.join(root, ...parts));

export async function readJson(root, relative, fallback) {
  const file = await safePath(root, relative, { mustExist: false });
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { if (fallback !== undefined) return structuredClone(fallback); throw new LibraryError('NOT_FOUND', 'The requested JSON file is missing.', { path: relative }); } if (error instanceof LibraryError) throw error; throw new LibraryError('INVALID_STATE', 'A library JSON file is malformed.', { path: relative }); }
}
export async function atomicJson(root, relative, value) {
  const file = await safePath(root, relative, { mustExist: false });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await safePath(root, relative, { mustExist: false });
  const temporary = `${file}.${randomUUID()}.tmp`;
  within(root, temporary);
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) { if (!['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || attempt >= 12) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function readBytes(root, relative, maximum) {
  const file = await safePath(root, relative, { type: 'file' });
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const info = await handle.stat(); if (!info.isFile() || info.size > maximum) throw new LibraryError('LIMIT_EXCEEDED', 'The file exceeds the allowed size.'); return await handle.readFile(); }
  finally { await handle.close(); }
}

export async function locked(root, action, timeoutMs = 10_000) {
  // Validate the stable parent rather than an ephemeral lock that another
  // instance may remove between lstat and realpath. Reuse the existing atomic
  // lock publication/reaper implementation used by native comment delivery.
  const state = await safePath(root, '_state', { type: 'directory' });
  const lock = within(root, path.join(state, 'library.lock'));
  if ((await statOrNull(lock))?.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'The library lock must be a real directory.');
  try { return await withLock(lock, action, { timeoutMs, staleMs: 10_000 }); }
  catch (cause) {
    if (cause.code === 'BRIDGE_BUSY') throw new LibraryError('LIBRARY_BUSY', 'Another library operation is still in progress.');
    throw cause;
  }
}
