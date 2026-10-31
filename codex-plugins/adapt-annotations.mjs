import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const skills = ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard'];

// Written next to each generated server, never into the upstream skills.
const serverModule = String.raw`import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

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

export async function serveCodexAnnotation(request, response, rest, root, skill, moduleUrl) {
  const route = rest.replace(/^\//, '');
  if (route !== '__codex/annotations.js' && route !== '__codex/annotation-context' && route !== '__codex/editor-session') return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, {Allow: 'GET, HEAD'}).end(); return true; }
  let body, type;
  if (route.endsWith('.js')) { body = await fs.readFile(new URL('./browser-annotations.js', moduleUrl)); type = 'text/javascript; charset=utf-8'; }
  else { body = Buffer.from(JSON.stringify(route.endsWith('/editor-session') ? {root: path.resolve(root), kind: editorKinds[skill], pid: process.pid} : await annotationContext(root, skill))); type = 'application/json; charset=utf-8'; }
  response.writeHead(200, {'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  response.end(request.method === 'HEAD' ? undefined : body);
  return true;
}
`;

function replaceOnce(source, needle, replacement, filename) {
  if (!source.includes(needle)) throw new Error(`Annotation patch anchor missing in ${filename}: ${needle}`);
  return source.replace(needle, replacement);
}

