import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { designSystemSearchEnvironment } from '../source/scripts/design-system-search.mjs';
import { createFixture } from './fixtures.mjs';

const run = promisify(execFile);
const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
async function removeTemporary(root) {
  const relative = path.relative(os.tmpdir(), path.resolve(root));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await rm(root, { recursive: true, force: true });
}

test('global design-system discovery preserves explicit roots and never initializes a missing library', async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-ds-search-'));
  try {
    const original = { CODEX_HOME: path.join(homeDirectory, 'other'), CODEX_DESIGN_SYSTEMS: 'explicit-path' };
    assert.equal(designSystemSearchEnvironment(original, { homeDirectory }), original);
    assert.deepEqual(await readdir(homeDirectory), []);
    const global = path.join(homeDirectory, '.codex', 'CodexDesignLibrary', 'design-system');
    await mkdir(global, { recursive: true });
    const explicit = path.join(homeDirectory, 'custom system');
    await mkdir(explicit);
    const env = { ...original, CODEX_DESIGN_SYSTEMS: [explicit, path.join(explicit, '.'), global].join(path.delimiter) };
    const updated = designSystemSearchEnvironment(env, { homeDirectory });
    assert.deepEqual(updated.CODEX_DESIGN_SYSTEMS.split(path.delimiter), [explicit, global]);
    assert.equal(updated.CODEX_HOME, original.CODEX_HOME);
    assert.equal(env.CODEX_DESIGN_SYSTEMS.split(path.delimiter).length, 3, 'caller environment is not mutated');
    assert.deepEqual(await readdir(path.dirname(global)), ['design-system'], 'no catalog or state is created');
  } finally {
    await removeTemporary(homeDirectory);
  }
});

test('implicit global discovery refuses linked library roots', async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-ds-link-'));
  try {
    const codex = path.join(homeDirectory, '.codex');
    const elsewhere = path.join(homeDirectory, 'elsewhere');
    await mkdir(codex);
    await mkdir(path.join(elsewhere, 'design-system'), { recursive: true });
    await symlink(elsewhere, path.join(codex, 'CodexDesignLibrary'), process.platform === 'win32' ? 'junction' : 'dir');
    const env = { CODEX_DESIGN_SYSTEMS: 'explicit-path' };
    assert.equal(designSystemSearchEnvironment(env, { homeDirectory }), env);
  } finally {
    await removeTemporary(homeDirectory);
  }
});

test('real artwork CLIs discover global systems from another project and exclude trash', async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-ds-list-'));
  const fixture = await createFixture('design-system', homeDirectory);
  try {
    const library = path.join(homeDirectory, '.codex', 'CodexDesignLibrary');
    const active = path.join(library, 'design-system', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const trashed = path.join(library, '_trash', '11111111-2222-4333-8444-555555555555');
    const project = path.join(homeDirectory, 'unrelated project');
    await cp(fixture.root, active, { recursive: true });
    await cp(fixture.root, trashed, { recursive: true });
    await mkdir(project);
    const index = path.join(active, 'project', 'design-system.json');
    const before = await readFile(index, 'utf8');
    const env = designSystemSearchEnvironment({ ...process.env, CODEX_DESIGN_SYSTEMS: '', CODEX_HOME: path.join(homeDirectory, 'ignored') }, { homeDirectory });
    for (const name of ['codex-slides', 'codex-design', 'codex-design-system']) {
      const { stdout } = await run(process.execPath, [path.join(pluginRoot, 'skills', name, 'scripts', 'artifact.mjs'), 'list'], { cwd: project, env, timeout: 20_000, windowsHide: true });
      const systems = JSON.parse(stdout);
      assert.equal(systems.length, 1, `${name} must discover only the active global system`);
      assert.equal(systems[0].root, active);
      assert.equal(systems[0].title, fixture.title);
    }
    assert.equal(await readFile(index, 'utf8'), before);
    assert.deepEqual((await readdir(library)).sort(), ['_trash', 'design-system']);
  } finally {
    await removeTemporary(homeDirectory);
  }
});
