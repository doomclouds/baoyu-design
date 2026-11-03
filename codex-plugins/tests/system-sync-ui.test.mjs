import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '@modelcontextprotocol/ext-apps';
import { createMcpBridge } from '../source/server/ui-bridge.mjs';

const artifactId = '11111111-2222-4333-8444-555555555555';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const confirmationToken = '22222222-3333-4444-8555-666666666666';
const preview = { confirmationToken, namespace: 'qa', title: 'QA design system', state: 'behind', canSync: true,
  changed: ['tokens.json', 'components/Card/preview.html'], removed: ['old.css'], source: '/source/project' };
const result = value => ({ content: [], structuredContent: { result: value } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const drain = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, { prepare = () => preview, apply = () => ({ copied: 2, state: 'current', snapshotId: 'snapshot-before-sync' }), confirm } = {}) {
  const app = new App({ name: 'system-sync-ui-test', version: '1' }, {}, { autoResize: false, strict: true });
  const requests = [], reviews = [], decisions = [], hostRequests = new Map();
  let active, disposed = false, factories = 0;
  const dialog = {
    confirm(detail) {
      reviews.push(detail);
      if (confirm) return confirm(detail);
      const gate = deferred(); active = { id: detail.artifactId, gate }; decisions.push(gate); return gate.promise;
    },
    cancel(id) { if (active?.id === id) { active.gate.resolve(false); active = undefined; } },
    dispose() { disposed = true; active?.gate.resolve(false); active = undefined; },
  };
  const transport = {
    async start() {},
    async close() { transport.onclose?.(); },
    async send(message) {
      requests.push(message);
      if (!message.method && hostRequests.has(message.id)) {
        hostRequests.get(message.id)(message); hostRequests.delete(message.id); return;
      }
      if (message.id === undefined) return;
      let response;
      if (message.method === 'ui/initialize') response = Promise.resolve({ protocolVersion: '2026-01-26',
        hostInfo: { name: 'test-host', version: '1' }, hostCapabilities: {}, hostContext: {} });
      else if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'design_action');
        const { action, payload } = message.params.arguments;
        assert.equal(action, 'editor.systemSync');
        response = Promise.resolve().then(() => payload.operation === 'prepare' ? prepare(payload) : apply(payload)).then(result);
      } else response = Promise.reject(new Error(`Unexpected host request: ${message.method}`));
      void response.then(value => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: value }), error => {
        transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [],
          structuredContent: { error: { code: error.code || 'TEST_FAILURE', message: error.message } } } });
      });
    },
  };
  const connect = app.connect.bind(app); app.connect = () => connect(transport);
  const bridge = await createMcpBridge({ app, systemSyncDialogFactory: () => { factories++; return dialog; } });
  t.after(() => bridge.dispose());
  return { bridge, requests, reviews, decisions, calls: () => requests.filter(item => item.method === 'tools/call').map(item => item.params.arguments),
    teardown: () => new Promise(resolve => {
      hostRequests.set('host-resource-teardown', resolve);
      transport.onmessage({ jsonrpc: '2.0', id: 'host-resource-teardown', method: 'ui/resource-teardown', params: {} });
    }),
    get disposed() { return disposed; }, get factories() { return factories; } };
}

test('system sync prepares a bounded diff and only applies the fixed artwork id and reviewed token after confirmation', async t => {
  const f = await fixture(t);
  const pending = f.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa', source: '/injected', confirmationToken: otherId });
  await drain();
  assert.deepEqual(f.calls(), [{ action: 'editor.systemSync', payload: { id: artifactId, operation: 'prepare', namespace: 'qa' } }]);
  assert.deepEqual(f.reviews, [{ ...preview, artifactId }]);
  let completed = false; void pending.then(() => { completed = true; });
  await drain(); assert.equal(completed, false);
  f.decisions[0].resolve(true);
  assert.deepEqual(await pending, { copied: 2, state: 'current', snapshotId: 'snapshot-before-sync' });
  assert.deepEqual(f.calls()[1], { action: 'editor.systemSync', payload: { id: artifactId, operation: 'apply', confirmationToken } });
  assert.equal(f.requests.some(item => ['ui/message', 'sampling/createMessage', 'ui/open-link'].includes(item.method)), false);
});

