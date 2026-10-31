import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, alive } from '../scripts/bridge-core.mjs';
import { verifyEditorInstance } from '../scripts/artifact-command.mjs';
import { createArtifactThumbnail } from '../library/thumbnail.mjs';
import { ACTIONS, KINDS, UNSUPPORTED_CHAT_CODE, fileUri, referenceUri } from './contract.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function idOf(value) { if (typeof value !== 'string' || !UUID.test(value)) throw failure('INVALID_ID', 'An artifact UUID is required.'); return value.toLowerCase(); }
function titleOf(value) { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw failure('INVALID_TITLE', 'Provide a title of at most 200 characters.'); return value.trim(); }
function kindOf(value) { if (!KINDS.includes(value)) throw failure('INVALID_KIND', 'Unsupported artifact kind.'); return value; }
function relativeOf(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes('%') || path.isAbsolute(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
    || /[\u0000-\u001f:]/.test(value)) throw failure('INVALID_PATH', 'Only a safe artifact-relative content path is accepted.');
  return value;
}

export const capabilityState = () => ({
  actions: [...ACTIONS], nativeEditConversation: false, selectNativeProject: false,
  arbitraryThreadTarget: false, reasonCode: UNSUPPORTED_CHAT_CODE,
});

export async function openLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 30_000 } = {}) {
  const current = readJson(path.join(record.path, '.artifact-server.json'));
  if (current && alive(current.pid)) {
    await verifyEditorInstance(current, record.path, record.kind);
    const binding = readJson(path.join(record.path, '.codex-design-bridge.json'));
    return { url: current.url, artifactId: record.id, kind: record.kind, reused: true,
      delivery: binding?.deliveryMode || 'manual', nativeConversationBound: false };
  }
  const skill = `codex-${record.kind}`;
  const cli = path.join(pluginRoot, 'skills', skill, 'scripts', 'codex-artifact.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'open', record.path, '--delivery', 'native'], {
      cwd: record.path, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(hardTimer); error ? reject(error) : resolve(result); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65_536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8_000); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const hardTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failure('EDITOR_TIMEOUT', 'The local editor did not finish starting.'));
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
    }, timeoutMs + 1_000);
    child.once('error', error => finish(failure('EDITOR_START_FAILED', error.message)));
    child.once('close', code => {
      if (timedOut) return finish(failure('EDITOR_TIMEOUT', 'The local editor did not finish starting.'));
      if (code !== 0) return finish(failure('EDITOR_START_FAILED', stderr.trim().slice(-2_000) || `Editor command exited ${code}.`));
      let result;
      try { result = JSON.parse(stdout.trim()); } catch { return finish(failure('EDITOR_INVALID_RESPONSE', 'The local editor returned invalid startup data.')); }
      let url;
      try { url = new URL(result.url); } catch { return finish(failure('EDITOR_INVALID_RESPONSE', 'The local editor did not return a URL.')); }
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
        return finish(failure('EDITOR_INVALID_RESPONSE', 'Only a local editor URL is accepted.'));
      }
      finish(null, { url: url.href, artifactId: record.id, kind: record.kind, delivery: 'native', nativeConversationBound: false });
    });
  });
}

