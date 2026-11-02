import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const nativeSession = () => process.env.CODEX_DESIGN_NATIVE_SESSION === '1';
export function assertNativeNetwork({host, lan = false}) {
  if (!nativeSession() || !lan && ['127.0.0.1', 'localhost', '::1'].includes(host)) return;
  const error = new Error('A native Codex Design data service is local-only; network sharing is not enabled by opening an artwork.');
  error.code = 'NATIVE_NETWORK_REFUSED';
  throw error;
}

export function userRevisionHash(thread) {
  const messages = Array.isArray(thread) ? thread : thread?.messages || [];
  const revision = messages.filter(message => (message.from || message.author?.kind) === 'user')
    .map(message => ({text: message.text, at: message.at, editedAt: message.editedAt}));
  return createHash('sha256').update(JSON.stringify(revision)).digest('hex');
}

export function assertUserRevision(thread, expected) {
  if (!expected) return;
  if (!/^[a-f0-9]{64}$/.test(expected) || thread?.status !== 'open' || userRevisionHash(thread) !== expected) {
    const error = new Error('The user changed or resolved this comment before the reply was saved; the newer request was preserved.');
    error.code = 'COMMENT_REVISION_CHANGED';
    throw error;
  }
}

export async function renameWithRetry(source, destination, {platform = process.platform, rename = fs.rename, pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), delays = [10, 20, 40, 80, 160, 250, 400, 600, 800]} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
      await pause(delays[attempt]);
    }
  }
}

export function sameCommentRevision(current, captured) {
  const revision = thread => JSON.stringify((thread.messages || []).filter(message => (message.from || message.author?.kind) === 'user').map(message => ({id: message.id, text: message.text, at: message.at, editedAt: message.editedAt})));
  return current?.status === 'open' && current.agent?.status === 'pending' && current.agent.sentAt === captured.agent?.sentAt && revision(current) === revision(captured);
}

const indexNames = { 'codex-slides': 'deck.json', 'codex-design': 'canvas.json', 'codex-design-system': 'design-system.json' };
const editorKinds = { 'codex-slides': 'slides', 'codex-design': 'design', 'codex-design-system': 'design-system', 'codex-dashboard': 'dashboard' };
const safe = value => typeof value === 'string' && value.length <= 220 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));
async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } }
async function exists(root, relative) {
  if (!safe(relative)) return false;
  try { const base = await fs.realpath(root); const file = path.join(base, ...relative.split('/')); return await fs.realpath(file) === file && (await fs.lstat(file)).isFile(); } catch { return false; }
}
async function files(root, relative = '', result = []) {
  if (result.length >= 1024) return result;
  let entries; try { entries = await fs.readdir(path.join(root, relative), {withFileTypes: true}); } catch { return result; }
  for (const entry of entries) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (!safe(name) || entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '_blobs') continue;
    if (entry.isDirectory()) await files(root, name, result);
    else if (entry.isFile()) result.push(name);
    if (result.length >= 1024) break;
  }
  return result;
}

export async function annotationContext(root, skill) {
  const project = path.resolve(root);
  if (skill === 'codex-dashboard') {
    const names = await files(path.join(root, 'db/files'));
    const objects = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const doc = await readJson(path.join(root, 'db/files', name));
      if (typeof doc?.text !== 'string') continue;
      const id = name.slice(0, -5);
      objects.push({id, file: 'db/files/' + name, name: id, keys: [id]});
    }
    const meta = await readJson(path.join(root, 'db/dash/meta.json'));
    return {skill, projectRoot: project, title: meta?.title || path.basename(root), indexFile: 'db/dash/meta.json', objects};
  }
  const indexName = indexNames[skill];
  const directory = path.join(root, 'project');
  const index = await readJson(path.join(directory, indexName));
  const objects = [];
  if (skill === 'codex-slides') {
    const ids = Array.isArray(index?.order) ? index.order : [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !await exists(directory, 'slides/' + id + '.html')) continue;
      objects.push({id, file: 'project/slides/' + id + '.html', name: 'Slide ' + (i + 1) + ' · ' + id, page: i + 1, keys: [id]});
    }
  } else if (skill === 'codex-design') {
    const boards = index?.boards && typeof index.boards === 'object' ? index.boards : {};
    const order = [...new Set([...(Array.isArray(index?.order) ? index.order : []), ...Object.keys(boards)])];
    for (const id of order) {
      if (!Object.hasOwn(boards, id) || !await exists(directory, id)) continue;
      const board = boards[id];
      objects.push({id, file: 'project/' + id, name: typeof board.title === 'string' ? board.title : id, ...(typeof board.page === 'string' ? {page: board.page} : {}), keys: [id]});
    }
  } else {
    for (const name of await files(directory)) objects.push({id: name, file: 'project/' + name, name, keys: [name, 'guidance:' + name]});
  }
  return {skill, projectRoot: project, title: typeof index?.title === 'string' ? index.title : path.basename(root), indexFile: 'project/' + indexName, objects};
}

export async function serveCodexAnnotation(request, response, rest, root, skill, moduleUrl, { viewer, bootScript } = {}) {
  const route = rest.replace(/^\//, '');
  if (!['__codex/annotations.js', '__codex/annotation-context', '__codex/editor-session', '__codex/boot.js', '__codex/history-ui.js'].includes(route)) return false;
  // These routes expose local filesystem identity or native boot metadata.
  // Keep them behind the upstream grant and viewer checks, and never expose
  // that information through a shared guest session.
  if (viewer?.role !== 'owner') { response.writeHead(403, {'Cache-Control': 'no-store'}).end(); return true; }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, {Allow: 'GET, HEAD'}).end(); return true; }
  let body, type;
  if (route === '__codex/boot.js') {
    if (typeof bootScript !== 'function') { response.writeHead(404, {'Cache-Control': 'no-store'}).end(); return true; }
    body = Buffer.from(bootScript(new URL(request.url ?? '/', 'http://localhost').searchParams)); type = 'text/javascript; charset=utf-8';
  }
  else if (route === '__codex/history-ui.js') {
    const file = path.join(path.dirname(fileURLToPath(moduleUrl)), 'editor', 'share-ui.js');
    let info;
    try { info = await fs.lstat(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!info?.isFile() || info.isSymbolicLink() || await fs.realpath(file) !== file) { response.writeHead(404, {'Cache-Control': 'no-store'}).end(); return true; }
    body = await fs.readFile(file); type = 'text/javascript; charset=utf-8';
  }
  else if (route.endsWith('.js')) { body = await fs.readFile(new URL('./browser-annotations.js', moduleUrl)); type = 'text/javascript; charset=utf-8'; }
  else { body = Buffer.from(JSON.stringify(route.endsWith('/editor-session') ? {root: path.resolve(root), kind: editorKinds[skill], pid: process.pid, nativeSessionVersion: 2, nativeLocalOnly: nativeSession()} : await annotationContext(root, skill))); type = 'application/json; charset=utf-8'; }
  response.writeHead(200, {'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}
