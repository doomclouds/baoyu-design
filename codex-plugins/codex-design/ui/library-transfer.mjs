const FORMAT = 'codex-design-artifact';
const KINDS = new Set(['slides', 'design', 'design-system', 'dashboard']);
export const MAX_UI_BUNDLE_BYTES = 16 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const bytes = value => new TextEncoder().encode(value).byteLength;

function contentPath(kind, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || relative.startsWith('/')
    || /[\\\u0000-\u001f\u007f:%]/.test(relative)) throw fail('INVALID_BUNDLE', 'The package contains an unsafe path.');
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.trimEnd() !== part
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('INVALID_BUNDLE', 'The package contains an unsafe path.');
  if (parts.some(part => ['comments.json', 'node_modules', '_state', '_trash'].includes(part)
    || part.startsWith('.') && part !== '.image-slots.state.json')) return false;
  if (kind !== 'dashboard') return parts[0] === 'project' && parts.length > 1;
  return parts[0] === '_blobs' && parts.length === 2
    || parts[0] === 'db' && parts.length >= 3 && ['files', 'datasets'].includes(parts[1])
    || /^db\/dash\/(?:meta|params|look)\.json$/.test(relative);
}

/** Retain only portable artwork content; the server performs native-format validation. */
export function portableBundle(input, { maxBytes = MAX_UI_BUNDLE_BYTES } = {}) {
  let bundle = input;
  if (typeof input === 'string') {
    if (bytes(input) > maxBytes) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
    try { bundle = JSON.parse(input); } catch { throw fail('INVALID_BUNDLE', 'Choose a Codex Design artwork package.'); }
  }
  if (!bundle || bundle.format !== FORMAT || bundle.version !== 1 || !KINDS.has(bundle.kind)
    || typeof bundle.title !== 'string' || !bundle.title.trim() || bundle.title.length > 200
    || /[\u0000-\u001f\u007f]/.test(bundle.title) || !Array.isArray(bundle.files) || bundle.files.length > 2048) {
    throw fail('INVALID_BUNDLE', 'Choose a supported Codex Design artwork package.');
  }
  const files = [], seen = new Set(); let totalBytes = 0;
  for (const file of bundle.files) {
    if (!contentPath(bundle.kind, file?.path)) continue;
    const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key) || file.encoding !== 'base64' || typeof file.data !== 'string'
      || file.data.length % 4 || /[^A-Za-z0-9+/=]/.test(file.data)) {
      throw fail('INVALID_BUNDLE', 'The package contains invalid or repeated content.');
    }
    const padding = file.data.indexOf('=');
    if (padding >= 0 && (padding < file.data.length - 2 || !/^={1,2}$/.test(file.data.slice(padding)))) throw fail('INVALID_BUNDLE', 'The package contains invalid content encoding.');
    seen.add(key);
    const size = file.data.length * 3 / 4 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
    totalBytes += size;
    if (size > 32 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
    files.push({ path: file.path, encoding: 'base64', data: file.data });
  }
  const portable = { format: FORMAT, version: 1, kind: bundle.kind, title: bundle.title.trim(), files };
  if (!files.length) throw fail('INVALID_BUNDLE', 'The package contains no artwork files.');
  if (bytes(JSON.stringify(portable)) > maxBytes) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
  return portable;
}

export function packageFilename(title) {
  let stem = String(title || 'Artwork').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/g, '').slice(0, 100);
  if (!stem || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = 'Artwork';
  return stem + '.codexdesign.json';
}

export function pickArtworkFile({ document = globalThis.document, window = globalThis.window } = {}) {
  if (!document?.body) return Promise.reject(fail('FILE_READ_FAILED', 'The file picker is not available.'));
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.codexdesign.json,application/json'; input.hidden = true;
    let settled = false, focusTimer;
    const finish = file => {
      if (settled) return; settled = true;
      clearTimeout(focusTimer); window?.removeEventListener('focus', focus);
      input.remove(); resolve(file || null);
    };
    const focus = () => { focusTimer = setTimeout(() => finish(input.files?.[0]), 300); };
    input.addEventListener('change', () => finish(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    window?.addEventListener('focus', focus, { once: true });
    document.body.append(input); input.click();
  });
}

export async function downloadArtwork({ filename, text }, { document = globalThis.document, URL = globalThis.URL, Blob = globalThis.Blob } = {}) {
  if (!document?.body || typeof URL?.createObjectURL !== 'function' || typeof Blob !== 'function') throw fail('DOWNLOAD_UNAVAILABLE', 'Artwork download is not available.');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.hidden = true;
  document.body.append(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

/** UI-owned transfer controller: no file paths, chat messages, or model calls. */
export function createLibraryTransfer({ invoke, pickFile = pickArtworkFile, download = downloadArtwork,
  onImported, onRestored, maxBundleBytes = MAX_UI_BUNDLE_BYTES } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('A library invocation function is required.');
  return {
    async importArtifact(file) {
      file ??= await pickFile();
      if (!file) return null;
      if (typeof file.text !== 'function' || !Number.isFinite(file.size) || file.size < 0) throw fail('FILE_READ_FAILED', 'The selected file could not be read.');
      if (file.size > maxBundleBytes) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
      let text;
      try { text = await file.text(); } catch { throw fail('FILE_READ_FAILED', 'The selected file could not be read.'); }
      const bundle = portableBundle(text, { maxBytes: maxBundleBytes });
      const artifact = await invoke('library.importArtifact', { bundle });
      await onImported?.(artifact);
      return artifact;
    },
    async exportArtifact(id, title) {
      const bundle = portableBundle(await invoke('library.exportArtifact', { id }), { maxBytes: maxBundleBytes });
      const text = JSON.stringify(bundle), filename = packageFilename(title || bundle.title);
      const saved = await download({ filename, text });
      return { filename: saved?.saved === true ? saved.filename : filename, bytes: bytes(text), bundle,
        ...(saved?.saved === true && typeof saved.path === 'string' ? { path: saved.path } : {}) };
    },
    listSnapshots(id) { return invoke('library.listSnapshots', { id }); },
    createSnapshot(id, label) { return invoke('library.snapshot', { id, ...(label ? { label } : {}) }); },
    async restoreSnapshot(id, snapshotId) {
      // A mistaken restore remains reversible without exporting comments or chat state.
      await invoke('library.snapshot', { id, label: 'Before restore' });
      const artifact = await invoke('library.restoreSnapshot', { id, snapshotId });
      await onRestored?.(artifact);
      return artifact;
    },
  };
}
