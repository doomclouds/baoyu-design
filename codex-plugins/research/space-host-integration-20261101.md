# Codex Space and MCP global app integration: 2026-11-01

## Scope and authority

Read-only investigation of the installed Windows Codex application and the public
OpenAI MCP Extensions contract. No host code/configuration was changed, no private
IPC was called, and no temporary plugin was installed.

Installed artifact:

`C:\Program Files\WindowsApps\OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0\app\resources\app.asar`

SHA-256: `6fbedf054a8d8cafaf5c745b40aa59176512e106e0bd6308275ae123b60fd074`

REA MCP `analyze_javascript_application` selected six relevant renderer modules.
Parent Evidence: `ev_5ffe243c70b7a9a8013a4014b3e4ebf34f6d163183addebfca030ab6d7153898`.
Summary Evidence: `ev_eef282c50bc8418f652d5725eff3a288d441ff95d18696e348842345f6eff499`.
The complete inventory was hashed; six sources were parsed as inert text. Graph
coverage is partial (unselected sources and semantic limits). Eight unrelated
unpacked native binaries differ from their ASAR-declared integrity hashes;
`record-and-continue` preserved that fact. These are static observations, not a
claim that native UI interactions were exercised.

Selected and subsequently relevant modules were extracted for ordinary read-only
source analysis into `research/host-20261101`. Babel parser/generator formatted
them without executing target code. Line references below refer to the
`*.js.readable.txt` files in that directory; original minified bytes are adjacent.

## Findings

### 1. Space owns a real host sidebar; a global MCP app does not get its slot

`app-initial-4267e52fe5b0.js.readable.txt:185586-185603` contains the host sidebar
area selector `E0r`. It explicitly returns `null` for
`/plugins/:pluginId/app/:toolName` and other MCP destinations, then selects only
built-in areas such as `customize`, `space`, `scheduled`, and `home`.

`app-primary-998934e837fc.js.readable.txt:122430-122656` renders the application
navigation rail and the retained middle navigation pane. The Space pane is the
host's `G9t`/`SpaceSidebar` component, not part of the content frame. Navigation
state (`sidebarArea`, `sidebarDestinationId`, `sidebarPrimaryContent`) belongs to
the host router and its retained destination sessions.

The one examined specialized MCP sidebar is Meetings. Its plugin IDs are
explicitly allowlisted in
`app-initial-4267e52fe5b0.js.readable.txt:185540-185552`.
`plugin-view-frame-402df5433fc4.js.readable.txt:7-43` injects the private
`openai/meetingsSidebar` capability only for the Meetings server/tool pair.
This is not a generic extension that Codex Design can truthfully declare.

The public schema in
`node_modules/@openai/mcp-extensions/dist/shared/ui.d.ts` allows global/thread/file
entrypoints and a global quick action. It declares no arbitrary host sidebar
content, sidebar collapse controller, or host navigation area.

Consequently, the existing global entrypoint is valid and installs a rail entry,
but it cannot replace the host's middle sidebar with Codex Design categories.
An app-internal collapsible category pane is achievable; claiming it is the
host-wide sidebar is incorrect. Exact Space parity requires a public host API or
a host implementation change. Patching the installed application is not an
acceptable plugin implementation.

### 2. The empty top strip with the plus button is owned by the host

The user clarified that the entire native workspace tab row must be absent:
the Codex Design chip, plus button, overflow menu and layout controls, not just
an empty Chat toolbar. There are separate control-registration, secondary
toolbar and unified-tab-row paths. The earlier three-prop null-forwarding
proposal addresses only the secondary toolbar; it is not a fix for this full
requirement.

`view-page-9c174d682b3b.js.readable.txt:385-390` calls `McpWorkspace` with
`view`, `mcpAppId`, `deepLink` and `session`, without a toolbar override.
`view-c43892ae83d7.js.readable.txt:294,381-390` accepts an internal
`mainToolbar` prop and uses its undefined/default case to register a new-chat
action and current-chat title. However, the `mt` workspace frame at `250-253`
does not forward that prop into `PersistentLayout`. Therefore setting only
`McpWorkspace.mainToolbar = null` is not sufficient evidence of a height fix.

The secondary Chat-toolbar reservation follows this chain:

1. `persistent-layout-f29542da2f2c.js.readable.txt:13,45` accepts and forwards
   `mainToolbar` to `ThreadAppShellChrome`; `49-51` separately selects the
   `thread-edge-scroll` content layout.
2. `thread-app-shell-chrome-acabd0086f14.js.readable.txt:2197-2212` creates the
   default `Ms` Chat toolbar when `mainToolbar` is undefined. Explicit `null`
   avoids that default. At `2346`, its result reaches
   `UnifiedTabStrip.mainToolbar`.
3. `app-primary-998934e837fc.js.readable.txt:26234` enables the main toolbar
   only when `Te.mainToolbar != null` and the other shell placement predicates
   hold. `26502-26520` then creates the fixed-height wrapper using
   `--app-shell-header-height` / `--height-toolbar`. Delivering explicit null
   through the full chain removes this secondary wrapper and its controls.

The whole native row has an independent path. At
`thread-app-shell-chrome-acabd0086f14.js.readable.txt:2332-2353`, the shell
registers `UnifiedTabStrip` with its own `children` node and `isVisible`
predicate. At `2359-2377`, its native tab portal is populated separately; at
`2405-2418`, `unified-workspace-controls` is registered as a separate header
action. `app-primary-998934e837fc.js.readable.txt:22244-22251` renders
`U.mode === 'full' ? U.node : null` independently of `U.mainToolbar`.
Consequently even fully forwarded `mainToolbar: null` does not remove the
Codex Design home tab, native tab strip, plus button and all header controls.

