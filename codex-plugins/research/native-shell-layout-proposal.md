# Native Codex Design shell integration proposal

## Status and scope

This is a reviewable proposal, not an executed fix. The user's target is a
global Codex Design rail entry, categories in the host's shared collapsible
middle sidebar, and content starting immediately below the native window/menu
bar. The user explicitly requires the **entire native workspace tab row** to be
absent, including its Codex Design chip, plus button, overflow menu and layout
controls. Filling that row with artwork tabs is not the requested solution.
The bottom native composer, local runtime selection and existing
editing/comment features must remain available.

No installed host file, configuration, private IPC, sandbox policy or security
setting was changed. Host JavaScript was read as inert text; no native visual
acceptance is claimed. Extracted host files stay in the ignored local research
directory and are not part of the portable plugin or this proposal.

The inspected installed artifact was rehashed on 2026-11-01:

- Package: `OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0`.
- Artifact: `app/resources/app.asar` inside that installed package.
- SHA-256: `6fbedf054a8d8cafaf5c745b40aa59176512e106e0bd6308275ae123b60fd074`.
- Installed public extension SDK: `@openai/mcp-extensions@0.2.1`.

All source locations below refer to formatted inert copies in
`research/host-20261101`; module names identify exact shipped bytes rather than
unverified upstream TypeScript paths. The complete earlier investigation and
its partial graph/integrity limits remain in
[space-host-integration-20261101.md](space-host-integration-20261101.md).

## Why the empty strip persists

| Boundary | Current behavior | Source evidence |
| --- | --- | --- |
| Global view to McpWorkspace | Passes no toolbar preference | `view-page-9c174d682b3b.js.readable.txt:385-390` |
| McpWorkspace to workspace frame | `mainToolbar` can replace control registration, but is not forwarded into the layout | `view-c43892ae83d7.js.readable.txt:250-253,294,381-390` |
| PersistentLayout to ThreadAppShellChrome | Forwards its own `mainToolbar` prop, currently undefined | `persistent-layout-f29542da2f2c.js.readable.txt:13,45` |
| Shell chrome to UnifiedTabStrip | Undefined creates the default Chat toolbar; explicit null suppresses it | `thread-app-shell-chrome-acabd0086f14.js.readable.txt:2197-2212,2346` |
| Secondary Chat-toolbar container | Renders only if `Te.mainToolbar != null` and shell placement conditions hold | `app-primary-998934e837fc.js.readable.txt:26234,26502-26520` |
| Whole native workspace tab row | Registers its own node, native-tab portal and independent visibility predicate | `thread-app-shell-chrome-acabd0086f14.js.readable.txt:2332-2377` |
| Native workspace controls | Registers a separate `unified-workspace-controls` header action | `thread-app-shell-chrome-acabd0086f14.js.readable.txt:2405-2418` |
| AppShell native tab-row rendering | Renders `U.node` in full mode independently of `U.mainToolbar` | `app-primary-998934e837fc.js.readable.txt:22244-22251` |

The secondary Chat-toolbar wrapper reserves
`h-[var(--app-shell-header-height,var(--height-toolbar))]`. Removing a title,
new-chat action, menu icon or inner plugin margin does not remove that wrapper.
Explicit null must reach the layout and shell registration, not just the
McpWorkspace child-control branch. Even then, the independent native tab-row
node and header controls above remain. This distinction corrects the earlier
proposal's insufficient interpretation of the user's screenshot.

Space's separate route illustrates the intended composition: the landing route
selects SlateSpacePage, whose nonembedded branch registers
`MainContentLayout layout="custom-titlebar"`
(`slate-page-a8ff51e2333c.js.readable.txt:2453-2455`). The generic floating-header
predicate checks for that layout at `app-primary-998934e837fc.js.readable.txt:22155`.
Space uses its own SpacesWorkspaceShell and library header, and its route
chooses the primary surface according to its own page/session context
(`app-primary-998934e837fc.js.readable.txt:125775-125782`). The custom-titlebar
predicate suppresses a generic page-header fallback; it is distinct from both
the main-toolbar non-null predicate and native tab-row rendering. Copying only
the custom-titlebar name does not prove removal of an independently registered
UnifiedTabStrip.

## The earlier three-prop patch is insufficient

The earlier concept forwarded `mainToolbar: null` through three boundaries:
global view to McpWorkspace, McpWorkspace to its workspace frame, and that frame
to PersistentLayout. That suppresses default Chat-toolbar registration and its
secondary height reservation. **It does not suppress UnifiedTabStrip.node,
the native tab portal or the separate native controls. It is withdrawn as a
solution for removing the user's whole red-framed row.**

No installed-host patch or generated React compiler memo table was edited.

## Required host chrome change for the whole row

An actual host implementation needs an explicit presentation contract for a
content-only global workspace, separate from its native tab/controller state.
The following are required change boundaries, not an implemented public API:

