import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSkills } from './adapt-skills.mjs';
import { adaptAnnotations } from './adapt-annotations.mjs';
import { buildPluginAssets } from './assets.mjs';
import { includePublishedSource } from './publish-filter.mjs';

const buildRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(buildRoot);
const outputRoot = path.join(buildRoot, 'codex-design');
const markerName = '.generated-manifest.json';
const generator = 'codex-design-build-v1';
const skillSources = {
  'codex-slides': 'claude-slides',
  'codex-design': 'claude-design',
  'codex-design-system': 'claude-design-system',
  'codex-dashboard': 'claude-dashboard',
  'codex-dataviz': 'dataviz',
};
const checkOnly = process.argv.slice(2).includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) {
  throw new Error('Usage: node codex-plugins/build.mjs [--check]');
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('codex design requires Node.js 22 or later.');
}

function assertBuildChild(target) {
  const relative = path.relative(buildRoot, path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to change a path outside the build directory: ${target}`);
  }
}

async function exists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function filesUnder(root, relative = '', directories = []) {
  const files = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in plugin build inputs or output: ${path.join(root, child)}`);
    if (entry.isDirectory()) {
      directories.push(child.split(path.sep).join('/'));
      files.push(...await filesUnder(root, child, directories));
    }
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
    else throw new Error(`Unsupported file type: ${path.join(root, child)}`);
  }
  return files;
}

async function digestFiles(root) {
  const records = {};
  const directories = [];
  for (const relative of await filesUnder(root, '', directories)) {
    if (relative === markerName) continue;
    records[relative] = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
  }
  return { files: records, directories };
}

async function normalizeText(root) {
  const textExtensions = new Set(['.mjs', '.cjs', '.js', '.py', '.md', '.json', '.html', '.css', '.txt', '.svg']);
  for (const relative of await filesUnder(root)) {
    if (path.basename(relative) !== 'LICENSE' && !textExtensions.has(path.extname(relative).toLowerCase())) continue;
    const filename = path.join(root, relative);
    const original = await readFile(filename, 'utf8');
    const normalized = original.replaceAll('\r\n', '\n');
    if (normalized !== original) await writeFile(filename, normalized);
  }
}

async function validateExistingOutput() {
  if (!await exists(outputRoot)) return null;
  if (!(await lstat(outputRoot)).isDirectory() || (await lstat(outputRoot)).isSymbolicLink()) {
    throw new Error(`Refusing to replace a non-directory or linked output: ${outputRoot}`);
  }
  let marker;
  try { marker = JSON.parse(await readFile(path.join(outputRoot, markerName), 'utf8')); }
  catch { throw new Error(`Existing output has no valid ownership manifest. Preserve or move it before building: ${outputRoot}`); }
  if (marker.generator !== generator || marker.version !== 1 || !marker.files || typeof marker.files !== 'object' || Array.isArray(marker.files) || !Array.isArray(marker.directories)) {
    throw new Error(`Existing output has an unrecognized ownership manifest: ${outputRoot}`);
  }
  const current = await digestFiles(outputRoot);
  const changed = [...new Set([...Object.keys(marker.files), ...Object.keys(current.files)])]
    .filter((relative) => marker.files[relative] !== current.files[relative]);
  for (const relative of new Set([...marker.directories, ...current.directories])) {
    if (marker.directories.includes(relative) !== current.directories.includes(relative)) changed.push(`${relative}/`);
  }
  if (changed.length) {
    throw new Error(`Refusing to overwrite changed or unowned output files. Edit codex-plugins/source or preserve these files first:\n${changed.map((relative) => `  ${relative}`).join('\n')}`);
  }
  return current;
}

await mkdir(buildRoot, { recursive: true });
const previous = await validateExistingOutput();
const stagingRoot = await mkdtemp(path.join(buildRoot, '.codex-design-build-'));
assertBuildChild(stagingRoot);
let backupRoot;
try {
  for (const [name, sourceName] of Object.entries(skillSources)) {
    const source = path.join(repoRoot, 'skills', sourceName);
    await filesUnder(source);
    await cp(source, path.join(stagingRoot, 'skills', name), { recursive: true, force: false, errorOnExist: true });
  }
  const sourceRoot = path.join(buildRoot, 'source');
  await filesUnder(sourceRoot);
  await cp(sourceRoot, stagingRoot, { recursive: true, force: true, filter: source =>
    includePublishedSource(path.relative(sourceRoot, source)) });
  await cp(path.join(repoRoot, 'NOTICE.md'), path.join(stagingRoot, 'NOTICE.md'));
  const noticePath = path.join(stagingRoot, 'NOTICE.md');
  const notice = await readFile(noticePath, 'utf8');
  await writeFile(noticePath, notice
    .replaceAll('](LICENSE)', '](https://github.com/JimLiu/baoyu-design/blob/main/LICENSE)')
    .replace(/\]\((archive\/[^)]+)\)/g, '](https://github.com/JimLiu/baoyu-design/blob/main/$1)'));
  await normalizeText(stagingRoot);
  await adaptSkills(stagingRoot);
  await adaptAnnotations(stagingRoot);
  await buildPluginAssets(stagingRoot);
  const next = await digestFiles(stagingRoot);
  await writeFile(path.join(stagingRoot, markerName), `${JSON.stringify({ generator, version: 1, ...next }, null, 2)}\n`);
  const unchanged = previous !== null && JSON.stringify(previous) === JSON.stringify(next);
  if (checkOnly) {
    if (!unchanged) throw new Error('Generated Codex plugin is stale or missing. Run: node codex-plugins/build.mjs');
    process.stdout.write(`codex design: generated package is current (${Object.keys(next.files).length} files).\n`);
  } else if (unchanged) {
    process.stdout.write(`codex design: no changes (${Object.keys(next.files).length} files).\n`);
  } else {
    // Revalidate immediately before replacing an owned tree; never discard concurrent manual edits.
    const beforeReplace = await validateExistingOutput();
    if (JSON.stringify(beforeReplace) !== JSON.stringify(previous)) throw new Error('Output changed during the build; no files were replaced.');
    if (previous !== null) {
      backupRoot = path.join(buildRoot, `.codex-design-backup-${randomUUID()}`);
      assertBuildChild(outputRoot);
      assertBuildChild(backupRoot);
      await rename(outputRoot, backupRoot);
    }
    try { await rename(stagingRoot, outputRoot); }
    catch (error) {
      if (backupRoot) { await rename(backupRoot, outputRoot); backupRoot = undefined; }
      throw error;
    }
    if (backupRoot) { assertBuildChild(backupRoot); await rm(backupRoot, { recursive: true }); backupRoot = undefined; }
    process.stdout.write(`codex design: built ${Object.keys(next.files).length} files in ${outputRoot}\n`);
  }
} finally {
  if (await exists(stagingRoot)) { assertBuildChild(stagingRoot); await rm(stagingRoot, { recursive: true }); }
}
