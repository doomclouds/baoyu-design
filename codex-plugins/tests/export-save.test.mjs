import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLibraryStore } from '../source/library/index.mjs';
import { createExportStore } from '../source/library/export-store.mjs';
import { createDesignService } from '../source/server/service.mjs';
import { ACTIONS, READ_ACTIONS } from '../source/server/contract.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-export-save-'));
  const home = path.join(temporary, 'Home 目录'), destination = path.join(home, 'Chosen exports');
  await fs.mkdir(destination, { recursive: true });
  for (const name of ['Documents', 'Downloads', 'Desktop']) await fs.mkdir(path.join(home, name));
  t.after(async () => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root: path.join(temporary, 'Library') });
  const exports = createExportStore({ store, homeDirectory: home });
  const payload = overrides => ({ requestId: randomUUID(), directory: destination, filename: '设计 export.json', mimeType: 'application/json', text: '{"title":"作品"}', ...overrides });
  return { temporary, home, destination, store, exports, payload };
}

test('Save As browsing lists only folders and never creates an export or saves a preference', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.home, 'not-a-folder.txt'), 'keep');
  const locations = await f.exports.locations();
  assert.equal(locations.defaultDirectory, await fs.realpath(path.join(f.home, 'Downloads')));
  assert.deepEqual(locations.locations.map(item => item.id), ['home', 'desktop', 'documents', 'downloads']);
  const listing = await f.exports.listDirectory({ path: f.home });
  assert.equal(listing.path, await fs.realpath(f.home));
  assert.deepEqual(listing.entries.map(item => item.name), ['Chosen exports', 'Desktop', 'Documents', 'Downloads']);
  assert.deepEqual(await fs.readdir(f.destination), []);
  await assert.rejects(fs.access(path.join(f.store.root, '_state/export-location.json')), { code: 'ENOENT' });
});

test('an explicit Unicode/spaced destination saves exact bytes, returns the real path and remembers the folder', async t => {
  const f = await fixture(t), payload = f.payload();
  const result = await f.exports.save(payload);
  assert.deepEqual(result, { saved: true, path: path.join(await fs.realpath(f.destination), payload.filename), filename: payload.filename, bytes: Buffer.byteLength(payload.text) });
  assert.equal(await fs.readFile(result.path, 'utf8'), payload.text);
  const fresh = createExportStore({ store: createLibraryStore({ root: f.store.root }), homeDirectory: f.home });
  assert.equal((await fresh.locations()).defaultDirectory, await fs.realpath(f.destination));
  assert.deepEqual(await fs.readdir(f.destination), [payload.filename]);
});

test('existing files require a content/destination-bound explicit overwrite token', async t => {
  const f = await fixture(t), payload = f.payload();
  const target = path.join(f.destination, payload.filename);
  await fs.writeFile(target, 'Original user file.');
  const conflict = await f.exports.save(payload);
  assert.equal(conflict.saved, false); assert.equal(conflict.exists, true); assert.ok(conflict.overwriteToken);
  assert.equal(await fs.readFile(target, 'utf8'), 'Original user file.');
  await assert.rejects(f.exports.save({ ...payload, text: 'Different content', overwriteToken: conflict.overwriteToken }), { code: 'EXPORT_REQUEST_CONFLICT' });
  const wrong = await f.exports.save({ ...payload, overwriteToken: randomUUID() });
  assert.notEqual(wrong.overwriteToken, conflict.overwriteToken);
  const result = await f.exports.save({ ...payload, overwriteToken: wrong.overwriteToken });
  assert.equal(result.saved, true); assert.equal(await fs.readFile(target, 'utf8'), payload.text);
  assert.deepEqual(await fs.readdir(f.destination), [payload.filename]);
});

test('a target changed after confirmation gets a fresh confirmation instead of being overwritten', async t => {
  const f = await fixture(t), payload = f.payload(), target = path.join(f.destination, payload.filename);
  await fs.writeFile(target, 'Before.');
  const first = await f.exports.save(payload);
  await fs.writeFile(target, 'Changed externally, after the dialog opened.');
  const second = await f.exports.save({ ...payload, overwriteToken: first.overwriteToken });
  assert.equal(second.saved, false); assert.notEqual(second.overwriteToken, first.overwriteToken);
  assert.equal(await fs.readFile(target, 'utf8'), 'Changed externally, after the dialog opened.');
  let changed = false;
  const racing = createExportStore({ store: f.store, homeDirectory: f.home, beforeCommit: async () => {
    if (!changed) { changed = true; await fs.writeFile(target, 'Changed immediately before commit.'); }
  } });
  const third = await racing.save({ ...payload, overwriteToken: second.overwriteToken });
  assert.equal(third.saved, false); assert.notEqual(third.overwriteToken, second.overwriteToken);
  assert.equal(await fs.readFile(target, 'utf8'), 'Changed immediately before commit.');
  assert.deepEqual(await fs.readdir(f.destination), [payload.filename]);
});

