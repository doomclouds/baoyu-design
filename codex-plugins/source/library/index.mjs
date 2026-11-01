import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LibraryError, KINDS, UUID, artifactId, artifactKind, titleText, relativePath, within, statOrNull, safePath, readJson, atomicJson, readBytes, locked } from './safety.mjs';
import { INDEX_FILES, DEFAULT_LIMITS, contentPath, contentType, collectContent, validateFiles, writeContent, blankContent } from './content.mjs';
import { alive } from '../scripts/bridge-core.mjs';
import { WORKER_FILE, WORKER_JOBS_FILE } from '../scripts/worker-core.mjs';

export { LibraryError, KINDS };
export const BUNDLE_FORMAT = 'codex-design-artifact';
const catalogFile = '_state/catalog.json', viewFile = '_state/view.json', bindingsFile = '_state/bindings.json';
const emptyCatalog = () => ({ version: 1, artifacts: {} });
const libraryTab = () => ({ id: 'library', type: 'library' });
const emptyView = () => ({ version: 1, tabs: [libraryTab()], activeTabId: 'library' });
const at = () => new Date().toISOString();
const metadata = value => {
  if (value.formatVersion !== undefined && value.formatVersion !== 1) throw new LibraryError('UNSUPPORTED_FORMAT', 'This artifact manifest needs a supported format version.');
  return { id: artifactId(value.id), kind: artifactKind(value.kind), title: titleText(value.title), formatVersion: 1,
  createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : at(),
  updatedAt: typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : at(), favorite: value.favorite === true,
  ...(value.sourceArtifactId && UUID.test(value.sourceArtifactId) ? { sourceArtifactId: value.sourceArtifactId } : {}),
  ...(typeof value.deletedAt === 'string' ? { deletedAt: value.deletedAt } : {}),
  };
};

/** A moved trash registry may retain its exact former active root. */
export async function nativeTrashActivity(record) {
  const busy = reason => ({ busy: true, reason });
  try {
    const id = artifactId(record.id), kind = artifactKind(record.kind), root = path.resolve(record.path);
    const libraryRoot = path.dirname(path.dirname(root));
    const expected = path.join(libraryRoot, '_trash', id);
    const same = (a, b) => typeof a === 'string' && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
    if (!same(root, expected)) return busy('The trash task location cannot be verified.');
    const target = await safePath(libraryRoot, `_trash/${id}`, { mustExist: false });
    if (!await statOrNull(target)) {
      const progress = await readJson(libraryRoot, `_state/purge-progress/${id}.json`, null);
      const active = await safePath(libraryRoot, `${kind}/${id}`, { mustExist: false });
      return progress?.version === 1 && progress.artifactId === id && progress.kind === kind && !await statOrNull(active)
        ? false : busy('The missing trash task location cannot be verified.');
    }
    await safePath(libraryRoot, `_trash/${id}`, { type: 'directory' });
    const registry = await readJson(root, WORKER_FILE, null);
    const state = await readJson(root, WORKER_JOBS_FILE, { version: 1, jobs: {}, order: [] });
    if (registry && (registry.version !== 1 || registry.url || registry.token || !UUID.test(registry.nativeThreadId ?? '')
      || !same(registry.root, root) && !same(registry.root, path.join(libraryRoot, kind, id)) || !['waiting', 'paused', 'active'].includes(registry.status))) return busy('The native owner is unknown; permanent deletion was refused.');
    if (!state || state.version !== 1 || !state.jobs || typeof state.jobs !== 'object' || Array.isArray(state.jobs) || !Array.isArray(state.order)
      || Object.values(state.jobs).some(job => !job || !['pending', 'active', 'completed', 'failed', 'superseded'].includes(job.status))) return busy('The native job journal cannot be verified; permanent deletion was refused.');
    if (Object.values(state.jobs).some(job => job.status === 'active') || registry?.activeJobId || registry?.status === 'active'
      || registry?.listener && (!Number.isFinite(registry.listener.expiresAt) || !Number.isInteger(registry.listener.pid) || registry.listener.expiresAt > Date.now() && alive(registry.listener.pid))) return busy('An unfinished native job or listener still owns this artwork. Its parent must coordinate it before permanent deletion.');
    return false;
  } catch { return busy('The native task state cannot be verified; permanent deletion was refused.'); }
}

