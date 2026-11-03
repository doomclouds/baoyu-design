import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const skills = ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard', 'codex-motion'];

// Written next to each generated server, never into the upstream skills.
const serverModule = String.raw`import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const nativeSession = () => process.env.CODEX_DESIGN_NATIVE_SESSION === '1';
export function assertNativeNetwork({host, lan = false}) {
  if (!lan && ['127.0.0.1', 'localhost', '::1'].includes(host)) return;
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
const editorKinds = { 'codex-slides': 'slides', 'codex-design': 'design', 'codex-design-system': 'design-system', 'codex-dashboard': 'dashboard', 'codex-motion': 'motion' };
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
  if (skill === 'codex-motion') {
    const meta = await readJson(path.join(root, 'db/film/meta.json'));
    const objects = [];
    for (const name of (await files(path.join(root, 'db/modules'))).filter(name => name.endsWith('.json'))) {
      const doc = await readJson(path.join(root, 'db/modules', name));
      if (typeof doc?.text !== 'string') continue;
      const id = name.slice(0, -5);
      objects.push({id, file: 'db/modules/' + name, name: id, keys: [id]});
    }
    return {skill, projectRoot: project, title: meta?.title || path.basename(root), indexFile: 'db/film/meta.json', objects};
  }
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
  let canonical;
  try { canonical = decodeURIComponent(route).split('/').filter(Boolean).join('/'); }
  catch { canonical = route; }
  if (nativeSession() && /^__ds-sync\//.test(canonical) && request.method === 'POST') {
    request.resume?.();
    response.writeHead(403, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(JSON.stringify({code: 'DS_SYNC_CONFIRMATION_REQUIRED', message: 'Review and confirm this design-system sync through the native workspace.'}));
    return true;
  }
  if (nativeSession() && /^__comments\/(?:agent\/|[^/]+\/send(?:\/|$))/.test(canonical)) {
    request.resume?.();
    response.writeHead(403, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(JSON.stringify({code: 'NATIVE_COMMENT_DELIVERY_REQUIRED', message: 'Use native Add to chat and the registered native worker.'}));
    return true;
  }
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
`;

function replaceOnce(source, needle, replacement, filename) {
  const first = source.indexOf(needle);
  if (first < 0 || first !== source.lastIndexOf(needle)) throw new Error(`Annotation patch anchor missing or ambiguous in ${filename}: ${needle}`);
  return source.replace(needle, replacement);
}

