// Read-only verification through Codex's real app-server skill discovery.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexRunner } from './source/scripts/bridge-core.mjs';
import { LIBRARY_UI_URI } from './source/server/contract.mjs';

const cwd = path.resolve(process.argv[2] || process.cwd());
const { version } = JSON.parse(await readFile(new URL('./source/plugin.json', import.meta.url), 'utf8'));
const runner = resolveCodexRunner({ codexPath: process.env.CODEX_APP_RUNTIME_CLI_PATH || undefined });
const child = spawn(runner.command, [...runner.args, 'app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
});
const pending = new Map();
let nextId = 0;
let stderrTail = '';
child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-8000); });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const call = pending.get(response.id);
  if (!call) return;
  pending.delete(response.id);
  clearTimeout(call.timer);
  response.error ? call.reject(new Error(JSON.stringify(response.error))) : call.resolve(response.result);
});
child.on('error', error => { for (const call of pending.values()) call.reject(error); });
child.on('exit', code => {
  for (const call of pending.values()) call.reject(new Error(`Codex app-server exited ${code}: ${stderrTail}`));
});
function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  const initialized = await rpc('initialize', { clientInfo: { name: 'codex-design-verifier', version } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const result = await rpc('skills/list', { cwds: [cwd], forceReload: true });
  const expected = ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard', 'codex-motion', 'codex-motion-director', 'codex-dataviz']
    .map(name => `codex-design:${name}`);
  const entries = result.data?.find(entry => path.resolve(entry.cwd).toLowerCase() === cwd.toLowerCase());
  if (!entries) throw new Error('Codex did not return skill discovery for the requested workspace.');
  const skills = entries.skills.filter(skill => expected.includes(skill.name) && /[\\/]plugins[\\/]cache[\\/]codex-design-marketplace[\\/]codex-design[\\/]/i.test(skill.path));
  for (const name of expected) {
    if (!skills.some(skill => skill.name === name && skill.enabled !== false)) {
      const candidates = entries.skills.filter(skill => /codex-design-marketplace|codex-(?:slides|design|dashboard|motion|dataviz)/i.test(`${skill.name} ${skill.path}`))
        .map(({ name, path, enabled, scope }) => ({ name, path, enabled, scope }));
      throw new Error(`Installed plugin skill was not enabled in Codex: ${name}; discovery: ${JSON.stringify({ candidates, errors: entries.errors })}`);
    }
  }
  const errors = (entries.errors || []).filter(error => /codex-design/i.test(JSON.stringify(error)));
  if (errors.length) throw new Error(`Installed plugin skill diagnostics: ${JSON.stringify(errors)}`);
  const pluginRoots = [...new Set(skills.map(skill => path.resolve(path.dirname(skill.path), '../..')))];
  if (pluginRoots.length !== 1) throw new Error('Codex resolved these plugin skills from different installed packages.');
  const installed = JSON.parse(await readFile(path.join(pluginRoots[0], 'plugin.json'), 'utf8'));
  if (installed.name !== 'codex-design' || installed.version !== version) throw new Error(`Expected installed codex-design ${version}, found ${installed.name} ${installed.version}.`);
  const status = await rpc('mcpServerStatus/list', { limit: 100 });
  const libraryServer = status.data?.find(server => server.pluginId === 'codex-design@codex-design-marketplace');
  if (!libraryServer || libraryServer.toolsError) throw new Error(`The installed library MCP did not load: ${JSON.stringify(libraryServer?.toolsError ?? 'missing plugin server')}`);
  const libraryTools = Object.values(libraryServer.tools || {});
  const globalEntry = libraryTools.find(tool => tool.name === 'DesignLibrary');
  if (!globalEntry?._meta?.['openai/ui']?.entrypoints?.some(entry => entry.type === 'global')) throw new Error('Codex did not discover the global library entrypoint.');
  if (globalEntry._meta.ui.resourceUri !== LIBRARY_UI_URI) throw new Error('The installed library UI resource URI is incorrect.');
  console.log(JSON.stringify({ verified: true, pluginVersion: installed.version, pluginRoot: pluginRoots[0], codex: initialized.userAgent ?? null, cwd,
    skills: skills.map(({ name, path: skillPath, enabled, scope }) => ({ name, path: skillPath, enabled, scope })),
    mcp: { name: libraryServer.name, pluginId: libraryServer.pluginId, tools: libraryTools.map(tool => tool.name), globalEntrypoint: true, toolsError: libraryServer.toolsError ?? null }, errors }, null, 2));
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  lines.close();
  child.stdin.end();
  child.kill();
}
