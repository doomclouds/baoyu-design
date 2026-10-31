import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../source/library/index.mjs';
import { checkpointArtworkForSkill } from '../source/scripts/artifact-command.mjs';
import { WORKER_JOBS_FILE } from '../source/scripts/worker-core.mjs';

async function removeTemporary(root) {
  const relative = path.relative(os.tmpdir(), path.resolve(root));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  await rm(root, { recursive: true, force: true });
}

test('checkpoint snapshots existing content and restores it without rolling back local comments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-checkpoint-'));
  try {
    const store = createLibraryStore({ root });
    const artwork = await store.create({ kind: 'slides', title: 'Checkpoint verification' });
    const content = path.join(artwork.path, 'project', 'slides', 'cover.html');
    const original = (await readFile(content, 'utf8')).replace('</section>', '<h1>Original before AI edit</h1></section>');
    await writeFile(content, original);
    await writeFile(path.join(artwork.path, 'comments.json'), '{"localComment":"before"}\n');
    const result = await checkpointArtworkForSkill('codex-slides', artwork.path);
    assert.equal(result.artifactId, artwork.id);
    assert.equal(result.snapshot.artifactId, artwork.id);
    assert.equal(result.snapshot.label, 'Before AI edit');
    assert.ok(result.snapshot.bytes > 0);
    await writeFile(content, original.replace('Original before AI edit', 'Changed by AI'));
    await writeFile(path.join(artwork.path, 'comments.json'), '{"localComment":"after"}\n');
    await store.restoreSnapshot(artwork.id, result.snapshot.id);
    assert.equal(await readFile(content, 'utf8'), original);
    assert.equal(await readFile(path.join(artwork.path, 'comments.json'), 'utf8'), '{"localComment":"after"}\n');
    assert.equal((await store.listSnapshots(artwork.id)).length, 1);
  } finally {
    await removeTemporary(root);
  }
});

test('checkpoint rejects nonlibrary/mismatched roots without writes, refuses active jobs and preserves pending jobs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-checkpoint-guard-'));
  try {
    const explicit = path.join(root, 'explicit project');
    await mkdir(explicit);
    await assert.rejects(checkpointArtworkForSkill('codex-slides', explicit), { code: 'NOT_LIBRARY_ARTIFACT' });
    assert.deepEqual(await readdir(explicit), []);
    const store = createLibraryStore({ root: path.join(root, 'library') });
    const artwork = await store.create({ kind: 'slides', title: 'Busy checkpoint' });
    await assert.rejects(checkpointArtworkForSkill('codex-design', artwork.path), { code: 'NOT_LIBRARY_ARTIFACT' });
    for (const status of ['active', 'pending']) {
      await writeFile(path.join(artwork.path, WORKER_JOBS_FILE), JSON.stringify({ version: 1, order: ['job'], jobs: { job: { id: 'job', status, event: { kind: 'comment', data: { id: 'comment' } } } } }));
      if (status === 'active') {
        await assert.rejects(checkpointArtworkForSkill('codex-slides', artwork.path), { code: 'ARTIFACT_BUSY' });
        assert.equal((await store.listSnapshots(artwork.id)).length, 0);
      } else {
        const result = await checkpointArtworkForSkill('codex-slides', artwork.path);
        assert.equal(result.pendingCount, 1);
        assert.equal((await store.listSnapshots(artwork.id)).length, 1);
        assert.equal(JSON.parse(await readFile(path.join(artwork.path, WORKER_JOBS_FILE), 'utf8')).jobs.job.status, 'pending');
      }
    }
    const incomplete = path.join(root, 'not-library', 'slides', artwork.id);
    await mkdir(incomplete, { recursive: true });
    await writeFile(path.join(incomplete, 'artifact.json'), JSON.stringify({ id: artwork.id, kind: 'slides', formatVersion: 1 }));
    await assert.rejects(checkpointArtworkForSkill('codex-slides', incomplete), { code: 'NOT_LIBRARY_ARTIFACT' });
    assert.deepEqual(await readdir(path.join(root, 'not-library')), ['slides']);
  } finally {
    await removeTemporary(root);
  }
});
