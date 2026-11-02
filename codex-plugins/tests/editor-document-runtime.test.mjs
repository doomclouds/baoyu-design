import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from '../source/library/index.mjs';
import { createDesignService } from '../source/server/service.mjs';
import { createFixture } from './fixtures.mjs';
import http from 'node:http';

const execute = promisify(execFile);
const pluginRoot = path.resolve(process.env.CODEX_DESIGN_TEST_PLUGIN_ROOT || fileURLToPath(new URL('../codex-design/', import.meta.url)));
const cli = kind => path.join(pluginRoot, 'skills', `codex-${kind}`, 'scripts', 'codex-artifact.mjs');

test('native documents use installed chrome while the scoped data service supplies only session metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-editor-current-chrome-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root });
  const record = await store.create({ kind: 'slides', title: 'Current installed editor' });
  const requests = [];
  const data = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/old-runtime/__codex/boot.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.__baoyuHistory={base:"/old-runtime/",canRestore:true};');
    } else response.writeHead(503).end('Static editor files are unavailable from this data service.');
  });
  await new Promise(resolve => data.listen(0, '127.0.0.1', resolve));
  t.after(() => { data.closeAllConnections(); data.close(); });
  const service = createDesignService({ store, pluginRoot,
    editorOpen: async () => ({ url: `http://127.0.0.1:${data.address().port}/old-runtime/`, kind: 'slides', artifactId: record.id }) });
  const result = await service.invoke('editor.document', { id: record.id, channel: 'current-chrome-test-channel', language: 'zh' });
  assert.ok(result.html.includes('"language":"en"'), 'old caller preferences cannot change the native editor UI language');
  assert.ok(result.html.includes('__CODEX_DESIGN_EDITOR_RESOURCES__'));
  assert.ok(result.html.includes('__CODEX_DESIGN_EDITOR_FLUSH__'));
  assert.ok(result.html.includes('Current installed editor') === false, 'Document content loads through the separate data transport.');
  assert.deepEqual(requests, ['/old-runtime/__codex/boot.js'], 'packaged scripts, CSS and fonts never come from the old service');
});

async function command(kind, ...args) {
  const { stdout } = await execute(process.execPath, [cli(kind), ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '' } });
  return JSON.parse(stdout);
}