No matching user-facing layout preference was established. The inspected
`Hide tabs` action explicitly hides content and leaves Chat visible
(`app-initial-4267e52fe5b0.js.readable.txt:298001-298003`), which is a different
outcome. The single-home-tab automatic hide predicate at `196976-196984`
refuses content-primary workspaces. MCP global routes choose
`primarySurface: 'content'` (`app-primary-998934e837fc.js.readable.txt:125783-125795`),
and that route field is not public plugin metadata.

Space uses a different composition. `app-runtime-e4b4e09bd942.js.readable.txt:2321`
loads `SpacesLandingRoute`, whose `landing-route-ac2fb68c4c3e.js.readable.txt:152-160`
selects `SlateSpacePage`. Its nonembedded path registers
`MainContentLayout layout="custom-titlebar"` at
`slate-page-a8ff51e2333c.js.readable.txt:2453-2455`, with its own library header.
`app-primary-998934e837fc.js.readable.txt:22155` suppresses the generic floating
page-header fallback for this layout; it does not itself disable an independently
registered `UnifiedTabStrip.node`. Space also has its own
`SpacesWorkspaceShell`, not the MCP `PersistentLayout` composition. Its route
selects the primary surface differently. The custom-titlebar, secondary-toolbar
and unified-tab-row predicates are distinct; changing one is not proof that the
others disappear.

The installed `@openai/mcp-extensions@0.2.1` strict metadata schema exposes
global/thread/file entrypoints and display modes, but no native toolbar field.
Fullscreen, widget border preferences and CSS inside the plugin cannot supply
the missing host chrome contract. There is no verified plugin-only switch in this
host version. A corrected host chrome/API proposal, its portable release
boundary and required actual-host checks are documented in
[native-shell-layout-proposal.md](native-shell-layout-proposal.md). No host
modification or native visual pass is claimed here.

### 3. Host typography and theme inheritance are supported and were missing

`mcp-app-host-styles-b3fb47a5d319.js.readable.txt:5-110` computes standard MCP Apps
style variables from the host's actual theme. They include:

- `--font-sans`, `--font-mono`, normal/medium/semibold/bold weights;
- text XS/SM/MD/LG sizes and line heights;
- heading XS through 3XL sizes and line heights;
- background, foreground, border, semantic and ring colors;
- radius XS through full, border width, and hairline/SM/MD/LG shadows.

The variables are delivered in `hostContext.styles.variables` during initialize
and `ui/notifications/host-context-changed` afterwards. Codex Design should apply
them and use the corresponding CSS variables rather than fixed font settings.
The standalone browser preview may retain sensible fallback values.

Official sources, searched and fetched during this investigation:

- https://developers.openai.com/plugins/build/extensions
- https://developers.openai.com/plugins/changelog#apps-sdk-2026-05-28
- https://github.com/openai/mcp-extensions/blob/main/docs/spec.md

### 4. Newly created editors fail because local HTTP frames are rejected

The outer app resource's `ui.csp.frameDomains` was set to
`http://127.0.0.1:*`/`http://localhost:*`. A successful HTTP preview does not
exercise the consuming app's resource parser.

`resource-104414a99f7e.js.readable.txt:389-405` sanitizes declared domains:

- empty/unsafe strings are discarded;
- literal `blob:` and `data:` are explicitly accepted at `392`;
- other entries must parse as a URL;
- only HTTPS (and WSS for connect domains) is accepted;
- the potential HTTP localhost exception calls `H()`, which returns false at
  `386-388`, and frame domains use the variant that cannot take that exception;
- wildcard ports also fail `new URL` before this scheme check.

At `410-444`, both modern `ui.csp` and legacy `openai/widgetCSP` pass through the
same transforms. Switching legacy metadata does not repair the problem.
At `360-371`, the final CSP reader receives already-sanitized values.

The actual outer renderer uses an Electron webview
(`widget-9db463e435db.js.readable.txt:2459`) and forwards approved frame domains
into the sandbox at `3625-3629`. Its local-network permission is conditional,
not a way to override rejected domains (`2220-2222`).

A bounded self-contained editor frame (`blob:` or `srcdoc`) plus MCP-backed
content/asset RPC is a plausible supported solution. `frameDomains: ['blob:']`
is explicitly accepted by the shipped parser. This establishes metadata parsing,
not an end-to-end runtime guarantee: the Skybridge document/CSP generator is
loaded remotely, so the actual consuming app must verify script/asset loading,
saving, navigation, and comments. Do not widen network access or invent an HTTPS
endpoint to hide this architectural issue.

### 5. A global native composer is not one editing chat per artwork

`view-c43892ae83d7.js.readable.txt:300-306` keys the native workspace by host ID,
route pathname, and `session.workspaceId`. The internal plugin tabs do not create
new native workspace sessions. `354-366` submits to that workspace session and
promotes its native conversation; `newConversationNavigation: 'stay'` only keeps
navigation in the workspace.

Public `@openai/mcp-extensions@0.2.1` message options expose `active`, `new`, and
`send`, not destination thread/project/cwd or an artifact-to-conversation binding
operation. A single app-level native conversation must not be described as each
artwork's unique editing conversation. This remains a host API gap, as already
recorded in `native-mcp-discovery-20261031.md`.

## Actionable implementation boundary

Implement and verify now: host-style variables, compact Space-like library rows,
anchored creation choices, accessible focus/keyboard handling, clear save/load
states, unique tabs, collapsible app category navigation, and self-contained
editor delivery with MCP content transport. Preserve comments, references,
content-only import/export, and local persistence.

Keep explicit as unsupported until a real public host API exists: replacing the
native middle sidebar, removing the native MCP workspace toolbar, and binding a
different native composer conversation to each internal artwork tab. Do not
silently substitute a shared composer, fake host UI, or private IPC.
