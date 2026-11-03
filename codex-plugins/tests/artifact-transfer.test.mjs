import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createLibraryStore } from '../source/library/index.mjs';
import { createArtifactTransfers } from '../source/server/artifact-transfer.mjs';
import { createExportStore } from '../source/library/export-store.mjs';
import { createLibraryTransfer, packageFilename, portableBundle, MAX_UI_BUNDLE_BYTES } from '../source/ui/library-transfer.mjs';

async function fixture(t, options) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'codex-artifact-transfer-'));
  t.after(async () => {
    const relative = path.relative(temporaryRoot, temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root: path.join(temporary, 'Library'), ...options });
  await store.initialize();
  return { store, temporary, transfers: createArtifactTransfers({ store }), directory: path.join(store.root, '_state/artifact-transfers') };
}

test('a Motion film with a real 33 MiB media payload exports by receipt and imports through bounded chunks', { timeout: 90_000 }, async t => {
  const { store, transfers, directory, temporary } = await fixture(t);
  const record = await store.create({ kind: 'motion', title: '长片媒体迁移'.repeat(15) });
  const media = Buffer.alloc(33 * 1024 * 1024, 37);
  const id = createHash('sha256').update(media).digest('hex').slice(0, 32);
  await fs.mkdir(path.join(record.path, '_blobs'), { recursive: true });
  await fs.writeFile(path.join(record.path, '_blobs', id), media);
  await fs.writeFile(path.join(record.path, '_blobs', id + '.json'), JSON.stringify({ name: 'long.mp4', contentType: 'video/mp4', bytes: media.length }));
  await fs.mkdir(path.join(record.path, 'db/assets'), { recursive: true });
  await fs.writeFile(path.join(record.path, 'db/assets/long.mp4.json'), JSON.stringify({ ref: '/_blob/' + id, mime: 'video/mp4' }));
  await fs.mkdir(path.join(record.path, 'src'), { recursive: true });
  await fs.writeFile(path.join(record.path, 'src/scene-source.js'), 'const workingSource = "Keep this editable source";');
  await fs.writeFile(path.join(record.path, 'comments.json'), '{"private":"DO_NOT_TRANSFER_THIS_COMMENT"}');
  const calls = [];
  const invoke = async (action, payload) => {
    calls.push({ action, operation: payload.operation, encoded: payload.base64?.length ?? 0 });
    assert.equal(payload.bundle, undefined, 'The large package is never carried by a single MCP argument.');
    assert.equal(payload.sourcePath, undefined, 'The UI never selects a host filesystem path.');
    if (action === 'library.transfer') return transfers.operate(payload);
    assert.equal(action, 'library.exportArtifact'); assert.equal(payload.asFile, true);
    return transfers.export(await store.get(payload.id));
  };
  let receipt;
  const destination = path.join(temporary, 'Selected folder');
  await fs.mkdir(destination);
  const saves = createExportStore({ store, resolveSource: (token, artifactId) => transfers.resolve(token, artifactId) });
  const ui = createLibraryTransfer({ invoke, downloadResource: async resource => {
    receipt = resource;
    return saves.save({ ...resource, requestId: randomUUID(), directory: destination });
  } });
  const exported = await ui.exportArtifact(record.id, record.title, { kind: 'motion' });
  assert.ok(exported.bytes > MAX_UI_BUNDLE_BYTES);
  assert.equal(exported.path, path.join(destination, receipt.filename));
  assert.equal(Buffer.byteLength(receipt.filename) <= 220, true);
  assert.equal(receipt.mimeType, 'application/json'); assert.equal(receipt.artifactId, record.id);
  assert.equal(receipt.path, undefined);
  const source = await transfers.resolve(receipt.exportToken, record.id);
  const bytes = await fs.readFile(source.path);
  assert.deepEqual(await fs.readFile(exported.path), bytes, 'The actual native Save As store copies every JSON/media byte.');
  assert.equal(bytes.length, receipt.bytes);
  assert.equal(source.contentHash, createHash('sha256').update('application/json\0').update(bytes).digest('hex'));
  assert.doesNotMatch(bytes.toString(), /DO_NOT_TRANSFER_THIS_COMMENT/);
  const file = new File([bytes], receipt.filename, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => assert.fail('A large package must use File.slice rather than file.text().') });
  const imported = await ui.importArtifact(file);
  assert.notEqual(imported.id, record.id);
  assert.equal(imported.kind, 'motion');
  assert.deepEqual(await fs.readFile(path.join(imported.path, '_blobs', id)), media);
  assert.match(await fs.readFile(path.join(imported.path, 'src/scene-source.js'), 'utf8'), /Keep this editable source/);
  await assert.rejects(fs.access(path.join(imported.path, 'comments.json')), { code: 'ENOENT' });
  const writes = calls.filter(call => call.operation === 'write');
  assert.ok(writes.length > 20);
  assert.ok(writes.every(call => call.encoded <= 1024 * 1024));
  assert.equal((await fs.readdir(directory)).length, 1, 'Only the retained export receipt remains; import staging was removed.');
});

