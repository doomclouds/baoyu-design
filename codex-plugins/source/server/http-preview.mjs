import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from '../library/index.mjs';
import { atomicJson, readJson, safePath, statOrNull, locked } from '../library/safety.mjs';
import { getWorkerStatus } from '../scripts/worker-client.mjs';
import { createDesignService } from './service.mjs';

export const PREVIEW_STATE = '_state/library-preview.json';
const KIND = 'codex-design-library-preview';
const error = (code, message) => Object.assign(new Error(message), { code });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (cause) { return cause.code === 'EPERM'; } };
const detail = cause => ({ code: cause.code || 'PREVIEW_ERROR', message: String(cause.message || cause).slice(0, 2_000) });
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

// Same fail-closed native task policy as the MCP service; no agent is created or interrupted.
export async function previewNativeActivity(record) {
  try { const status = await getWorkerStatus(record.path); return status.counts.active > 0 ? { busy: true, reason: 'An unfinished native design job is recorded for this artwork.' } : false; }
  catch { return { busy: true, reason: 'The artwork task state cannot be verified.' }; }
}

function verifiedState(state, root) {
  if (!state || state.version !== 1 || state.kind !== KIND || !Number.isInteger(state.pid) || state.pid <= 0 || typeof state.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state.token) || typeof state.instanceId !== 'string' || !samePath(state.root, root)) throw error('INVALID_PREVIEW_STATE', 'The preview record cannot identify this library.');
  let url; try { url = new URL(state.url); } catch { throw error('INVALID_PREVIEW_STATE', 'The preview URL is invalid.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== `/${state.token}/` || !url.port) throw error('INVALID_PREVIEW_STATE', 'Only the recorded loopback preview URL is accepted.');
  return url;
}

export async function libraryPreviewStatus({ root = createLibraryStore().root, timeoutMs = 2_000 } = {}) {
  root = path.resolve(root);
  if (!await statOrNull(root)) return { running: false, root };
  const state = await readJson(root, PREVIEW_STATE, null);
  if (!state) return { running: false, root };
  const url = verifiedState(state, root);
  if (!alive(state.pid)) return { running: false, stale: true, root, state };
  try {
    const response = await fetch(new URL('session', url), { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const session = response.ok ? await response.json() : null;
    if (!session || session.kind !== KIND || session.pid !== state.pid || session.instanceId !== state.instanceId || !samePath(session.root, root)) throw error('PREVIEW_IDENTITY_UNVERIFIED', 'A live PID did not confirm this preview identity.');
    return { running: true, root, url: state.url, pid: state.pid, instanceId: state.instanceId, state };
  } catch { throw error('PREVIEW_IDENTITY_UNVERIFIED', 'The recorded live process did not confirm this library preview. No process was stopped.'); }
}

export async function stopLibraryPreview(options = {}) {
  const status = await libraryPreviewStatus(options);
  if (!status.running) return { stopped: false, running: false, root: status.root };
  const url = new URL(status.url);
  const response = await fetch(new URL('shutdown', url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceId: status.instanceId }) });
  const result = await response.json();
  if (!response.ok || result.instanceId !== status.instanceId || result.stopping !== true) throw error('PREVIEW_STOP_REFUSED', 'The preview did not accept its authenticated shutdown.');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const recorded = await readJson(status.root, PREVIEW_STATE, null);
    if (!recorded || recorded.instanceId !== status.instanceId) return { stopped: true, root: status.root, pid: status.pid };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { stopped: false, stopping: true, root: status.root, pid: status.pid };
}

function builtHtml(html, endpoint, eventsUrl, nonce) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8 * 1024 * 1024 || !/<head\b/i.test(html)) throw error('INVALID_PREVIEW_UI', 'The built UI is missing or exceeds its size limit.');
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scripts)) if (/\bsrc\s*=/i.test(match[1])) throw error('UI_NOT_BUNDLED', 'Use a published or staged plugin whose ui/index.html has inline assets.');
  if (/<link\b[^>]*\brel\s*=\s*["']stylesheet["']/i.test(html.replace(scripts, ''))) throw error('UI_NOT_BUNDLED', 'Use a published or staged plugin whose ui/index.html has inline assets.');
  const config = `<script nonce="${nonce}">window.codexDesignHttpEndpoint=${JSON.stringify(endpoint)};window.codexDesignEventsUrl=${JSON.stringify(eventsUrl)};</script>`;
  return html.replace(scripts, (_, attributes, body) => `<script nonce="${nonce}"${attributes}>${body}</script>`).replace(/<head\b[^>]*>/i, head => head + config);
}
async function requestJson(request, maximum) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) { request.resume(); throw error('UNSUPPORTED_MEDIA_TYPE', 'Expected application/json.'); }
  if (Number(request.headers['content-length'] || 0) > maximum) { request.resume(); throw error('REQUEST_TOO_LARGE', 'The request exceeds the preview limit.'); }
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > maximum) { request.resume(); throw error('REQUEST_TOO_LARGE', 'The request exceeds the preview limit.'); } chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw error('INVALID_JSON', 'Expected one JSON object.'); }
}

