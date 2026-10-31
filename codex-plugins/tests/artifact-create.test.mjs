import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArtworkForSkill } from '../source/scripts/artifact-command.mjs';
import { createLibraryStore } from '../source/library/index.mjs';

const run = promisify(execFile);
const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
async function removeTemporary(root) {
  const relative = path.relative(os.tmpdir(), path.resolve(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(root, { recursive: true, force: true });
}

test('all editor skills create valid unique native artwork in the selected library with native deep links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-artwork-create-'));
  const store = createLibraryStore({ root });
  try {
    const ids = new Set();
    for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
      const result = await createArtworkForSkill(path.join('skills', `codex-${kind}`), `验收 ${kind} "quoted"`, { store });
      assert.equal(result.kind, kind);
      assert.match(result.id, /^[0-9a-f-]{36}$/);
      assert.ok(!ids.has(result.id));
      ids.add(result.id);
      assert.equal(result.root, path.join(root, kind, result.id));
      const link = new URL(result.appUrl);
      assert.equal(link.protocol, 'codex:');
      assert.equal(link.pathname, '/codex-design@codex-design-marketplace/app/DesignLibrary');
      assert.equal(link.searchParams.get('path'), `/artifacts/${result.id}`);
      const { stdout } = await run(process.execPath, [path.join(pluginRoot, 'skills', `codex-${kind}`, 'scripts', 'artifact.mjs'), 'check', result.root], { windowsHide: true, timeout: 20_000 });
      assert.equal(JSON.parse(stdout).problems, 0, stdout);
      assert.equal(JSON.parse(await readFile(path.join(result.root, 'artifact.json'), 'utf8')).title, result.title);
      assert.deepEqual((await readdir(result.root)).sort(), ['artifact.json', kind === 'dashboard' ? 'db' : 'project'].sort());
    }
    assert.equal((await store.list()).length, 4);
    await assert.rejects(createArtworkForSkill('codex-dataviz', 'Unsupported', { store }), { code: 'UNSUPPORTED_SKILL' });
    assert.equal((await store.list()).length, 4);
  } finally {
    await removeTemporary(root);
  }
});

test('create dispatch returns one JSON result without starting an editor or model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-create-dispatch-'));
  try {
    const skill = path.join(root, 'skills', 'codex-slides');
    await mkdir(skill, { recursive: true });
    const runner = path.join(root, 'runner.mjs');
    const commandModule = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;
    const libraryModule = new URL('../source/library/index.mjs', import.meta.url).href;
    await writeFile(runner, `import { runArtifactCommand } from ${JSON.stringify(commandModule)};\nimport { createLibraryStore } from ${JSON.stringify(libraryModule)};\nawait runArtifactCommand(${JSON.stringify(skill)}, process.argv.slice(2), { env: {}, libraryStore: createLibraryStore({root: ${JSON.stringify(path.join(root, 'library'))}}) });\n`);
    const { stdout, stderr } = await run(process.execPath, [runner, 'create', '标题 with "quotes"'], { cwd: root, windowsHide: true, timeout: 20_000 });
    const created = JSON.parse(stdout);
    assert.equal(created.title, '标题 with "quotes"');
    assert.equal(stderr, '');
    assert.equal(created.kind, 'slides');
    assert.deepEqual((await readdir(created.root)).sort(), ['artifact.json', 'project']);
    await assert.rejects(run(process.execPath, [runner, 'create'], { windowsHide: true, timeout: 20_000 }), error => {
      assert.equal(error.code, 2);
      assert.equal(JSON.parse(error.stderr).error, 'INVALID_CREATE_ARGUMENTS');
      return true;
    });
    assert.equal((await createLibraryStore({ root: path.join(root, 'library') }).list()).length, 1);
  } finally {
    await removeTemporary(root);
  }
});
