import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLibraryStore } from '../library/index.mjs';
import { UUID } from '../library/safety.mjs';
import { BridgeError, readJson, samePath } from './bridge-core.mjs';

export function artworkAppUrl(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new BridgeError('INVALID_ARTIFACT_ID', 'A library artwork UUID is required.');
  const url = new URL('codex://plugins/codex-design@codex-design-marketplace/app/DesignLibrary');
  url.searchParams.set('path', `/artifacts/${id.toLowerCase()}`);
  return url.href;
}

/** Read existing metadata only. Checking/opening never imports or repairs a folder. */
export function nativeArtworkForRoot(root, kind, { libraryRoot = createLibraryStore().root } = {}) {
  const candidateLibrary = path.dirname(path.dirname(root));
  if (!samePath(candidateLibrary, libraryRoot)) return null;
  const fail = () => new BridgeError('INVALID_LIBRARY_ARTIFACT', 'This folder does not have valid active artwork metadata for this skill. Its files were preserved.');
  const id = path.basename(root).toLowerCase();
  try {
    if (!UUID.test(id) || path.basename(path.dirname(root)) !== kind) throw fail();
    for (const directory of [root, path.dirname(root), libraryRoot, path.join(libraryRoot, '_state')]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    }
    for (const filename of [path.join(root, 'artifact.json'), path.join(libraryRoot, '_state/library.json')]) {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail();
    }
    const manifest = readJson(path.join(root, 'artifact.json'));
    const identity = readJson(path.join(libraryRoot, '_state/library.json'));
    if (manifest?.formatVersion !== 1 || manifest.id !== id || manifest.kind !== kind || manifest.deletedAt
      || identity?.version !== 1 || !UUID.test(identity.id)) throw fail();
    const catalog = readJson(path.join(libraryRoot, '_state/catalog.json'));
    const record = catalog?.artifacts?.[id];
    if (record && (record.kind !== kind || record.location !== 'active')) throw fail();
    return { id, kind, title: manifest.title, root, appUrl: artworkAppUrl(id) };
  } catch { throw fail(); }
}

