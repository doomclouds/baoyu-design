/** The UI never creates chats or starts models. A host supplies these capabilities. */
export class BridgeError extends Error {
  constructor(message, code = 'BRIDGE_UNAVAILABLE') { super(message); this.name = 'BridgeError'; this.code = code; }
}

export function unavailableBridge() {
  return {
    available: false,
    capabilities: { actions: [] },
    invoke: async () => { throw new BridgeError('The design workspace is not connected.'); },
    subscribe: () => () => {},
  };
}

/** Optional transport; the host explicitly supplies the endpoint and authorization. */
export function createHttpBridge({ endpoint, eventsUrl, headers = {}, language, fetch: fetcher = globalThis.fetch } = {}) {
  if (!endpoint) throw new TypeError('An explicit bridge endpoint is required.');
  const subscriptions = new Set();
  let events;
  return {
    available: true,
    language,
    async invoke(action, payload = {}) {
      const response = await fetcher(endpoint, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ action, payload }),
      });
      let result;
      try { result = await response.json(); }
      catch { throw new BridgeError('The workspace returned an invalid response.', 'INVALID_RESPONSE'); }
      if (!response.ok || result?.error) {
        const detail = typeof result?.error === 'object' ? result.error : result;
        throw new BridgeError(detail?.message || String(result?.error || response.statusText), detail?.code || 'BRIDGE_ERROR');
      }
      return Object.hasOwn(result ?? {}, 'result') ? result.result : result;
    },
    subscribe(handler) {
      subscriptions.add(handler);
      if (eventsUrl && !events && typeof EventSource !== 'undefined') {
        events = new EventSource(eventsUrl, { withCredentials: true });
        events.onmessage = (event) => {
          let value;
          try { value = JSON.parse(event.data); } catch { return; }
          for (const listener of subscriptions) listener(value);
        };
      }
      return () => {
        subscriptions.delete(handler);
        if (!subscriptions.size) { events?.close(); events = undefined; }
      };
    },
  };
}

export function supports(bridge, action) {
  if (!bridge || bridge.available === false || typeof bridge.invoke !== 'function') return false;
  const actions = bridge.capabilities?.actions;
  return !Array.isArray(actions) || actions.includes(action);
}
