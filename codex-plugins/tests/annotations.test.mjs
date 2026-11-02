import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { adaptAnnotations } from '../adapt-annotations.mjs';
import { createFixture } from './fixtures.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const browserSource = await fs.readFile(new URL('../source/scripts/browser-annotations.js', import.meta.url), 'utf8');
const names = ['codex-slides', 'codex-design', 'codex-design-system', 'codex-dashboard'];
const upstreamNames = {'codex-slides': 'claude-slides', 'codex-design': 'claude-design', 'codex-design-system': 'claude-design-system', 'codex-dashboard': 'claude-dashboard'};
let temporary, pluginRoot, serverModule;
const execFileAsync = promisify(execFile);

test.before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'baoyu-annotations-'));
  pluginRoot = path.join(temporary, 'plugin');
  for (const name of names) {
    const source = path.join(repository, 'skills', upstreamNames[name], 'scripts');
    const target = path.join(pluginRoot, 'skills', name, 'scripts');
    await fs.mkdir(path.join(target, 'editor'), {recursive: true});
    for (const relative of ['artifact.mjs', ...(name === 'codex-dashboard' ? ['editor/local-host.js', 'editor/comments.js'] : ['server.mjs']), 'editor/index.html', 'editor/share-ui.js']) await fs.copyFile(path.join(source, relative), path.join(target, relative));
  }
  await adaptAnnotations(pluginRoot);
  serverModule = await import(pathToFileURL(path.join(pluginRoot, 'skills/codex-slides/scripts/codex-annotation-server.mjs')));
});
test.after(async () => { await fs.rm(temporary, {recursive: true, force: true}); });

test('real reply CLI checks the captured user revision inside its comment transaction', async () => {
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const fixture = await createFixture(kind, temporary);
    const filename = path.join(fixture.root, 'comments.json');
    const at = '2026-10-31T00:00:00.000Z';
    const thread = {id: 'c_revision', anchor: fixture.comment.anchor, label: fixture.comment.label, detail: fixture.comment.detail,
      status: 'open', createdAt: at, updatedAt: at,
      messages: [{id: 'm_revision', author: {kind: 'user', name: 'test'}, text: 'Request A', at}]};
    const doc = {version: 1, threads: [thread]};
    await fs.writeFile(filename, JSON.stringify(doc));
    const expected = createHash('sha256').update(JSON.stringify([{text: 'Request A', at}])).digest('hex');
    assert.equal(serverModule.userRevisionHash(thread), expected);
    const cli = path.join(pluginRoot, 'skills', fixture.skill, 'scripts/artifact.mjs');
    const guardedEnv = {...process.env, CODEX_DESIGN_EXPECTED_USER_REVISION: expected};
    await execFileAsync(process.execPath, [cli, 'comment-reply', fixture.root, thread.id, 'Reply A'], {env: guardedEnv, windowsHide: true});
    const newer = JSON.parse(await fs.readFile(filename, 'utf8'));
    newer.threads[0].messages[0].text = 'Request B';
    newer.threads[0].messages[0].editedAt = '2026-10-31T00:00:01.000Z';
    await fs.writeFile(filename, JSON.stringify(newer));
    const before = await fs.readFile(filename, 'utf8');
    await assert.rejects(execFileAsync(process.execPath, [cli, 'comment-reply', fixture.root, thread.id, 'Stale reply A'], {env: guardedEnv, windowsHide: true}), error => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /COMMENT_REVISION_CHANGED/);
      return true;
    });
    assert.equal(await fs.readFile(filename, 'utf8'), before, 'a stale reply must preserve the newer request byte for byte');
    await execFileAsync(process.execPath, [cli, 'comment-reply', fixture.root, thread.id, 'Manual reply B'], {
      env: {...process.env, CODEX_DESIGN_EXPECTED_USER_REVISION: ''}, windowsHide: true,
    });
  }
});

async function write(root, relative, data) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data));
}

test('all generated editors load a same-origin integrity-checked adapter and grant-scoped route', async () => {
  for (const name of names) {
    const scripts = path.join(pluginRoot, 'skills', name, 'scripts');
    const html = await fs.readFile(path.join(scripts, 'editor/index.html'), 'utf8');
    const integrity = 'sha384-' + createHash('sha384').update(browserSource).digest('base64');
    assert.ok(html.includes(`src="./__codex/annotations.js" integrity="${integrity}"`));
    const filename = name === 'codex-dashboard' ? 'artifact.mjs' : 'server.mjs';
    const runtime = await fs.readFile(path.join(scripts, filename), 'utf8');
    assert.ok(runtime.includes('serveCodexAnnotation'));
    assert.ok(runtime.includes('windowsHide: true'));
    if (name !== 'codex-dashboard') assert.ok(runtime.includes('serveCodexAnnotation(request, response, rest, root'));
  }
});