export async function startLibraryPreview({ root, pluginRoot = fileURLToPath(new URL('../', import.meta.url)), store, service, html, port = 0, maxRequestBytes = 17 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw error('INVALID_PREVIEW_OPTION', 'Invalid preview port or request limit.');
  store ||= createLibraryStore({ ...(root === undefined ? {} : { root }), isBusy: previewNativeActivity });
  await store.initialize(); root = store.root; pluginRoot = path.resolve(pluginRoot);
  service ||= createDesignService({ store, pluginRoot });
  if (html === undefined) html = await fs.readFile(path.join(pluginRoot, 'ui', 'index.html'), 'utf8');
  const token = randomBytes(32).toString('base64url'), instanceId = randomUUID(), nonce = randomBytes(18).toString('base64');
  const prefix = `/${token}/`, subscribers = new Set(), timers = new Map();
  let origin, servedHtml, state, closed = false;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: 'self'; font-src data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'`;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': csp, 'Cross-Origin-Resource-Policy': 'same-origin' };
  const json = (response, status, value, extra = {}) => {
    const body = JSON.stringify(value); response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra }); response.end(body);
  };
  const broadcast = event => { for (const response of subscribers) response.write('data: ' + JSON.stringify(event) + '\n\n'); };
  let server;
  const close = async () => {
    if (closed) return; closed = true;
    for (const response of subscribers) { clearInterval(timers.get(response)); response.end(); } subscribers.clear(); timers.clear();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
    await locked(root, async () => {
      const recorded = await readJson(root, PREVIEW_STATE, null);
      if (recorded?.instanceId === instanceId) await fs.unlink(await safePath(root, PREVIEW_STATE, { type: 'file' }));
    });
  };
  server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    try {
      if (!origin || request.headers.host !== new URL(origin).host) { request.resume(); return json(response, 421, { error: { code: 'INVALID_HOST', message: 'Unexpected Host header.' } }); }
      const route = (request.url || '').split('?')[0];
      if (!route.startsWith(prefix) || route.includes('%') || route.includes('\\') || route.includes('/../')) { request.resume(); return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }); }
      const suppliedOrigin = request.headers.origin;
      const topNavigation = route === prefix && ['GET', 'HEAD'].includes(request.method) && request.headers['sec-fetch-mode'] === 'navigate';
      if (suppliedOrigin !== undefined && suppliedOrigin !== origin || request.headers['sec-fetch-site'] === 'cross-site' && !topNavigation) { request.resume(); return json(response, 403, { error: { code: 'ORIGIN_REFUSED', message: 'Cross-origin requests are refused.' } }); }
      if (route === prefix && ['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(servedHtml) }); response.end(request.method === 'HEAD' ? undefined : servedHtml); return;
      }
      if (route === prefix + 'session' && ['GET', 'HEAD'].includes(request.method)) return json(response, 200, { kind: KIND, pid: process.pid, instanceId, root, startedAt: state.startedAt });
      if (route === prefix + 'events' && request.method === 'GET') {
        if (subscribers.size >= 16) return json(response, 429, { error: { code: 'TOO_MANY_CLIENTS', message: 'Too many preview event clients.' } });
        response.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); response.write(': preview events\n\n'); subscribers.add(response);
        const timer = setInterval(() => response.write(': ping\n\n'), 15_000); timer.unref(); timers.set(response, timer);
        response.on('close', () => { clearInterval(timer); timers.delete(response); subscribers.delete(response); }); return;
      }
      if (![prefix + 'api', prefix + 'shutdown'].includes(route)) { request.resume(); return json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }); }
      if (request.method !== 'POST') { request.resume(); return json(response, 405, { error: { code: 'METHOD_REFUSED', message: 'Use POST.' } }, { Allow: 'POST' }); }
      if (suppliedOrigin !== origin) { request.resume(); return json(response, 403, { error: { code: 'ORIGIN_REQUIRED', message: 'A matching Origin is required for preview actions.' } }); }
      const body = await requestJson(request, maxRequestBytes);
      if (route.endsWith('/shutdown')) {
        if (body.instanceId !== instanceId) return json(response, 403, { error: { code: 'IDENTITY_REFUSED', message: 'The preview instance changed.' } });
        json(response, 200, { stopping: true, instanceId }); setImmediate(() => close().catch(() => {})); return;
      }
      if (typeof body.action !== 'string' || body.action.length > 100 || body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))) return json(response, 400, { error: { code: 'INVALID_ACTION', message: 'Expected {action, payload}.' } });
      const result = await service.invoke(body.action, body.payload || {}); json(response, 200, { result });
      if (body.action.startsWith('view.')) broadcast({ type: 'view.changed', ...(result?.tabs ? { viewState: result } : {}) });
      else if (body.action.startsWith('library.') && !['library.list', 'library.get', 'library.listSnapshots', 'library.exportArtifact'].includes(body.action)) broadcast({ type: 'library.changed' });
    } catch (cause) {
      if (response.headersSent) { response.destroy(); return; }
      const status = cause.code === 'REQUEST_TOO_LARGE' ? 413 : cause.code === 'UNSUPPORTED_MEDIA_TYPE' ? 415 : cause.code === 'NOT_FOUND' ? 404 : ['ARTIFACT_BUSY', 'LIBRARY_BUSY', 'BINDING_CONFLICT'].includes(cause.code) ? 409 : 400;
      json(response, status, { error: detail(cause) });
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  try {
    await locked(root, async () => {
      const previous = await libraryPreviewStatus({ root });
      if (previous.running) throw error('PREVIEW_ALREADY_RUNNING', 'This library preview is already running at ' + previous.url);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      origin = `http://127.0.0.1:${server.address().port}`;
      state = { version: 1, kind: KIND, root, pluginRoot, pid: process.pid, instanceId, token, url: origin + prefix, startedAt: new Date().toISOString() };
      servedHtml = builtHtml(html, origin + prefix + 'api', origin + prefix + 'events', nonce);
      await atomicJson(root, PREVIEW_STATE, state);
    });
  } catch (cause) { if (server.listening) await new Promise(resolve => server.close(resolve)); throw cause; }
  return { url: state.url, endpoint: origin + prefix + 'api', eventsUrl: origin + prefix + 'events', token, instanceId, pid: process.pid, root, close };
}
