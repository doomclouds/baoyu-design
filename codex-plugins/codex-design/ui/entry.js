import { createUi } from './library-ui.js';
import { createHttpBridge, unavailableBridge } from './bridge.js';
import { installMcpBridge } from '../server/ui-bridge.mjs';

let controller;
let mounting = Promise.resolve();
async function mount(bridge) {
  controller?.destroy();
  controller = await createUi({ root: document.getElementById('codex-design-root'), bridge });
  window.codexDesignUi = controller;
  return controller;
}
window.createCodexDesignUi = createUi;
window.installCodexDesignBridge = (bridge) => {
  window.codexDesignBridge = bridge;
  mounting = mounting.catch(() => {}).then(() => mount(bridge));
  return mounting;
};
window.addEventListener('codex-design:bridge-ready', (event) => {
  window.installCodexDesignBridge(event.detail?.bridge ?? window.codexDesignBridge);
});
const initialBridge = window.codexDesignBridge ?? (window.codexDesignHttpEndpoint
  ? createHttpBridge({ endpoint: window.codexDesignHttpEndpoint, eventsUrl: window.codexDesignEventsUrl })
  : unavailableBridge());
mounting = mount(initialBridge);
if (!window.codexDesignBridge && !window.codexDesignHttpEndpoint && window.parent !== window) {
  installMcpBridge({ timeoutMs: 8000 }).catch((error) => {
    window.dispatchEvent(new CustomEvent('codex-design:bridge-error', { detail: { code: error.code, message: error.message } }));
  });
}