test('adaptation is idempotent and does not duplicate hidden-process settings', async () => {
  const file = path.join(pluginRoot, 'skills/codex-slides/scripts/server.mjs');
  const before = await fs.readFile(file, 'utf8');
  await adaptAnnotations(pluginRoot);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('all four CLI help banners use their installed Codex skill names', async () => {
  for (const name of names) {
    const file = path.join(pluginRoot, 'skills', name, 'scripts/artifact.mjs');
    const runtime = await fs.readFile(file, 'utf8');
    assert.ok(runtime.includes(`// ${name}: local Artifact tool`));
    const {stdout} = await execFileAsync(process.execPath, [file, '--help'], {windowsHide: true, timeout: 10_000});
    assert.ok(stdout.startsWith(name + ' '), stdout.slice(0, 120));
    if (name === 'codex-dashboard') {
      assert.ok(runtime.includes('require the hosted editor'));
      assert.ok(!runtime.includes('need the claude.ai page'));
    }
  }
});

test('design-system discovery prefers the new environment name and retains its legacy alias', async () => {
  const primary = path.join(temporary, 'env-primary');
  const legacy = path.join(temporary, 'env-legacy');
  const empty = path.join(temporary, 'env-empty');
  await fs.mkdir(empty, {recursive: true});
  await write(primary, 'project/design-system.json', {v: 3, layout: 'files', title: 'New environment', namespace: 'NewEnvironment'});
  await write(legacy, 'project/design-system.json', {v: 3, layout: 'files', title: 'Legacy environment', namespace: 'LegacyEnvironment'});
  for (const name of names.filter(name => name !== 'codex-dashboard')) {
    const file = path.join(pluginRoot, 'skills', name, 'scripts/artifact.mjs');
    const runtime = await fs.readFile(file, 'utf8');
    assert.ok(runtime.includes('process.env.CODEX_DESIGN_SYSTEMS ?? process.env.CLAUDE_DESIGN_SYSTEMS ?? ""'));
    const env = {...process.env, CODEX_DESIGN_SYSTEMS: primary, CLAUDE_DESIGN_SYSTEMS: legacy};
    const preferred = await execFileAsync(process.execPath, [file, 'list', empty], {env, windowsHide: true, timeout: 10_000});
    assert.deepEqual(JSON.parse(preferred.stdout).map(system => system.title), ['New environment']);
    delete env.CODEX_DESIGN_SYSTEMS;
    const aliased = await execFileAsync(process.execPath, [file, 'list', empty], {env, windowsHide: true, timeout: 10_000});
    assert.deepEqual(JSON.parse(aliased.stdout).map(system => system.title), ['Legacy environment']);
  }
});

test('Windows comment replacement retries only temporary sharing failures and preserves permanent errors', async () => {
  const refused = Object.assign(new Error('sharing violation'), {code: 'EPERM'});
  let attempts = 0;
  const delays = [];
  await serverModule.renameWithRetry('same.tmp', 'comments.json', {
    platform: 'win32', delays: [1, 2], pause: async value => delays.push(value),
    rename: async (source, destination) => { assert.equal(source, 'same.tmp'); assert.equal(destination, 'comments.json'); if (++attempts < 3) throw refused; },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1, 2]);
  attempts = 0;
  await assert.rejects(serverModule.renameWithRetry('same.tmp', 'comments.json', {
    platform: 'win32', delays: [1, 2], pause: async () => {}, rename: async () => { attempts++; throw refused; },
  }), error => error === refused);
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(serverModule.renameWithRetry('same.tmp', 'comments.json', {
    platform: 'linux', pause: async () => assert.fail('must not retry non-Windows errors'), rename: async () => { attempts++; throw refused; },
  }), error => error === refused);
  assert.equal(attempts, 1);
});

test('an old hook acknowledgement cannot mark a newer user revision delivered', () => {
  const captured = {status: 'open', agent: {status: 'pending', sentAt: '2026-10-31T00:00:00Z'}, messages: [{id: 'm1', author: {kind: 'user'}, text: 'Revision A', at: '2026-10-31T00:00:00Z'}]};
  const same = structuredClone(captured);
  assert.equal(serverModule.sameCommentRevision(same, captured), true);
  same.messages.push({id: 'reply', author: {kind: 'agent'}, text: 'Done'});
  assert.equal(serverModule.sameCommentRevision(same, captured), true, 'agent replies are not user revisions');
  const newer = structuredClone(captured);
  newer.agent.sentAt = '2026-10-31T00:00:01Z';
  assert.equal(serverModule.sameCommentRevision(newer, captured), false);
  newer.agent.sentAt = captured.agent.sentAt;
  newer.messages[0].text = 'Revision B';
  assert.equal(serverModule.sameCommentRevision(newer, captured), false, 'same-millisecond edits must still differ');
  newer.messages[0].text = 'Revision A';
  newer.status = 'resolved';
  assert.equal(serverModule.sameCommentRevision(newer, captured), false);
});

test('renamed skill namespaces preserve standard editor health kinds', async () => {
  const kinds = ['slides', 'design', 'design-system', 'dashboard'];
  for (let i = 0; i < names.length; i++) {
    let body;
    const response = {writeHead(status) { assert.equal(status, 200); }, end(bytes) { body = JSON.parse(bytes.toString()); }};
    assert.equal(await serverModule.serveCodexAnnotation({method: 'GET'}, response, '__codex/editor-session', temporary, names[i], import.meta.url, {viewer: {role: 'owner'}}), true);
    assert.deepEqual(body, {root: path.resolve(temporary), kind: kinds[i], pid: process.pid, nativeSessionVersion: 2, nativeLocalOnly: false});
  }
});

test('native metadata and boot routes refuse guests before reading local state', async () => {
  for (const role of [undefined, 'viewer', 'commenter', 'editor']) {
    for (const route of ['__codex/editor-session', '__codex/annotation-context', '__codex/annotations.js', '__codex/boot.js', '__codex/history-ui.js']) {
      let status, ended = false;
      const response = {writeHead(value) { status = value; return this; }, end() { ended = true; }};
      const result = await serverModule.serveCodexAnnotation({method: 'GET'}, response, route,
        path.join(temporary, 'must-not-read'), 'codex-design', import.meta.url,
        {viewer: role ? {role} : undefined, bootScript: () => assert.fail('guest boot metadata must not be computed')});
      assert.equal(result, true);
      assert.equal(status, 403);
      assert.equal(ended, true);
    }
  }
});

test('internal native services refuse network opt-ins while standalone options retain their own behavior', () => {
  const previous = process.env.CODEX_DESIGN_NATIVE_SESSION;
  try {
    process.env.CODEX_DESIGN_NATIVE_SESSION = '1';
    for (const host of ['127.0.0.1', 'localhost', '::1']) serverModule.assertNativeNetwork({host});
    for (const options of [{host: '0.0.0.0'}, {host: '::'}, {host: '192.0.2.2'}, {host: 'localhost', lan: true}]) {
      assert.throws(() => serverModule.assertNativeNetwork(options), {code: 'NATIVE_NETWORK_REFUSED'});
    }
    delete process.env.CODEX_DESIGN_NATIVE_SESSION;
    serverModule.assertNativeNetwork({host: '0.0.0.0', lan: true});
  } finally {
    if (previous === undefined) delete process.env.CODEX_DESIGN_NATIVE_SESSION;
    else process.env.CODEX_DESIGN_NATIVE_SESSION = previous;
  }
});

test('real adapted artifact servers retain authenticated metadata, history boot and local-only native startup', async () => {
  const previous = process.env.CODEX_DESIGN_NATIVE_SESSION;
  process.env.CODEX_DESIGN_NATIVE_SESSION = '1';
  try {
    for (const kind of ['slides', 'design', 'design-system']) {
      const fixture = await createFixture(kind, temporary);
      const sharing = path.join(fixture.root, '.sharing.json');
      const persisted = JSON.stringify({lan: true, port: 42399, links: {}, guests: []});
      await fs.writeFile(sharing, persisted);
      const scripts = path.join(pluginRoot, 'skills', fixture.skill, 'scripts');
      const module = await import(pathToFileURL(path.join(scripts, 'server.mjs')));
      const server = await module.startServer({root: fixture.root, port: 0, log: () => {}});
      try {
        assert.equal(server.lan, undefined, 'opening a native editor must not restore persisted LAN listeners');
        const base = new URL(server.url), origin = base.origin;
        const session = await fetch(new URL('__codex/editor-session', base));
        assert.equal(session.status, 200);
        assert.deepEqual(await session.json(), {root: path.resolve(fixture.root), kind, pid: process.pid, nativeSessionVersion: 2, nativeLocalOnly: true});
        assert.equal((await fetch(`${origin}/${kind}/wrong/__codex/editor-session`)).status, 404);
        assert.equal((await fetch(`${origin}/__codex/editor-session`)).status, 404);
        const head = await fetch(new URL('__codex/editor-session', base), {method: 'HEAD'});
        assert.equal(head.status, 200); assert.equal(await head.text(), '');
        const refused = await fetch(new URL('__codex/editor-session', base), {method: 'POST'});
        assert.equal(refused.status, 405); await refused.arrayBuffer();
        const boot = await fetch(new URL('__codex/boot.js?at=1', base));
        assert.equal(boot.status, 200);
        const code = await boot.text();
        assert.match(code, /window\.__baoyuShare=/);
        assert.match(code, /__baoyuHistory/);
        assert.match(code, /canRestore/);
        const historyUI = await fetch(new URL('__codex/history-ui.js', base));
        assert.equal(historyUI.status, 200);
        assert.equal(await historyUI.text(), await fs.readFile(path.join(scripts, 'editor/share-ui.js'), 'utf8'));
        const historyHead = await fetch(new URL('__codex/history-ui.js', base), {method: 'HEAD'});
        assert.equal(historyHead.status, 200); assert.equal(await historyHead.text(), '');
        const share = await fetch(`${origin}/__share`, {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: '{"action":"lan","on":true}'});
        assert.equal(share.status, 403); assert.equal((await share.json()).code, 'native_local_only');
        const zip = await fetch(`${origin}/__share/archive`);
        assert.equal(zip.status, 403); await zip.arrayBuffer();
        assert.equal(await fs.readFile(sharing, 'utf8'), persisted, 'native opening and refused share requests preserve the old sharing record');
      } finally { server.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_DESIGN_NATIVE_SESSION;
    else process.env.CODEX_DESIGN_NATIVE_SESSION = previous;
  }
});

test('upstream port probing excludes synthetic always-answering TUN interfaces but still rejects real occupied ports', async () => {
  for (const name of names) {
    const file = path.join(pluginRoot, 'skills', name, 'scripts', name === 'codex-dashboard' ? 'artifact.mjs' : 'server.mjs');
    const runtime = await fs.readFile(file, 'utf8');
    const start = runtime.indexOf('async function listenFree('), end = runtime.indexOf('\nfunction serverOrigin(', start);
    assert.ok(start >= 0 && end > start, `${name}: upstream port probe contract changed`);
    const implementation = runtime.slice(start, end);
    const probes = [], binds = [];
    const portError = class extends Error { code = 'PORT_IN_USE'; };
    const compile = overrides => vm.runInNewContext(`(${implementation})`, {
      PORT_TRIES: 100, PortsTaken: portError,
      lanAddresses: () => ['10.255.0.1', '192.0.2.10'],
      answersAnyPort: async address => address === '10.255.0.1',
      answers: async (address, port) => { probes.push({address, port}); return address === '127.0.0.1' && port === 4710; },
      listen: async (_server, port, host) => { binds.push({port, host}); if (port === 4711) throw Object.assign(new Error('bind race'), {code: 'EADDRINUSE'}); return port; },
      ...overrides,
    });
    const port = await compile()({}, 4710, '127.0.0.1');
    assert.equal(port, 4712);
    assert.equal(probes.some(probe => probe.address === '10.255.0.1'), false, 'the always-answering interface must not make every port appear occupied');
    assert.ok(probes.some(probe => probe.address === '192.0.2.10'), 'ordinary local interfaces remain checked');
    assert.deepEqual(binds.map(bind => bind.port), [4711, 4712], 'occupied port and bind races retain their guards');
    const exhausted = compile({answers: async () => true, listen: async () => assert.fail('occupied port must not be bound')});
    await assert.rejects(exhausted({}, 65535, '127.0.0.1'), {code: 'PORT_IN_USE'});
    const ephemeral = compile({lanAddresses: () => assert.fail('port zero must let the OS select'), listen: async (_server, value) => value === 0 ? 52719 : assert.fail('unexpected bind')});
    assert.equal(await ephemeral({}, 0, '127.0.0.1'), 52719);
  }
});

test('real adapted artifact saves reject stale or missing bases after an intervening edit without partial writes', async () => {
  const previous = process.env.CODEX_DESIGN_NATIVE_SESSION;
  process.env.CODEX_DESIGN_NATIVE_SESSION = '1';
  try {
    for (const kind of ['slides', 'design', 'design-system']) {
      const fixture = await createFixture(kind, temporary);
      const module = await import(pathToFileURL(path.join(pluginRoot, 'skills', fixture.skill, 'scripts/server.mjs')));
      const server = await module.startServer({root: fixture.root, port: 0, log: () => {}});
      try {
        const base = new URL(server.url);
        const files = (await (await fetch(new URL('_files.json', base))).json()).files;
        const content = path.join(fixture.root, fixture.contentFile), index = path.join(fixture.root, fixture.indexFile);
        const original = await fs.readFile(content, 'utf8');
        const indexBytes = await fs.readFile(index);
        const send = async batch => {
          const response = await fetch(new URL('__deck/publish', base), {method: 'POST',
            headers: {origin: base.origin, 'content-type': 'application/json', 'x-deck-client': 'codex_cas_test'}, body: JSON.stringify({files: batch})});
          return {status: response.status, body: await response.json()};
        };
        const entry = (text, ifMatch) => ({base64: Buffer.from(text).toString('base64'), contentType: 'text/plain', ...(ifMatch === undefined ? {} : {ifMatch})});
        const first = await send({[fixture.contentFile]: entry(original + '\nPage edit', files[fixture.contentFile].sha256)});
        assert.equal(first.status, 200, JSON.stringify(first.body));
        const external = original + '\nExternal user edit, preserved';
        await fs.writeFile(content, external);
        const missing = await send({[fixture.contentFile]: entry(original + '\nStale page overwrite')});
        assert.equal(missing.status, 409);
        assert.equal(missing.body.code, 'conflict');
        assert.equal(await fs.readFile(content, 'utf8'), external);
        const stale = await send({
          [fixture.indexFile]: entry(indexBytes.toString() + '\n', files[fixture.indexFile].sha256),
          [fixture.contentFile]: entry(original + '\nAnother stale overwrite', files[fixture.contentFile].sha256),
        });
        assert.equal(stale.status, 409);
        assert.equal(await fs.readFile(content, 'utf8'), external);
        assert.deepEqual(await fs.readFile(index), indexBytes, 'the unrelated index must not be partially written');
      } finally { server.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_DESIGN_NATIVE_SESSION;
    else process.env.CODEX_DESIGN_NATIVE_SESSION = previous;
  }
});

test('actual Dashboard service keeps native metadata behind its stable artwork base and merges concurrent creation', async () => {
  const fixture = await createFixture('dashboard', temporary);
  const sharing = path.join(fixture.root, '.sharing.json');
  const sharingBytes = JSON.stringify({lan: true, port: 42398, links: {}, guests: []});
  await fs.writeFile(sharing, sharingBytes);
  const cli = path.join(pluginRoot, 'skills/codex-dashboard/scripts/artifact.mjs');
  const child = spawn(process.execPath, [cli, 'serve', fixture.root, '--port', '0'], {
    env: {...process.env, CODEX_DESIGN_NATIVE_SESSION: '1'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Dashboard did not start: ${stderr}`)), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited ${code}: ${stderr}`)); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        let result; try { result = JSON.parse(stdout); } catch { return; }
        if (result.url) { clearTimeout(timer); resolve(result); }
      });
    });
    const base = new URL(ready.url);
    assert.match(base.pathname, /^\/dashboard\/[A-Za-z0-9_-]{22}\/$/);
    assert.equal(ready.lan, undefined);
    const session = await fetch(new URL('__codex/editor-session', base));
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {root: path.resolve(fixture.root), kind: 'dashboard', pid: child.pid, nativeSessionVersion: 2, nativeLocalOnly: true});
    for (const route of ['__codex/editor-session', '__codex/annotation-context', '__codex/boot.js', '__codex/history-ui.js']) {
      for (const requestPath of [`/${route}`, `/dashboard/wrong-base/${route}`]) {
        const refused = await fetch(`${base.origin}${requestPath}`);
        assert.equal(refused.status, 404, requestPath); await refused.arrayBuffer();
      }
    }
    const boot = await fetch(new URL('__codex/boot.js', base));
    assert.equal(boot.status, 200); assert.match(await boot.text(), /__baoyuHistory/);
    const historyUI = await fetch(new URL('__codex/history-ui.js', base));
    assert.equal(historyUI.status, 200); assert.match(await historyUI.text(), /__baoyuHistory/);
    const share = await fetch(`${base.origin}/__share`, {method: 'POST', headers: {origin: base.origin, 'content-type': 'application/json'}, body: '{"action":"lan","on":true}'});
    assert.equal(share.status, 403); await share.arrayBuffer();
    const zip = await fetch(`${base.origin}/__share/archive`);
    assert.equal(zip.status, 403); await zip.arrayBuffer();
    assert.equal(await fs.readFile(sharing, 'utf8'), sharingBytes);
    const writeDoc = async data => {
      const result = await fetch(new URL('_api/write', base), {method: 'POST', headers: {origin: base.origin, 'content-type': 'application/json'},
        body: JSON.stringify({op: 'set', path: 'dash/concurrent', base: null, data})});
      assert.equal(result.status, 200); await result.arrayBuffer();
    };
    await Promise.all([writeDoc({first: 1}), writeDoc({second: 2})]);
    const read = await fetch(new URL('_api/doc?path=dash%2Fconcurrent', base));
    assert.deepEqual((await read.json()).data, {first: 1, second: 2});
  } finally {
    child.kill();
    await closed;
  }
});

test('native boot preserves upstream history metadata and preview query in the grant-scoped route', async () => {
  let body, seen;
  const response = {writeHead(status, headers) { assert.equal(status, 200); assert.match(headers['Content-Type'], /javascript/); }, end(value) { body = value.toString(); }};
  assert.equal(await serverModule.serveCodexAnnotation({method: 'GET', url: '/design/grant/__codex/boot.js?at=3'}, response,
    '__codex/boot.js', temporary, 'codex-design', import.meta.url, {
      viewer: {role: 'owner'},
      bootScript: query => { seen = query.get('at'); return 'window.__baoyuHistory={base:"__history",canRestore:true,preview:{n:3}};'; },
    }), true);
  assert.equal(seen, '3');
  const context = {window: {}};
  vm.runInNewContext(body, context);
  assert.equal(context.window.__baoyuHistory.preview.n, 3);
  assert.equal(context.window.__baoyuHistory.canRestore, true);
});

test('upstream comment-transaction rename is adapted without changing archive replacement', async () => {
  const runtime = await fs.readFile(path.join(pluginRoot, 'skills/codex-dashboard/scripts/artifact.mjs'), 'utf8');
  assert.match(runtime, /async function writeAtomic2\(file, text\) \{[\s\S]*?await codexRenameWithRetry\(temp, file\);/);
  assert.match(runtime, /await fsp\.rename\(tmp, file\);/, 'archive output keeps its independent upstream replacement');
});

test('slide and artboard identities come from the real index and existing safe files', async () => {
  const root = path.join(temporary, 'deck');
  await write(root, 'project/deck.json', {title: 'Real deck', order: ['cover', 'missing', '../escape']});
  await write(root, 'project/slides/cover.html', '<section id="cover"><h1>Cover</h1></section>');
  const context = await serverModule.annotationContext(root, 'codex-slides');
  assert.equal(context.title, 'Real deck');
  assert.deepEqual(context.objects.map(x => [x.id, x.file, x.page]), [['cover', 'project/slides/cover.html', 1]]);
  await write(root, 'project/canvas.json', {title: 'Real canvas', boards: {'Main.dc.html': {title: 'Main artboard'}, '../escape': {}, 'sub\\Board.dc.html': {}}, order: ['Main.dc.html']});
  await write(root, 'project/Main.dc.html', '<x-dc><h1>Main</h1></x-dc>');
  await write(root, 'project/sub/Board.dc.html', '<x-dc><h1>Sub</h1></x-dc>');
  const design = await serverModule.annotationContext(root, 'codex-design');
  assert.deepEqual(design.objects.map(x => [x.id, x.file]), [['Main.dc.html', 'project/Main.dc.html']]);
  assert.equal(design.objects[0].name, 'Main artboard');
});

test('design-system and dashboard identities name existing project files and document storage', async () => {
  const root = path.join(temporary, 'system');
  await write(root, 'project/design-system.json', {title: 'Real system'});
  await write(root, 'project/components/Button/preview.html', '<button>Button</button>');
  const system = await serverModule.annotationContext(root, 'codex-design-system');
  assert.ok(system.objects.some(x => x.file === 'project/components/Button/preview.html'));
  await write(root, 'db/dash/meta.json', {title: 'Real dashboard'});
  await write(root, 'db/files/index.html.json', {text: '<h1>Revenue</h1>'});
  await write(root, 'db/files/invalid.json', {other: 'not a page'});
  const dashboard = await serverModule.annotationContext(root, 'codex-dashboard');
  assert.equal(dashboard.title, 'Real dashboard');
  assert.deepEqual(dashboard.objects.map(x => [x.id, x.file]), [['index.html', 'db/files/index.html.json']]);
});

// Deliberately small DOM model: the contract tests below exercise mapping,
// native request gesture handling, no-API fallback, and stale-node rejection.
class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.attrs = new Map(); this.children = []; this.listeners = new Map(); this.style = {}; this.value = ''; this.textContent = ''; this.isConnected = true; this.rect = {left: 10, top: 10, right: 510, bottom: 310, width: 500, height: 300}; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.isConnected = false; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  getBoundingClientRect() { return this.rect; }
  matches(selector) { return selector.split(',').some(part => { const s = part.trim(); if (s.startsWith('.')) return this.getAttribute('class')?.split(' ').includes(s.slice(1)); if (/^#[\w-]+$/.test(s)) return (this.id || this.getAttribute('id')) === s.slice(1); const attrs = [...s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]; return attrs.length > 0 && attrs.every(([,key,value]) => value === undefined ? this.attrs.has(key) : this.getAttribute(key) === value); }); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

async function browser({skill = 'codex-design', api = true, frame = false, initialAttributes = {}, contextOverride = {}, setupDOM} = {}) {
  const document = {readyState: 'complete', currentScript: {src: 'http://127.0.0.1:1234/design/grant/__codex/annotations.js'}, listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); }, createElement(tag) { return new Element(tag, this); }};
  document.body = new Element('body', document);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  document.getElementById = id => id === 'root' ? root : document.body.querySelectorAll('[id]').find(element => element.getAttribute('id') === id) || null;
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  let target = document.createElement('article');
  const id = skill === 'codex-slides' ? 'cover' : 'Main.dc.html';
  target.setAttribute(skill === 'codex-slides' ? 'data-slide-id' : 'data-mega-artboard', id);
  for (const [key, value] of Object.entries(initialAttributes)) target.setAttribute(key, value);
  root.append(target);
  if (setupDOM) target = setupDOM({document, root, defaultTarget: target});
  const requests = [];
  if (api) document.oai = {annotation: {request(element, options) { requests.push({element, options}); return {accepted: true}; }}};
  const window = {addEventListener() {}}; window.top = frame ? {} : window;
  const context = {skill, projectRoot: 'C:/work/real-project', title: 'Real project', indexFile: 'project/canvas.json', objects: [{id, file: skill === 'codex-slides' ? 'project/slides/cover.html' : 'project/Main.dc.html', name: 'Main', ...(skill === 'codex-slides' ? {page: 1} : {}), keys: [id]}]};
  Object.assign(context, contextOverride);
  const observed = [];
  vm.runInNewContext(browserSource, {window, document, URL, TextEncoder, innerHeight: 900, innerWidth: 1400, MutationObserver: class {observe(_target, options) { observed.push(options); } disconnect() {}}, requestAnimationFrame: fn => fn(), setInterval: () => 1, clearInterval() {}, fetch: async url => {assert.equal(String(url), 'http://127.0.0.1:1234/design/grant/__codex/annotation-context'); return {ok: true, json: async () => context}; }});
  await new Promise(resolve => setImmediate(resolve));
  return {window, document, root, target, requests, context, observed};
}

function nodesUnder(element) { return [element, ...element.children.flatMap(nodesUnder)]; }
function nativeMetadata(element) { const value = element.getAttribute('oai-annotation-metadata'); return value === null ? null : JSON.parse(value); }
function assertNoAddedUI(document, requests) {
  assert.equal(document.body.children.length, 1, 'only the existing editor root may remain');
  assert.equal(nodesUnder(document.body).filter(element => ['ASIDE', 'BUTTON', 'SELECT', 'OPTION'].includes(element.tagName)).length, 0);
  assert.equal(document.listeners.has('pointerdown'), false, 'the adapter must not intercept page selection');
  assert.equal(requests.length, 0, 'only the browser toolbar initiates native annotations');
}

test('ordinary browsers and iframe documents remain completely unchanged', async () => {
  for (const options of [{api: false}, {frame: true}]) {
    const result = await browser(options);
    assertNoAddedUI(result.document, result.requests);
    assert.equal(result.root.getAttribute('oai-annotation-container'), null);
    assert.equal(nativeMetadata(result.target), null);
    assert.equal(result.window.__baoyuCodexAnnotations, undefined);
  }
});

test('native toolbar receives bounded top-document metadata without any filename controls', async () => {
  for (const skill of ['codex-design', 'codex-slides']) {
    const {window, document, root, target, requests, context} = await browser({skill});
    const iframe = document.createElement('iframe');
    Object.defineProperty(iframe, 'contentDocument', {get() { assert.fail('the adapter must not enter iframe documents'); }});
    target.append(iframe);
    await window.__baoyuCodexAnnotations.refresh();
    const data = nativeMetadata(target);
    assert.equal(data.objectId, context.objects[0].id);
    assert.equal(data.file, context.objects[0].file);
    assert.equal(data.skill, skill);
    assert.ok(Object.keys(data).length <= 6);
    assert.ok(Object.values(data).every(value => ['number', 'string', 'boolean'].includes(typeof value) || value === null));
    assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 2048);
    assert.equal(nativeMetadata(iframe), null, 'the top-level artboard is the proxy');
    assertNoAddedUI(document, requests);
    window.__baoyuCodexAnnotations.dispose();
    assert.equal(nativeMetadata(target), null);
    assert.equal(root.getAttribute('oai-annotation-container'), null);
  }
  assert.doesNotMatch(browserSource, /\.request\s*\(/);
  assert.doesNotMatch(browserSource, /createElement\s*\(/);
});

test('authored Slides accessible label text keeps native annotation file and slide identity stable', async () => {
  for (const label of ['Slide 1 (thumbnail): Original title', '幻灯片 1（缩略图）：Original title']) {
    const { target, document, requests } = await browser({ skill: 'codex-slides', setupDOM({ defaultTarget }) {
      defaultTarget.setAttribute('aria-label', label);
      defaultTarget.setAttribute('aria-current', 'true');
      return defaultTarget;
    } });
    const metadata = nativeMetadata(target);
    assert.equal(metadata.file, 'project/slides/cover.html');
    assert.equal(metadata.objectId, 'cover'); assert.equal(metadata.page, 1);
    assert.equal(target.getAttribute('data-slide-id'), 'cover');
    assertNoAddedUI(document, requests);
  }
});

test('reused DOM proxies lose stale native metadata and restore original attributes', async () => {
  const original = '{"owner":"editor"}';
  const {window, document, target, requests, observed} = await browser({initialAttributes: {'oai-annotatable': 'Original editor object', 'oai-annotation-metadata': original}});
  assert.equal(nativeMetadata(target).file, 'project/Main.dc.html');
  target.setAttribute('data-mega-artboard', 'unknown.dc.html');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(target.getAttribute('oai-annotation-metadata'), original);
  assert.equal(target.getAttribute('oai-annotatable'), 'Original editor object');
  target.setAttribute('data-mega-artboard', 'Main.dc.html');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(nativeMetadata(target).file, 'project/Main.dc.html');
  target.removeAttribute('data-mega-artboard');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(target.getAttribute('oai-annotation-metadata'), original);
  for (const field of ['data-path', 'data-comment-target', 'data-node-path', 'data-slide-surface', 'class']) assert.ok(observed[0].attributeFilter.includes(field));
  assertNoAddedUI(document, requests);
  window.__baoyuCodexAnnotations.dispose();
});

test('the captured dashboard dash-root exposes source metadata without filename UI', async () => {
  const {document, target, requests} = await browser({skill: 'codex-dashboard', contextOverride: {title: 'Monthly revenue', indexFile: 'db/dash/meta.json', objects: [{id: 'index.html', file: 'db/files/index.html.json', name: 'index.html', keys: ['index.html']}]}, setupDOM({document, root, defaultTarget}) {
    defaultTarget.remove();
    const content = document.createElement('div'); content.setAttribute('id', 'dash-root'); root.append(content);
    const heading = document.createElement('h1'); heading.textContent = 'Monthly revenue'; content.append(heading);
    return content;
  }});
  assert.equal(nativeMetadata(target).file, 'db/files/index.html.json');
  assert.equal(target.getAttribute('oai-annotatable'), 'Monthly revenue');
  assert.equal(target.children[0].textContent, 'Monthly revenue');
  assertNoAddedUI(document, requests);
});

// These shapes were captured read-only by the primary agent from the actual
// IAB design-system editor. These fake-DOM regressions exercise that captured
// markup; the desktop acceptance run remains a separate check.
test('captured design-system token/style/cover markers preserve source and element identities', async () => {
  const objects = [
    {id: 'tokens.json', file: 'project/tokens.json', name: 'tokens.json', keys: ['tokens.json', 'guidance:tokens.json']},
    {id: 'components/Cover/preview.html', file: 'project/components/Cover/preview.html', name: 'components/Cover/preview.html', keys: ['components/Cover/preview.html']},
  ];
  for (const [tag, id, attributes, file] of [
    ['div', 'token-ink', {'data-testid': 'ds-color-ink', 'data-comment-target': ''}, 'project/tokens.json'],
    ['section', 'tset-Text', {'data-card-key': 'type:Text'}, 'project/tokens.json'],
    ['div', 'style-body', {'data-comment-target': ''}, 'project/tokens.json'],
    ['div', 'token-space-4', {'data-comment-target': ''}, 'project/tokens.json'],
    ['h1', 'page-colors', {}, 'project/tokens.json'],
    ['div', 'ds-cover', {'data-comment-target': '', 'data-testid': 'ds-cover'}, 'project/components/Cover/preview.html'],
  ]) {
    const {document, target, requests} = await browser({skill: 'codex-design-system', contextOverride: {indexFile: 'project/design-system.json', objects}, setupDOM({document, root, defaultTarget}) {
      defaultTarget.remove();
      const node = document.createElement(tag); node.setAttribute('data-id', id);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      root.append(node); return node;
    }});
    assert.equal(nativeMetadata(target).objectId, id);
    assert.equal(nativeMetadata(target).file, file);
    assertNoAddedUI(document, requests);
  }
});

test('captured IAB README editor markup maps to the actual README file in fake DOM', async () => {
  const {document, target, requests} = await browser({skill: 'codex-design-system', contextOverride: {indexFile: 'project/design-system.json', objects: [{id: 'README.md', file: 'project/README.md', name: 'README.md', keys: ['README.md', 'guidance:README.md']}]}, setupDOM({document, root, defaultTarget}) {
    defaultTarget.remove();
    const article = document.createElement('article'); article.setAttribute('data-testid', 'ds-overview'); root.append(article);
    const readme = document.createElement('div');
    for (const [name, value] of Object.entries({class: 'ds-readme ds-readme-editable', 'data-testid': 'ds-readme-rendered', contenteditable: 'true', role: 'textbox', 'aria-label': 'README'})) readme.setAttribute(name, value);
    article.append(readme); return readme;
  }});
  assert.equal(nativeMetadata(target).file, 'project/README.md');
  assert.equal(nativeMetadata(target).objectId, 'ds-readme-rendered');
  assertNoAddedUI(document, requests);
});

test('captured IAB file-browser text previews carry metadata independently of their navigation row', async () => {
  const {document, target, requests} = await browser({skill: 'codex-design-system', contextOverride: {indexFile: 'project/design-system.json', objects: [{id: 'tokens.json', file: 'project/tokens.json', name: 'tokens.json', keys: ['tokens.json']}]}, setupDOM({document, root, defaultTarget}) {
    defaultTarget.remove();
    const browser = document.createElement('div'); browser.setAttribute('data-testid', 'files-browser'); root.append(browser);
    const tree = document.createElement('div');
    for (const [key, value] of Object.entries({role: 'tree', 'aria-label': 'Files', 'data-testid': 'files-browser-list', 'aria-activedescendant': '_r_47_-file-tokens'})) tree.setAttribute(key, value);
    browser.append(tree);
    const row = document.createElement('div');
    for (const [key, value] of Object.entries({role: 'treeitem', 'aria-selected': 'true', 'data-testid': 'files-browser-row', 'data-path': 'tokens.json'})) row.setAttribute(key, value);
    row.rect = {left: 0, right: 100, top: -100, bottom: -10, width: 100, height: 90}; tree.append(row);
    const preview = document.createElement('div'); preview.setAttribute('data-testid', 'files-browser-preview'); browser.append(preview);
    const card = document.createElement('div'); card.setAttribute('data-testid', 'files-browser-card'); preview.append(card);
    const label = document.createElement('div'); label.setAttribute('id', '_r_4e_'); label.textContent = 'tokens.json'; card.append(label);
    const pre = document.createElement('pre');
    for (const [key, value] of Object.entries({'data-testid': 'files-browser-text', role: 'group', 'aria-labelledby': '_r_4e_', tabindex: '0'})) pre.setAttribute(key, value);
    card.append(pre); return pre;
  }});
  assert.equal(nativeMetadata(target).file, 'project/tokens.json');
  assert.equal(nativeMetadata(target).objectId, 'file:tokens.json');
  assertNoAddedUI(document, requests);
});

test('captured file-preview labels clear stale identity while another file loads', async () => {
  let selectedRow, label;
  const {window, document, target, requests, observed} = await browser({skill: 'codex-design-system', contextOverride: {indexFile: 'project/design-system.json', objects: ['tokens.json', 'README.md'].map(name => ({id: name, file: 'project/' + name, name, keys: [name]}))}, setupDOM({document, root, defaultTarget}) {
    defaultTarget.remove();
    const fileBrowser = document.createElement('div'); fileBrowser.setAttribute('data-testid', 'files-browser'); root.append(fileBrowser);
    selectedRow = document.createElement('div');
    for (const [key, value] of Object.entries({'data-testid': 'files-browser-row', 'aria-selected': 'true', 'data-path': 'tokens.json'})) selectedRow.setAttribute(key, value);
    fileBrowser.append(selectedRow);
    label = document.createElement('div'); label.setAttribute('id', '_r_4e_'); label.textContent = 'tokens.json'; fileBrowser.append(label);
    const pre = document.createElement('pre'); pre.setAttribute('data-testid', 'files-browser-text'); pre.setAttribute('aria-labelledby', '_r_4e_'); fileBrowser.append(pre); return pre;
  }});
  assert.equal(nativeMetadata(target).file, 'project/tokens.json');
  selectedRow.setAttribute('data-path', 'README.md');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(nativeMetadata(target), null, 'an asynchronously stale preview must lose its old source metadata');
  label.textContent = 'README.md';
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(nativeMetadata(target).file, 'project/README.md');
  assert.equal(nativeMetadata(target).objectId, 'file:README.md');
  assert.equal(observed[0].characterData, true);
  for (const field of ['aria-selected', 'aria-labelledby', 'data-testid']) assert.ok(observed[0].attributeFilter.includes(field));
  assertNoAddedUI(document, requests);
});
