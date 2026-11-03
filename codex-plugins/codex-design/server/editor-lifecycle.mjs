import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, samePath } from '../scripts/bridge-core.mjs';
import { editorInstanceStopped } from '../scripts/artifact-command.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });

/** Stop only the selected artwork through the CLI's live editor identity guard. */
export async function stopLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 15_000 } = {}) {
  const stateFile = path.join(record.path, '.artifact-server.json');
  if (!fs.existsSync(stateFile)) return { stopped: false };
  const state = readJson(stateFile);
  if (!state || state.kind !== record.kind || !samePath(state.root, record.path)) {
    throw failure('EDITOR_IDENTITY_UNVERIFIED', 'The selected artwork editor record is invalid. Its process and files were preserved.');
  }
  const cli = path.join(pluginRoot, 'skills', `codex-${record.kind}`, 'scripts', 'codex-artifact.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'stop', record.path], {
      cwd: pluginRoot, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65_536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
    const timer = setTimeout(() => {
      child.kill();
      finish(failure('EDITOR_STOP_TIMEOUT', 'The selected editor did not finish stopping. Artwork files were not moved.'));
    }, timeoutMs);
    child.once('error', error => finish(failure('EDITOR_STOP_FAILED', error.message)));
    child.once('close', async code => {
      if (finished) return;
      if (code !== 0) {
        let detail;
        try { detail = JSON.parse(stderr.trim().split(/\r?\n/).at(-1)); } catch { /* Keep the bounded error below. */ }
        return finish(failure(detail?.error || 'EDITOR_STOP_FAILED', detail?.message || stderr.trim().slice(-2_000) || `Editor stop exited ${code}.`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (fs.existsSync(stateFile) || !await editorInstanceStopped(state, record.path, record.kind)) return finish(failure('EDITOR_STOP_FAILED', 'The verified editor is still running. Artwork files were not moved.'));
        finish(null, result);
      }
      catch { finish(failure('EDITOR_STOP_FAILED', 'The selected editor stop returned invalid data. Artwork files were not moved.')); }
    });
  });
}
