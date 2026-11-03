import { spawn } from 'node:child_process';

// Exercise the real artifact service in its own process; closing one test server must
// not install process signal handlers or terminate the Node test runner.
export async function startArtifactServer(script, root, { port = 0, native = process.env.CODEX_DESIGN_NATIVE_SESSION === '1' } = {}) {
  const args = [script, ...(/(?:^|[/\\])artifact\.mjs$/.test(script) ? ['serve', root] : [root]), ...(port === null ? [] : ['--port', String(port)]), '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, CODEX_DESIGN_NATIVE_SESSION: native ? '1' : '' },
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const closed = new Promise(resolve => child.once('close', resolve));
  const close = async () => { child.kill(); await closed; };
  try {
    const state = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Artifact server did not start: ${stderr}`)), 10_000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`Artifact server exited ${code}: ${stderr}`)));
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        let value; try { value = JSON.parse(stdout); } catch { return; }
        if (!value.url) return;
        clearTimeout(timer); resolve(value);
      });
    });
    return { ...state, close };
  } catch (error) { await close(); throw error; }
}
