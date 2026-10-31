import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibraryStore } from '../library/index.mjs';
import { safePath } from '../library/safety.mjs';
import { startLibraryPreview, libraryPreviewStatus, stopLibraryPreview } from '../server/http-preview.mjs';

function parse(argv) {
  const [command = 'help', ...arguments_] = argv; const options = {};
  for (let i = 0; i < arguments_.length; i++) {
    const match = /^--(root|plugin-root|port)(?:=(.*))?$/.exec(arguments_[i]);
    if (!match) throw new Error('Use --root, --plugin-root, or --port.');
    const value = match[2] ?? arguments_[++i]; if (!value || value.startsWith('--')) throw new Error('Missing option value.');
    options[match[1] === 'plugin-root' ? 'pluginRoot' : match[1]] = match[1] === 'port' ? Number(value) : path.resolve(value);
  }
  return { command, options };
}
export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('codex design requires Node.js 22 or later.');
  const { command, options } = parse(argv);
  const root = options.root || createLibraryStore().root;
  if (command === 'status') { const status = await libraryPreviewStatus({ root }); const { state, ...publicStatus } = status; console.log(JSON.stringify(publicStatus, null, 2)); return; }
  if (command === 'stop') { console.log(JSON.stringify(await stopLibraryPreview({ root }), null, 2)); return; }
  if (command === 'serve') {
    const preview = await startLibraryPreview(options); console.log(JSON.stringify({ url: preview.url, root: preview.root, pid: preview.pid, mode: 'local-http-preview', nativeIntegrationVerified: false }, null, 2));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => preview.close().then(() => { process.exitCode = 0; }, cause => { console.error(cause.message); process.exitCode = 1; }));
    return;
  }
  if (command === 'open') {
    const existing = await libraryPreviewStatus({ root }); if (existing.running) { console.log(JSON.stringify({ url: existing.url, root, pid: existing.pid, reused: true }, null, 2)); return; }
    const store = createLibraryStore({ root }); await store.initialize();
    const log = await safePath(root, '_state/library-preview.log', { mustExist: false }); const fd = fs.openSync(log, 'a');
    const entrypoint = fileURLToPath(import.meta.url), childArgs = [entrypoint, 'serve', '--root', root, '--plugin-root', options.pluginRoot || fileURLToPath(new URL('../', import.meta.url)), ...(options.port === undefined ? [] : ['--port', String(options.port)])];
    const child = spawn(process.execPath, childArgs, { detached: true, windowsHide: true, shell: false, stdio: ['ignore', fd, fd] }); child.unref(); fs.closeSync(fd);
    let childError; child.once('error', cause => { childError = cause; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) { if (childError) throw childError; await new Promise(resolve => setTimeout(resolve, 150)); const status = await libraryPreviewStatus({ root }); if (status.running && status.pid === child.pid) { console.log(JSON.stringify({ url: status.url, root, pid: status.pid, log, mode: 'local-http-preview', nativeIntegrationVerified: false }, null, 2)); return; } }
    throw new Error('The preview did not finish starting; inspect ' + log + '. No unrelated process was stopped.');
  }
  console.log('Usage: node scripts/library-preview.mjs open|serve|status|stop [--root <library>] [--plugin-root <built-plugin>] [--port <number>]');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(cause => { console.error(JSON.stringify({ error: cause.code || 'LIBRARY_PREVIEW_ERROR', message: cause.message })); process.exitCode = 1; });
