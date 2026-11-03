import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignService } from '../source/server/service.mjs';

test('new Theme status and confirmed sync work with an existing service that has no upstream ds-sync route', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sync-existing-service-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLibraryStore({ root: path.join(directory, 'Library') }); await store.initialize();
  const artwork = await store.create({ kind: 'design', title: 'Existing native artwork' });
  const source = path.join(directory, 'source'); await fs.mkdir(path.join(source, 'project'), { recursive: true });
  await fs.writeFile(path.join(source, 'project/design-system.json'), JSON.stringify({ v: 3, title: 'Brand' }));
  await fs.writeFile(path.join(source, 'project/tokens.json'), JSON.stringify({ color: 'new' }));
  const indexFile = path.join(artwork.path, 'project/canvas.json');
  const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  index.designSystems = [{ namespace: 'brand', title: 'Brand', artifact: source }];
  await fs.writeFile(indexFile, JSON.stringify(index));
  await fs.mkdir(path.join(artwork.path, 'project/ds/brand'), { recursive: true });
  await fs.writeFile(path.join(artwork.path, 'project/ds/brand/tokens.json'), JSON.stringify({ color: 'old' }));
  let openings = 0;
  const service = createDesignService({ store, editorOpen: async record => { openings++; return { url: 'http://127.0.0.1:9/design/old-session/', kind: record.kind }; } });
  // Port 9 has no service. These requests must use the new package's status
  // implementation instead of depending on an old process's HTTP routes.
  const response = await service.invoke('editor.request', { id: artwork.id, request: { path: '__ds-sync/brand', method: 'GET' } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(response.body, 'base64')), { state: 'behind', changed: 1, removed: 0, canSync: true });
  const head = await service.invoke('editor.request', { id: artwork.id, request: { path: '__ds-sync/brand', method: 'HEAD' } });
  assert.equal(head.body, ''); assert.equal(openings, 2);
  await assert.rejects(service.invoke('editor.request', { id: artwork.id, request: { path: '__ds-sync/brand', method: 'POST' } }), { code: 'SYSTEM_SYNC_CONFIRMATION_REQUIRED' });
  const preview = await service.invoke('editor.systemSync', { id: artwork.id, operation: 'prepare', namespace: 'brand' });
  assert.deepEqual(preview.changed, ['tokens.json']);
  assert.equal(JSON.parse(await fs.readFile(path.join(artwork.path, 'project/ds/brand/tokens.json'), 'utf8')).color, 'old');
  const synced = await service.invoke('editor.systemSync', { id: artwork.id, operation: 'apply', confirmationToken: preview.confirmationToken });
  assert.equal(synced.copied, 1); assert.ok(synced.snapshotId);
  assert.equal(JSON.parse(await fs.readFile(path.join(artwork.path, 'project/ds/brand/tokens.json'), 'utf8')).color, 'new');
});