export function createDesignService({ store, pluginRoot = fileURLToPath(new URL('../', import.meta.url)), editorOpen = openLocalEditor } = {}) {
  if (!store) throw new TypeError('A LibraryStore is required.');
  const opening = new Map();
  const requireRecord = async id => {
    const record = await store.get(idOf(id));
    if (!record || record.deletedAt) throw failure('ARTIFACT_UNAVAILABLE', 'The artifact is missing or in the trash.');
    return record;
  };
  const initialize = async () => { await store.initialize(); return store; };
  const reference = async id => {
    await initialize();
    const artifact = await requireRecord(id);
    const files = await store.listFiles(artifact.id);
    return { version: 1, artifact: { id: artifact.id, kind: artifact.kind, title: artifact.title }, readOnly: true,
      editPolicy: 'Reference only. Make source edits from the artwork tab; this resource does not grant write access.',
      files: files.map(file => ({ ...file, uri: fileUri(artifact.id, file.path) })) };
  };
  const resourceLink = artifact => ({ type: 'resource_link', uri: referenceUri(artifact.id), name: artifact.title,
    description: `${artifact.kind}; read-only design reference. Open its artwork tab to edit the source.`, mimeType: 'application/json' });

  return {
    async initialState() {
      await initialize();
      return { schemaVersion: 1, artifacts: await store.list({ includeDeleted: true }), viewState: await store.getViewState(), capabilities: capabilityState() };
    },
    async mentions(query = '') {
      await initialize();
      return { items: (await store.list({ query: String(query).slice(0, 200) })).filter(record => !record.deletedAt && record.contentStatus === 'ok').slice(0, 50).map(resourceLink) };
    },
    reference,
    async readReferenceFile(id, relative, encoding = 'utf8') {
      await initialize(); await requireRecord(id);
      if (!['utf8', 'base64'].includes(encoding)) throw failure('INVALID_ENCODING', 'Choose utf8 or base64.');
      return await store.readFile(idOf(id), relativeOf(relative), { encoding });
    },
    async invoke(action, payload = {}) {
      await initialize();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('INVALID_ARGUMENTS', 'An action payload must be an object.');
      if (action === 'conversation.send') throw failure(UNSUPPORTED_CHAT_CODE, 'The host has not exposed a verified per-artifact native edit-conversation bridge. No message was sent.');
      if (!ACTIONS.includes(action)) throw failure('UNKNOWN_ACTION', 'Unsupported library action.');
      switch (action) {
        case 'library.list': return await store.list({ kind: payload.kind === undefined ? undefined : kindOf(payload.kind), query: typeof payload.query === 'string' ? payload.query.slice(0, 200) : '', favoritesOnly: payload.favoritesOnly === true, includeDeleted: payload.includeDeleted === true });
        case 'library.get': return await store.get(idOf(payload.id));
        case 'thumbnail.get': return await createArtifactThumbnail(store, idOf(payload.id));
        case 'library.create': return await store.create({ kind: kindOf(payload.kind), title: titleOf(payload.title) });
        case 'library.rename': return await store.rename(idOf(payload.id), titleOf(payload.title));
        case 'library.setFavorite': if (typeof payload.favorite !== 'boolean') throw failure('INVALID_ARGUMENTS', 'favorite must be a boolean.'); return await store.setFavorite(idOf(payload.id), payload.favorite);
        case 'library.duplicate': return await store.duplicate(idOf(payload.id), { ...(payload.title === undefined ? {} : { title: titleOf(payload.title) }) });
        case 'library.trash': return await store.trash(idOf(payload.id));
        case 'library.restore': return await store.restore(idOf(payload.id));
        case 'library.snapshot': return await store.snapshot(idOf(payload.id));
        case 'library.listSnapshots': return await store.listSnapshots(idOf(payload.id));
        case 'library.restoreSnapshot': return await store.restoreSnapshot(idOf(payload.id), payload.snapshotId);
        case 'library.exportArtifact': return await store.exportArtifact(idOf(payload.id));
        case 'library.importArtifact': {
          if (!payload.bundle || typeof payload.bundle !== 'object' || Array.isArray(payload.bundle) || Object.hasOwn(payload, 'sourcePath')) {
            throw failure('INVALID_IMPORT', 'Choose a native artwork package; browser calls cannot import an arbitrary local path.');
          }
          return await store.importArtifact({ bundle: payload.bundle, ...(payload.title === undefined ? {} : { title: titleOf(payload.title) }) });
        }
        case 'view.get': return await store.getViewState();
        case 'view.openTab': return await store.openTab(idOf(payload.id));
        case 'view.activateTab': return await store.activateTab(payload.id === 'library' ? 'library' : idOf(payload.id));
        case 'view.closeTab': return await store.closeTab(payload.id === 'library' ? 'library' : idOf(payload.id));
        case 'view.reorderTabs': if (!Array.isArray(payload.ids)) throw failure('INVALID_ARGUMENTS', 'ids must be an array.'); return await store.reorderTabs(payload.ids.map(id => id === 'library' ? 'library' : idOf(id)));
        case 'editor.open': {
          const record = await requireRecord(payload.id);
          if (record.contentStatus !== 'ok') throw failure('ARTIFACT_CONTENT_UNAVAILABLE', 'Missing or invalid artifact content cannot open as a blank replacement.');
          if (!opening.has(record.id)) opening.set(record.id, Promise.resolve().then(() => editorOpen(record, { pluginRoot })).finally(() => opening.delete(record.id)));
          return await opening.get(record.id);
        }
        case 'conversation.get': {
          const record = await requireRecord(payload.id);
          return { artifactId: record.id, binding: await store.getBinding(record.id), messages: [], status: 'unsupported',
            capabilities: { sendMessage: false }, reasonCode: UNSUPPORTED_CHAT_CODE };
        }
        case 'reference.get': { const value = await reference(payload.id); return { ...value, resource: resourceLink(value.artifact) }; }
        case 'reference.readFile': return await this.readReferenceFile(payload.id, payload.path, payload.encoding);
      }
    },
  };
}
