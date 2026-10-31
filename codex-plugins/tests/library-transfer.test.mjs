import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignService } from '../source/server/service.mjs';
import { createLibraryTransfer, portableBundle, packageFilename, MAX_UI_BUNDLE_BYTES } from '../source/ui/library-transfer.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-transfer-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), root); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(root, { recursive: true, force: true }); });
  const store = createLibraryStore({ root }); await store.initialize();
  const service = createDesignService({ store });
  return { store, invoke: service.invoke.bind(service) };
}

test('UI package roundtrip preserves the four native formats and excludes local discussions and control state', async t => {
  const { store, invoke } = await fixture(t);
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const artifact = await store.create({ kind, title: '作品 ' + kind });
    await fs.writeFile(path.join(artifact.path, 'comments.json'), '{"text":"private discussion"}');
    await fs.writeFile(path.join(artifact.path, '.codex-design-bridge.json'), '{"token":"private token"}');
    await store.bindChat(artifact.id, { threadId: 'existing-native-thread' });
    let selected, downloaded;
    const transfer = createLibraryTransfer({ invoke,
      download: async value => { downloaded = value; },
      pickFile: async () => new File([downloaded.text], downloaded.filename, { type: 'application/json' }),
      onImported: record => { selected = record; },
    });
    const exported = await transfer.exportArtifact(artifact.id);
    assert.ok(exported.filename.endsWith('.codexdesign.json'));
    assert.doesNotMatch(downloaded.text, /private discussion|private token|existing-native-thread/);
    const imported = await transfer.importArtifact();
    assert.equal(imported.kind, kind); assert.equal(imported.title, artifact.title);
    assert.notEqual(imported.id, artifact.id); assert.equal(selected.id, imported.id);
    assert.equal(imported.contentStatus, 'ok'); assert.equal(await store.getBinding(imported.id), null);
    assert.deepEqual((await store.listFiles(imported.id)).map(file => file.path), (await store.listFiles(artifact.id)).map(file => file.path));
  }
});

test('UI restores content with an automatic recovery point while preserving comments and the actual binding', async t => {
  const { store, invoke } = await fixture(t);
  const record = await store.create({ kind: 'slides', title: 'Restore flow' });
  const slide = path.join(record.path, 'project/slides/cover.html');
  await fs.writeFile(slide, '<section id="cover"><h1>Before</h1></section>');
  const transfer = createLibraryTransfer({ invoke, download() {} });
  const saved = await transfer.createSnapshot(record.id, 'Approved design');
  assert.equal(saved.label, 'Approved design');
  await fs.writeFile(slide, '<section id="cover"><h1>Current work</h1></section>');
  await fs.writeFile(path.join(record.path, 'comments.json'), '{"keep":"current comments"}');
  await store.bindChat(record.id, { threadId: 'native-edit-thread' });
  await transfer.restoreSnapshot(record.id, saved.id);
  assert.match(await fs.readFile(slide, 'utf8'), /Before/);
  assert.match(await fs.readFile(path.join(record.path, 'comments.json'), 'utf8'), /current comments/);
  assert.equal((await store.getBinding(record.id)).threadId, 'native-edit-thread');
  const snapshots = await transfer.listSnapshots(record.id);
  const recovery = snapshots.find(item => item.label === 'Before restore');
  assert.ok(recovery);
  await invoke('library.restoreSnapshot', { id: record.id, snapshotId: recovery.id });
  assert.match(await fs.readFile(slide, 'utf8'), /Current work/);
});

test('cancel, malformed data, oversized files and unsafe paths never call the server', async () => {
  let calls = 0, read = false;
  const transfer = createLibraryTransfer({ invoke() { calls++; }, pickFile: async () => null });
  assert.equal(await transfer.importArtifact(), null);
  await assert.rejects(transfer.importArtifact(new File(['{not json'], 'bad.json')), hasCode('INVALID_BUNDLE'));
  await assert.rejects(transfer.importArtifact({ size: MAX_UI_BUNDLE_BYTES + 1, text() { read = true; } }), hasCode('TRANSFER_TOO_LARGE'));
  assert.equal(read, false);
  const bundle = { format: 'codex-design-artifact', version: 1, kind: 'design', title: 'Unsafe', files: [{ path: 'project/../../secret', encoding: 'base64', data: 'eA==' }] };
  await assert.rejects(transfer.importArtifact(new File([JSON.stringify(bundle)], 'unsafe.json')), hasCode('INVALID_BUNDLE'));
  assert.equal(calls, 0);
});

test('portable filtering strips runtime metadata and refuses a restore when the recovery point fails', async () => {
  const input = { format: 'codex-design-artifact', version: 1, kind: 'design', title: 'Artwork', threadId: 'private-thread', token: 'private-token',
    files: [{ path: 'project/Main.dc.html', encoding: 'base64', data: 'eA==' }, { path: 'comments.json', encoding: 'base64', data: 'eA==' }, { path: '_state/bindings.json', encoding: 'base64', data: 'eA==' }] };
  const output = portableBundle(input);
  assert.deepEqual(Object.keys(output), ['format', 'version', 'kind', 'title', 'files']);
  assert.deepEqual(output.files.map(item => item.path), ['project/Main.dc.html']);
  assert.equal(packageFilename('../../CON<>'), '.._.._CON__.codexdesign.json');
  assert.equal(packageFilename('CON'), 'Artwork.codexdesign.json');
  const calls = [];
  const transfer = createLibraryTransfer({ invoke(action) { calls.push(action); throw Object.assign(new Error('Active worker'), { code: 'ARTIFACT_BUSY' }); } });
  await assert.rejects(transfer.restoreSnapshot('id', 'snapshot'), hasCode('ARTIFACT_BUSY'));
  assert.deepEqual(calls, ['library.snapshot']);
});
