import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryError, artifactKind, relativePath, safePath, readBytes, statOrNull, within } from './safety.mjs';

export const INDEX_FILES = Object.freeze({ slides: 'project/deck.json', design: 'project/canvas.json', 'design-system': 'project/design-system.json', dashboard: 'db/dash/meta.json', motion: 'db/film/meta.json' });
export const DEFAULT_LIMITS = Object.freeze({ maxFiles: 2048, maxFileBytes: 32 * 1024 * 1024, maxMotionFileBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, maxBundleBytes: 180 * 1024 * 1024 });
export const contentFileLimit = (kind, limits) => kind === 'motion' ? limits.maxMotionFileBytes ?? limits.maxFileBytes : limits.maxFileBytes;
const forbidden = part => ['comments.json', 'node_modules', '_state', '_trash'].includes(part) || (part.startsWith('.') && part !== '.image-slots.state.json');
export function contentPath(kind, relative) {
  relativePath(relative); artifactKind(kind);
  const parts = relative.split('/');
  if (parts.some(forbidden)) return false;
  if (kind === 'motion') return /^db\/(?:film|modules|assets)\/[A-Za-z0-9][A-Za-z0-9_.~\-]{0,99}\.json$/.test(relative) || /^_blobs\/[a-f0-9]{32}(?:\.json)?$/.test(relative) || /^src\/.+\.(?:[cm]?js|jsx|tsx?|css|html?|json|md|txt|svg|csv|tsv)$/i.test(relative);
  if (kind !== 'dashboard') return parts[0] === 'project' && parts.length > 1;
  return parts[0] === '_blobs' && parts.length === 2 || parts[0] === 'db' && parts.length >= 3 && ['files', 'datasets'].includes(parts[1]) || /^db\/dash\/(?:meta|params|look)\.json$/.test(relative);
}
export function contentType(relative) {
  const ext = path.extname(relative).toLowerCase();
  return ({ '.html': 'text/html', '.md': 'text/markdown', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.srt': 'application/x-subrip', '.vtt': 'text/vtt' })[ext] || 'application/octet-stream';
}
export async function collectContent(root, kind, limits = DEFAULT_LIMITS, { includeBytes = true } = {}) {
  const found = []; let total = 0;
  const maxFileBytes = contentFileLimit(kind, limits);
  const walk = async (relative) => {
    const absolute = await safePath(root, relative, { mustExist: false });
    const info = await statOrNull(absolute);
    if (!info) return;
    if (info.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'A content path is a symbolic link.');
    if (info.isDirectory()) {
      for (const entry of (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (forbidden(entry.name)) continue;
        const child = relative + '/' + entry.name;
        relativePath(child);
        if (entry.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'A content path is a symbolic link.', { path: child });
        await walk(child);
      }
    } else if (info.isFile() && contentPath(kind, relative)) {
      if (info.size > maxFileBytes || total + info.size > limits.maxTotalBytes || found.length >= limits.maxFiles) throw new LibraryError('LIMIT_EXCEEDED', 'The artifact exceeds the configured content limits.');
      total += info.size;
      found.push({ path: relative, bytes: info.size, contentType: contentType(relative), modifiedAt: info.mtime.toISOString(), ...(includeBytes ? { data: (await readBytes(root, relative, maxFileBytes)).toString('base64'), encoding: 'base64' } : {}) });
    } else if (!info.isFile()) throw new LibraryError('INVALID_CONTENT', 'Only regular files are accepted as content.');
  };
  const roots = kind === 'motion' ? ['db/film', 'db/modules', 'db/assets', '_blobs', 'src'] : kind === 'dashboard' ? ['db/files', 'db/datasets', 'db/dash/meta.json', 'db/dash/params.json', 'db/dash/look.json', '_blobs'] : ['project'];
  for (const start of roots) await walk(start);
  return found;
}
export function validateFiles(kind, files) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const json = relative => {
    const file = byPath.get(relative);
    if (!file) throw new LibraryError('MISSING_CONTENT', 'A required native content file is missing.', { path: relative });
    try { const value = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new LibraryError('INVALID_CONTENT', 'A native index is not a JSON object.', { path: relative }); }
  };
  const index = json(INDEX_FILES[kind]);
  if (typeof index.title !== 'string' || !index.title.trim()) throw new LibraryError('INVALID_CONTENT', 'The native index needs a title.');
  const blobExists = id => ['dashboard', 'motion'].includes(kind) ? byPath.has('_blobs/' + id) : [...byPath.keys()].some(name => name.startsWith((kind === 'design-system' ? 'project/_blobs/' : 'project/assets/') + id + '.'));
  for (const file of files) if (/\.(?:html|css|js|mjs|json|md|svg)$/i.test(file.path) && !(kind === 'motion' && file.path.startsWith('src/'))) {
    const text = Buffer.from(file.data, 'base64').toString('utf8');
    for (const match of text.matchAll(/\/_blob\/([a-f0-9]{32})\b/g)) if (!blobExists(match[1])) throw new LibraryError('MISSING_CONTENT', 'An artwork material referenced by the content is missing.', { path: file.path, blobId: match[1] });
  }
  if (kind === 'slides') {
    if (!Array.isArray(index.order)) throw new LibraryError('INVALID_CONTENT', 'A deck needs an order array.');
    for (const id of index.order) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !byPath.has('project/slides/' + id + '.html')) throw new LibraryError('MISSING_CONTENT', 'A slide named by the index is missing or invalid.'); }
  } else if (kind === 'design') {
    if (!index.boards || typeof index.boards !== 'object' || Array.isArray(index.boards) || !Array.isArray(index.order)) throw new LibraryError('INVALID_CONTENT', 'A canvas needs boards and order.');
    for (const name of Object.keys(index.boards)) { relativePath(name); if (!name.endsWith('.dc.html') || !byPath.has('project/' + name)) throw new LibraryError('MISSING_CONTENT', 'An indexed artboard is missing.'); }
  } else if (kind === 'design-system') {
    if (index.v < 3 || index.layout !== 'files' || !(index.createdOnFiles || index.convertedFrom)) throw new LibraryError('INVALID_CONTENT', 'The design-system index is not in the editable files format.');
    const tokens = json('project/tokens.json');
    for (const font of tokens.type?.fonts || []) if (typeof font.file === 'string') { const name = 'project/' + relativePath(font.file); if (!byPath.has(name)) throw new LibraryError('MISSING_CONTENT', 'A design-system font file is missing.', { path: name }); }
  } else if (kind === 'motion') {
    if (index.v !== 1 || Array.from(index.title).length > 120) throw new LibraryError('INVALID_CONTENT', 'A Motion film needs v: 1 and a title of at most 120 characters.');
    const script = json('db/film/script.json');
    if (typeof script.code !== 'string' || !script.code.trim()) throw new LibraryError('INVALID_CONTENT', 'A Motion film needs film/script code.');
    for (const file of files.filter(file => /^db\/(?:modules|assets)\//.test(file.path))) {
      const document = json(file.path);
      if (file.path.startsWith('db/modules/') && (typeof document.text !== 'string' || document.kind !== undefined && !['css', 'html', 'js', 'json', 'text'].includes(document.kind))) throw new LibraryError('INVALID_CONTENT', 'A Motion module needs text and a supported kind.', { path: file.path });
      if (file.path.startsWith('db/assets/') && (typeof document.ref !== 'string' || typeof document.mime !== 'string')) throw new LibraryError('INVALID_CONTENT', 'A Motion asset needs a ref and mime.', { path: file.path });
    }
  } else {
    const page = json('db/files/index.html.json');
    if (typeof page.text !== 'string') throw new LibraryError('INVALID_CONTENT', 'A dashboard needs files/index.html text.');
    for (const file of files.filter(file => /^db\/datasets\/.+\.json$/.test(file.path))) {
      const dataset = json(file.path);
      const id = /^\/_blob\/([a-f0-9]{32})$/.exec(dataset.source?.url || '')?.[1];
      if (id && !byPath.has('_blobs/' + id)) throw new LibraryError('MISSING_CONTENT', 'A dashboard dataset attachment is missing.');
    }
  }
  return index;
}
export async function writeContent(root, files) {
  for (const file of files) {
    const absolute = await safePath(root, file.path, { mustExist: false });
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await safePath(root, file.path, { mustExist: false });
    await fs.writeFile(within(root, absolute), Buffer.from(file.data, 'base64'), { flag: 'wx' });
  }
}
const entry = (file, value) => ({ path: file, encoding: 'base64', data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n').toString('base64') });
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function blankContent(kind, title, at) {
  const marker = { v: 1, at };
  if (kind === 'motion') return [entry('db/film/meta.json', { v: 1, title, updatedAt: at }), entry('db/film/script.json', { code: 'window.CUT = { width: 1280, height: 720, fps: 30, duration: 3, background: "#fafaf8", init() {}, render() {} };\n' })];
  if (kind === 'slides') return [entry('project/deck.json', { v: 4, createdOnFiles: marker, lists: 'css', title, order: ['cover'], cover: 'cover', sections: {}, faces: {}, designSystems: [] }), entry('project/slides/cover.html', '<section id="cover" style="background:#ffffff;color:#20211f;font-family:Arial,sans-serif;padding:128px;display:flex;flex-direction:column;gap:32px"></section>\n')];
  if (kind === 'design') return [entry('project/canvas.json', { v: 3, createdOnFiles: marker, title, launch: { view: 'canvas' }, pages: [], boards: {}, order: [], notes: {}, designSystems: [] })];
  if (kind === 'design-system') return [
    entry('project/design-system.json', { v: 3, layout: 'files', createdOnFiles: marker, title, namespace: 'DesignSystem', libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { readme: 'project/README.md', sections: [] } }),
    entry('project/tokens.json', { name: title, version: 1, color: { themes: [{ id: 'light', name: 'Light' }], tokens: [] }, type: { fonts: [], families: { sans: 'Arial, sans-serif' }, groups: [] }, spacing: { tokens: [] }, radius: { tokens: [] } }),
    entry('project/README.md', '# ' + title + '\n'), entry('project/components/Cover/preview.html', '<!-- @dsCard group="Overview" height=160 -->\n<div style="min-height:120px"></div>\n'),
  ];
  return [entry('db/dash/meta.json', { title }), entry('db/dash/params.json', {}), entry('db/files/index.html.json', { text: '<meta name="dash-one-writer"><style>#dash-root{color:#20211f;background:#fafaf8;font-family:Arial,sans-serif}#dash-root .library-blank-title{color:#20211f;font-size:28px;font-weight:500}</style><h1 class="library-blank-title">' + escape(title) + '</h1>' })];
}
