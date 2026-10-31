// Read-only verification through Codex's real app-server skill discovery.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { resolveCodexRunner } from './source/scripts/bridge-core.mjs';

const cwd = path.resolve(process.argv[2] || process.cwd());
const runner = resolveCodexRunner();
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
  const initialized = await rpc('initialize', { clientInfo: { name: 'codex-design-verifier', version: '0.1.0' } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  const result = await rpc('skills/list', { cwds: [cwd], forceReload: true });
  const expected = ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard', 'codex-dataviz']
    .map(name => `codex-design:${name}`);
  const entries = result.data?.find(entry => path.resolve(entry.cwd).toLowerCase() === cwd.toLowerCase());
  if (!entries) throw new Error('Codex did not return skill discovery for the requested workspace.');
  const skills = entries.skills.filter(skill => expected.includes(skill.name) && /[\\/]plugins[\\/]cache[\\/]codex-design-marketplace[\\/]codex-design[\\/]/i.test(skill.path));
  for (const name of expected) {
    if (!skills.some(skill => skill.name === name && skill.enabled !== false)) {
      const candidates = entries.skills.filter(skill => /codex-design-marketplace|codex-(?:slides|design|dashboard|dataviz)/i.test(`${skill.name} ${skill.path}`))
        .map(({ name, path, enabled, scope }) => ({ name, path, enabled, scope }));
      throw new Error(`Installed plugin skill was not enabled in Codex: ${name}; discovery: ${JSON.stringify({ candidates, errors: entries.errors })}`);
    }
  }
  const errors = (entries.errors || []).filter(error => /codex-design/i.test(JSON.stringify(error)));
  if (errors.length) throw new Error(`Installed plugin skill diagnostics: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ verified: true, codex: initialized.userAgent ?? null, cwd,
    skills: skills.map(({ name, path: skillPath, enabled, scope }) => ({ name, path: skillPath, enabled, scope })), errors }, null, 2));
} finally {
  for (const call of pending.values()) clearTimeout(call.timer);
  lines.close();
  child.stdin.end();
  child.kill();
}
