import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import { LIBRARY_UI_URI, FILE_UI_URI, PLUGIN_UI_VERSION } from '../source/server/contract.mjs';

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

async function packageFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    assert.ok(!entry.isSymbolicLink(), 'a distributed package must not depend on an external symlink: ' + relative);
    assert.notEqual(entry.name, 'node_modules', 'runtime dependencies must be bundled, not installed into the plugin cache');
    if (entry.isDirectory()) result.push(...await packageFiles(root, relative));
    else result.push(relative);
  }
  return result;
}

function packagePath(root, relative) {
  const resolved = path.resolve(root, relative);
  const part = path.relative(root, resolved);
  assert.ok(part && part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part), 'packaged path escaped its root: ' + relative);
  return resolved;
}

// Exercise the distributed entrypoint, not source imports that could silently
// resolve development node_modules or return a placeholder HTML document.
async function packagedMcpSession(t) {
  const configuration = await readJson(path.join(pluginRoot, 'mcp.json'));
  const server = configuration.mcpServers['codex-design'];
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', pluginRoot);
  const child = spawn(server.command, server.args.map(expand), {
    cwd: expand(server.cwd), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_PATH: '' },
  });
  let buffer = '', stderr = '', nextId = 0;
  const pending = new Map();
  const rejectPending = error => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.once('exit', code => rejectPending(new Error(`Packaged MCP exited ${code}: ${stderr}`)));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { rejectPending(new Error('The packaged MCP wrote non-JSON text to protocol stdout: ' + line.slice(0, 300))); continue; }
      const call = pending.get(message.id);
      if (!call) continue;
      clearTimeout(call.timer); pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    for (const call of pending.values()) clearTimeout(call.timer);
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.end(); child.kill();
    if (child.exitCode === null && child.signalCode === null) await closed;
  });
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'codex-design-package-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return { rpc, initialized };
}

