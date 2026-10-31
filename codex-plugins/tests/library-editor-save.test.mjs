import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLibraryStore } from '../source/library/index.mjs';

test('recent artwork observes a native editor content save without counting local comments as content', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-library-editor-save-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root });
  const record = await store.create({ kind: 'slides', title: 'Before editing' });
  const deckPath = path.join(record.path, 'project/deck.json');
  const deck = JSON.parse(await fs.readFile(deckPath, 'utf8'));
  deck.title = 'Saved by the slide editor';
  await fs.writeFile(deckPath, JSON.stringify(deck));
  const edited = new Date(Date.now() + 2_000);
  await fs.utimes(deckPath, edited, edited);
  const observed = await store.get(record.id);
  assert.equal(observed.title, deck.title);
  assert.ok(Math.abs(Date.parse(observed.updatedAt) - edited.getTime()) < 2);
  const commentPath = path.join(record.path, 'comments.json');
  await fs.writeFile(commentPath, '{"threads":[]}');
  const later = new Date(edited.getTime() + 2_000);
  await fs.utimes(commentPath, later, later);
  assert.equal((await store.get(record.id)).updatedAt, observed.updatedAt);
  assert.equal((await store.exportArtifact(record.id)).files.some(file => 'modifiedAt' in file), false);
  const reference = await store.readFile(record.id, 'project/deck.json');
  assert.equal(reference.revision.sha256, createHash('sha256').update(reference.text).digest('hex'));
  assert.ok(Number.isFinite(Date.parse(reference.revision.observedAt)));
  deck.title = 'A later edit';
  await fs.writeFile(deckPath, JSON.stringify(deck));
  assert.notEqual((await store.readFile(record.id, 'project/deck.json')).revision.sha256, reference.revision.sha256);
});
