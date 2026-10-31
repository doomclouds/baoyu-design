import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptEditorLocalization } from './editor-localization.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(here, 'source');
const nodeBanner = 'import { createRequire as codexCreateRequire } from "node:module"; const require = codexCreateRequire(import.meta.url);';
const htmlScript = code => code.replace(/<\/script/gi, '<\\/script');

async function licensesFor(results) {
  const packages = new Map();
  const nodeModulesSegment = `${path.sep}node_modules${path.sep}`;
  for (const result of results) for (const input of Object.keys(result.metafile?.inputs || {})) {
    const absolute = path.resolve(here, input);
    const boundary = absolute.lastIndexOf(nodeModulesSegment);
    if (boundary < 0) continue;
    // A distribution may repeat name/version in dist/package.json while its
    // license remains in the actual npm package root. Nested node_modules are
    // independent packages, not children of the enclosing dependency.
    const parts = absolute.slice(boundary + nodeModulesSegment.length).split(path.sep);
    const packageParts = parts.slice(0, parts[0].startsWith('@') ? 2 : 1);
    const directory = path.join(absolute.slice(0, boundary + nodeModulesSegment.length), ...packageParts);
    const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.version) throw new Error(`Bundled dependency has no package identity: ${input}`);
    packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg });
  }
  const fallbackCatalog = JSON.parse(await fs.readFile(path.join(here, 'third-party/licenses.json'), 'utf8'));
  if (fallbackCatalog.version !== 1 || !fallbackCatalog.packages) throw new Error('Unrecognized third-party license provenance catalog.');
  const lock = JSON.parse(await fs.readFile(path.join(here, 'package-lock.json'), 'utf8'));
  const { createHash } = await import('node:crypto');
  const notices = ['Bundled JavaScript dependencies\n\nOriginal editor third-party notices remain with their editor files.\n'];
  for (const [name, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const candidates = (await fs.readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name));
    const files = [];
    for (const file of candidates) if ((await fs.stat(path.join(directory, file))).isFile()) files.push(file);
    notices.push(`\n${'='.repeat(72)}\n${name}\nLicense: ${typeof pkg.license === 'string' ? pkg.license : 'See package notices'}\n`);
    if (!files.length) {
      const fallback = fallbackCatalog.packages[name];
      if (!fallback) throw new Error(`No license notice found for bundled dependency ${name}; add the original notice from its exact release commit.`);
      const lockEntry = lock.packages?.[path.relative(here, directory).split(path.sep).join('/')];
      if (fallback.license !== pkg.license || fallback.npmIntegrity !== lockEntry?.integrity
        || !/^[a-f0-9]{40}$/.test(fallback.gitHead) || !fallback.source.includes(`/${fallback.gitHead}/`)
        || path.basename(fallback.file) !== fallback.file) throw new Error(`License provenance does not match the pinned dependency ${name}.`);
      const text = (await fs.readFile(path.join(here, 'third-party', fallback.file), 'utf8')).replaceAll('\r\n', '\n');
      if (createHash('sha256').update(text).digest('hex') !== fallback.sha256) throw new Error(`The verified upstream license changed for ${name}.`);
      notices.push(text + '\n');
    }
    for (const file of files.sort()) {
      const text = (await fs.readFile(path.join(directory, file), 'utf8')).replaceAll('\r\n', '\n');
      if (!text.trim()) throw new Error(`The bundled dependency notice is empty: ${name}/${file}`);
      notices.push(`\n${file}\n${text}\n`);
    }
  }
  return notices.join('');
}

export async function buildPluginAssets(pluginRoot) {
  const bundles = [];
  const common = { absWorkingDir: here, bundle: true, metafile: true, logLevel: 'warning', legalComments: 'eof', charset: 'utf8' };
  const ui = await build({ ...common, entryPoints: [path.join(sourceRoot, 'ui/entry.js')], write: false,
    platform: 'browser', format: 'iife', target: 'es2022', loader: { '.svg': 'dataurl' } });
  bundles.push(ui);
  const css = await fs.readFile(path.join(sourceRoot, 'ui/styles.css'), 'utf8');
  let html = await fs.readFile(path.join(sourceRoot, 'ui/index.html'), 'utf8');
  const styleTag = '<link rel="stylesheet" href="./styles.css">';
  const scriptTag = '<script type="module" src="./entry.js"></script>';
  if (!html.includes(styleTag) || !html.includes(scriptTag)) throw new Error('The library UI build anchors changed.');
  html = html.replace(styleTag, () => `<style>\n${css}\n</style>`)
    .replace(scriptTag, () => `<script>\n${htmlScript(ui.outputFiles[0].text)}\n</script>`);
  await fs.writeFile(path.join(pluginRoot, 'ui/index.html'), html);

  const localization = await build({ ...common, entryPoints: [path.join(sourceRoot, 'scripts/editor-localization.js')], write: false,
    platform: 'browser', format: 'iife', target: 'es2022' });
  bundles.push(localization);
  const localizationPath = path.join(pluginRoot, 'scripts/editor-localization.js');
  await fs.writeFile(localizationPath, localization.outputFiles[0].contents);
  const editorCoverage = await adaptEditorLocalization(pluginRoot, { bundlePath: localizationPath });

  for (const [entry, output] of [['server/index.mjs', 'server/index.mjs'], ['scripts/library-preview.mjs', 'scripts/library-preview.mjs']]) {
    const source = path.join(sourceRoot, entry);
    if (!(await fs.stat(source).catch(() => null))) throw new Error(`Missing plugin entrypoint: ${entry}`);
    const result = await build({ ...common, entryPoints: [source], outfile: path.join(pluginRoot, output), platform: 'node',
      format: 'esm', target: 'node22', banner: { js: nodeBanner } });
    bundles.push(result);
  }
  await fs.writeFile(path.join(pluginRoot, 'assets/third-party-notices.txt'), await licensesFor(bundles));
  return { editorCoverage, bundledDependencies: true };
}

export async function buildSpike(pluginRoot) {
  await fs.mkdir(path.join(pluginRoot, 'server'), { recursive: true });
  await fs.mkdir(path.join(pluginRoot, 'assets'), { recursive: true });
  await build({ absWorkingDir: here, entryPoints: [path.join(sourceRoot, 'server/spike.mjs')], outfile: path.join(pluginRoot, 'server/index.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'eof', banner: { js: nodeBanner } });
  await fs.copyFile(path.join(sourceRoot, 'server/spike.html'), path.join(pluginRoot, 'server/spike.html'));
  await fs.copyFile(path.join(sourceRoot, 'assets/icon.png'), path.join(pluginRoot, 'assets/icon.png'));
}

if (process.argv[2] === '--spike') {
  if (!process.argv[3]) throw new Error('Give a destination for the self-contained native entrypoint probe.');
  await buildSpike(path.resolve(process.argv[3]));
  process.stdout.write('Built self-contained native entrypoint probe.\n');
}
