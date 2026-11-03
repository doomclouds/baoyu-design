import { createHash, randomUUID } from 'node:crypto';
import { editorRequestUrl, validateEditorRequest } from './editor-transport.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const jsonResult = (value, status = 200) => ({ status, statusText: status === 200 ? 'OK' : 'Accepted', headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: encode(value) });
const parseResult = result => {
  try { return JSON.parse(Buffer.from(result.body, 'base64').toString('utf8')); }
  catch { throw fail('INVALID_COMMENT_RESPONSE', 'The comment service did not return valid JSON.'); }
};

/** Native comment delivery is a draft operation; the original HTTP preview stays unchanged. */
export function createNativeComments({ requests, transport, editorFor, pollMs = 1000, idleMs = 120_000 } = {}) {
  const streams = new Map();
  const route = async (id, relative) => {
    const editor = await editorFor(id);
    const url = editorRequestUrl(editor.url, relative);
    const base = new URL(editor.url);
    // Canonical services decode and split their routes. Match those aliases
    // before forwarding, so an encoded/trailing slash cannot reach the old hook.
    const path = decodeURIComponent(url.pathname.slice(base.pathname.length)).split('/').filter(Boolean).join('/');
    return { editor, path, url };
  };
  const project = async (id, snapshot) => {
    const value = await requests.project(id, snapshot);
    value.agent = { ...value.agent, available: true, listening: false,
      busy: value.threads.some(thread => thread.agent?.nativeRequest?.status === 'working'), hook: false };
    return value;
  };
  const snapshot = async id => {
    const result = await transport.request(id, { path: '__comments', method: 'GET' });
    if (result.status < 200 || result.status >= 300) throw fail('COMMENTS_UNAVAILABLE', 'The artwork comments could not be loaded.');
    return project(id, parseResult(result));
  };
  const prepared = async (id, threadId, response) => {
    const request = await requests.prepare({ artifactId: id, commentId: threadId });
    const title = `${request.artifact.title} · ${request.event.data.where || request.event.data.location?.file || 'Comment'}`;
    const summary = request.event.data.messages.map(message => message.text).join('\n\n');
    const body = parseResult(response);
    if (body.thread) {
      const value = await project(id, { threads: [body.thread] });
      body.thread = value.threads[0];
    }
    return { ...response, body: encode(body), nativeDraft: { requestId: request.id, attemptId: randomUUID(), savedCommentId: threadId, artifactId: id,
      uri: request.requestUri, title: title.slice(0, 300), summary: summary.slice(0, 12_000) } };
  };
  const close = stream => { clearTimeout(stream.expiry); streams.delete(stream.id); };
  const touch = stream => { clearTimeout(stream.expiry); stream.expiry = setTimeout(() => close(stream), idleMs); stream.expiry.unref?.(); };
  return {
    async request(id, request) {
      const { path, editor } = await route(id, request.path);
      const { method, body } = validateEditorRequest(request, { maxBodyBytes: editor.kind === 'motion' ? 64 * 1024 * 1024 : 32 * 1024 * 1024 });
      if (path === '__comments' && ['GET', 'HEAD'].includes(method)) {
        const result = jsonResult(await snapshot(id));
        return method === 'HEAD' ? { ...result, body: '' } : result;
      }
      const send = /^__comments\/([^/]+)\/send$/.exec(path);
      if (send && method === 'POST') {
        const current = await snapshot(id);
        const matches = current.threads.filter(item => item.id === send[1]);
        if (!matches.length && send[1].length >= 3) matches.push(...current.threads.filter(item => item.id.startsWith(send[1])));
        if (matches.length !== 1) throw fail(matches.length ? 'AMBIGUOUS_COMMENT' : 'COMMENT_NOT_FOUND', 'Select one existing comment before adding it to chat.');
        const thread = matches[0];
        return prepared(id, thread.id, jsonResult({ thread }));
      }
      const mutation = path === '__comments' && method === 'POST'
        || /^__comments\/[^/]+\/messages(?:\/[^/]+)?$/.test(path) && ['POST', 'PATCH'].includes(method);
      const adHoc = path === '__comments/agent/requests' && method === 'POST';
      if ((mutation || adHoc) && body) {
        if (body.length > 256 * 1024) throw fail('INVALID_COMMENT', 'The comment exceeds its transfer limit.');
        let input;
        try { input = JSON.parse(body.toString('utf8')); } catch { throw fail('INVALID_COMMENT', 'The comment request is not valid JSON.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_COMMENT', 'Expected a comment object.');
        if (input.send === true || adHoc) {
          const normal = adHoc ? { anchor: 'request:' + randomUUID(), label: input.label || 'Artwork request', text: input.text,
            ...(input.selection ? { detail: input.selection } : {}), send: false } : { ...input, send: false };
          // Preserve the canonical comment lock, author and response shape, while
          // preventing its old hook from enqueuing anything before native Send.
          const result = await transport.request(id, { ...request, path: adHoc ? '__comments' : request.path, body: encode(normal) });
          if (result.status < 200 || result.status >= 300) return result;
          const saved = parseResult(result);
          if (!saved.thread?.id) throw fail('INVALID_COMMENT_RESPONSE', 'The saved comment has no identity.');
          return prepared(id, saved.thread.id, adHoc ? { ...result, body: encode({ ...saved, request: { id: saved.thread.id } }) } : result);
        }
      }
      return transport.request(id, request);
    },
    async openEvents(id, path) {
      const found = await route(id, path);
      if (found.path !== '__comments/events') return transport.openEvents(id, path);
      const stream = { id: randomUUID(), artifactId: id, cursor: 0, events: [], fingerprint: null, lastPoll: 0 };
      streams.set(stream.id, stream); touch(stream);
      return { subscriptionId: stream.id, cursor: 0 };
    },
    async pollEvents(id, subscriptionId, cursor = 0) {
      const stream = streams.get(subscriptionId);
      if (!stream) return transport.pollEvents(id, subscriptionId, cursor);
      if (stream.artifactId !== id) throw fail('EDITOR_SUBSCRIPTION_UNAVAILABLE', 'This comment stream belongs to another artwork.');
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stream.cursor) throw fail('INVALID_EDITOR_REQUEST', 'Invalid comment event cursor.');
      touch(stream);
      const delay = Math.max(0, pollMs - (Date.now() - stream.lastPoll));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (!streams.has(subscriptionId)) return { events: [], cursor: stream.cursor, ended: true };
      const value = await snapshot(id);
      const data = JSON.stringify(value), fingerprint = createHash('sha256').update(data).digest('hex');
      if (fingerprint !== stream.fingerprint) {
        stream.fingerprint = fingerprint;
        stream.events.push({ cursor: ++stream.cursor, event: 'comments', data });
        if (stream.events.length > 128) stream.events.shift();
      }
      stream.lastPoll = Date.now();
      return { events: stream.events.filter(item => item.cursor > cursor), cursor: stream.cursor, ended: false };
    },
    async closeEvents(id, subscriptionId) {
      const stream = streams.get(subscriptionId);
      if (!stream) return transport.closeEvents(id, subscriptionId);
      if (stream.artifactId !== id) throw fail('EDITOR_SUBSCRIPTION_UNAVAILABLE', 'This comment stream belongs to another artwork.');
      close(stream); return { closed: true };
    },
    dispose() { for (const stream of streams.values()) close(stream); },
  };
}
