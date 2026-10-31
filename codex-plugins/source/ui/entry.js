import { createUi } from './library-ui.js';
import { BridgeError, createHttpBridge, unavailableBridge } from './bridge.js';
import { installMcpBridge } from '../server/ui-bridge.mjs';
import { PLUGIN_UI_VERSION } from '../server/contract.mjs';

let controller;
let mounting = Promise.resolve();
const embedded = window.parent !== window;
const currentMcpBridge = bridge => bridge?.transport === 'mcp'
  && bridge.uiVersion === PLUGIN_UI_VERSION && bridge.available === true
  && bridge.supportsInlineEditor === true && typeof bridge.invoke === 'function';
async function mount(bridge) {
  controller?.destroy();
  controller = await createUi({ root: document.getElementById('codex-design-root'), bridge });
  window.codexDesignUi = controller;
  return controller;
}
window.createCodexDesignUi = createUi;
window.installCodexDesignBridge = (bridge) => {
  if (embedded && !currentMcpBridge(bridge)) return Promise.reject(new BridgeError('A current native MCP bridge is required in the embedded workspace.'));
  window.codexDesignBridge = bridge;
  mounting = mounting.catch(() => {}).then(() => mount(bridge));
  return mounting;
};
window.addEventListener('codex-design:bridge-ready', (event) => {
  const bridge = event.detail?.bridge ?? window.codexDesignBridge;
  if (!embedded || currentMcpBridge(bridge)) window.installCodexDesignBridge(bridge);
});
const previousBridge = window.codexDesignBridge;
const initialBridge = embedded ? (currentMcpBridge(previousBridge) ? previousBridge : unavailableBridge()) : previousBridge ?? (window.codexDesignHttpEndpoint
  ? createHttpBridge({ endpoint: window.codexDesignHttpEndpoint, eventsUrl: window.codexDesignEventsUrl })
  : unavailableBridge());
mounting = mount(initialBridge);
if (embedded && !currentMcpBridge(previousBridge)) {
  (async () => {
    await previousBridge?.dispose?.();
    await installMcpBridge({ timeoutMs: 8000 });
  })().catch((error) => {
    window.dispatchEvent(new CustomEvent('codex-design:bridge-error', { detail: { code: error.code, message: error.message } }));
  });
}
