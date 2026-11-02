import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { adaptInlineEditorScript } from '../source/server/editor-document.mjs';

const source = await fs.readFile(new URL('../../skills/claude-design/scripts/editor/assets/index-DyKwtQBI.js', import.meta.url), 'utf8');
const adapted = adaptInlineEditorScript(source, 'https://codex-design.invalid/artifacts/test/assets/editor.js');
function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Actual upstream boundary: ${start}`);
  return text.slice(from, to);
}
const publisher = section(source, 'const Hy=', 'const oW=')
  + section(source, 'async function zW(', 'const M_=');
const originalFlush = section(source, 'const ZW=', 'function JW(');
const setter = section(adapted, 'function kn(Me){', 'function as(');
const liveSettler = section(source, 'let ae=async()=>{await Ut.current?.();', ',xe=()=>{document.visibilityState');
const registration = section(source, '(0,e.setEmbedSettler)(async()=>{', '),()=>{document.removeEventListener("visibilitychange",xe)');
const callback = registration.slice('(0,e.setEmbedSettler)('.length);
const hook = adapted.match(/globalThis\.__CODEX_DESIGN_EDITOR_TRANSPORT__&&\(globalThis\.__CODEX_DESIGN_EDITOR_FLUSH__=async\(\)=>\{await globalThis\.__CODEX_DESIGN_EDITOR_SETTLE__\?\.\(\);return Sw\(a,b\)\}\)/)?.[0];
assert.ok(hook, 'The actual adapted parent-flush branch retains its original window and publisher.');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ native = true, commit = async () => {}, board = async () => {}, fetch } = {}) {
  const events = [];
  const a = new EventTarget();
  let dirty = false;
  a.addEventListener('beforeunload', event => { events.push('dirty-guard'); if (dirty) event.preventDefault(); });
  const context = vm.createContext({ Event, TextEncoder, Uint8Array, Response, setTimeout, clearTimeout,
    btoa, a, fetch, events, Ut: { current: commit }, gt: { current: new Map([['board', board]]) },
    ru: { current: null }, window: { setTimeout }, me: 100,
    ...(native ? { __CODEX_DESIGN_EDITOR_TRANSPORT__: {} } : {}) });
  vm.runInContext(`${publisher}${originalFlush}let wn;${setter}${liveSettler};kn(${callback});const b=GW('https://codex-design.invalid/artifacts/test/',fetch);${hook};globalThis.publish=files=>b.publish(files);`, context);
  return { context, events, dirty: value => { dirty = value; }, flush: () => context.__CODEX_DESIGN_EDITOR_FLUSH__(), original: () => vm.runInContext('Sw(a,b,20)', context), publish: files => context.publish(files), clear: () => vm.runInContext('kn(null)', context) };
}

test('the actual Canvas settler commits the live preview and each board before the actual publisher-idle flush acknowledges saving', async () => {
  const commit = deferred(), response = deferred();
  const order = [];
  let f;
  let publishing;
  f = fixture({
    commit: async () => {
      order.push('commit-start');
      await commit.promise;
      order.push('commit-finished');
      publishing = f.publish({ 'project/Artboard.dc.html': { content: '<div>Committed text</div>', contentType: 'text/html', ifMatch: 'old-sha' } }).then(() => f.dirty(false));
    },
    board: async () => order.push('board-settled'),
    fetch: async (url, init) => {
      order.push('publish');
      assert.ok(url.endsWith('/__deck/publish'));
      const write = JSON.parse(init.body).files['project/Artboard.dc.html'];
      assert.equal(Buffer.from(write.base64, 'base64').toString(), '<div>Committed text</div>');
      assert.equal(write.ifMatch, 'old-sha');
      await response.promise;
      return new Response('{"version":2}', { headers: { 'content-type': 'application/json' } });
    },
  });
  f.dirty(true);
  assert.equal(await f.original(), false, 'The original publisher-only flush refuses the live model without ever committing it.');
  assert.deepEqual(order, []);
  f.events.length = 0;
  let saved = false;
  const flushing = f.flush().then(value => { saved = value; return value; });
  assert.deepEqual(order, ['commit-start']);
  assert.deepEqual(f.events, [], 'A quiet file queue cannot bypass the uncommitted preview.');
  commit.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['commit-start', 'commit-finished', 'publish', 'board-settled']);
  assert.equal(saved, false, 'The real publisher remains in flight until its response arrives.');
  assert.ok(f.events.includes('dirty-guard'));
  response.resolve();
  assert.equal(await flushing, true);
  await publishing;
  assert.equal(saved, true);
});

test('a refused canonical live-session settle propagates without publishing or accepting the dirty guard', async () => {
  const failure = new Error('The live text editor has not settled.');
  let reads = 0;
  const f = fixture({ commit: async () => { throw failure; }, fetch: async () => { reads++; return new Response('{}'); } });
  await assert.rejects(f.flush(), error => error === failure);
  assert.equal(reads, 0);
  assert.deepEqual(f.events, []);
});

test('the canonical null-on-unmount lifecycle clears the native settler and ordinary editors expose no hook', async () => {
  let commits = 0;
  const f = fixture({ commit: async () => { commits++; }, fetch: async () => new Response('{}') });
  assert.equal(typeof f.context.__CODEX_DESIGN_EDITOR_SETTLE__, 'function');
  f.clear();
  assert.equal(f.context.__CODEX_DESIGN_EDITOR_SETTLE__, null);
  assert.equal(await f.flush(), true);
  assert.equal(commits, 0);
  const ordinary = fixture({ native: false, fetch: async () => new Response('{}') });
  assert.equal(ordinary.context.__CODEX_DESIGN_EDITOR_SETTLE__, undefined);
  assert.equal(ordinary.context.__CODEX_DESIGN_EDITOR_FLUSH__, undefined);
});

test('changed or ambiguous canonical settler shapes fail closed', () => {
  const url = 'https://codex-design.invalid/artifacts/test/assets/editor.js';
  assert.throws(() => adaptInlineEditorScript('function save(fn){slot=fn;notify()}register(api,"setEmbedSettler",()=>save)', url), { code: 'EDITOR_SETTLE_ADAPTER_UNSUPPORTED' });
  assert.throws(() => adaptInlineEditorScript('register(api,"setEmbedSettler",()=>save);register(api,"setEmbedSettler",()=>other)', url), { code: 'EDITOR_SETTLE_ADAPTER_UNSUPPORTED' });
  assert.throws(() => adaptInlineEditorScript('register(api,"setEmbedSettler",function(){return save})', url), { code: 'EDITOR_SETTLE_ADAPTER_UNSUPPORTED' });
});