export async function adaptAnnotations(pluginRoot) {
  const adapter = await fs.readFile(path.join(here, 'source/scripts/browser-annotations.js'));
  const integrity = 'sha384-' + createHash('sha384').update(adapter).digest('base64');
  const tag = `<script defer src="./__codex/annotations.js" integrity="${integrity}" data-baoyu-codex-annotations></script>`;
  for (const skill of skills) {
    const scripts = path.join(pluginRoot, 'skills', skill, 'scripts');
    // Detached servers and comment hook commands must not flash console windows
    // when the generated plugin is run from Codex desktop on Windows.
    for (const entry of skill === 'codex-dashboard' ? ['artifact.mjs'] : ['artifact.mjs', 'server.mjs']) {
      const file = path.join(scripts, entry);
      let runtime = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
      const upstreamName = skill.replace(/^codex-/, 'claude-');
      // Rename our CLI presentation only. Compatibility identifiers, reserved
      // source filenames, and third-party/license records stay unchanged.
      runtime = runtime.replace(new RegExp(`^// ${upstreamName}:`, 'm'), `// ${skill}:`);
      if (entry === 'artifact.mjs') {
        const prefix = skill === 'codex-dashboard' ? 'var USAGE = `' : 'var USAGE = `${"';
        if (!runtime.includes(prefix + skill)) runtime = replaceOnce(runtime, prefix + upstreamName, prefix + skill, file);
        if (skill === 'codex-dashboard') runtime = runtime.replaceAll('need the claude.ai page', 'require the hosted editor');
        else if (!runtime.includes('process.env.CODEX_DESIGN_SYSTEMS')) runtime = replaceOnce(runtime, 'process.env.CLAUDE_DESIGN_SYSTEMS ?? ""', 'process.env.CODEX_DESIGN_SYSTEMS ?? process.env.CLAUDE_DESIGN_SYSTEMS ?? ""', file);
        if (!runtime.includes('codexAssertUserRevision')) {
          runtime = runtime.replace(/(#![^\n]*\n)/, '$1import { assertUserRevision as codexAssertUserRevision } from "./codex-annotation-server.mjs";\n');
          const replyAnchor = '    const found = findThread(doc, id);\n    const now = (/* @__PURE__ */ new Date()).toISOString();\n    addMessage(found, AGENT_AUTHOR, text, now);';
          const guardedReply = '    const found = findThread(doc, id);\n    codexAssertUserRevision(found, process.env.CODEX_DESIGN_EXPECTED_USER_REVISION);\n    const now = (/* @__PURE__ */ new Date()).toISOString();\n    addMessage(found, AGENT_AUTHOR, text, now);';
          runtime = replaceOnce(runtime, replyAnchor, guardedReply, file);
        }
      }
      runtime = runtime.replaceAll('{ detached: true, stdio:', '{ detached: true, windowsHide: true, stdio:');
      runtime = runtime.replace(/spawn\(command, \{\r?\n\s*shell: true,(?!\r?\n\s*windowsHide:)/g, 'spawn(command, {\n        shell: true,\n        windowsHide: true,');
      // Retry the rename alone, retaining the same temporary file and lock.
      // Re-running updateComments could apply the user's mutation twice.
      if (!runtime.includes('codexRenameWithRetry')) {
        runtime = replaceOnce(runtime, 'await fsp.rename(temp, file);', 'await codexRenameWithRetry(temp, file);', file);
        runtime = runtime.replace(/(#![^\n]*\n)/, '$1import { renameWithRetry as codexRenameWithRetry } from "./codex-annotation-server.mjs";\n');
      }
      if ((entry === 'server.mjs' || skill === 'codex-dashboard') && !runtime.includes('codexSameCommentRevision')) {
        runtime = runtime.replace(/(#![^\n]*\n)/, '$1import { sameCommentRevision as codexSameCommentRevision } from "./codex-annotation-server.mjs";\n');
        runtime = replaceOnce(runtime, 'if (t) markDelivered(t, now(), "hook");', 'if (!codexSameCommentRevision(t, thread)) return false;\n          markDelivered(t, now(), "hook");\n          return true;', file);
        runtime = replaceOnce(runtime, 'child.on("exit", (code) => {\n        hookRunning.delete(thread.id);\n        if (code !== 0) {', 'child.on("exit", (code) => {\n        if (code !== 0) {\n          hookRunning.delete(thread.id);', file);
        const oldTail = ['        }).then(() => {', '          log(`comments: sent to the agent (hook): ${thread.id}`);', '          return broadcast();', '        }).catch((error) => log(`comments: ${error.message}`));'].join('\n');
        const newTail = ['        }).then(async (delivered) => {', '          hookRunning.delete(thread.id);', '          log(`comments: sent captured revision to the agent (hook): ${thread.id}`);', '          await broadcast();', '          if (!delivered) await deliver();', '        }).catch((error) => { hookRunning.delete(thread.id); log(`comments: ${error.message}`); });'].join('\n');
        runtime = replaceOnce(runtime, oldTail, newTail, file);
      }
      await fs.writeFile(file, runtime);
    }
    const editor = path.join(scripts, 'editor/index.html');
    let html = await fs.readFile(editor, 'utf8');
    if (html.includes('data-baoyu-codex-annotations')) html = html.replace(/<script\b[^>]*data-baoyu-codex-annotations[^>]*><\/script>/, tag);
    else {
      html = replaceOnce(html, '</head>', tag + '\n</head>', editor);
    }
    await fs.writeFile(editor, html);
    await fs.writeFile(path.join(scripts, 'browser-annotations.js'), adapter);
    await fs.writeFile(path.join(scripts, 'codex-annotation-server.mjs'), serverModule);
    const filename = path.join(scripts, skill === 'codex-dashboard' ? 'artifact.mjs' : 'server.mjs');
    let source = await fs.readFile(filename, 'utf8');
    if (source.includes('serveCodexAnnotation')) continue;
    source = source.replace(/(#![^\n]*\n)/, '$1import { serveCodexAnnotation } from "./codex-annotation-server.mjs";\n');
    if (skill === 'codex-dashboard') {
      source = replaceOnce(source, 'const p = url2.pathname;', 'const p = url2.pathname;\n      if (await serveCodexAnnotation(req, res, p, root, "codex-dashboard", import.meta.url)) return;', filename);
    } else {
      source = replaceOnce(source, 'const route = async (request, response, rest) => {', `const route = async (request, response, rest) => {\n    if (await serveCodexAnnotation(request, response, rest, root, ${JSON.stringify(skill)}, import.meta.url)) return;`, filename);
    }
    await fs.writeFile(filename, source);
  }
}
