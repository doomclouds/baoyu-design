import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const source = new URL('../source/scripts/artifact-command.mjs', import.meta.url).href;

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-command-boundary-'));
  const skill = path.join(temporary, 'codex-design'), marker = path.join(temporary, 'upstream-called');
  await mkdir(path.join(skill, 'scripts'), { recursive: true });
  await writeFile(path.join(skill, 'scripts/artifact.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'called');console.log(JSON.stringify({args:process.argv.slice(2)}));`);
  const launcher = path.join(temporary, 'launcher.mjs');
  await writeFile(launcher, `import {runArtifactCommand} from ${JSON.stringify(source)};await runArtifactCommand(${JSON.stringify(skill)},process.argv.slice(2));`);
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(temporary, { recursive: true, force: true });
  });
  return { marker, invoke: args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { windowsHide: true, shell: false,
      cwd: temporary, env: { ...process.env, CODEX_THREAD_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  }) };
}

test('unadvertised raw sharing, folder archive and LAN flags cannot run the upstream CLI', async t => {
  const f = await fixture(t);
  for (const args of [['share', 'unused-root'], ['archive', 'unused-root'], ['open-service', 'unused-root', '--lan'], ['serve-service', 'unused-root', '--lan=true'], ['preview', 'unused-root', '--lan']]) {
    const result = await f.invoke(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(JSON.parse(result.stderr).error, 'UNSUPPORTED_NATIVE_WORKFLOW');
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
  }
});

test('ordinary read commands still delegate to the existing upstream CLI', async t => {
  const f = await fixture(t);
  const result = await f.invoke(['list']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['list'] });
  assert.equal(await readFile(f.marker, 'utf8'), 'called');
});