test('a malformed persisted confirmation cannot authorize replacement', async t => {
  const f = await fixture(t), payload = f.payload(), target = path.join(f.destination, payload.filename);
  await fs.writeFile(target, 'Original confirmation target.');
  const confirmation = await f.exports.save(payload);
  const receiptPath = path.join(f.store.root, '_state/export-receipts', payload.requestId + '.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); delete receipt.expiresAt;
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(f.exports.save({ ...payload, overwriteToken: confirmation.overwriteToken }), { code: 'EXPORT_INVALID_STATE' });
  assert.equal(await fs.readFile(target, 'utf8'), 'Original confirmation target.');
});

test('new-file publication refuses a file that appears during staging', async t => {
  const f = await fixture(t), payload = f.payload(), target = path.join(f.destination, payload.filename);
  const racing = createExportStore({ store: f.store, beforeCommit: () => fs.writeFile(target, 'Another application created this.') });
  const result = await racing.save(payload);
  assert.equal(result.saved, false); assert.equal(result.exists, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'Another application created this.');
  assert.deepEqual(await fs.readdir(f.destination), [payload.filename]);
});

test('a confirmed destination deleted before Save becomes a new exclusive write rather than an overwrite', async t => {
  const f = await fixture(t), payload = f.payload(), target = path.join(f.destination, payload.filename);
  await fs.writeFile(target, 'File selected for replacement.');
  const conflict = await f.exports.save(payload);
  await fs.unlink(target);
  const result = await f.exports.save({ ...payload, overwriteToken: conflict.overwriteToken });
  assert.equal(result.saved, true); assert.equal(await fs.readFile(target, 'utf8'), payload.text);
});

test('failed atomic replacement leaves the original file untouched and removes only its own staging file', async t => {
  const f = await fixture(t), payload = f.payload(), target = path.join(f.destination, payload.filename);
  await fs.writeFile(target, 'Original survives.');
  const conflict = await f.exports.save(payload);
  const io = { ...fs, rename: async (from, to) => { if (to === target) throw Object.assign(new Error('Destination is in use.'), { code: 'EPERM' }); return fs.rename(from, to); } };
  const failing = createExportStore({ store: f.store, fsImpl: io });
  await assert.rejects(failing.save({ ...payload, overwriteToken: conflict.overwriteToken }), { code: 'EPERM' });
  assert.equal(await fs.readFile(target, 'utf8'), 'Original survives.');
  assert.deepEqual(await fs.readdir(f.destination), [payload.filename]);
});

test('a completed request is idempotent across instances and recovers publication before a lost acknowledgement', async t => {
  const f = await fixture(t), payload = f.payload();
  const io = { ...fs, link: async (from, to) => { await fs.link(from, to); throw Object.assign(new Error('Lost publication acknowledgement.'), { code: 'EIO' }); } };
  const interrupted = createExportStore({ store: f.store, fsImpl: io });
  await assert.rejects(interrupted.save(payload), { code: 'EIO' });
  const target = path.join(f.destination, payload.filename), before = await fs.stat(target);
  const fresh = createExportStore({ store: createLibraryStore({ root: f.store.root }) });
  const recovered = await fresh.save(payload);
  assert.equal(recovered.saved, true); assert.equal(recovered.duplicate, true);
  assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs);
  assert.equal((await fresh.save(payload)).duplicate, true);
  await assert.rejects(fresh.save({ ...payload, filename: 'different.json' }), { code: 'EXPORT_REQUEST_CONFLICT' });
  assert.deepEqual(await fs.readdir(f.destination), [payload.filename]);
  await fs.writeFile(target, 'A later edit by another application.');
  await assert.rejects(fresh.save(payload), { code: 'EXPORT_RESULT_CHANGED' });
  assert.equal(await fs.readFile(target, 'utf8'), 'A later edit by another application.');
});

test('an optional invalid or missing last-used folder cannot prevent choosing another export destination', async t => {
  const f = await fixture(t);
  await f.store.initialize();
  const preference = path.join(f.store.root, '_state/export-location.json');
  await fs.writeFile(preference, '{broken');
  assert.equal((await f.exports.locations()).defaultDirectory, await fs.realpath(path.join(f.home, 'Downloads')));
  await fs.writeFile(preference, JSON.stringify({ version: 1, directory: path.join(f.home, 'Removed folder') }));
  assert.equal((await f.exports.locations()).defaultDirectory, await fs.realpath(path.join(f.home, 'Downloads')));
});

test('independent export instances serialize collisions instead of overwriting each other', async t => {
  const f = await fixture(t), other = createExportStore({ store: createLibraryStore({ root: f.store.root }) });
  const results = await Promise.all([f.exports.save(f.payload({ text: 'First.' })), other.save(f.payload({ text: 'Second.' }))]);
  assert.equal(results.filter(item => item.saved).length, 1);
  assert.equal(results.filter(item => item.exists).length, 1);
  assert.ok(['First.', 'Second.'].includes(await fs.readFile(results.find(item => item.saved).path, 'utf8')));
});

