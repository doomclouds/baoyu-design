import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adaptAnnotations } from '../adapt-annotations.mjs';

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
    for (const relative of ['artifact.mjs', ...(name === 'codex-dashboard' ? [] : ['server.mjs']), 'editor/index.html']) await fs.copyFile(path.join(source, relative), path.join(target, relative));
  }
  await adaptAnnotations(pluginRoot);
  serverModule = await import(pathToFileURL(path.join(pluginRoot, 'skills/codex-slides/scripts/codex-annotation-server.mjs')));
});
test.after(async () => { await fs.rm(temporary, {recursive: true, force: true}); });

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
    assert.equal(await serverModule.serveCodexAnnotation({method: 'GET'}, response, '__codex/editor-session', temporary, names[i], import.meta.url), true);
    assert.deepEqual(body, {root: path.resolve(temporary), kind: kinds[i], pid: process.pid});
  }
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
  matches(selector) { return selector.split(',').some(part => { const s = part.trim(); if (s.startsWith('.')) return this.getAttribute('class')?.split(' ').includes(s.slice(1)); const attrs = [...s.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]; return attrs.length > 0 && attrs.every(([,key,value]) => value === undefined ? this.attrs.has(key) : this.getAttribute(key) === value); }); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
}

async function browser({skill = 'codex-design', api = true, frame = false, initialAttributes = {}} = {}) {
  const document = {readyState: 'complete', currentScript: {src: 'http://127.0.0.1:1234/design/grant/__codex/annotations.js'}, listeners: new Map(), addEventListener(name, fn) { this.listeners.set(name, fn); }, removeEventListener(name) { this.listeners.delete(name); }, createElement(tag) { return new Element(tag, this); }};
  document.body = new Element('body', document);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  document.getElementById = id => id === 'root' ? root : null;
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.querySelectorAll(selector)[0] || null;
  const target = document.createElement('article');
  const id = skill === 'codex-slides' ? 'cover' : 'Main.dc.html';
  target.setAttribute(skill === 'codex-slides' ? 'data-slide-id' : 'data-mega-artboard', id);
  for (const [key, value] of Object.entries(initialAttributes)) target.setAttribute(key, value);
  root.append(target);
  const requests = [];
  if (api) document.oai = {annotation: {request(element, options) { requests.push({element, options}); return {accepted: true}; }}};
  const window = {addEventListener() {}}; window.top = frame ? {} : window;
  const context = {skill, projectRoot: 'C:/work/real-project', title: 'Real project', indexFile: 'project/canvas.json', objects: [{id, file: skill === 'codex-slides' ? 'project/slides/cover.html' : 'project/Main.dc.html', name: 'Main', ...(skill === 'codex-slides' ? {page: 1} : {}), keys: [id]}]};
  const observed = [];
  vm.runInNewContext(browserSource, {window, document, URL, TextEncoder, innerHeight: 900, innerWidth: 1400, MutationObserver: class {observe(_target, options) { observed.push(options); } disconnect() {}}, requestAnimationFrame: fn => fn(), setInterval: () => 1, clearInterval() {}, fetch: async url => {assert.equal(String(url), 'http://127.0.0.1:1234/design/grant/__codex/annotation-context'); return {ok: true, json: async () => context}; }});
  await new Promise(resolve => setImmediate(resolve));
  return {window, document, root, target, requests, context, observed};
}

test('ordinary browsers and iframe documents receive no controls or native API calls', async () => {
  for (const options of [{api: false}, {frame: true}]) {
    const result = await browser(options);
    assert.equal(result.document.body.children.length, 1);
    assert.equal(result.window.__baoyuCodexAnnotations, undefined);
  }
});

test('native request targets a top-document proxy with accurate bounded flat metadata', async () => {
  for (const skill of ['codex-design', 'codex-slides']) {
    const {window, document, root, target, requests, context} = await browser({skill});
    const iframe = document.createElement('iframe'); target.append(iframe);
    document.listeners.get('pointerdown')({target});
    const panel = document.body.children[1];
    panel.children[1].listeners.get('click')();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].element, target);
    const data = requests[0].options.metadata;
    assert.equal(data.objectId, context.objects[0].id);
    assert.equal(data.file, context.objects[0].file);
    assert.equal(data.skill, skill);
    assert.ok(Object.keys(data).length <= 6);
    assert.ok(Object.values(data).every(value => ['number', 'string', 'boolean'].includes(typeof value) || value === null));
    assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 2048);
    assert.match(panel.children[2].textContent, /填写意见并发送/);
    window.__baoyuCodexAnnotations.dispose();
    assert.equal(target.getAttribute('oai-annotation-metadata'), null);
    assert.equal(root.getAttribute('oai-annotation-container'), null);
  }
});

test('requests re-resolve changed identities and reject stale or invisible proxies', async () => {
  const {document, target, requests} = await browser();
  document.listeners.get('pointerdown')({target});
  target.setAttribute('data-mega-artboard', 'new-page.dc.html');
  const button = document.body.children[1].children[1];
  button.listeners.get('click')();
  assert.equal(requests.length, 0);
  assert.match(document.body.children[1].children[2].textContent, /重新选择/);
});

test('reused DOM proxies lose stale native metadata and can be mapped again', async () => {
  const original = '{"owner":"editor"}';
  const {window, target, observed} = await browser({initialAttributes: {'oai-annotatable': 'Original editor object', 'oai-annotation-metadata': original}});
  assert.equal(JSON.parse(target.getAttribute('oai-annotation-metadata')).file, 'project/Main.dc.html');
  target.setAttribute('data-mega-artboard', 'unknown.dc.html');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(target.getAttribute('oai-annotation-metadata'), original);
  assert.equal(target.getAttribute('oai-annotatable'), 'Original editor object');
  target.setAttribute('data-mega-artboard', 'Main.dc.html');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(JSON.parse(target.getAttribute('oai-annotation-metadata')).file, 'project/Main.dc.html');
  target.removeAttribute('data-mega-artboard');
  await window.__baoyuCodexAnnotations.refresh();
  assert.equal(target.getAttribute('oai-annotation-metadata'), original);
  for (const field of ['data-path', 'data-comment-target', 'data-node-path', 'data-slide-surface', 'class']) assert.ok(observed[0].attributeFilter.includes(field));
  window.__baoyuCodexAnnotations.dispose();
});
