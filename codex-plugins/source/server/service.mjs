import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, alive } from '../scripts/bridge-core.mjs';
import { verifyEditorInstance } from '../scripts/artifact-command.mjs';
import { createArtifactThumbnail } from '../library/thumbnail.mjs';
import { createEditRequestStore } from '../library/edit-requests.mjs';
import { createExportStore } from '../library/export-store.mjs';
import { readJson as safeJson } from '../library/safety.mjs';
import { createEditorTransport, editorRequestUrl, isValidBase64 } from './editor-transport.mjs';
import { createNativeComments } from './native-comments.mjs';
import { buildEditorDocument } from './editor-document.mjs';
import { installNativeEditorTransport } from '../scripts/editor-native-transport.js';
import { stopWorker } from '../scripts/worker-client.mjs';
import { stopLocalEditor } from './editor-lifecycle.mjs';
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

export async function openLocalEditor(record, { pluginRoot, env = process.env, timeoutMs = 30_000, spawnProcess = spawn } = {}) {
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
    const child = spawnProcess(process.execPath, [cli, 'open-service', record.path, '--delivery', 'native'], {
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

export function createDesignService({ store, pluginRoot = fileURLToPath(new URL('../', import.meta.url)), editorOpen = openLocalEditor, editorStop = stopLocalEditor } = {}) {
  if (!store) throw new TypeError('A LibraryStore is required.');
  const opening = new Map();
  const trashing = new Set();
  const requireRecord = async id => {
    const record = await store.get(idOf(id));
    if (!record || record.deletedAt) throw failure('ARTIFACT_UNAVAILABLE', 'The artifact is missing or in the trash.');
    return record;
  };
  const initialize = async () => { await store.initialize(); return store; };
  const editorFor = async id => {
    const record = await requireRecord(id);
    if (trashing.has(record.id)) throw failure('ARTIFACT_BUSY', 'This artwork is being moved to the trash.');
    if (record.contentStatus !== 'ok') throw failure('ARTIFACT_CONTENT_UNAVAILABLE', 'Missing or invalid artifact content cannot open as a blank replacement.');
    if (!opening.has(record.id)) opening.set(record.id, Promise.resolve().then(() => editorOpen(record, { pluginRoot })).finally(() => opening.delete(record.id)));
    return await opening.get(record.id);
  };
  const transport = createEditorTransport({ editorFor });
  const requests = createEditRequestStore({ store });
  const exports = createExportStore({ store });
  const nativeComments = createNativeComments({ requests, transport, editorFor });
  const modelRequest = async requestId => {
    const value = await requests.requestForModel(idOf(requestId));
    if (value.status === 'superseded') return value;
    const comments = await safeJson(value.artifactRoot, 'comments.json', { version: 1, threads: [] });
    const projected = await requests.project(value.artifactId, { threads: comments.threads });
    const reported = projected.threads.find(thread => thread.agent?.nativeRequest?.requestId === value.id)?.agent.nativeRequest;
    const cli = path.join(pluginRoot, 'skills', `codex-${value.artifact.kind}`, 'scripts', 'codex-artifact.mjs');
    return { ...value, ...(reported ? { status: reported.status, phase: reported.phase } : {}),
      skillFile: path.join(pluginRoot, 'skills', `codex-${value.artifact.kind}`, 'SKILL.md'),
      dispatchCommand: { executable: process.execPath, args: [cli, 'request-dispatch', value.artifactRoot, value.id] },
      workerStatus: { executable: process.execPath, args: [cli, 'worker-status', value.artifactRoot] },
      executionPolicy: 'Dispatch only requests attached to the user message you actually received. Run the dispatch command in your own native parent environment. Inspect the real native worker before choosing reuse, resume or a new child; only the registered native child runs worker-register/worker-next/worker-complete. Never invent thread IDs, start an independent model process, or replay legacy unconfirmed jobs.' };
  };
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
    readEditRequest: modelRequest,
    async operateEditRequests(action, ids) {
      if (!['read', 'accept'].includes(action) || !Array.isArray(ids) || ids.length < 1 || ids.length > 25) throw failure('INVALID_ARGUMENTS', 'Read or accept between 1 and 25 immutable request IDs.');
      const results = [], errors = [];
      for (const id of [...new Set(ids.map(idOf))]) {
        try { if (action === 'accept') await requests.accept(id); results.push(await modelRequest(id)); }
        catch (error) { errors.push({ requestId: id, code: error.code || 'REQUEST_FAILED', message: String(error.message).slice(0, 2000) }); }
      }
      return { requests: results, errors };
    },
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
        case 'export.locations': return await exports.locations();
        case 'export.listDirectory': return await exports.listDirectory(payload);
        case 'export.save': return await exports.save(payload);
        case 'library.list': return await store.list({ kind: payload.kind === undefined ? undefined : kindOf(payload.kind), query: typeof payload.query === 'string' ? payload.query.slice(0, 200) : '', favoritesOnly: payload.favoritesOnly === true, includeDeleted: payload.includeDeleted === true });
        case 'library.get': return await store.get(idOf(payload.id));
        case 'thumbnail.get': return await createArtifactThumbnail(store, idOf(payload.id));
        case 'library.create': return await store.create({ kind: kindOf(payload.kind), title: titleOf(payload.title) });
        case 'library.rename': return await store.rename(idOf(payload.id), titleOf(payload.title));
        case 'library.setFavorite': if (typeof payload.favorite !== 'boolean') throw failure('INVALID_ARGUMENTS', 'favorite must be a boolean.'); return await store.setFavorite(idOf(payload.id), payload.favorite);
        case 'library.duplicate': return await store.duplicate(idOf(payload.id), { ...(payload.title === undefined ? {} : { title: titleOf(payload.title) }) });
        case 'library.trash': {
          const id = idOf(payload.id);
          if (trashing.has(id)) throw failure('ARTIFACT_BUSY', 'This artwork is already being moved to the trash.');
          trashing.add(id);
          try {
            const record = await requireRecord(id);
            if (opening.has(id)) await opening.get(id);
            // Pause only idle ownership before stopping the verified editor.
            // Release the worker lock before moving the directory that holds it.
            await stopWorker(record.path, { onlyWhenIdle: true });
            await editorStop(record, { pluginRoot });
            return await store.trash(id);
          } finally { trashing.delete(id); }
        }
        case 'library.restore': return await store.restore(idOf(payload.id));
        case 'library.purge': {
          if (!Array.isArray(payload.ids) || payload.ids.length < 1 || payload.ids.length > 200) throw failure('INVALID_ARGUMENTS', 'Choose between 1 and 200 trashed artworks.');
          return await store.purge(payload.ids.map(idOf));
        }
        case 'library.snapshot': return await store.snapshot(idOf(payload.id), payload.label === undefined ? {} : { label: titleOf(payload.label) });
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
        case 'editor.open': return await editorFor(payload.id);
        case 'request.draftAdded': return await requests.markDraftAdded(idOf(payload.requestId));
        case 'request.draftFailed': return await requests.markDraftFailed(idOf(payload.requestId), payload.error);
        case 'editor.document': {
          const id = idOf(payload.id);
          if (typeof payload.channel !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(payload.channel)) throw failure('INVALID_EDITOR_REQUEST', 'A unique editor channel is required.');
          const language = 'en';
          const editor = await editorFor(id);
          const virtualBase = `https://codex-design.invalid/artifacts/${id}/`;
          const configuration = { artifactId: id, channel: payload.channel, baseUrl: virtualBase, language, hostDepth: 2,
            canDraftComments: payload.canDraftComments === true };
          if (editor.kind === 'design-system') {
            configuration.previewVendors = await Promise.all([
              ['react.production.min.js', 'd949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd'],
              ['react-dom.production.min.js', '35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d'],
            ].map(async ([file, expected]) => {
              const bytes = await readFile(path.join(pluginRoot, 'skills/codex-design-system/scripts/editor/artifact-type/vendor', file));
              if (bytes.length > 256 * 1024 || createHash('sha256').update(bytes).digest('hex') !== expected) throw failure('EDITOR_VENDOR_INTEGRITY', 'The packaged preview runtime failed its integrity check.');
              return { file, url: 'data:text/javascript;base64,' + bytes.toString('base64') };
            }));
          }
          const bootstrap = `(${installNativeEditorTransport.toString()})(${JSON.stringify(configuration).replace(/</g, '\\u003c')});`;
          const root = new URL(editor.url);
          const fetchLocal = async value => {
            const url = new URL(String(value));
            if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw failure('INVALID_EDITOR_REQUEST', 'Editor assets must stay inside their artwork session.');
            const relative = url.pathname.slice(root.pathname.length);
            editorRequestUrl(root.href, relative + url.search);
            // Reuse the live data service, but load editor chrome from this
            // installed release. Otherwise an old service would reintroduce
            // obsolete immutable JS/i18n assets after a plugin upgrade.
            let asset;
            if (!relative) asset = path.join(pluginRoot, 'skills', `codex-${editor.kind}`, 'scripts/editor/index.html');
            else if (relative === '__codex/annotations.js') asset = path.join(pluginRoot, 'scripts/browser-annotations.js');
            else if (/^(?:assets\/[A-Za-z0-9._-]+|comments\.js|local-host\.js)$/.test(relative)) {
              asset = path.join(pluginRoot, 'skills', `codex-${editor.kind}`, 'scripts/editor', relative);
            } else throw failure('EDITOR_ASSET_REFUSED', 'Only packaged static editor assets can be assembled.');
            const bytes = await readFile(asset);
            return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
          };
          const document = await buildEditorDocument({ baseUrl: editor.url, fetchLocal, config: { ...configuration, virtualBase, bootstrap } });
          return { ...editor, ...document, artifactId: id, channel: payload.channel, transport: 'mcp' };
        }
        case 'editor.request': return await nativeComments.request(idOf(payload.id), payload.request);
        case 'editor.digest': {
          await requireRecord(payload.id);
          if (payload.algorithm !== 'SHA-256' || typeof payload.base64 !== 'string' || payload.base64.length > 44_739_244
            || !isValidBase64(payload.base64)) throw failure('INVALID_EDITOR_DIGEST', 'Only a bounded SHA-256 digest is supported.');
          const bytes = Buffer.from(payload.base64, 'base64');
          if (bytes.length > 32 * 1024 * 1024) throw failure('INVALID_EDITOR_DIGEST', 'The digest input exceeds the transfer limit.');
          return { base64: createHash('sha256').update(bytes).digest('base64') };
        }
        case 'editor.events.open': return await nativeComments.openEvents(idOf(payload.id), payload.path);
        case 'editor.events.poll': return await nativeComments.pollEvents(idOf(payload.id), payload.subscriptionId, payload.cursor);
        case 'editor.events.close': return await nativeComments.closeEvents(idOf(payload.id), payload.subscriptionId);
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