test('unsafe filenames, relative folders and malformed payloads fail without writing a file', async t => {
  const f = await fixture(t);
  for (const filename of ['../outside', 'folder/file', 'folder\\file', 'CON.txt', 'COM¹.txt', 'CONOUT$', 'bad:name', 'trailing.', '..', ' space ']) {
    await assert.rejects(f.exports.save(f.payload({ filename })), { code: 'EXPORT_INVALID_FILENAME' });
  }
  await assert.rejects(f.exports.save(f.payload({ directory: 'relative/folder' })), { code: 'EXPORT_INVALID_DIRECTORY' });
  await assert.rejects(f.exports.save(f.payload({ requestId: 'not-a-uuid' })), { code: 'EXPORT_INVALID_REQUEST' });
  await assert.rejects(f.exports.save(f.payload({ base64: 'AAAA' })), { code: 'EXPORT_INVALID_CONTENT' });
  for (const base64 of ['A===', 'AAAA=AAA', 'AB==', '====', 'A', 'AA=', 'YWJj\n']) {
    const payload = f.payload({ base64 }); delete payload.text;
    await assert.rejects(f.exports.save(payload), { code: 'EXPORT_INVALID_CONTENT' });
  }
  assert.deepEqual(await fs.readdir(f.destination), []);
});

test('a multi-megabyte binary export preserves every byte without a recursive validation regex', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const payload = f.payload({ filename: 'binary.png', mimeType: 'image/png', base64: bytes.toString('base64') }); delete payload.text;
  const result = await f.exports.save(payload);
  assert.equal(result.bytes, bytes.length); assert.deepEqual(await fs.readFile(result.path), bytes);
});

test('folder aliases are canonicalized visibly and linked file targets cannot be replaced', async t => {
  const f = await fixture(t), alias = path.join(f.home, 'Alias');
  try { await fs.symlink(f.destination, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('This account cannot create test-only directory links.'); throw error; }
  assert.equal((await f.exports.listDirectory({ path: alias })).path, await fs.realpath(f.destination));
  const result = await f.exports.save(f.payload({ directory: alias }));
  assert.equal(path.dirname(result.path), await fs.realpath(f.destination));
  const original = path.join(f.home, 'linked-original.txt'), linked = path.join(f.destination, 'linked.txt');
  await fs.writeFile(original, 'Preserve linked data.');
  let linkExports = f.exports;
  try { await fs.symlink(original, linked, 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.diagnostic('Real file-symlink creation was denied; the lstat-based refusal is tested through an injected filesystem instead.');
    const io = { ...fs, lstat: async (file, options) => file === linked ? { isSymbolicLink: () => true, isFile: () => false } : fs.lstat(file, options) };
    linkExports = createExportStore({ store: f.store, fsImpl: io });
  }
  await assert.rejects(linkExports.save(f.payload({ filename: 'linked.txt' })), { code: 'EXPORT_UNSAFE_TARGET' });
  assert.equal(await fs.readFile(original, 'utf8'), 'Preserve linked data.');
});

test('folder pages are bounded and their cursor cannot cross directories or a changed listing', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 205 }, (_, index) => fs.mkdir(path.join(f.destination, 'folder-' + String(index).padStart(3, '0')))));
  const first = await f.exports.listDirectory({ path: f.destination });
  assert.equal(first.entries.length, 200); assert.ok(first.nextCursor);
  const next = await f.exports.listDirectory({ path: f.destination, cursor: first.nextCursor });
  assert.equal(next.entries.length, 5); assert.equal(next.nextCursor, undefined);
  await assert.rejects(f.exports.listDirectory({ path: f.home, cursor: first.nextCursor }), { code: 'EXPORT_DIRECTORY_CHANGED' });
  await fs.mkdir(path.join(f.destination, 'new-folder'));
  await assert.rejects(f.exports.listDirectory({ path: f.destination, cursor: first.nextCursor }), { code: 'EXPORT_DIRECTORY_CHANGED' });
});

test('export operations are app-only and do not open an editor, create artwork or change the selected tab', async t => {
  const f = await fixture(t);
  for (const action of ['export.locations', 'export.listDirectory', 'export.save']) { assert.ok(ACTIONS.includes(action)); assert.equal(READ_ACTIONS.includes(action), false); }
  const service = createDesignService({ store: f.store, editorOpen: () => assert.fail('Save As cannot open an editor.') });
  const before = await f.store.getViewState();
  const result = await service.invoke('export.save', f.payload());
  assert.equal(result.saved, true); assert.deepEqual(await f.store.list(), []); assert.deepEqual(await f.store.getViewState(), before);
});