test('portable and compatibility manifests expose the same local Codex plugin', async () => {
  const portable = await readJson(path.join(pluginRoot, 'plugin.json'));
  const sourceManifest = await readJson(path.join(buildRoot, 'source/plugin.json'));
  const compatibility = await readJson(path.join(pluginRoot, '.codex-plugin/plugin.json'));
  const marketplace = await readJson(path.join(buildRoot, '..', '.agents/plugins/marketplace.json'));
  assert.equal(portable.name, 'codex-design');
  assert.match(sourceManifest.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  assert.equal(portable.version, sourceManifest.version);
  assert.equal(compatibility.name, portable.name);
  assert.equal(compatibility.version, portable.version);
  assert.equal(compatibility.skills, './skills/');
  assert.equal(compatibility.mcpServers, './mcp.json');
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

test('the distributed stdio command and bundled Node entrypoints are independent of the author machine', async () => {
  const configuration = await readJson(path.join(pluginRoot, 'mcp.json'));
  assert.deepEqual(Object.keys(configuration.mcpServers), ['codex-design']);
  const server = configuration.mcpServers['codex-design'];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node', 'the installation must use Node from PATH, never the author\'s executable path');
  assert.deepEqual(server.args, ['${PLUGIN_ROOT}/server/index.mjs']);
  assert.equal(server.cwd, '${PLUGIN_ROOT}');
  assert.doesNotMatch(JSON.stringify(server), /(?:[A-Za-z]:[\\/]|file:\/\/|\/Users\/|\/home\/|AppData|\.codex[\\/]plugins[\\/]cache)/);
  const files = await packageFiles(pluginRoot);
  for (const relative of ['server/index.mjs', 'scripts/library-preview.mjs', 'ui/index.html', 'assets/third-party-notices.txt']) assert.ok(files.includes(relative), relative);
  assert.ok(!files.includes('server/spike.mjs') && !files.includes('server/spike.html'), 'development entrypoint probes are not published');
  for (const relative of ['server/index.mjs', 'scripts/library-preview.mjs']) {
    const text = await readFile(packagePath(pluginRoot, relative), 'utf8');
    const normalized = text.replaceAll('\\\\', '\\').replaceAll('\\', '/');
    for (const outside of [path.resolve(buildRoot, 'source'), path.dirname(buildRoot), os.tmpdir()]) {
      assert.ok(!normalized.toLowerCase().includes(outside.replaceAll('\\', '/').toLowerCase()), `${relative}: bundled code retained an author/source/temp path`);
    }
    // Parse actual module imports, not documentation/code-generation strings
    // containing e.g. `require("ajv/...")`. Treat packages as external so this
    // check cannot accidentally resolve a missing dependency from the author's
    // development node_modules and conceal a broken distributed bundle.
    const inspected = await build({ entryPoints: [packagePath(pluginRoot, relative)], bundle: true,
      platform: 'node', format: 'esm', target: 'node22', packages: 'external',
      write: false, metafile: true, logLevel: 'silent' });
    const dependencies = Object.values(inspected.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path));
    for (const dependency of dependencies) {
      if (isBuiltin(dependency)) continue;
      assert.ok(dependency.startsWith('./') || dependency.startsWith('../'), `${relative}: unbundled external runtime dependency ${dependency}`);
      await readFile(packagePath(pluginRoot, path.relative(pluginRoot, path.resolve(path.dirname(packagePath(pluginRoot, relative)), dependency))));
    }
  }
  const notices = await readFile(path.join(pluginRoot, 'assets/third-party-notices.txt'), 'utf8');
  assert.match(notices, /i18next@/);
  assert.match(notices, /@openai\/mcp-extensions@/);
});

test('the packaged workspace UI is a single HTML resource with no external script, CSS, or module dependency', async () => {
  const html = await readFile(path.join(pluginRoot, 'ui/index.html'), 'utf8');
  assert.match(html, /id="codex-design-root"/);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'a placeholder document is not a packaged workspace UI');
  for (const [, attributes, script] of scripts) {
    assert.doesNotMatch(attributes, /\bsrc\s*=|\btype\s*=\s*["']module["']/i);
    assert.doesNotMatch(script, /^\s*import\s+(?:["'{*]|[\w$]+\s+from\s+)/m);
    assert.doesNotMatch(script, /\bimport\s*\(\s*["'](?:\.\.?\/|@|https?:)/);
  }
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel\s*=\s*["']modulepreload["']/i);
  assert.match(html, /<style>/);
  for (const [, css] of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    assert.doesNotMatch(css, /@import\b|url\(\s*["']?https?:/i, 'the packaged workspace must not require an external stylesheet or font');
  }
});

test('the installed stdio bundle exposes real entrypoints while ordinary tools keep chat output free of UI panels', async t => {
  const session = await packagedMcpSession(t);
  const manifest = await readJson(path.join(pluginRoot, 'plugin.json'));
  assert.equal(manifest.version, PLUGIN_UI_VERSION, 'the packaged UI resource version must match the installed release');
  assert.equal(session.initialized.serverInfo.name, manifest.name);
  assert.equal(session.initialized.serverInfo.version, manifest.version);
  const { tools } = await session.rpc('tools/list');
  for (const [name, type] of [['DesignLibrary', 'global'], ['DesignFile', 'file']]) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, 'missing native entrypoint ' + name);
    assert.deepEqual(tool._meta.ui.visibility, ['app']);
    assert.ok(tool._meta['openai/ui'].entrypoints.some(entry => entry.type === type));
    assert.equal(tool._meta.ui.resourceUri, type === 'global' ? LIBRARY_UI_URI : FILE_UI_URI);
  }
  for (const name of ['design_read', 'design_action', 'search_mentions']) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, 'missing regular tool ' + name);
    assert.equal(tool._meta?.ui?.resourceUri, undefined, name + ': ordinary model output must not open the workspace panel');
    assert.equal(tool._meta?.['openai/outputTemplate'], undefined);
    assert.equal(tool._meta?.['openai/ui']?.entrypoints, undefined);
  }
  assert.equal(tools.find(tool => tool.name === 'search_mentions').annotations.readOnlyHint, true);
  const ui = await session.rpc('resources/read', { uri: LIBRARY_UI_URI });
  const packagedHtml = await readFile(path.join(pluginRoot, 'ui/index.html'), 'utf8');
  assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(ui.contents[0].text, packagedHtml, 'the distributed server must return the bundled UI, not source HTML or a test placeholder');
});

test('all four distributed editors load complete native English/Chinese resources before their runtime', async () => {
  for (const name of editors) {
    const editor = path.join(pluginRoot, 'skills', name, 'scripts/editor');
    const html = await readFile(path.join(editor, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    const resources = scripts.find(match => /(?:^|\s)data-codex-editor-i18n-resources(?:\s|$)/.test(match[1]));
    const runtime = scripts.find(match => /(?:^|\s)data-codex-editor-i18n(?:\s|$)/.test(match[1]));
    assert.ok(resources && runtime, name + ': editor localization assets are missing');
    assert.ok(resources.index < runtime.index);
    for (const script of scripts.filter(match => /type="module"|src="\.\/comments\.js"/.test(match[1]))) assert.ok(runtime.index < script.index, name + ': localization must initialize before editor labels');
    let catalog;
    for (const script of [resources, runtime]) {
      assert.doesNotMatch(script[1], /\bdefer\b|\basync\b|\btype="module"/);
      const src = /\bsrc="([^"]+)"/.exec(script[1])?.[1];
      assert.ok(src?.startsWith('./assets/'));
      const bytes = await readFile(packagePath(editor, src));
      const expected = 'sha384-' + createHash('sha384').update(bytes).digest('base64');
      assert.equal(/\bintegrity="([^"]+)"/.exec(script[1])?.[1], expected);
      if (script === resources) {
        const sandbox = {};
        vm.runInNewContext(bytes.toString('utf8'), sandbox, { timeout: 1_000 });
        catalog = sandbox.__CODEX_DESIGN_EDITOR_RESOURCES__;
      }
    }
    assert.equal(catalog.kind, name.replace(/^codex-/, ''));
    assert.ok(catalog.coverage.native > 50);
    assert.equal(catalog.coverage.translatedNative, catalog.coverage.native, name + ': incomplete native UI translation');
    assert.deepEqual(Object.keys(catalog.resources.en.editor).sort(), Object.keys(catalog.resources.zh.editor).sort(), name + ': shared menus and comment controls must not rely on English fallbacks');
    assert.ok(catalog.resources.zh.editor['chrome.reply']);
  }
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
      if (/^(?:https?:|mailto:|codex:|plugin:|app:|codex-design:|#)/i.test(target)) continue;
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
      assert.match(text, /browser toolbar's \*\*批注\*\*/);
      assert.match(text, /Parent native-agent controller/);
      assert.match(text, /worker-status <root>/);
      assert.match(text, /worker-register <root> --name <task>/);
      assert.match(text, /worker-next <root> --timeout 60/);
      assert.match(text, /worker-complete <root> <jobId> -/);
      assert.match(text, /own actual .*CODEX_THREAD_ID/);
      assert.match(text, /On .*timedOut.*call worker-next again/);
      assert.match(text, /On .*closed.*end this listener turn/);
      assert.match(text, /Do not create an agent for every comment/);
      assert.match(text, /does not wake a native agent, call an external queue, or start a model\/HTTP daemon/);
      assert.match(text, /cannot interrupt a native agent/);
      assert.match(text, /must not wait for its own worker-status entry/);
      assert.doesNotMatch(text, /independent local design worker|codex app-server|ephemeral|stdin.*RPC/i);
      assert.doesNotMatch(text, /向 Codex 批注/);
      const wrapper = await readFile(path.join(pluginRoot, 'skills', name, 'scripts/codex-artifact.mjs'), 'utf8');
      assert.match(wrapper, /runArtifactCommand/);
      await readFile(path.join(pluginRoot, 'skills', name, 'scripts/artifact.mjs'));
    } else {
      assert.doesNotMatch(text, /built-in\s+`?check|codex-artifact/i);
      assert.doesNotMatch(text, /annotation panel|Send to agent|worker-status/i);
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
      await writeFile(path.join(temporaryBuild, 'assets.mjs'), 'export async function buildPluginAssets() { throw new Error("Assets must not build before refusing changed user output."); }\n');
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
