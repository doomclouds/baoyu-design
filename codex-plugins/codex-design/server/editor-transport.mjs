import { randomUUID } from 'node:crypto';
import { isValidBase64 } from '../scripts/base64.mjs';
export { isValidBase64 };

const fail = (code, message) => Object.assign(new Error(message), { code });
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_HEADERS = new Set(['content-type', 'accept', 'if-match', 'if-none-match', 'last-event-id', 'x-filename']);
const RESPONSE_HEADERS = ['content-type', 'content-disposition', 'etag', 'last-modified', 'cache-control'];
const MAX_BODY = 32 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;

export function editorRequestUrl(base, relative) {
  const root = new URL(base);
  if (root.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname)
    || root.username || root.password || !root.pathname.endsWith('/')) throw fail('INVALID_EDITOR_URL', 'An authenticated local editor session is required.');
  if (typeof relative !== 'string' || relative.length > 4096 || /[\\\u0000-\u0020]/.test(relative)
    || relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(relative)) throw fail('INVALID_EDITOR_REQUEST', 'Only a request inside this artwork editor is accepted.');
  const path = relative.split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw fail('INVALID_EDITOR_REQUEST', 'Invalid editor request encoding.'); }
  if (decoded.includes('\\') || /[\u0000-\u001f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')
    || /%2f|%5c|%2e/i.test(decoded)) throw fail('INVALID_EDITOR_REQUEST', 'Editor requests cannot escape their artwork session.');
  const target = new URL(relative, root);
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname) || target.hash) throw fail('INVALID_EDITOR_REQUEST', 'Editor requests cannot escape their artwork session.');
  return target;
}

async function limitedBody(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw fail('EDITOR_RESPONSE_TOO_LARGE', 'The editor response exceeds the transfer limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

// The native MCP sandbox does not permit local HTTP frames. Only the server
// talks to an already verified editor, and every request stays within its grant.
export function createEditorTransport({ editorFor, fetcher = fetch, idleMs = 120_000 } = {}) {
  const streams = new Map();
  const get = async (id, relative) => {
    const editor = await editorFor(id);
    return { editor, url: editorRequestUrl(editor.url, relative) };
  };
  const close = stream => { stream.closed = true; clearTimeout(stream.expiry); stream.abort.abort(); streams.delete(stream.id); };
  const touch = stream => { clearTimeout(stream.expiry); stream.expiry = setTimeout(() => close(stream), idleMs); stream.expiry.unref?.(); };
  const pump = async stream => {
    let buffer = '';
    const decoder = new TextDecoder();
    const record = block => {
      const lines = block.split('\n');
      let event = 'message', data = [], id;
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
      if (!data.length) return;
      stream.events.push({ cursor: ++stream.cursor, event, data: data.join('\n'), ...(id === undefined ? {} : { id }) });
      if (stream.events.length > 128) stream.events.shift();
      for (const wake of stream.waiters) wake();
      stream.waiters.clear();
    };
    try {
      for await (const chunk of stream.response.body) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 4 * 1024 * 1024) throw fail('EDITOR_EVENT_TOO_LARGE', 'The editor event exceeds the transfer limit.');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) { record(buffer.slice(0, end)); buffer = buffer.slice(end + 2); }
      }
    } catch (error) { if (!stream.closed) stream.error = { code: error.code || 'EDITOR_EVENTS_FAILED', message: error.message }; }
    finally { stream.ended = true; for (const wake of stream.waiters) wake(); stream.waiters.clear(); }
  };
  return {
    async request(id, request = {}) {
      const { url } = await get(id, request.path);
      const method = String(request.method || 'GET').toUpperCase();
      if (!METHODS.has(method)) throw fail('INVALID_EDITOR_REQUEST', 'Unsupported editor request method.');
      const headers = new Headers();
      if (request.headers && (typeof request.headers !== 'object' || Array.isArray(request.headers))) throw fail('INVALID_EDITOR_REQUEST', 'Invalid editor request headers.');
      for (const [name, value] of Object.entries(request.headers || {})) {
        if (!REQUEST_HEADERS.has(name.toLowerCase()) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw fail('INVALID_EDITOR_REQUEST', 'Unsupported editor request header.');
        headers.set(name, value);
      }
      headers.set('origin', url.origin);
      let body;
      if (request.body !== undefined) {
        if (typeof request.body !== 'string' || request.body.length > Math.ceil(MAX_BODY / 3) * 4 || !isValidBase64(request.body)) throw fail('INVALID_EDITOR_REQUEST', 'Invalid editor request body.');
        body = Buffer.from(request.body, 'base64');
        if (body.length > MAX_BODY || method === 'GET' || method === 'HEAD') throw fail('INVALID_EDITOR_REQUEST', 'Invalid editor request body.');
      }
      const response = await fetcher(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw fail('INVALID_EDITOR_REQUEST', 'Use the editor event subscription for a live stream.'); }
      const bytes = await limitedBody(response, MAX_RESPONSE);
      return { status: response.status, statusText: response.statusText, headers: Object.fromEntries(RESPONSE_HEADERS.flatMap(name => response.headers.has(name) ? [[name, response.headers.get(name)]] : [])), body: bytes.toString('base64') };
    },
    async openEvents(id, path) {
      const { url } = await get(id, path);
      if (!/(?:^|\/)events$/.test(url.pathname)) throw fail('INVALID_EDITOR_REQUEST', 'Only editor event endpoints can be subscribed.');
      const abort = new AbortController();
      let response;
      const startup = setTimeout(() => abort.abort(), 10_000);
      try { response = await fetcher(url, { headers: { accept: 'text/event-stream', origin: url.origin }, redirect: 'error', signal: abort.signal }); }
      finally { clearTimeout(startup); }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) { abort.abort(); throw fail('EDITOR_EVENTS_FAILED', 'The local editor did not open its event stream.'); }
      const stream = { id: randomUUID(), artifactId: id, response, abort, events: [], cursor: 0, waiters: new Set(), closed: false, ended: false };
      streams.set(stream.id, stream); touch(stream); void pump(stream);
      return { subscriptionId: stream.id, cursor: 0 };
    },
    async pollEvents(id, subscriptionId, cursor = 0) {
      const stream = streams.get(subscriptionId);
      if (!stream || stream.artifactId !== id || stream.closed) throw fail('EDITOR_SUBSCRIPTION_UNAVAILABLE', 'The editor event subscription has closed.');
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.cursor) throw fail('INVALID_EDITOR_REQUEST', 'Invalid editor event cursor.');
      touch(stream);
      if (!stream.ended && stream.cursor <= cursor) await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); stream.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 1_000); stream.waiters.add(wake);
      });
      return { events: stream.events.filter(event => event.cursor > cursor), cursor: stream.cursor, ended: stream.ended, ...(stream.error ? { error: stream.error } : {}) };
    },
    async closeEvents(id, subscriptionId) {
      const stream = streams.get(subscriptionId);
      if (stream && stream.artifactId === id) close(stream);
      return { closed: true };
    },
    dispose() { for (const stream of streams.values()) close(stream); },
  };
}
