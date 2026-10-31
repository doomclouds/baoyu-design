import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const buildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(buildRoot, 'codex-design');
const readJson = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
const editors = ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard'];

async function markdownFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(filename));
    else if (entry.name.endsWith('.md')) files.push(filename);
  }
  return files;
}

test('portable and compatibility manifests expose the same local Codex plugin', async () => {
  const portable = await readJson(path.join(pluginRoot, 'plugin.json'));
  const compatibility = await readJson(path.join(pluginRoot, '.codex-plugin/plugin.json'));
  const marketplace = await readJson(path.join(buildRoot, '..', '.agents/plugins/marketplace.json'));
  assert.equal(portable.name, 'codex-design');
  assert.equal(portable.version, '0.1.0');
  assert.equal(compatibility.name, portable.name);
  assert.equal(compatibility.version, portable.version);
  assert.equal(compatibility.skills, './skills/');
  assert.equal(compatibility.requires_local_executor, true);
  assert.equal(portable.extensions['com.openai'].requires_local_executor, true);
  assert.deepEqual(compatibility.interface, portable.extensions['com.openai'].interface);
  assert.equal(compatibility.interface.displayName, 'codex design');
  assert.ok(compatibility.interface.shortDescription.length <= 30);
  assert.equal(marketplace.name, 'codex-design-marketplace');
  assert.equal(marketplace.plugins[0].name, portable.name);
  assert.equal(marketplace.plugins[0].source.path, './codex-plugins/codex-design');
  const notice = await readFile(path.join(pluginRoot, 'NOTICE.md'), 'utf8');
  assert.match(notice, /https:\/\/github\.com\/JimLiu\/baoyu-design\/blob\/main\/LICENSE/);
  assert.match(notice, /https:\/\/github\.com\/JimLiu\/baoyu-design\/blob\/main\/archive\/baoyu-design\/built-in-skills\/LICENSE-frontend-design\.txt/);
  assert.match(await readFile(path.join(pluginRoot, 'NOTICE.md'), 'utf8'), /Anthropic/);
  assert.ok(!(await readdir(pluginRoot)).includes('LICENSE'), 'do not restore the top-level plugin LICENSE removed by the user');
});

test('installed-package metadata and Markdown links resolve inside the package', async () => {
  const manifest = await readJson(path.join(pluginRoot, 'plugin.json'));
  const presentation = manifest.extensions['com.openai'].interface;
  for (const relative of [presentation.logo, presentation.composerIcon]) {
    assert.ok(relative.startsWith('./') && !relative.split('/').includes('..'));
    await readFile(path.resolve(pluginRoot, relative));
  }
  for (const file of await markdownFiles(pluginRoot)) {
    const text = (await readFile(file, 'utf8')).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      let target = match[1].trim().replace(/^<|>$/g, '').split(/\s+"/)[0];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      target = decodeURIComponent(target.split('#')[0]);
      if (!target || /[<>${}]/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), target);
      const relative = path.relative(pluginRoot, resolved);
      assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `${file}: link escapes the plugin: ${target}`);
      await readFile(resolved).catch(error => { throw new Error(`${file}: unresolved packaged link ${target}: ${error.message}`); });
    }
  }
});

test('all five generated skills use Codex routing, validation, and supported entry points', async () => {
  assert.deepEqual((await readdir(path.join(pluginRoot, 'skills'))).sort(), [...editors, 'codex-dataviz'].sort());
  for (const name of [...editors, 'codex-dataviz']) {
    const text = await readFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
    assert.equal(/^name: (.+)$/m.exec(text)?.[1], name);
    assert.doesNotMatch(text, /claude/i);
    assert.match(text, /Mixed sources\. See the bundled \.\.\/\.\.\/NOTICE\.md/);
    assert.match(text, /## Codex execution/);
    assert.match(text, /Node\.js 22 or later/);
    assert.doesNotMatch(text, /NEVER VERIFY|Never verify further unless the user asked|is baoyu-design's|that is the baoyu-design skill/);
    assert.ok(!text.includes('\r\n'));
    if (editors.includes(name)) {
      assert.match(text, /codex-artifact\.mjs/);
      assert.match(text, /向 Codex 批注/);
      assert.match(text, /NO_CODEX_THREAD/);
      const wrapper = await readFile(path.join(pluginRoot, 'skills', name, 'scripts/codex-artifact.mjs'), 'utf8');
      assert.match(wrapper, /runArtifactCommand/);
      await readFile(path.join(pluginRoot, 'skills', name, 'scripts/artifact.mjs'));
    } else {
      assert.doesNotMatch(text, /built-in\s+`?check|codex-artifact/i);
      assert.match(text, /scripts\/validate_palette\.js/);
      assert.match(text, /Render the actual chart/);
      await readFile(path.join(pluginRoot, 'skills', name, 'scripts/validate_palette.js'));
      await readFile(path.join(pluginRoot, 'skills', name, 'scripts/validate_palette.py'));
    }
  }
  for (const filename of await markdownFiles(path.join(pluginRoot, 'skills'))) {
    assert.doesNotMatch(await readFile(filename, 'utf8'), /claude/i, filename);
  }
  const sync = await readFile(path.join(pluginRoot, 'skills/codex-design-system/artifact-type/reference/from-code.md'), 'utf8');
  assert.match(sync, /Source-project synchronization is not bundled/);
  assert.doesNotMatch(sync, /\/design-sync/);
  const design = await readFile(path.join(pluginRoot, 'skills/codex-design/SKILL.md'), 'utf8');
  assert.match(design, /The local format references use these file and command mappings/);
  assert.doesNotMatch(design, /appifacts-design skill's files/);
  const system = await readFile(path.join(pluginRoot, 'skills/codex-design-system/SKILL.md'), 'utf8');
  assert.match(system, /Source-project synchronization is not bundled/);
  assert.doesNotMatch(system, /the appifacts plugin and its `appifacts-design-system-from-code` skill/);
});

test('builder refuses unowned files, changed files, and unowned empty directories', async (t) => {
  for (const kind of ['unowned-file', 'changed-file', 'unowned-directory']) {
    await t.test(kind, async (t) => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-design-build-safety-'));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const temporaryBuild = path.join(temporary, 'codex-plugins');
      const output = path.join(temporaryBuild, 'codex-design');
      await mkdir(output, { recursive: true });
      await cp(path.join(buildRoot, 'build.mjs'), path.join(temporaryBuild, 'build.mjs'));
      await writeFile(path.join(temporaryBuild, 'adapt-skills.mjs'), 'export async function adaptSkills() {}\n');
      await writeFile(path.join(temporaryBuild, 'adapt-annotations.mjs'), 'export async function adaptAnnotations() {}\n');
      const files = {};
      if (kind === 'changed-file') files['user.txt'] = createHash('sha256').update('old value').digest('hex');
      await writeFile(path.join(output, '.generated-manifest.json'), JSON.stringify({ generator: 'codex-design-build-v1', version: 1, files, directories: [] }));
      if (kind === 'unowned-directory') await mkdir(path.join(output, 'user-notes'));
      else await writeFile(path.join(output, 'user.txt'), 'preserve this value');
      const result = spawnSync(process.execPath, [path.join(temporaryBuild, 'build.mjs')], { encoding: 'utf8', windowsHide: true });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to overwrite changed or unowned output files/);
      if (kind === 'unowned-directory') assert.ok((await readdir(output)).includes('user-notes'));
      else assert.equal(await readFile(path.join(output, 'user.txt'), 'utf8'), 'preserve this value');
    });
  }
});