test('cancel preserves the reviewed behind state, while an unchanged diff opens no dialog or apply request', async t => {
  const cancelled = await fixture(t, { confirm: async () => false });
  assert.deepEqual(await cancelled.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' }), {
    copied: 0, state: 'behind', changed: 2, removed: 1, canSync: true, cancelled: true,
  });
  assert.equal(cancelled.calls().length, 1);
  const unchanged = await fixture(t, { prepare: () => ({ ...preview, state: 'current', changed: [] }) });
  assert.deepEqual(await unchanged.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' }), {
    copied: 0, state: 'current', changed: 0, removed: 1, canSync: true,
  });
  assert.equal(unchanged.factories, 0); assert.equal(unchanged.calls().length, 1);
});

test('a changed source rejects the reviewed apply without automatically retrying prepare or overwriting again', async t => {
  const f = await fixture(t, { confirm: async () => true,
    apply: () => { throw Object.assign(new Error('The source changed after review.'), { code: 'DS_SYNC_STALE' }); } });
  await assert.rejects(f.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' }), { code: 'DS_SYNC_STALE' });
  assert.equal(f.reviews.length, 1);
  assert.deepEqual(f.calls().map(item => item.payload.operation), ['prepare', 'apply']);
});

test('closing the selected tab or disposing the bridge cancels its review without applying a stale decision', async t => {
  for (const action of ['tab', 'dispose']) {
    const f = await fixture(t), pending = f.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' });
    await drain();
    f.bridge.cancelSystemSync(otherId);
    let finished = false; void pending.then(() => { finished = true; });
    await drain(); assert.equal(finished, false, 'Another tab cannot cancel this artwork review.');
    if (action === 'tab') f.bridge.cancelSystemSync(artifactId); else await f.bridge.dispose();
    assert.equal((await pending).cancelled, true);
    f.decisions[0].resolve(true); await drain();
    assert.equal(f.calls().length, 1);
    if (action === 'dispose') assert.equal(f.disposed, true);
  }
});

test('disposal while preparation is pending cannot open a new review or apply after the bridge has closed', async t => {
  const gate = deferred();
  const f = await fixture(t, { prepare: () => gate.promise, confirm: async () => true });
  const pending = f.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' });
  const rejected = assert.rejects(pending, error => {
    assert.ok(error.code === 'BRIDGE_UNAVAILABLE' || error.code === -32000 && /Connection closed/.test(error.message));
    return true;
  });
  await drain(); await f.bridge.dispose(); gate.resolve(preview); await rejected;
  assert.equal(f.factories, 0);
  assert.equal(f.calls().length, 1);
});

test('closing the selected artwork while its diff is preparing cannot open a delayed confirmation or apply', async t => {
  const gate = deferred();
  const f = await fixture(t, { prepare: () => gate.promise, confirm: async () => true });
  const pending = f.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' });
  const rejected = assert.rejects(pending, { code: 'SYSTEM_SYNC_CANCELLED' });
  await drain(); f.bridge.cancelSystemSync(artifactId); gate.resolve(preview);
  await rejected;
  assert.equal(f.factories, 0);
  assert.equal(f.calls().length, 1);
});

test('actual host resource teardown invalidates a preparing synchronization before it can open a new dialog', async t => {
  const gate = deferred();
  const f = await fixture(t, { prepare: () => gate.promise, confirm: async () => true });
  const pending = f.bridge.syncDesignSystem({ id: artifactId, namespace: 'qa' });
  const rejected = assert.rejects(pending, { code: 'SYSTEM_SYNC_CANCELLED' });
  await drain();
  const acknowledgement = await f.teardown();
  assert.equal(acknowledgement.error, undefined);
  gate.resolve(preview); await rejected;
  assert.equal(f.factories, 0);
  assert.equal(f.calls().length, 1);
});