/** The OS request is deliberately separate from proof of a rendered app view. */
export function requestAppNavigation(appUrl, { platform = process.platform, env = process.env, spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  const url = new URL(appUrl);
  const route = /^\/artifacts\/(.+)$/.exec(url.searchParams.get('path') || '');
  if (url.protocol !== 'codex:' || url.hostname !== 'plugins'
    || url.pathname !== '/codex-design@codex-design-marketplace/app/DesignLibrary'
    || url.username || url.password || url.port || url.hash || url.searchParams.size !== 1 || [...url.searchParams.keys()].some(key => key !== 'path')
    || !route || !UUID.test(route[1])) throw new BridgeError('INVALID_APP_URL', 'Only the official Codex Design artwork entrypoint can be opened.');
  // The host deduplicates identical app-relative targets independently of our
  // artwork tabs. Give each explicit open a fresh navigation target so a closed
  // internal tab can reopen; the artwork identity and returned appUrl stay stable.
  url.searchParams.set('path', `/artifacts/${route[1]}?openRequest=${randomUUID()}`);
  let command, args, environment = env;
  if (platform === 'win32') {
    command = env.SystemRoot ? path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    // The URI is data in an environment variable, never PowerShell source or
    // cmd.exe input. In particular, percent-encoded artifact routes stay literal.
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:CODEX_DESIGN_OPEN_URI -ErrorAction Stop'];
    environment = { ...env, CODEX_DESIGN_OPEN_URI: url.href };
  } else if (platform === 'darwin') { command = '/usr/bin/open'; args = [url.href]; }
  else if (platform === 'linux') { command = 'xdg-open'; args = [url.href]; }
  else throw new BridgeError('APP_NAVIGATION_UNAVAILABLE', 'This platform cannot request native app navigation. Open appUrl in Codex manually.');
  return new Promise((resolve, reject) => {
    let settled = false, child, timer;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      error ? reject(error) : resolve({ navigationRequested: true, renderVerified: false });
    };
    try { child = spawnProcess(command, args, { env: environment, shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch (error) { finish(new BridgeError('APP_NAVIGATION_FAILED', `The OS did not accept the Codex navigation request: ${error.message}`)); return; }
    timer = setTimeout(() => { child.kill(); finish(new BridgeError('APP_NAVIGATION_TIMEOUT', 'The OS navigation request timed out. Open appUrl in Codex manually.')); }, timeoutMs);
    child.once('error', error => finish(new BridgeError('APP_NAVIGATION_FAILED', `The OS did not accept the Codex navigation request: ${error.message}`)));
    child.once('close', code => finish(code === 0 ? null : new BridgeError('APP_NAVIGATION_FAILED', `The OS navigation helper exited ${code}. Open appUrl in Codex manually.`)));
  });
}

const shellArgument = (value, platform = process.platform) => {
  const text = String(value);
  return platform === 'win32' ? "'" + text.replaceAll("'", "''") + "'" : "'" + text.replaceAll("'", "'\\''") + "'";
};

export function wrapperCommand(skillDir, command, root) {
  return ['node', shellArgument(path.join(skillDir, 'scripts/codex-artifact.mjs')), command, shellArgument(root)].join(' ');
}

export function libraryDeliveryRequired(skillDir, root) {
  return Object.assign(new BridgeError('NATIVE_ARTIFACT_REQUIRED', 'This folder is outside the Codex Design library. Import it explicitly for native editing, or choose preview for an independent web editor. No files were moved or copied.'), {
    nativeAvailable: false, appUrl: null, navigationRequested: false, renderVerified: false,
    next: `For an explicitly requested web preview: ${wrapperCommand(skillDir, 'preview', root)}.`,
  });
}

export async function openArtworkInApp(skillDir, root, kind, { libraryRoot, navigate = requestAppNavigation } = {}) {
  const artwork = nativeArtworkForRoot(root, kind, { libraryRoot });
  if (!artwork) throw libraryDeliveryRequired(skillDir, root);
  try {
    const navigation = await navigate(artwork.appUrl);
    if (navigation?.navigationRequested === false) throw new BridgeError('APP_NAVIGATION_FAILED', 'The OS did not accept the native artwork navigation request.');
    return { ...artwork, navigationRequested: true, renderVerified: false,
      next: 'The OS navigation request was accepted. This does not verify that Codex rendered the artwork; verify its native artwork tab.' };
  } catch (error) { throw Object.assign(error, { appUrl: artwork.appUrl, navigationRequested: false, renderVerified: false }); }
}

export function checkedArtworkDelivery(result, { skillDir, root, kind, libraryRoot } = {}) {
  const artwork = nativeArtworkForRoot(root, kind, { libraryRoot });
  const valid = Number(result.problems) === 0;
  const next = valid
    ? artwork ? `Open this artwork in Codex Design: ${wrapperCommand(skillDir, 'open', root)}. Deliver appUrl, not the internal data-service URL. Structural checks do not verify the rendered editor.`
      : libraryDeliveryRequired(skillDir, root).next + ' Native opening requires an explicit import into the library.'
    : `Fix the reported problems, notes and warnings, then rerun ${wrapperCommand(skillDir, 'check', root)}. Files and diagnostics are preserved below.`;
  const output = { ...result, nativeAvailable: Boolean(artwork), appUrl: artwork?.appUrl ?? null, navigationRequested: false, next };
  if (kind === 'dashboard') {
    output.notChecked = 'This command does not render the dashboard. Verify charts, values and interactions in its native Codex Design editor, then rerun check to read any runtime pageCheck result.';
    if (output.pageCheck?.status === null && output.pageCheck.note) output.pageCheck = { ...output.pageCheck,
      note: 'No runtime page-check result is available. Open the native artwork tab and rerun check after its page has loaded; a missing result is not proof that rendering passed.' };
  }
  return output;
}

export function normalizeControlHints(result, script, skillDir, root = result?.root) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const output = { ...result };
  if (typeof root !== 'string') return output;
  // Match the canonical emitter's exact script/root argv, rather than treating
  // JSON or POSIX quoting as valid PowerShell escaping. User data is not scanned.
  const canonical = value => /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  for (const key of ['next', 'stop']) {
    if (typeof output[key] !== 'string') continue;
    for (const encodedScript of new Set([canonical(script), JSON.stringify(script)])) {
      const prefix = 'node ' + encodedScript + ' ';
      const start = output[key].indexOf(prefix);
      if (start < 0) continue;
      const command = /^[a-z][a-z-]*/.exec(output[key].slice(start + prefix.length))?.[0];
      if (!command) continue;
      for (const encodedRoot of new Set([canonical(root), JSON.stringify(root)])) {
        const original = prefix + command + ' ' + encodedRoot;
        if (output[key].includes(original)) output[key] = output[key].split(original).join(wrapperCommand(skillDir, command, root));
      }
    }
  }
  return output;
}
