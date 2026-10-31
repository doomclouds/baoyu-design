import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { BridgeError, unavailableBridge } from '../source/ui/bridge.js';
import { PLUGIN_UI_VERSION } from '../source/server/contract.mjs';

// Execute the actual entry module with UI/SDK dependencies replaced at their
// import boundary. The entry's bridge selection and lifecycle stay unchanged.
const source = (await fs.readFile(new URL('../source/ui/entry.js', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gm, '');

async function start({ embedded = true, existing, endpoint, failConnect, onConnect } = {}) {
  const calls = [], events = [], mounts = [], httpEndpoints = [];
  const native = { available: true, transport: 'mcp', uiVersion: PLUGIN_UI_VERSION, supportsInlineEditor: true,
    invoke: async action => { calls.push({ bridge: native, action }); } };
  const http = { available: true, invoke: async action => { calls.push({ bridge: http, action }); } };
  const listeners = new Map();
  const window = { codexDesignBridge: existing, codexDesignHttpEndpoint: endpoint,
    addEventListener: (name, handler) => listeners.set(name, handler),
    dispatchEvent: event => { events.push(event); listeners.get(event.type)?.(event); } };
  window.parent = embedded ? {} : window;
  let installations = 0;
  const context = vm.createContext({ window, document: { getElementById: () => ({}) }, PLUGIN_UI_VERSION, BridgeError, unavailableBridge,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    createHttpBridge: options => { httpEndpoints.push(options.endpoint); return http; },
    createUi: async ({ bridge }) => {
      mounts.push(bridge);
      if (bridge.available === true) await bridge.invoke(bridge.supportsInlineEditor === true ? 'editor.document' : 'editor.open');
      return { destroy() {} };
    },
    installMcpBridge: async () => {
      installations++; onConnect?.();
      if (failConnect) throw failConnect;
      await window.installCodexDesignBridge(native);
    },
  });
  vm.runInContext(source, context, { filename: 'source/ui/entry.js' });
  await setImmediate();
  await vm.runInContext('mounting', context);
  return { window, native, http, calls, events, mounts, httpEndpoints, installations };
}

test('fresh embedded startup installs the native MCP bridge and opens editor.document', async () => {
  const result = await start();
  assert.equal(result.installations, 1);
  assert.deepEqual(result.calls.map(call => call.action), ['editor.document']);
  assert.equal(result.mounts.at(-1), result.native);
});

test('embedded startup disposes a 0.3 bridge before connecting and never invokes its HTTP editor', async () => {
  let disposed = false, invoked = false;
  const result = await start({ existing: { available: true,
    invoke: async () => { invoked = true; },
    dispose: async () => { await setImmediate(); disposed = true; } }, onConnect: () => assert.equal(disposed, true) });
  assert.equal(disposed, true);
  assert.equal(invoked, false);
  assert.equal(result.installations, 1);
  assert.deepEqual(result.calls.map(call => call.action), ['editor.document']);
});

test('embedded startup ignores a legacy HTTP endpoint and never constructs an HTTP bridge', async () => {
  const result = await start({ endpoint: 'http://127.0.0.1:9739/legacy/api' });
  assert.equal(result.installations, 1);
  assert.deepEqual(result.httpEndpoints, []);
  assert.deepEqual(result.calls.map(call => call.action), ['editor.document']);
});

test('embedded startup only reuses a current, available native MCP bridge', async () => {
  for (const patch of [{ uiVersion: '0.3.0' }, { available: false }, { supportsInlineEditor: false }, { transport: 'http' }]) {
    let invoked = false;
    const existing = { available: true, transport: 'mcp', uiVersion: PLUGIN_UI_VERSION, supportsInlineEditor: true,
      invoke: async () => { invoked = true; }, ...patch };
    const result = await start({ existing });
    assert.equal(result.installations, 1);
    assert.equal(invoked, false);
    assert.equal(result.calls[0].action, 'editor.document');
  }
  const invoked = [];
  const existing = { available: true, transport: 'mcp', uiVersion: PLUGIN_UI_VERSION, supportsInlineEditor: true,
    invoke: async action => invoked.push(action) };
  const result = await start({ existing });
  assert.equal(result.installations, 0);
  assert.equal(result.mounts.at(-1), existing);
  assert.deepEqual(invoked, ['editor.document']);
});

test('legacy bridge-ready events and direct installation cannot replace an embedded native bridge', async () => {
  const result = await start();
  const legacy = { available: true, invoke() { throw new Error('HTTP must not run.'); } };
  result.window.dispatchEvent({ type: 'codex-design:bridge-ready', detail: { bridge: legacy } });
  await assert.rejects(result.window.installCodexDesignBridge(legacy), { code: 'BRIDGE_UNAVAILABLE' });
  assert.equal(result.window.codexDesignBridge, result.native);
  assert.equal(result.mounts.length, 2);
});

test('an unsuccessful embedded MCP connection stays unavailable without falling back to HTTP', async () => {
  const result = await start({ endpoint: 'http://127.0.0.1:9739/legacy/api', failConnect: Object.assign(new Error('Handshake failed.'), { code: 'BRIDGE_UNAVAILABLE' }) });
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.httpEndpoints, []);
  assert.equal(result.mounts.at(-1).available, false);
  assert.equal(result.events.at(-1).type, 'codex-design:bridge-error');
});

test('top-level standalone preview retains explicit HTTP endpoint behavior', async () => {
  const result = await start({ embedded: false, endpoint: 'http://127.0.0.1:9739/preview/api' });
  assert.equal(result.installations, 0);
  assert.deepEqual(result.httpEndpoints, ['http://127.0.0.1:9739/preview/api']);
  assert.deepEqual(result.calls.map(call => call.action), ['editor.open']);
});

test('top-level injected preview bridge remains usable without MCP identity markers', async () => {
  const actions = [];
  const existing = { available: true, supportsInlineEditor: true, invoke: async action => actions.push(action) };
  const result = await start({ embedded: false, existing });
  assert.equal(result.installations, 0);
  assert.equal(result.mounts.at(-1), existing);
  assert.deepEqual(actions, ['editor.document']);
});