for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
  test(`${kind}: native document assembly, save and live comments use the real local editor through the scoped MCP proxy`, { timeout: 40_000 }, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-design-native-document-'));
    const fixture = await createFixture(kind, temporary);
    const store = createLibraryStore({ root: path.join(temporary, 'library') });
    let opened;
    let service;
    let subscription;
    try {
      const artifact = await store.importArtifact({ sourcePath: fixture.root, kind });
      service = createDesignService({ store, pluginRoot, editorOpen: async record => {
        opened = await command(kind, 'open-service', record.path, '--no-agent');
        return { ...opened, artifactId: record.id, kind, nativeConversationBound: false };
      } });
      const document = await service.invoke('editor.document', { id: artifact.id, channel: 'runtime-editor-channel', language: 'zh' });
      assert.equal(document.transport, 'mcp');
      assert.ok(document.bytes > 100_000);
      assert.match(document.html, /codex-design:editor-request/);
      assert.match(document.html, /https:\/\/codex-design\.invalid\/artifacts\//);
      if (kind === 'design-system') assert.match(document.html, /"previewVendors":\[\{"file":"react\.production\.min\.js","url":"data:text\/javascript;base64,/);
      for (const script of document.html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/gi)) {
        assert.equal(/\bsrc\s*=/.test(script[1]), false, 'Actual document script tags must be inline; example strings inside bundles are not tags.');
      }
      const request = async (path, method = 'GET', body) => {
        const result = await service.invoke('editor.request', { id: artifact.id, request: { path, method,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)).toString('base64') }) } });
        assert.ok(result.status < 400, `${result.status}: ${Buffer.from(result.body, 'base64').toString()}`);
        return JSON.parse(Buffer.from(result.body, 'base64').toString());
      };
      const before = await readFile(path.join(artifact.path, fixture.contentFile), 'utf8');
      if (kind === 'dashboard') {
        const changed = { ...JSON.parse(before), text: JSON.parse(before).text.replace('Monthly revenue</p>', 'Native proxy verified revenue</p>') };
        await request('_api/write', 'POST', { op: 'set', path: 'files/index.html', data: changed });
        assert.equal(JSON.parse(await readFile(path.join(artifact.path, fixture.contentFile), 'utf8')).text, changed.text);
      } else {
        const listing = await request('_files.json');
        const changed = before.replace('Codex Design verification', 'Native proxy verified');
        await request('__deck/publish', 'POST', { files: { [fixture.contentFile]: { base64: Buffer.from(changed).toString('base64'), contentType: kind === 'design-system' ? 'text/markdown' : 'text/html', ifMatch: listing.files[fixture.contentFile].sha256 } } });
        assert.equal(await readFile(path.join(artifact.path, fixture.contentFile), 'utf8'), changed);
      }
      const comment = await request('__comments', 'POST', { ...fixture.comment, text: 'Native editor proxy comment.', send: false });
      const draft = await service.invoke('editor.request', { id: artifact.id,
        request: { path: '__comments/' + comment.thread.id + '/send', method: 'POST' } });
      assert.equal(draft.nativeDraft.artifactId, artifact.id);
      assert.match(draft.nativeDraft.uri, /^codex-design:\/\/edit-requests\//);
      assert.ok(draft.nativeDraft.attemptId);
      const canonical = JSON.parse(await readFile(path.join(artifact.path, 'comments.json'), 'utf8'));
      assert.equal(canonical.threads.find(thread => thread.id === comment.thread.id).agent, undefined, 'native Add never calls the canonical delivery hook');
      await assert.rejects(readFile(path.join(artifact.path, '.codex-design-worker-jobs.json')), { code: 'ENOENT' });
      await service.invoke('request.draftAdded', { requestId: draft.nativeDraft.requestId });
      subscription = await service.invoke('editor.events.open', { id: artifact.id, path: '__comments/events' });
      const events = await service.invoke('editor.events.poll', { id: artifact.id, ...subscription });
      assert.ok(events.events.some(event => event.event === 'comments' && event.data.includes(comment.thread.id)));
      assert.ok(events.events.some(event => JSON.parse(event.data).threads.some(thread => thread.agent?.nativeRequest?.status === 'prepared')));
      const accepted = await service.operateEditRequests('accept', [draft.nativeDraft.requestId]);
      assert.deepEqual(accepted.errors, []);
      assert.equal(accepted.requests[0].status, 'accepted');
      assert.equal(accepted.requests[0].dispatchCommand.args[1], 'request-dispatch');
      const updated = await service.invoke('editor.events.poll', { id: artifact.id, subscriptionId: subscription.subscriptionId, cursor: events.cursor });
      assert.ok(updated.events.some(event => JSON.parse(event.data).threads.some(thread => thread.agent?.nativeRequest?.status === 'accepted')),
        'request state changes reach comments even when comments.json itself did not change');
      await assert.rejects(readFile(path.join(artifact.path, '.codex-design-worker-jobs.json')), { code: 'ENOENT' }, 'model receipt alone does not enqueue or invent a parent id');
      await service.invoke('editor.events.close', { id: artifact.id, ...subscription }); subscription = null;
      const createAndAdd = await service.invoke('editor.request', { id: artifact.id, request: { path: '__comments', method: 'POST',
        headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ...fixture.comment, text: 'Save before preparing a native draft.', send: true })).toString('base64') } });
      assert.ok(createAndAdd.nativeDraft.requestId);
      const created = JSON.parse(Buffer.from(createAndAdd.body, 'base64').toString());
      const saved = JSON.parse(await readFile(path.join(artifact.path, 'comments.json'), 'utf8')).threads.find(thread => thread.id === created.thread.id);
      assert.equal(saved.messages.at(-1).text, 'Save before preparing a native draft.');
      assert.equal(saved.agent, undefined);
      // Imported/legacy comment identities are legal canonical data too. Their
      // routes and encoded aliases must never fall through to the old hook.
      const legacyDoc = JSON.parse(await readFile(path.join(artifact.path, 'comments.json'), 'utf8'));
      const legacy = legacyDoc.threads.find(thread => thread.id === created.thread.id);
      legacy.id = 'legacy-thread'; legacy.messages[0].id = 'legacy-message';
      await writeFile(path.join(artifact.path, 'comments.json'), JSON.stringify(legacyDoc));
      const legacySend = await service.invoke('editor.request', { id: artifact.id,
        request: { path: '__comments//legacy-thread/%73end/', method: 'POST' } });
      assert.equal(legacySend.nativeDraft.savedCommentId, 'legacy-thread');
      const legacyEdit = await service.invoke('editor.request', { id: artifact.id, request: {
        path: '__comments/legacy-thread/messages/legacy-message', method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ text: 'Revised legacy user comment.', send: true })).toString('base64'),
      } });
      assert.equal(legacyEdit.nativeDraft.savedCommentId, 'legacy-thread');
      const adHoc = await service.invoke('editor.request', { id: artifact.id, request: {
        path: '__comments/agent/requests', method: 'POST', headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ text: 'Review the selected artwork area.', label: 'Selection', selection: 'Selected area' })).toString('base64'),
      } });
      assert.ok(adHoc.nativeDraft.savedCommentId);
      await assert.rejects(readFile(path.join(artifact.path, '.codex-design-worker-jobs.json')), { code: 'ENOENT' });
      const check = await command(kind, 'check', artifact.path);
      assert.equal(check.problems, 0, JSON.stringify(check));
    } finally {
      const records = await store.list({ includeDeleted: true }).catch(() => []);
      if (subscription && records[0]) await service.invoke('editor.events.close', { id: records[0].id, ...subscription }).catch(() => {});
      if (opened && records[0]) await command(kind, 'stop', records[0].path).catch(() => {});
      const relative = path.relative(os.tmpdir(), path.resolve(temporary));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