function adaptAtomicCommentRename(runtime, file) {
  // Upstream Dashboard bundles several fs aliases and archive writes. Patch
  // only the comments transaction's atomic replacement, not the first rename.
  const expression = /(async function writeAtomic\d*\(file, text\) \{\n  const temp = [^\n]+;\n  await ([\w$]+)\.writeFile\(temp, text\);\n  try \{\n    )await \2\.rename\(temp, file\);/g;
  const matches = [...runtime.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`Comment atomic rename anchor missing or ambiguous in ${file}`);
  return runtime.replace(expression, '$1await codexRenameWithRetry(temp, file);');
}

function adaptNativeNetwork(runtime, file) {
  if (!runtime.includes('var ShareHost = class {') || runtime.includes('codexAssertNativeNetwork')) return runtime;
  runtime = replaceOnce(runtime, 'async function serveHub(call) {',
    'async function serveHub(call) {\n  codexAssertNativeNetwork({host: call.host, lan: call.lan});', file);
  runtime = replaceOnce(runtime, 'const linksPort = !call.portGiven && (call.lan || sharing.lan) ? sharing.port : void 0;',
    'const linksPort = !codexNativeSession() && !call.portGiven && (call.lan || sharing.lan) ? sharing.port : void 0;', file);
  runtime = replaceOnce(runtime, '  async start(lan = false) {\n    const { state } = this.sharing;',
    '  async start(lan = false) {\n    return; // Codex Design does not open LAN listeners or restore sharing state.\n    const { state } = this.sharing;', file);
  // A native artwork must not join a standalone preview's Hub, whose sharing
  // policy is determined by the process that first started it.
  runtime = replaceOnce(runtime, 'const info = { hub: 1, kind: this.kind, build: this.build, host: this.host, pid: process.pid };',
    'const info = { hub: 1, kind: this.kind, build: this.build, host: this.host, pid: process.pid, nativeSession: codexNativeSession() };', file);
  runtime = replaceOnce(runtime, 'if (!info || info.kind !== call.kind || info.build !== build || info.host !== call.host) continue;',
    'if (!info || info.kind !== call.kind || info.build !== build || info.host !== call.host || info.nativeSession !== codexNativeSession()) continue;', file);
  runtime = replaceOnce(runtime, '  async setLan(on) {', '  async setLan(on) {\n    if (on) codexAssertNativeNetwork({host: "127.0.0.1", lan: true});', file);
  // Root Share API writes include Copy link's implicit LAN enable. Folder ZIP
  // and exports-to-exports writes also bypass Codex's content-only Save As.
  // Preserve their standalone behavior, but refuse them in internal services.
  runtime = replaceOnce(runtime, '    if (!ours) return false;', [
    '    if (!ours) return false;',
    '    if (!["GET", "HEAD"].includes(method) || p === "/__share/archive" || p === "/__share/save") {',
    '      request.resume();',
    '      response.writeHead(403, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}).end(JSON.stringify({code: "native_local_only", message: "Use the native artwork and Save As controls."}));',
    '      return true;',
    '    }',
  ].join('\n'), file);
  return runtime.replace(/(#![^\n]*\n)/, '$1import { nativeSession as codexNativeSession, assertNativeNetwork as codexAssertNativeNetwork } from "./codex-annotation-server.mjs";\n');
}

function adaptIndependentServices(runtime, file) {
  const marker = '// codex-design:single-artwork-service-v1';
  if (runtime.includes(marker)) return runtime;
  const join = /async function joinHub\(call, below = Infinity\) \{[\s\S]*?\n\}\n(?=async function leaveHub\(state\))/g;
  if ([...runtime.matchAll(join)].length !== 1) throw new Error(`Independent service join anchor changed in ${file}`);
  runtime = runtime.replace(join, `async function joinHub(call, below = Infinity) {\n  ${marker}\n  return null;\n}\n`);
  if (runtime.includes('async function serveHub(call) {')) {
    runtime = replaceOnce(runtime, 'async function serveHub(call) {',
      'async function serveHub(call) {\n  if (call.agentHook) throw Object.assign(new Error("Use native Add to chat and the registered native worker."), {code: "NATIVE_COMMENT_DELIVERY_REQUIRED"});', file);
    runtime = replaceOnce(runtime, '    if (body.action === "mount") {',
      '    if (body.action === "mount") {\n      return response.writeHead(403, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}).end(JSON.stringify({code: "SINGLE_ARTWORK_SERVICE", message: "This process serves one artwork; open the other artwork in its own process."}));', file);
  }
  if (runtime.includes('async function waitComments(')) {
    const wait = /async function waitComments\((?:a|root), flags\) \{/g;
    if ([...runtime.matchAll(wait)].length !== 1) throw new Error(`Legacy comment wait anchor changed in ${file}`);
    runtime = runtime.replace(wait, '$&\n  throw Object.assign(new Error("Use native Add to chat and worker-next; upstream comment waiting is disabled."), {code: "NATIVE_COMMENT_DELIVERY_REQUIRED"});');
  }
  if (runtime.includes('    case "ds-sync": {')) {
    runtime = replaceOnce(runtime, '    case "ds-sync": {',
      '    case "ds-sync": {\n      if (!flags.has("check")) throw Object.assign(new Error("Review and confirm design-system synchronization through codex-artifact.mjs; the raw CLI cannot overwrite the installed copy."), {code: "DS_SYNC_CONFIRMATION_REQUIRED"});', file);
  }
  return runtime;
}

export async function adaptAnnotations(pluginRoot) {
  const adapter = await fs.readFile(path.join(here, 'source/scripts/browser-annotations.js'));
  const integrity = 'sha384-' + createHash('sha384').update(adapter).digest('base64');
  const tag = `<script defer src="./__codex/annotations.js" integrity="${integrity}" data-baoyu-codex-annotations></script>`;
  for (const skill of skills) {
    const scripts = path.join(pluginRoot, 'skills', skill, 'scripts');
    const singleFile = ['codex-dashboard', 'codex-motion'].includes(skill);
    // Detached servers and comment hook commands must not flash console windows
    // when the generated plugin is run from Codex desktop on Windows.
    for (const entry of singleFile ? ['artifact.mjs'] : ['artifact.mjs', 'server.mjs']) {
      const file = path.join(scripts, entry);
      let runtime = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
      const upstreamName = skill.replace(/^codex-/, 'claude-');
      // Rename our CLI presentation only. Compatibility identifiers, reserved
      // source filenames, and third-party/license records stay unchanged.
      runtime = runtime.replace(new RegExp(`^// ${upstreamName}:`, 'm'), `// ${skill}:`);
      if (entry === 'artifact.mjs') {
        const prefix = singleFile ? 'var USAGE = `' : 'var USAGE = `${"';
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
      runtime = runtime.replace(/(spawn\d*\(command\d*, \{\r?\n\s*shell: true,)(?!\r?\n\s*windowsHide:)/g, '$1\n        windowsHide: true,');
      runtime = adaptNativeNetwork(runtime, file);
      runtime = adaptIndependentServices(runtime, file);
      // Retry the rename alone, retaining the same temporary file and lock.
      // Re-running updateComments could apply the user's mutation twice.
      if (!runtime.includes('codexRenameWithRetry')) {
        runtime = adaptAtomicCommentRename(runtime, file);
        runtime = runtime.replace(/(#![^\n]*\n)/, '$1import { renameWithRetry as codexRenameWithRetry } from "./codex-annotation-server.mjs";\n');
      }
      if ((entry === 'server.mjs' || singleFile) && !runtime.includes('codexSameCommentRevision')) {
        runtime = runtime.replace(/(#![^\n]*\n)/, '$1import { sameCommentRevision as codexSameCommentRevision } from "./codex-annotation-server.mjs";\n');
        runtime = replaceOnce(runtime, 'if (t) markDelivered(t, now(), "hook");', 'if (!codexSameCommentRevision(t, thread)) return false;\n          markDelivered(t, now(), "hook");\n          return true;', file);
        runtime = replaceOnce(runtime, 'child.on("exit", (code) => {\n        hookRunning.delete(thread.id);\n        if (code !== 0) {', 'child.on("exit", (code) => {\n        if (code !== 0) {\n          hookRunning.delete(thread.id);', file);
        const log = skill === 'codex-motion' ? 'log3' : 'log';
        const oldTail = ['        }).then(() => {', `          ${log}(\`comments: sent to the agent (hook): \${thread.id}\`);`, '          return broadcast();', `        }).catch((error) => ${log}(\`comments: \${error.message}\`));`].join('\n');
        const newTail = ['        }).then(async (delivered) => {', '          hookRunning.delete(thread.id);', `          ${log}(\`comments: sent captured revision to the agent (hook): \${thread.id}\`);`, '          await broadcast();', '          if (!delivered) await deliver();', `        }).catch((error) => { hookRunning.delete(thread.id); ${log}(\`comments: \${error.message}\`); });`].join('\n');
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
    const filename = path.join(scripts, singleFile ? 'artifact.mjs' : 'server.mjs');
    let source = await fs.readFile(filename, 'utf8');
    if (source.includes('serveCodexAnnotation')) continue;
    source = source.replace(/(#![^\n]*\n)/, '$1import { serveCodexAnnotation } from "./codex-annotation-server.mjs";\n');
    if (skill === 'codex-motion') {
      source = replaceOnce(source, '      const p = url.pathname;', '      const p = url.pathname;\n      if (await serveCodexAnnotation(req, res, p, root, "codex-motion", import.meta.url, { viewer, bootScript: (query) => share2.bootScript(viewer, query) })) return;', filename);
    } else if (skill === 'codex-dashboard') {
      source = replaceOnce(source, '      const p = url.pathname;', '      const p = url.pathname;\n      if (await serveCodexAnnotation(req, res, p, root, "codex-dashboard", import.meta.url, { viewer, bootScript: (query) => share2.bootScript(viewer, query) })) return;', filename);
    } else {
      source = replaceOnce(source, 'const route = async (request, response, rest, viewer) => {', `const route = async (request, response, rest, viewer) => {\n    if (await serveCodexAnnotation(request, response, rest, root, ${JSON.stringify(skill)}, import.meta.url, { viewer, bootScript: (query) => share.bootScript(viewer, query) })) return;`, filename);
    }
    await fs.writeFile(filename, source);
  }
}
