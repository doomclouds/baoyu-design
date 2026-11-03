const FORMAT = 'codex-design-artifact';
const KINDS = new Set(['slides', 'design', 'design-system', 'dashboard', 'motion']);
export const MAX_UI_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_NATIVE_BUNDLE_BYTES = 180 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 768 * 1024;
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
  if (kind === 'motion') return /^db\/(?:film|modules|assets)\/[A-Za-z0-9][A-Za-z0-9_.~\-]{0,99}\.json$/.test(relative) || /^_blobs\/[a-f0-9]{32}(?:\.json)?$/.test(relative) || /^src\/.+\.(?:[cm]?js|jsx|tsx?|css|html?|json|md|txt|svg|csv|tsv)$/i.test(relative);
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
    if (size > (bundle.kind === 'motion' ? 64 : 32) * 1024 * 1024 || totalBytes > 128 * 1024 * 1024) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
    files.push({ path: file.path, encoding: 'base64', data: file.data });
  }
  const portable = { format: FORMAT, version: 1, kind: bundle.kind, title: bundle.title.trim(), files };
  if (!files.length) throw fail('INVALID_BUNDLE', 'The package contains no artwork files.');
  if (bytes(JSON.stringify(portable)) > maxBytes) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
  return portable;
}

export function packageFilename(title) {
  let stem = Array.from(String(title || 'Artwork').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().replace(/[. ]+$/g, '')).slice(0, 100).join('');
  while (bytes(stem + '.codexdesign.json') > 220) stem = Array.from(stem).slice(0, -1).join('');
  stem = stem.replace(/[. ]+$/g, '');
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
export function createLibraryTransfer({ invoke, pickFile = pickArtworkFile, download = downloadArtwork, downloadResource,
  onImported, onRestored, maxBundleBytes = MAX_UI_BUNDLE_BYTES,
  maxImportBytes = maxBundleBytes === MAX_UI_BUNDLE_BYTES ? MAX_NATIVE_BUNDLE_BYTES : maxBundleBytes } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('A library invocation function is required.');
  const upload = async file => {
    let transferId;
    try {
      const started = await invoke('library.transfer', { operation: 'start', bytes: file.size });
      transferId = started?.transferId;
      if (typeof transferId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transferId) || started.offset !== 0) throw fail('FILE_READ_FAILED', 'The package upload could not be started.');
      for (let offset = 0; offset < file.size;) {
        const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + UPLOAD_CHUNK_BYTES)).arrayBuffer());
        if (!chunk.byteLength || chunk.byteLength > UPLOAD_CHUNK_BYTES) throw fail('FILE_READ_FAILED', 'The selected package could not be read completely.');
        let binary = '';
        for (let at = 0; at < chunk.length; at += 16_384) binary += String.fromCharCode(...chunk.subarray(at, at + 16_384));
        const written = await invoke('library.transfer', { operation: 'write', transferId, offset, base64: btoa(binary) });
        offset += chunk.byteLength;
        if (written?.transferId !== transferId || written.offset !== offset) throw fail('FILE_READ_FAILED', 'The package upload offset could not be confirmed.');
      }
      return await invoke('library.transfer', { operation: 'finish', transferId });
    } catch (error) {
      if (transferId) await invoke('library.transfer', { operation: 'cancel', transferId }).catch(() => {});
      throw error;
    }
  };
  return {
    async importArtifact(file) {
      file ??= await pickFile();
      if (!file) return null;
      if (typeof file.text !== 'function' || !Number.isFinite(file.size) || file.size < 0) throw fail('FILE_READ_FAILED', 'The selected file could not be read.');
      if (file.size > maxImportBytes) throw fail('TRANSFER_TOO_LARGE', 'The artwork package exceeds the transfer size limit.');
      if (file.size > maxBundleBytes) {
        if (typeof file.slice !== 'function') throw fail('TRANSFER_TOO_LARGE', 'This host cannot upload a large artwork package.');
        const artifact = await upload(file);
        await onImported?.(artifact);
        return artifact;
      }
      let text;
      try { text = await file.text(); } catch { throw fail('FILE_READ_FAILED', 'The selected file could not be read.'); }
      const bundle = portableBundle(text, { maxBytes: maxBundleBytes });
      const artifact = await invoke('library.importArtifact', { bundle });
      await onImported?.(artifact);
      return artifact;
    },
    async exportArtifact(id, title, { kind } = {}) {
      if (kind === 'motion' && typeof downloadResource === 'function') {
        const resource = await invoke('library.exportArtifact', { id, asFile: true });
        if (!resource || resource.artifactId !== id || resource.mimeType !== 'application/json' || typeof resource.exportToken !== 'string'
          || !Number.isSafeInteger(resource.bytes) || resource.bytes < 1 || resource.bytes > maxImportBytes) throw fail('INVALID_BUNDLE', 'The exported artwork package could not be confirmed.');
        const saved = await downloadResource(resource);
        if (saved?.saved !== true || typeof saved.path !== 'string' || !saved.path) throw fail('DOWNLOAD_UNCONFIRMED', 'The package save result could not be confirmed.');
        return { filename: saved.filename || resource.filename, bytes: resource.bytes, path: saved.path };
      }
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