1. Carry a validated, negotiated header-chrome preference from the global view
   through McpWorkspace and PersistentLayout to the host shell. Keep the
   existing default for plugins that do not opt in.
2. Suppress native workspace tab-row presentation, including the rendered
   UnifiedTabStrip node and its native-tab portal, plus the independent
   `unified-workspace-controls` header action. Suppressing only
   `mainToolbar` is insufficient.
3. Preserve the active content outlet, workspace-home lifecycle and native
   session/composer controller. Blindly setting the existing `isVisible` false
   or removing the whole tab controller is not proven safe: AppShell also uses
   that registration to decide content layout, focus and split/full placement.
4. Remove the corresponding header reservation/offset and any fallback Chat
   toolbar for this presentation mode, while retaining the OS menu/window
   chrome. A custom-titlebar content layout may participate but is not, alone,
   the complete change.
5. Preserve access to essential new-chat/history/layout actions through an
   appropriate native menu rather than leaving invisible focusable controls.

The exact safe source patch depends on the host's owned layout contracts and
must be reviewed and tested there. Static source inspection establishes why the
old smaller patch is insufficient; it does not establish that the above change
has already been implemented or rendered.

## Existing layout controls are not equivalent

The inspected `Hide tabs` label explicitly means hiding content while leaving
Chat visible (`app-initial-4267e52fe5b0.js.readable.txt:298001-298003`). That does
not preserve visible artwork below the menu bar. Full/split-view controls change
placement, not a documented header-only visibility preference.

The automatic single-home-tab hide predicate is `Wdi`
(`app-initial-4267e52fe5b0.js.readable.txt:196976-196984`). It refuses a
content-primary workspace, while MCP global routes are constructed with
`primarySurface: 'content'`
(`app-primary-998934e837fc.js.readable.txt:125783-125795`). The route field is
host-owned and is not accepted plugin metadata. No supported user preference
has been verified to hide exactly this row while preserving the required
global artwork surface and bottom composer.

## Portable plugin API boundary

A local modification of this Windows host is not a fix that another user gets
by installing the GitHub plugin. A portable release requires the host to expose
and implement a supported workspace-chrome preference.

One possible public extension, explicitly **proposed and not currently valid**,
is a tool UI metadata option such as
`workspaceChrome: { header: "hidden" }`, negotiated by a named host
capability. The host would validate the option, carry it into the global view,
then implement all of the header, tab-row and layout behavior above. The strict
public SDK schema, host
metadata parser and global workspace renderer must all agree on the extension.
The plugin must not insert this invented field into a production manifest or
claim support before the host and SDK implement it.

Current SDK fields do not provide that path:

- `preferredDisplayMode` / `availableDisplayModes` affect MCP resource display
  mode. The plugin already requests fullscreen; these fields do not feed
  PersistentLayout's toolbar prop.
- `preferredModelDisplayMode` affects how model output is presented.
- Widget border preferences affect resource chrome, not the parent layout.
- Global/thread/file entrypoints select hosting contexts. Replacing the global
  workspace with a file/thread/settings route is not an equivalent layout fix
  and may change or lose the confirmed native composer behavior.
- Plugin CSS runs inside its resource boundary. Cropping, negative offsets,
  covering the host strip or faking a replacement title bar is not this fix.

## Installed-host patch feasibility: blocked by verified integrity protection

Read-only checks on 2026-11-01 established the following for the installed
Windows package; no write, patched launch or security-setting change was tried:

- `Get-AppxPackage` reports version `26.1027.3384.0`, signature kind `Store`,
  status `Ok` and `IsDevelopmentMode: false`. The ASAR is owned by SYSTEM;
  ordinary Users have ReadAndExecute, not write permission. Its AppxBlockMap
  explicitly covers `app/resources/app.asar`, `ChatGPT.exe` and `chrome.dll`.
- Both `ChatGPT.exe` and `chrome.dll` have valid OpenAI Authenticode signatures.
- The fuse reader found no sentinel in `ChatGPT.exe`: its fuse state alone is
  **unknown**, not disabled. The engine's `chrome.dll` contains a complete v1
  fuse wire at file offset `287200672`: `EnableEmbeddedAsarIntegrityValidation`
  and `OnlyLoadAppFromAsar` are **enabled**. RunAsNode, NodeOptions and Node CLI
  Inspector arguments are disabled. The inspected DLL SHA-256 is
  `f66d0d4e578dc848dd0666bfa80063ea21402cc6155270316491656f26c3839d`.
- PE resource inspection found `INTEGRITY/ELECTRONASAR` in `ChatGPT.exe` at
  file offset `4690112`, length 122. It names `resources\\app.asar`, algorithm
  SHA256, and header hash
  `58b11f647e1119b429ae364292977cf86fe116de3987265ccd2a265991fb9d85`.
  Hashing the actual ASAR header string produced exactly that value.