test('package receipts are bound to their artwork and refuse a modified source file', async t => {
  const { store, transfers } = await fixture(t);
  const first = await store.create({ kind: 'motion', title: 'Original' });
  const other = await store.create({ kind: 'motion', title: 'Other' });
  const exported = await transfers.export(first);
  await assert.rejects(transfers.resolve(exported.exportToken, other.id), { code: 'TRANSFER_NOT_FOUND' });
  const source = await transfers.resolve(exported.exportToken, first.id);
  await fs.appendFile(source.path, ' ');
  await assert.rejects(transfers.resolve(exported.exportToken, first.id), { code: 'TRANSFER_CHANGED' });
});

test('upload offsets, exact size and encoded chunk limits fail closed and remove staging', async t => {
  const { transfers, directory } = await fixture(t);
  for (const payload of [
    { offset: 1, base64: 'eA==' },
    { offset: 0, base64: '!!!!' },
    { offset: 0, base64: 'AAAA'.repeat(262145) },
    { offset: 0, base64: Buffer.alloc(20).toString('base64') },
  ]) {
    const started = await transfers.operate({ operation: 'start', bytes: 10 });
    await assert.rejects(transfers.operate({ operation: 'write', transferId: started.transferId, ...payload }));
    assert.deepEqual(await fs.readdir(directory), []);
    await assert.rejects(transfers.operate({ operation: 'finish', transferId: started.transferId }), { code: 'TRANSFER_NOT_FOUND' });
  }
  const started = await transfers.operate({ operation: 'start', bytes: 100 });
  await assert.rejects(transfers.operate({ operation: 'finish', transferId: started.transferId }), { code: 'TRANSFER_INCOMPLETE' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('already-removed staging can be cancelled while a symlink substitution remains refused', async t => {
  const { transfers, directory, temporary } = await fixture(t);
  const first = await transfers.operate({ operation: 'start', bytes: 10 });
  await fs.rm(path.join(directory, first.transferId), { recursive: true });
  assert.deepEqual(await transfers.operate({ operation: 'cancel', transferId: first.transferId }), { cancelled: true });
  const next = await transfers.operate({ operation: 'start', bytes: 10 });
  const staging = path.join(directory, next.transferId), backup = staging + '-original';
  const outside = path.join(temporary, 'Outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'Do not remove this folder.');
  await fs.rename(staging, backup);
  await fs.symlink(outside, staging, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(transfers.operate({ operation: 'cancel', transferId: next.transferId }), { code: 'SYMLINK_REFUSED' });
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'Do not remove this folder.');
});

test('a zero-byte file write fails explicitly and cleans the package operation', async t => {
  const { transfers, directory } = await fixture(t);
  const started = await transfers.operate({ operation: 'start', bytes: 1 });
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await original(...args);
    return { stat: handle.stat.bind(handle), close: handle.close.bind(handle), write: async () => ({ bytesWritten: 0 }) };
  });
  await assert.rejects(transfers.operate({ operation: 'write', transferId: started.transferId, offset: 0, base64: 'eA==' }), { code: 'TRANSFER_WRITE_FAILED' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('invalid packages and user-provided paths cannot escape validation or create an imported record', async t => {
  const { store, transfers, directory } = await fixture(t);
  const record = await store.create({ kind: 'motion', title: 'Existing' });
  const count = (await store.list()).length;
  const bundle = await store.exportArtifact(record.id);
  bundle.files.push({ path: '../escape.txt', encoding: 'base64', data: 'eA==' });
  const body = Buffer.from(JSON.stringify(bundle));
  const started = await transfers.operate({ operation: 'start', bytes: body.length });
  await transfers.operate({ operation: 'write', transferId: started.transferId, offset: 0, base64: body.toString('base64') });
  await assert.rejects(transfers.operate({ operation: 'finish', transferId: started.transferId }));
  assert.equal((await store.list()).length, count);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(transfers.operate({ operation: 'start', bytes: 1, sourcePath: '/private/secret' }), { code: 'INVALID_TRANSFER' });
});

test('successful finish is idempotent while cancelled and foreign transfers cannot be resumed', async t => {
  const { store, transfers, directory } = await fixture(t);
  const original = await store.create({ kind: 'motion', title: 'Upload once' });
  const bytes = Buffer.from(JSON.stringify(await store.exportArtifact(original.id)));
  const started = await transfers.operate({ operation: 'start', bytes: bytes.length });
  await transfers.operate({ operation: 'write', transferId: started.transferId, offset: 0, base64: bytes.toString('base64') });
  const imported = await transfers.operate({ operation: 'finish', transferId: started.transferId });
  assert.equal((await transfers.operate({ operation: 'finish', transferId: started.transferId })).id, imported.id);
  assert.equal((await store.list()).length, 2);
  const cancelled = await transfers.operate({ operation: 'start', bytes: 10 });
  assert.deepEqual(await transfers.operate({ operation: 'cancel', transferId: cancelled.transferId }), { cancelled: true });
  await assert.rejects(transfers.operate({ operation: 'write', transferId: cancelled.transferId, offset: 0, base64: 'eA==' }), { code: 'TRANSFER_NOT_FOUND' });
  const anotherSession = createArtifactTransfers({ store });
  await assert.rejects(anotherSession.operate({ operation: 'finish', transferId: started.transferId }), { code: 'TRANSFER_NOT_FOUND' });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('an import acknowledgement lost after commit keeps the completed receipt through UI cleanup', async t => {
  const { store, transfers } = await fixture(t);
  const original = await store.create({ kind: 'motion', title: 'Do not import twice' });
  const bytes = Buffer.from(JSON.stringify(await store.exportArtifact(original.id)));
  let transferId, committed;
  const ui = createLibraryTransfer({ maxBundleBytes: 1, maxImportBytes: 1024 * 1024, invoke: async (_action, payload) => {
    const result = await transfers.operate(payload);
    if (payload.operation === 'start') transferId = result.transferId;
    if (payload.operation === 'finish') { committed = result; throw Object.assign(new Error('The response was lost after import.'), { code: 'ACK_LOST' }); }
    return result;
  } });
  await assert.rejects(ui.importArtifact(new File([bytes], 'film.codexdesign.json')), { code: 'ACK_LOST' });
  assert.equal((await transfers.operate({ operation: 'finish', transferId })).id, committed.id);
  assert.equal((await store.list()).length, 2, 'A retry confirms the existing import instead of creating another record.');
});

test('custom package limits apply before staging and long Unicode filenames retain a bounded valid suffix', async t => {
  const { transfers } = await fixture(t, { limits: { maxBundleBytes: 1024 } });
  await assert.rejects(transfers.operate({ operation: 'start', bytes: 1025 }), { code: 'TRANSFER_TOO_LARGE' });
  assert.equal(packageFilename('a'.repeat(150)), 'a'.repeat(100) + '.codexdesign.json');
  for (const title of ['长片标题'.repeat(40), '🎥'.repeat(100)]) {
    const filename = packageFilename(title);
    assert.ok(Buffer.byteLength(filename) <= 220);
    assert.ok(filename.endsWith('.codexdesign.json'));
    assert.doesNotMatch(filename, /\uFFFD/);
  }
  const source = { format: 'codex-design-artifact', version: 1, kind: 'motion', title: 'Source', files: [
    { path: 'db/film/meta.json', encoding: 'base64', data: 'e30=' },
    { path: 'src/scene.ts', encoding: 'base64', data: 'eA==' },
    { path: 'src/private.env', encoding: 'base64', data: 'eA==' },
  ] };
  assert.deepEqual(portableBundle(source).files.map(file => file.path), ['db/film/meta.json', 'src/scene.ts']);
});