/** User data lives here independently of CODEX_HOME, plugin caches, projects, or chats. */
export class LibraryStore {
  constructor({ root = path.join(os.homedir(), '.codex', 'CodexDesignLibrary'), isBusy = async () => false, limits = {} } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new LibraryError('INVALID_PATH', 'A library root is required.');
    if (typeof isBusy !== 'function') throw new LibraryError('INVALID_OPTION', 'isBusy must be a function.');
    this.root = path.resolve(root); this.isBusy = isBusy;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new LibraryError('INVALID_OPTION', 'Content limits must be positive integers.');
  }
  async initialize() {
    if (!this.ready) this.ready = this._initialize().catch(error => { this.ready = null; throw error; });
    await this.ready; return this;
  }
  async _initialize() {
    const existing = await statOrNull(this.root);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new LibraryError('SYMLINK_REFUSED', 'The library root must be a real directory.');
    await fs.mkdir(this.root, { recursive: true });
    this.realRoot = await fs.realpath(this.root);
    for (const relative of [...KINDS, '_state', '_trash']) {
      const directory = await safePath(this.root, relative, { mustExist: false });
      await fs.mkdir(directory, { recursive: true }); await safePath(this.root, relative, { type: 'directory' });
    }
    await locked(this.root, async () => {
      let identity = await readJson(this.root, '_state/library.json', null);
      if (!identity) { identity = { version: 1, id: randomUUID(), createdAt: at() }; await atomicJson(this.root, '_state/library.json', identity); }
      if (identity.version !== 1 || !UUID.test(identity.id)) throw new LibraryError('INVALID_STATE', 'The library identity is invalid.');
      this.libraryId = identity.id;
      const catalog = await this._catalog();
      for (const kind of KINDS) {
        for (const entry of await fs.readdir(await safePath(this.root, kind, { type: 'directory' }), { withFileTypes: true })) {
          if (!UUID.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
          const relative = `${kind}/${entry.name}/artifact.json`;
          if (!await statOrNull(await safePath(this.root, relative, { mustExist: false }))) continue;
          const manifest = metadata(await readJson(this.root, relative));
          if (manifest.id !== entry.name.toLowerCase() || manifest.kind !== kind) throw new LibraryError('INVALID_MANIFEST', 'Artifact directory and identity disagree.');
          const previous = catalog.artifacts[manifest.id];
          if (previous && (previous.location === 'trash' || previous.kind !== kind) && await statOrNull(await safePath(this.root, this._relative(previous), { mustExist: false }))) throw new LibraryError('ID_CONFLICT', 'An artifact id exists in more than one physical location.');
          catalog.artifacts[manifest.id] = { ...manifest, location: 'active' };
        }
      }
      for (const entry of await fs.readdir(await safePath(this.root, '_trash', { type: 'directory' }), { withFileTypes: true })) {
        if (!UUID.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const relative = `_trash/${entry.name}/artifact.json`;
        if (!await statOrNull(await safePath(this.root, relative, { mustExist: false }))) continue;
        const manifest = metadata(await readJson(this.root, relative));
        if (manifest.id !== entry.name.toLowerCase()) throw new LibraryError('INVALID_MANIFEST', 'A recycled artifact has a different directory identity.');
        const previous = catalog.artifacts[manifest.id];
        if (previous && previous.location === 'active' && await statOrNull(await safePath(this.root, `${previous.kind}/${manifest.id}`, { mustExist: false }))) throw new LibraryError('ID_CONFLICT', 'An artifact id exists in both active storage and trash.');
        catalog.artifacts[manifest.id] = { ...manifest, location: 'trash' };
      }
      await this._saveCatalog(catalog);
      if (!await statOrNull(await safePath(this.root, viewFile, { mustExist: false }))) await atomicJson(this.root, viewFile, emptyView());
      if (!await statOrNull(await safePath(this.root, bindingsFile, { mustExist: false }))) await atomicJson(this.root, bindingsFile, { version: 1, artifacts: {} });
    });
  }
  async _checkRoot() {
    await this.initialize();
    if ((await fs.lstat(this.root)).isSymbolicLink() || await fs.realpath(this.root) !== this.realRoot) throw new LibraryError('ROOT_CHANGED', 'The library root changed after initialization.');
  }
  async _catalog() {
    const value = await readJson(this.root, catalogFile, emptyCatalog());
    if (value.version !== 1 || !value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)) throw new LibraryError('INVALID_STATE', 'The library catalog is invalid.');
    for (const [id, record] of Object.entries(value.artifacts)) { if (artifactId(id) !== record.id || !['active', 'trash'].includes(record.location)) throw new LibraryError('INVALID_STATE', 'A catalog identity is invalid.'); metadata(record); }
    return value;
  }
  _saveCatalog(catalog) { return atomicJson(this.root, catalogFile, catalog); }
  _relative(record) { return record.location === 'trash' ? `_trash/${record.id}` : `${artifactKind(record.kind)}/${artifactId(record.id)}`; }
  async _artifactPath(record, mustExist = true) { return safePath(this.root, this._relative(record), { mustExist, type: 'directory' }); }
  async _raw(id, { includeDeleted = false } = {}) {
    id = artifactId(id); const catalog = await this._catalog(); const record = catalog.artifacts[id];
    if (!record || !includeDeleted && record.location === 'trash') throw new LibraryError('NOT_FOUND', 'No such artifact.');
    return { record, catalog };
  }
  async _inspect(record) {
    const result = { ...metadata(record), path: path.join(this.root, ...this._relative(record).split('/')), contentStatus: 'ok', deleted: record.location === 'trash' };
    try {
      const root = await this._artifactPath(record);
      const manifest = metadata(await readJson(root, 'artifact.json'));
      if (manifest.id !== record.id || manifest.kind !== record.kind) throw new LibraryError('INVALID_MANIFEST', 'The artifact identity changed.');
      const listed = await collectContent(root, record.kind, this.limits, { includeBytes: false });
      const needed = new Set([INDEX_FILES[record.kind], 'project/tokens.json', 'db/files/index.html.json']);
      const files = [];
      for (const file of listed) files.push({ ...file, data: needed.has(file.path) || /\.(?:html|css|js|mjs|json|md|svg)$/i.test(file.path) ? (await readBytes(root, file.path, this.limits.maxFileBytes)).toString('base64') : '' });
      const native = validateFiles(record.kind, files);
      // The native editors write content directly. Their saves must be visible
      // to recent/sort even when no library metadata command was invoked.
      const changedAt = listed.reduce((latest, file) => file.modifiedAt > latest ? file.modifiedAt : latest, manifest.updatedAt);
      Object.assign(result, manifest, { title: native.title, updatedAt: changedAt });
    } catch (error) {
      result.contentStatus = ['NOT_FOUND', 'MISSING_CONTENT'].includes(error.code) ? 'missing' : 'invalid';
      result.contentError = { code: error.code || 'INVALID_CONTENT', message: error.message };
    }
    return result;
  }
  async _busy(record) {
    const result = await this.isBusy(await this._inspect(record));
    if (result === true || result?.busy) throw new LibraryError('ARTIFACT_BUSY', result?.reason || 'This artifact still has an active editor task. No agent was stopped.');
  }
  async list({ kind, query = '', favoritesOnly = false, includeDeleted = false } = {}) {
    await this._checkRoot(); if (kind) artifactKind(kind);
    if (typeof query !== 'string' || query.length > 500) throw new LibraryError('INVALID_QUERY', 'Search text is too long.');
    const needle = query.trim().toLocaleLowerCase(); const catalog = await this._catalog(); const records = [];
    for (const entry of Object.values(catalog.artifacts)) {
      if (kind && entry.kind !== kind || !includeDeleted && entry.location === 'trash' || favoritesOnly && !entry.favorite) continue;
      const record = await this._inspect(entry);
      if (!needle || `${record.title} ${record.kind}`.toLocaleLowerCase().includes(needle)) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  }
  async get(id, options = {}) { await this._checkRoot(); return this._inspect((await this._raw(id, options)).record); }
  async _stage() {
    const relative = `_state/staging/${randomUUID()}`; const absolute = await safePath(this.root, relative, { mustExist: false });
    await fs.mkdir(absolute, { recursive: true }); await safePath(this.root, relative, { type: 'directory' });
    return { relative, absolute };
  }
  async _removeStage(stage) {
    const absolute = await safePath(this.root, stage.relative, { mustExist: false }); within(path.join(this.root, '_state/staging'), absolute);
    await fs.rm(absolute, { recursive: true, force: true });
  }
  _retitle(kind, files, title) {
    return files.map(file => { if (file.path !== INDEX_FILES[kind]) return file; const value = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8')); value.title = title; return { ...file, data: Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64') }; });
  }
  async _create(kind, title, files, extra = {}) {
    artifactKind(kind); title = titleText(title); files = this._retitle(kind, files, title); validateFiles(kind, files);
    const manifest = metadata({ id: randomUUID(), kind, title, createdAt: at(), updatedAt: at(), favorite: false, ...extra });
    const stage = await this._stage();
    try {
      await writeContent(stage.absolute, files); await atomicJson(stage.absolute, 'artifact.json', manifest);
      const destination = await safePath(this.root, `${kind}/${manifest.id}`, { mustExist: false });
      if (await statOrNull(destination)) throw new LibraryError('ID_CONFLICT', 'The new identity already exists.');
      await fs.rename(stage.absolute, destination);
      const catalog = await this._catalog(); catalog.artifacts[manifest.id] = { ...manifest, location: 'active' }; await this._saveCatalog(catalog);
      return this._inspect(catalog.artifacts[manifest.id]);
    } finally { await this._removeStage(stage); }
  }
  async create({ kind, title = `Untitled ${kind}` } = {}) {
    await this._checkRoot(); artifactKind(kind); title = titleText(title);
    return locked(this.root, () => this._create(kind, title, blankContent(kind, title, at())));
  }
  async _updateMetadata(id, update, { touchContentTitle = false } = {}) {
    const { record, catalog } = await this._raw(id); if (touchContentTitle) await this._busy(record);
    const root = await this._artifactPath(record); const manifest = metadata(await readJson(root, 'artifact.json'));
    const next = metadata({ ...manifest, ...update, updatedAt: at() });
    if (touchContentTitle) { const index = await readJson(root, INDEX_FILES[record.kind]); index.title = next.title; await atomicJson(root, INDEX_FILES[record.kind], index); }
    await atomicJson(root, 'artifact.json', next); catalog.artifacts[id] = { ...next, location: 'active' }; await this._saveCatalog(catalog); return this._inspect(catalog.artifacts[id]);
  }
  async rename(id, title) { id = artifactId(id); title = titleText(title); await this._checkRoot(); return locked(this.root, () => this._updateMetadata(id, { title }, { touchContentTitle: true })); }
  async setFavorite(id, favorite = true) { id = artifactId(id); if (typeof favorite !== 'boolean') throw new LibraryError('INVALID_OPTION', 'favorite must be boolean.'); await this._checkRoot(); return locked(this.root, () => this._updateMetadata(id, { favorite })); }
  async _export(record) {
    await this._busy(record); const root = await this._artifactPath(record);
    const files = await collectContent(root, record.kind, this.limits); const native = validateFiles(record.kind, files);
    const bundle = { format: BUNDLE_FORMAT, version: 1, kind: record.kind, title: native.title, files: files.map(({ path, encoding, data }) => ({ path, encoding, data })) };
    if (Buffer.byteLength(JSON.stringify(bundle)) > this.limits.maxBundleBytes) throw new LibraryError('LIMIT_EXCEEDED', 'The native bundle exceeds the configured export limit.');
    return bundle;
  }
  async exportArtifact(id) { await this._checkRoot(); return locked(this.root, async () => this._export((await this._raw(id)).record)); }
  async duplicate(id, { title } = {}) { await this._checkRoot(); return locked(this.root, async () => { const { record } = await this._raw(id); const bundle = await this._export(record); return this._create(record.kind, title || bundle.title + ' copy', bundle.files, { sourceArtifactId: record.id }); }); }
  _bundle(input, kind) {
    let bundle = input;
    if (typeof bundle === 'string' || Buffer.isBuffer(bundle)) {
      if (Buffer.byteLength(bundle) > this.limits.maxBundleBytes) throw new LibraryError('LIMIT_EXCEEDED', 'The native bundle is too large.');
      try { bundle = JSON.parse(String(bundle)); } catch { throw new LibraryError('INVALID_BUNDLE', 'Expected a native library JSON bundle.'); }
    }
    if (!bundle || bundle.format !== BUNDLE_FORMAT || bundle.version !== 1 || !Array.isArray(bundle.files)) throw new LibraryError('INVALID_BUNDLE', 'Unsupported native artifact bundle.');
    artifactKind(bundle.kind); if (kind && kind !== bundle.kind) throw new LibraryError('INVALID_KIND', 'Bundle and selected kind disagree.');
    if (bundle.files.length > this.limits.maxFiles) throw new LibraryError('LIMIT_EXCEEDED', 'Too many files in the native bundle.');
    const files = [], keys = new Set(); let total = 0, encoded = 0;
    for (const file of bundle.files) {
      const relative = relativePath(file?.path); const key = relative.normalize('NFC').toLowerCase();
      if (keys.has(key)) throw new LibraryError('INVALID_BUNDLE', 'Duplicate or case-colliding bundle path.'); keys.add(key);
      if (!contentPath(bundle.kind, relative)) continue;
      if (file.encoding !== 'base64' || typeof file.data !== 'string' || file.data.length > Math.ceil(this.limits.maxFileBytes / 3) * 4 || file.data.length % 4 || /[^A-Za-z0-9+/=]/.test(file.data)) throw new LibraryError('INVALID_BUNDLE', 'Invalid or oversized base64 file.');
      const padding = file.data.indexOf('=');
      if (padding >= 0 && (padding < file.data.length - 2 || !/^={1,2}$/.test(file.data.slice(padding)))) throw new LibraryError('INVALID_BUNDLE', 'Invalid base64 padding.');
      const bytes = Buffer.from(file.data, 'base64'); encoded += file.data.length; total += bytes.length;
      if (bytes.toString('base64') !== file.data || bytes.length > this.limits.maxFileBytes || total > this.limits.maxTotalBytes || encoded > this.limits.maxBundleBytes) throw new LibraryError('LIMIT_EXCEEDED', 'The native bundle exceeds content limits.');
      files.push({ path: relative, encoding: 'base64', data: file.data });
    }
    const native = validateFiles(bundle.kind, files); return { kind: bundle.kind, title: native.title, files };
  }
  async _source(sourcePath, kind) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new LibraryError('INVALID_PATH', 'Choose an absolute source path explicitly.');
    const info = await fs.lstat(sourcePath).catch(error => { if (error.code === 'ENOENT') throw new LibraryError('NOT_FOUND', 'The import source is missing.'); throw error; });
    if (info.isSymbolicLink()) throw new LibraryError('SYMLINK_REFUSED', 'The import source cannot be a symbolic link.');
    if (info.isFile()) return this._bundle(await readBytes(path.dirname(sourcePath), path.basename(sourcePath), this.limits.maxBundleBytes), kind);
    if (!info.isDirectory()) throw new LibraryError('INVALID_CONTENT', 'The import source is not a native folder or bundle.');
    const matches = [];
    for (const candidate of KINDS) if (await statOrNull(await safePath(sourcePath, INDEX_FILES[candidate], { mustExist: false }))) matches.push(candidate);
    if (!kind) { if (matches.length !== 1) throw new LibraryError(matches.length ? 'AMBIGUOUS_KIND' : 'MISSING_CONTENT', 'Select one native artifact kind with an existing index.'); kind = matches[0]; }
    artifactKind(kind); if (!matches.includes(kind)) throw new LibraryError('MISSING_CONTENT', 'The chosen source has no native index for this kind.');
    const busy = await this.isBusy({ id: null, kind, path: sourcePath }); if (busy === true || busy?.busy) throw new LibraryError('ARTIFACT_BUSY', 'The import source has an active task.');
    const files = await collectContent(sourcePath, kind, this.limits); const native = validateFiles(kind, files); return { kind, title: native.title, files };
  }
  async importArtifact({ bundle, sourcePath, kind, title } = {}) {
    await this._checkRoot(); if ((bundle === undefined) === (sourcePath === undefined)) throw new LibraryError('INVALID_OPTION', 'Provide exactly one native bundle or explicitly chosen source path.');
    if (kind) artifactKind(kind); if (title !== undefined) titleText(title);
    return locked(this.root, async () => { const source = bundle === undefined ? await this._source(sourcePath, kind) : this._bundle(bundle, kind); return this._create(source.kind, title || source.title, source.files); });
  }
  async listFiles(id) {
    await this._checkRoot(); const { record } = await this._raw(id); const root = await this._artifactPath(record);
    return collectContent(root, record.kind, this.limits, { includeBytes: false });
  }
  async readFile(id, relative, { encoding = 'utf8' } = {}) {
    await this._checkRoot(); const { record } = await this._raw(id); relativePath(relative);
    if (!contentPath(record.kind, relative)) throw new LibraryError('CONTENT_ONLY', 'This route exposes only artwork and material files, not comments, chats, tasks, or runtime bindings.');
    if (!['utf8', 'base64'].includes(encoding)) throw new LibraryError('INVALID_OPTION', 'Unsupported file encoding.');
    const root = await this._artifactPath(record), bytes = await readBytes(root, relative, this.limits.maxFileBytes), type = contentType(relative);
    if (encoding === 'utf8' && !/^(?:text\/|application\/json|image\/svg)/.test(type)) throw new LibraryError('BINARY_ENCODING_REQUIRED', 'Read binary material using base64.');
    return { path: relative, contentType: type, bytes: bytes.length,
      revision: { sha256: createHash('sha256').update(bytes).digest('hex'), observedAt: at() },
      ...(encoding === 'base64' ? { encoding, data: bytes.toString('base64') } : { text: bytes.toString('utf8') }) };
  }
  async trash(id) {
    await this._checkRoot(); return locked(this.root, async () => {
      const { record, catalog } = await this._raw(id); await this._busy(record); const source = await this._artifactPath(record), destination = await safePath(this.root, `_trash/${record.id}`, { mustExist: false });
      if (await statOrNull(destination)) throw new LibraryError('ID_CONFLICT', 'The recycle location already exists.');
      await fs.rename(source, destination); const next = metadata({ ...record, deletedAt: at(), updatedAt: at() }); await atomicJson(destination, 'artifact.json', next);
      catalog.artifacts[record.id] = { ...next, location: 'trash' }; await this._saveCatalog(catalog);
      const view = await this._view(catalog); view.tabs = view.tabs.filter(tab => tab.id !== record.id); if (view.activeTabId === record.id) view.activeTabId = 'library'; await atomicJson(this.root, viewFile, view);
      return this._inspect(catalog.artifacts[record.id]);
    });
  }
  async restore(id) {
    await this._checkRoot(); return locked(this.root, async () => {
      const { record, catalog } = await this._raw(id, { includeDeleted: true }); if (record.location !== 'trash') return this._inspect(record);
      await this._busy(record); const source = await this._artifactPath(record), destination = await safePath(this.root, `${record.kind}/${record.id}`, { mustExist: false });
      if (await statOrNull(destination)) throw new LibraryError('ID_CONFLICT', 'An active directory already occupies this identity.');
      await fs.rename(source, destination); const { deletedAt, ...old } = record; const next = metadata({ ...old, updatedAt: at() }); await atomicJson(destination, 'artifact.json', next);
      catalog.artifacts[record.id] = { ...next, location: 'active' }; await this._saveCatalog(catalog); return this._inspect(catalog.artifacts[record.id]);
    });
  }
  async _purgeTree(relative, { inspectOnly = true } = {}) {
    // Every recursive deletion is confined to one explicit artifact identity.
    if (!/^(?:_trash|_state\/snapshots)\/[0-9a-f-]{36}$/.test(relative) || !UUID.test(relative.split('/').at(-1))) throw new LibraryError('INVALID_PATH', 'Permanent deletion requires an exact trash or snapshot identity.');
    if (await fs.realpath(this.root) !== this.realRoot || (await fs.lstat(this.root)).isSymbolicLink()) throw new LibraryError('ROOT_CHANGED', 'The library root changed before permanent deletion.');
    const absolute = await safePath(this.root, relative, { mustExist: false });
    const expected = path.resolve(this.root, ...relative.split('/'));
    within(this.root, absolute);
    if (path.resolve(absolute) !== expected) throw new LibraryError('INVALID_PATH', 'The permanent deletion target changed.');
    if (!await statOrNull(absolute)) return false;
    const walk = async child => {
      const target = await safePath(this.root, child);
      const info = await fs.lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new LibraryError('SYMLINK_REFUSED', 'Permanent deletion refuses links and special files.');
      if (info.isDirectory()) for (const entry of await fs.readdir(target)) await walk(`${child}/${entry}`);
    };
    await safePath(this.root, relative, { type: 'directory' }); await walk(relative);
    if (!inspectOnly) {
      // Recheck the absolute target immediately before the recursive operation.
      const checked = await safePath(this.root, relative, { type: 'directory' });
      if (path.resolve(checked) !== expected || await fs.realpath(this.root) !== this.realRoot) throw new LibraryError('ROOT_CHANGED', 'The permanent deletion target changed.');
      await fs.rm(checked, { recursive: true, force: false });
    }
    return true;
  }
  async _purgeNativeIdle(record, root) {
    const inspected = record.title ? await this._inspect(record) : { ...record, path: root, deleted: true, contentStatus: 'missing' };
    const native = await nativeTrashActivity({ ...inspected, path: root });
    if (native?.busy) throw new LibraryError('ARTIFACT_BUSY', native.reason);
    const external = await this.isBusy(inspected);
    if (external === true || external?.busy) throw new LibraryError('ARTIFACT_BUSY', external?.reason || 'An external artwork task still owns this trash item.');
  }
  async purge(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200) throw new LibraryError('INVALID_ARGUMENTS', 'Choose between 1 and 200 trash artifact ids.');
    ids = [...new Set(ids.map(artifactId))]; await this._checkRoot();
    return locked(this.root, async () => {
      const catalog = await this._catalog(), bindings = await this._bindings();
      const legacy = await readJson(this.root, '_state/legacy-imports.json', null);
      if (legacy && (legacy.version !== 1 || !legacy.sources || typeof legacy.sources !== 'object' || Array.isArray(legacy.sources))) throw new LibraryError('INVALID_STATE', 'The legacy registration state is invalid.');
      const requestFiles = new Map(ids.map(id => [id, []]));
      const requests = await safePath(this.root, '_state/edit-requests', { mustExist: false });
      if (await statOrNull(requests)) {
        await safePath(this.root, '_state/edit-requests', { type: 'directory' });
        for (const name of await fs.readdir(requests)) if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
          const relative = `_state/edit-requests/${name}`;
          let request;
          try { request = JSON.parse((await readBytes(this.root, relative, 512 * 1024)).toString('utf8')); }
          catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError('INVALID_STATE', 'An edit request record is malformed.'); }
          if (request.version !== 1 || !UUID.test(request.id ?? '') || request.id.toLowerCase() !== name.slice(0, -5).toLowerCase() || !UUID.test(request.artifactId ?? '')) throw new LibraryError('INVALID_STATE', 'An edit request identity is invalid.');
          requestFiles.get(request.artifactId.toLowerCase())?.push(relative);
        }
      }
      const plans = [];
      // Complete the whole batch preflight before writing progress or removing
      // any artwork. A restored, busy or unsafe selection preserves all items.
      for (const id of ids) {
        const progressPath = `_state/purge-progress/${id}.json`;
        const progress = await readJson(this.root, progressPath, null);
        if (progress && (progress.version !== 1 || progress.artifactId !== id || !KINDS.includes(progress.kind))) throw new LibraryError('INVALID_STATE', 'A permanent deletion receipt is invalid.');
        const record = catalog.artifacts[id] || (progress ? { id, kind: progress.kind, location: 'trash' } : null);
        if (!record) throw new LibraryError('NOT_FOUND', 'No such trash artifact.');
        if (record.location !== 'trash') throw new LibraryError('NOT_IN_TRASH', 'Only artifacts currently in the trash can be permanently deleted.');
        if (progress && progress.kind !== record.kind) throw new LibraryError('INVALID_STATE', 'A permanent deletion receipt has a different artifact kind.');
        const active = await safePath(this.root, `${record.kind}/${id}`, { mustExist: false });
        if (await statOrNull(active)) throw new LibraryError('NOT_IN_TRASH', 'An active artifact occupies this identity; permanent deletion was refused.');
        const present = await this._purgeTree(`_trash/${id}`);
        if (!present && !progress) throw new LibraryError('NOT_FOUND', 'The selected trash directory is missing.');
        if (present) {
          const root = await safePath(this.root, `_trash/${id}`, { type: 'directory' });
          const manifestFile = await safePath(root, 'artifact.json', { mustExist: false });
          if (await statOrNull(manifestFile)) {
            const manifest = metadata(await readJson(root, 'artifact.json'));
            if (manifest.id !== id || manifest.kind !== record.kind || !manifest.deletedAt) throw new LibraryError('NOT_IN_TRASH', 'The trash directory does not contain this deleted artwork identity.');
          } else if (!progress) throw new LibraryError('NOT_FOUND', 'The selected trash manifest is missing.');
        }
        await this._purgeNativeIdle(record, await safePath(this.root, `_trash/${id}`, { mustExist: false }));
        await this._purgeTree(`_state/snapshots/${id}`);
        const snapshots = await safePath(this.root, `_state/snapshots/${id}`, { mustExist: false });
        if (await statOrNull(snapshots)) for (const name of await fs.readdir(snapshots)) if (/^[0-9a-f-]{36}\.json$/i.test(name)) {
          const saved = await readJson(this.root, `_state/snapshots/${id}/${name}`);
          if (saved.artifactId !== id || saved.id !== name.slice(0, -5)) throw new LibraryError('INVALID_STATE', 'A recovery point belongs to a different artifact identity.');
        }
        plans.push({ id, record, progressPath, progress, requestFiles: requestFiles.get(id) });
      }
      const deleted = [], failed = [];
      for (const plan of plans) {
        const { id } = plan, removed = []; let stage = 'prepare';
        try {
          if (catalog.artifacts[id] && catalog.artifacts[id].location !== 'trash') throw new LibraryError('NOT_IN_TRASH', 'The selected artwork is no longer in the trash.');
          await atomicJson(this.root, plan.progressPath, plan.progress || { version: 1, artifactId: id, kind: plan.record.kind, startedAt: at() });
          const trashRoot = await safePath(this.root, `_trash/${id}`, { mustExist: false });
          await this._purgeNativeIdle(plan.record, trashRoot);
          stage = 'artwork';
          if (await this._purgeTree(`_trash/${id}`, { inspectOnly: false })) removed.push('artwork');
          stage = 'snapshots';
          if (await this._purgeTree(`_state/snapshots/${id}`, { inspectOnly: false })) removed.push('snapshots');
          stage = 'requests';
          for (const relative of plan.requestFiles) {
            const file = await safePath(this.root, relative, { mustExist: false });
            if (await statOrNull(file)) await fs.unlink(await safePath(this.root, relative, { type: 'file' }));
          }
          if (plan.requestFiles.length) removed.push('requests');
          stage = 'metadata';
          const nextBindings = structuredClone(bindings); delete nextBindings.artifacts[id]; await atomicJson(this.root, bindingsFile, nextBindings); delete bindings.artifacts[id];
          if (legacy) { const nextLegacy = structuredClone(legacy); for (const [key, value] of Object.entries(nextLegacy.sources)) if (value === id) delete nextLegacy.sources[key]; await atomicJson(this.root, '_state/legacy-imports.json', nextLegacy); legacy.sources = nextLegacy.sources; }
          const nextCatalog = structuredClone(catalog); delete nextCatalog.artifacts[id];
          await atomicJson(this.root, viewFile, await this._view(nextCatalog));
          await this._saveCatalog(nextCatalog); delete catalog.artifacts[id]; removed.push('metadata');
          stage = 'receipt';
          await fs.unlink(await safePath(this.root, plan.progressPath, { type: 'file' }));
          deleted.push(id);
        } catch (error) {
          const message = (stage === 'prepare' ? '' : 'Permanent deletion was incomplete; some local data may already be removed. ') + String(error.message || error);
          failed.push({ id, error: { code: error.code || 'PURGE_FAILED', message: message.slice(0, 1000) }, removed, stage });
        }
      }
      return { deleted, failed };
    });
  }
  async snapshot(id, { label = 'Snapshot' } = {}) {
    label = titleText(label); await this._checkRoot(); return locked(this.root, async () => {
      const { record } = await this._raw(id), bundle = await this._export(record); const snapshot = { id: randomUUID(), artifactId: record.id, label, createdAt: at(), bundle };
      await atomicJson(this.root, `_state/snapshots/${record.id}/${snapshot.id}.json`, snapshot); return this._snapshotSummary(snapshot);
    });
  }
  _snapshotSummary(snapshot) { return { id: snapshot.id, artifactId: snapshot.artifactId, label: snapshot.label, createdAt: snapshot.createdAt, files: snapshot.bundle.files.length, bytes: snapshot.bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0) }; }
  async listSnapshots(id) {
    id = artifactId(id); await this._checkRoot(); await this._raw(id, { includeDeleted: true }); const relative = `_state/snapshots/${id}`, directory = await safePath(this.root, relative, { mustExist: false });
    if (!await statOrNull(directory)) return [];
    const result = [];
    for (const name of await fs.readdir(directory)) if (/^[0-9a-f-]+\.json$/i.test(name) && UUID.test(name.slice(0, -5))) {
      const snapshot = await readJson(this.root, relative + '/' + name); if (snapshot.artifactId !== id) throw new LibraryError('INVALID_STATE', 'Snapshot identity disagrees.'); this._bundle(snapshot.bundle); result.push(this._snapshotSummary(snapshot));
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async restoreSnapshot(id, snapshotId) {
    id = artifactId(id); snapshotId = artifactId(snapshotId); await this._checkRoot(); return locked(this.root, async () => {
      const { record, catalog } = await this._raw(id); await this._busy(record); const saved = await readJson(this.root, `_state/snapshots/${id}/${snapshotId}.json`);
      if (saved.artifactId !== id) throw new LibraryError('INVALID_STATE', 'Snapshot identity disagrees.'); const bundle = this._bundle(saved.bundle, record.kind);
      const root = await this._artifactPath(record), current = await collectContent(root, record.kind, this.limits, { includeBytes: false }), stage = await this._stage();
      const originalManifest = await readJson(root, 'artifact.json'); let manifestWritten = false;
      const before = path.join(stage.absolute, 'before'), after = path.join(stage.absolute, 'after'); await fs.mkdir(before); await fs.mkdir(after); await writeContent(after, bundle.files);
      const moved = [], added = [];
      try {
        for (const file of current) { const from = await safePath(root, file.path, { type: 'file' }), to = await safePath(before, file.path, { mustExist: false }); await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); moved.push(file.path); }
        for (const file of bundle.files) { const from = await safePath(after, file.path, { type: 'file' }), to = await safePath(root, file.path, { mustExist: false }); if (await statOrNull(to)) throw new LibraryError('CONTENT_CHANGED', 'A file changed while restoring a snapshot.'); await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); added.push(file.path); }
        const next = metadata({ ...record, title: bundle.title, updatedAt: at() }); await atomicJson(root, 'artifact.json', next); manifestWritten = true; catalog.artifacts[id] = { ...next, location: 'active' }; await this._saveCatalog(catalog); return this._inspect(catalog.artifacts[id]);
      } catch (error) {
        for (const relative of added) await fs.unlink(await safePath(root, relative, { type: 'file' }));
        for (const relative of moved) { const from = await safePath(before, relative, { type: 'file' }), to = await safePath(root, relative, { mustExist: false }); await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to); }
        if (manifestWritten) await atomicJson(root, 'artifact.json', originalManifest);
        throw error;
      } finally { await this._removeStage(stage); }
    });
  }
  async scanLegacy() {
    await this._checkRoot(); return locked(this.root, async () => {
      const state = await readJson(this.root, '_state/legacy-imports.json', { version: 1, sources: {} }); if (state.version !== 1 || !state.sources) throw new LibraryError('INVALID_STATE', 'The legacy registration state is invalid.');
      const results = [];
      for (const kind of KINDS) for (const entry of await fs.readdir(await safePath(this.root, kind, { type: 'directory' }), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue; const relative = `${kind}/${entry.name}`;
        if (entry.isSymbolicLink()) { results.push({ kind, path: path.join(this.root, relative), status: 'invalid', code: 'SYMLINK_REFUSED' }); continue; }
        if (!entry.isDirectory()) continue;
        const source = await safePath(this.root, relative, { type: 'directory' });
        if (await statOrNull(await safePath(source, 'artifact.json', { mustExist: false }))) continue;
        if (state.sources[relative]) {
          const registered = (await this._catalog()).artifacts[state.sources[relative]];
          const status = registered ? (await this._inspect(registered)).contentStatus : 'missing';
          results.push({ kind, path: source, status: status === 'ok' ? 'registered' : status, artifactId: state.sources[relative] }); continue;
        }
        try { const content = await this._source(source, kind); const imported = await this._create(kind, content.title, content.files); state.sources[relative] = imported.id; await atomicJson(this.root, '_state/legacy-imports.json', state); results.push({ kind, path: source, status: 'imported', artifactId: imported.id }); }
        catch (error) { results.push({ kind, path: source, status: ['MISSING_CONTENT', 'NOT_FOUND'].includes(error.code) ? 'missing' : 'invalid', code: error.code || 'INVALID_CONTENT', message: error.message }); }
      }
      return results;
    });
  }
  async _bindings() { const value = await readJson(this.root, bindingsFile, { version: 1, artifacts: {} }); if (value.version !== 1 || !value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)) throw new LibraryError('INVALID_STATE', 'Chat bindings are invalid.'); return value; }
  async getBinding(id) { id = artifactId(id); await this._checkRoot(); await this._raw(id); return structuredClone((await this._bindings()).artifacts[id] || null); }
  async bindChat(id, { threadId, projectId } = {}) {
    id = artifactId(id); for (const value of [threadId, ...(projectId === undefined ? [] : [projectId])]) if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) throw new LibraryError('INVALID_BINDING', 'Use an actual nonempty host identifier.');
    await this._checkRoot(); return locked(this.root, async () => {
      await this._raw(id); const state = await this._bindings(), previous = state.artifacts[id];
      if (previous && previous.threadId !== threadId) throw new LibraryError('BINDING_CONFLICT', 'This artifact already has a different editing conversation; unlink it explicitly first.');
      const binding = { artifactId: id, threadId, ...(projectId ? { projectId } : {}), boundAt: previous?.boundAt || at(), updatedAt: at() }; state.artifacts[id] = binding; await atomicJson(this.root, bindingsFile, state); return binding;
    });
  }
  async unbindChat(id) { id = artifactId(id); await this._checkRoot(); return locked(this.root, async () => { await this._raw(id); const state = await this._bindings(); delete state.artifacts[id]; await atomicJson(this.root, bindingsFile, state); return null; }); }
  async _view(catalog) {
    const value = await readJson(this.root, viewFile, emptyView()); if (value.version !== 1 || !Array.isArray(value.tabs)) throw new LibraryError('INVALID_STATE', 'The saved library view is invalid.');
    const tabs = [libraryTab()], seen = new Set(['library']);
    for (const tab of value.tabs) if (tab?.type === 'artifact' && typeof tab.artifactId === 'string' && UUID.test(tab.artifactId)) {
      const id = tab.artifactId.toLowerCase(); if (!seen.has(id) && catalog.artifacts[id]?.location === 'active') { tabs.push({ id, type: 'artifact', artifactId: id }); seen.add(id); }
    }
    return { version: 1, tabs, activeTabId: seen.has(value.activeTabId) ? value.activeTabId : 'library' };
  }
  async getViewState() { await this._checkRoot(); return this._view(await this._catalog()); }
  async _viewUpdate(fn) { await this._checkRoot(); return locked(this.root, async () => { const catalog = await this._catalog(), view = await this._view(catalog); await fn(view, catalog); await atomicJson(this.root, viewFile, view); return view; }); }
  async openTab(id) { id = artifactId(id); return this._viewUpdate((view, catalog) => { if (catalog.artifacts[id]?.location !== 'active') throw new LibraryError('NOT_FOUND', 'No active artifact has this id.'); if (!view.tabs.some(tab => tab.id === id)) view.tabs.push({ id, type: 'artifact', artifactId: id }); view.activeTabId = id; }); }
  async activateTab(id) { if (id !== 'library') id = artifactId(id); return this._viewUpdate(view => { if (!view.tabs.some(tab => tab.id === id)) throw new LibraryError('NOT_FOUND', 'This tab is not open.'); view.activeTabId = id; }); }
  async closeTab(id) { if (id !== 'library') id = artifactId(id); return this._viewUpdate(view => { if (id === 'library') return; view.tabs = view.tabs.filter(tab => tab.id !== id); if (view.activeTabId === id) view.activeTabId = view.tabs.at(-1).id; }); }
  async reorderTabs(ids) { if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new LibraryError('INVALID_VIEW', 'Expected an ordered list of tab ids.'); return this._viewUpdate(view => { const requested = ids.filter(id => id !== 'library'); const current = view.tabs.filter(tab => tab.type === 'artifact'); if (new Set(requested).size !== requested.length || requested.length !== current.length || requested.some(id => !current.some(tab => tab.id === id))) throw new LibraryError('INVALID_VIEW', 'Tab order must contain each open artifact once.'); view.tabs = [libraryTab(), ...requested.map(id => current.find(tab => tab.id === id))]; }); }
}

export function createLibraryStore(options) { return new LibraryStore(options); }