REA evidence IDs: fuse inspection
`ev_d99989719c3450ee73c24712156d2daa55f8ca18b562f510834823b977ef9008`;
PE resources
`ev_408fe864ccb4fedf9411706549a9995da8e04d4a0ddf6aca97560d43c1d72fd6`.
These target-free tools only read bytes and did not create a binary session.

Electron's official [ASAR integrity documentation](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
and [fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses)
were queried through Context7 before interpreting the flags. They explain
the embedded Windows header hash and ASAR-only code-loading relationship.
The observed header match and enabled flags establish that editing ASAR code
is not an ordinary deployable local UI patch: a modified header would no longer
match the signed executable's embedded value, while editing that value changes
the signed executable and package-covered bytes. Copying the installation does
not itself remove that embedded check.

Under the requirement to preserve those protections, there is no verified safe
route to apply this change to the installed package. Taking over WindowsApps
permissions, disabling fuses/integrity, changing trusted signing policy or
launching a modified host is not proposed or performed. A supported vendor host
feature or vendor-built update is required for this exact native-header target;
it also has to expose a public contract before it becomes a portable GitHub
plugin feature.

A host source proposal can still be scoped precisely: the resolved global
view object in `view-page...:347-390` carries the plugin/tool identity, and
AppShell obtains the active scoped route with `rf(fT)` at
`app-primary...:26074-26084`. A host-owned implementation should derive an
explicit presentation preference from that validated global view identity and
carry it through the scoped workspace layout. It should not guess from a
window-global URL, user-visible title or unrelated chat. No private host
function is exposed for the plugin to invoke by this observation.

Safe work remaining is an inert, reviewable source/API proposal and its test
plan, or testing a vendor-provided supported build. A browser fixture alone
cannot prove that this installed host header has been fixed.

## Shared middle sidebar needs its own host adapter

The sidebar requirement is separate from toolbar suppression. The installed
host's sidebar-area selector explicitly returns null for generic MCP app routes
(`app-initial-4267e52fe5b0.js.readable.txt:185586-185603`). Space's retained
middle pane belongs to host navigation state and layout, not the plugin frame.
The Meetings-specific sidebar capability is allowlisted and cannot be reused
as a generic Codex Design contract.

A supported implementation would need:

1. A public, negotiated navigation/sidebar resource or adapter associated with
   the global app entrypoint and validated by the host.
2. Host-owned pane width, collapse/expand control, persistence, keyboard focus
   and rail-area switching. Changing the rail destination must change the
   shared pane's content, not leave another area's navigation visible.
3. Artwork/category activation routed through the app's supported navigation
   contract, with stable artwork IDs and the existing global library data.
4. The plugin rendering its category navigation in that host slot, and omitting
   the duplicate category pane in the main content only when capability
   negotiation confirms that the slot is actually available.

Simply removing the app-internal sidebar would leave no navigation and would
not connect the native collapse button. Declaring a private Meetings capability
or invoking private host state is not a portable implementation.

## Acceptance before describing the layout as fixed

The following checks must run in the real installed host, not only an ordinary
browser or an isolated AppBridge:

- Record the exact host version/hash and installed plugin release.
- Open Codex Design from the rail. Verify the entire native workspace row,
  including its home-tab chip, plus button, overflow and controls, is absent and
  the plugin's content bounds start below the OS menu bar. Removing only Chat
  toolbar controls, filling the native row with artwork tabs, or retaining empty
  height is a failure.
- Exercise library and all four editors; preserve save/reopen, properties,
  comments, Add to chat, explicit native Send, dispatch and canonical replies.
- Switch native transcript/composer placement and responsive window sizes;
  keep essential native controls accessible and avoid overlaps.
- Send a real native message, then return to artwork and restart; a row hidden
  only before the first conversation exists is not a pass.
- Exercise light/dark theme, host typography, category switching, collapsed
  sidebar reopening and restart persistence.
- If a shared sidebar adapter exists, switch among native rail destinations
  and confirm the same pane and collapse control participate correctly.
- On a host without the new negotiated capability, report the limitation;
  do not mark that fallback as exact Space-equivalent integration.

None of these proposed-host-change checks has been executed by this document.

## Public contract references

- [OpenAI Extensions guidance](https://developers.openai.com/plugins/build/extensions)
- [OpenAI MCP Extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
- [OpenAI MCP Extensions shared UI schema](https://github.com/openai/mcp-extensions/blob/main/typescript/src/shared/ui.ts)
- [MCP Apps specification](https://modelcontextprotocol.io/docs/extensions/apps)

The local installed SDK and shipped host bytes establish the version-specific
observations above. These public references describe extension contracts; they
do not establish that the proposed toolbar/sidebar API already exists.
