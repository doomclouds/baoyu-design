# Testing Codex Design in its actual host

Research checked on 2026-11-01. This is a testing procedure, not a record claiming
that every step has already passed.

## Test layers have different authority

| Layer | Suitable evidence | What it does not establish |
| --- | --- | --- |
| Library/unit tests | Content, validation, persistence, isolation, concurrency | Native UI rendering |
| Raw MCP client / MCP Inspector | Discovery, tool schemas/results, resource bytes | The Codex resource parser, CSP, native frame, native sidebar |
| Browser preview / SDK basic host | App layout, AppBridge protocol, interactions, screenshots | Real Codex host capabilities or policies |
| Actual installed Codex plugin | Native entrypoint, host initialization, consuming-app actions and rendered output | Features the public host API does not expose |

OpenAI's [connect-and-test guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
requires both server checks and complete installed-plugin checks. Keep the
evaluation inputs and results; after metadata changes, refresh the installed
integration and rerun affected paths.

The upstream MCP Apps [E2E instructions](https://github.com/modelcontextprotocol/ext-apps/blob/main/CONTRIBUTING.md#e2e-tests)
describe Playwright screenshot tests. Their [Playwright configuration](https://github.com/modelcontextprotocol/ext-apps/blob/main/playwright.config.ts)
uses a localhost example host. Those tests are useful component coverage; they
do not launch Codex Desktop.

The proposed [HostTestInterface](https://github.com/modelcontextprotocol/ext-apps/issues/743)
is an open conformance proposal. It is not evidence that a public Codex Desktop
test-control interface is available.

## 1. Verify the exact installed package

Use the final GitHub marketplace installation, not a second temporary probe.
Record:

- plugin ID, version, source ref and commit;
- actual Desktop runtime version;
- installed-file hashes compared with the generated release;
- discovered server plugin ID and global/file entrypoint metadata;
- resource MIME type and resource HTML hash.

The existing `verify-installed.mjs` metadata test can establish that the actual
Desktop runtime starts and discovers the installed MCP server. It cannot by
itself establish that the current Desktop window rendered the app.

For an additional raw protocol check, the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
supports stdio servers and a scriptable CLI. Resolve and pin the Inspector
version before adding it as a dependency; do not silently change the plugin's
runtime SDK to match an example.

```powershell
# SERVER_ENTRY is the absolute installed server/index.mjs path.
npx @modelcontextprotocol/inspector --cli node $SERVER_ENTRY --method tools/list
```

This is still a protocol test, even if the process is the same final installed
server binary.

## 2. Open the real entrypoint

Use the actual left-rail entry or the documented global deep link:

`codex://plugins/codex-design@codex-design-marketplace/app/DesignLibrary?path=%2F`

The [public deep-link contract](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#deep-links)
defines this OS URI and delivers the path through host context. A localhost web
preview is not an equivalent launch. Codex's `open_in_codex` browser target does
not support arbitrary Codex app deep links; do not mislabel a browser tab as a
native global entrypoint.

A `.codexdesign` file can also be opened through the normal file-viewer tool to
exercise the registered file handler. This tests a different entrypoint and
must be recorded separately from global navigation.

## 3. Observe actual UI through an available supported surface

Prefer the platform's registered MCP Apps browser target when the actual app is
available there. Inspect the existing target; do not create an ordinary browser
preview and label it as the consuming app. Capture the frame tree, DOM/UI
snapshot and screenshot from that target, then exercise its real controls.

The app may also record bounded, app-owned diagnostics from its normal SDK
initialization and actions: host name/version, advertised capabilities, display
mode, received style variable names, initialization/resource revision, and
editor-ready/save/error events. Exclude chat text, credentials and unrelated
user content. These events help attribute failures; a successful handshake or
an app-generated `ready` event alone does not prove visual correctness.

REA can passively observe an already-enabled loopback CDP endpoint. It cannot
attach to an endpoint that does not exist. On this machine, the live check at
the time of research found:

- no `--remote-debugging`/Inspector switch on the running ChatGPT processes;
- no listening TCP endpoint owned by those processes;
- no `DevToolsActivePort` under the active Roaming Codex profile.

Therefore no passive CDP consuming-app run was available from that check. Do
not enable debugging, disable fuses/sandboxing, relaunch the user's desktop,
inject private IPC, or fabricate host metadata to convert this into a pass.
Native application UI automation remains subject to the active computer-use
tool's boundaries. If no supported target is exposed, the final native visual
steps need an operator to perform them, and the report must leave them pending.

## 4. Native acceptance matrix

Use freshly named acceptance artwork. Preserve preexisting artwork, view state,
comments, and original demo servers. For each result, record version, entrypoint,
actual action, observable outcome, evidence location, and pass/fail/pending.

| Case | Required actual-host observation |
| --- | --- |
| Global entry | Left-rail click opens the installed app; current native route and screenshot agree |
| Native home Tab | First open shows the named nonclosable home without creating a dummy second Tab; rail reentry and restart preserve it. A manual full-view shortcut success alone is not a default-initialization pass |
| Creation context | Global sidebar Create and All-page Create offer type choices; each category's heading/empty-state action creates that type directly; keyboard focus, Escape and dismissal work for actual menus |
| Four blank types | Slides, Design, Design System and Dashboard each show real editable content after creation, not a gray/broken frame |
| CSP | Inner editor scripts/assets load under the consuming host policy; no HTTP loopback frame dependency remains |
| Themes/fonts | Host light/dark and UI font settings arrive and change app chrome; artwork content is unaffected |
| Language (0.4.2 onward) | Plugin controls, menus and dialogs remain English despite old Chinese preferences or host locale; authored titles, body and comments remain unchanged |
| Save/reopen | Edit a distinctive literal, observe saved state, close/reopen, read exact saved bytes from the library |
| Unique tabs | Open an existing artwork again and activate the same tab; tab order and selection restore |
| Failure/retry | A failed content load displays a useful error; retry recovers without creating a replacement artwork |
| Comments | Anchor, save, reply, resolve and reopen persist; Add to chat changes only the native draft, and user Send is followed by exact request read/accept/dispatch, an actual worker and canonical result reply |
| Steered requests | Send a second comment during an active native turn; its exact visible URI/attachment identifies a separate request, with its own receipt, dispatch, serial job and reply |
| Reference | A selected artwork/design system becomes a read-only reference; no unrelated source is edited |
| Import/export | Native host import selects content and creates a new artifact; downloaded bundle contains artwork/assets only |
| Trash/restore | Trash hides the work from active lists and DS search; restore brings back the same UUID/content |
| Restart | Reopen the installed app and retained local library data loads without relying on an expired localhost URL |

Export must be checked in the real installed host. The earlier download path
delegated to the desktop sandbox; from 0.5.1 the shared native path instead uses
the plugin's Save As UI and app-only filesystem save operations. Verify chosen
directory, filename, actual bytes, cancellation, overwrite confirmation and
returned path for library and editor exports. A simulated bridge or browser
`a.download` result does not establish installed-host export behavior.

## 5. Explicit capability limits

The current public global-entrypoint schema provides no arbitrary native middle
sidebar slot, native MCP workspace toolbar replacement, or per-internal-tab
native composer binding. A collapsible category pane inside the app is testable;
it must not be reported as replacing the host-wide middle sidebar. A shared
global composer must not be reported as one bound conversation per artwork.

See the shipped-artifact evidence in
`research/space-host-integration-20261101.md`. Mark these requirements as host API
gaps until a supported API is available. Never use a browser-only screenshot,
an isolated stdio test or a synthetic AppBridge to close these gaps on paper.

## Release report rule

Publish separate counts for unit/protocol/component checks and actual installed
host checks. Preserve failures and pending cases. Do not describe the release as
fully native-verified, pixel-perfect or feature-complete while actual-host cases
remain unexecuted.
