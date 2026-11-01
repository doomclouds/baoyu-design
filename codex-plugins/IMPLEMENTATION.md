# Codex Design library implementation

## 0.5.1 request and category corrections (prepared)

Native draft text includes the exact immutable request URI before the bounded
comment summary, alongside its matching resource attachment. Every newly sent
request, including active-turn steering, requires its own read/accept/dispatch
before a child is reused or receives a follow-up. An earlier request cannot
authorize a new comment. Missing exact IDs require re-adding from the editor;
the agent must not scan or infer an unsent draft.

The operator confirmed the installed 0.5.0 Add to chat/native Send workflow.
Post-restart live MCP reads and an actual completed request with a saved reply
were independently observed. A second steered message skipped its own receipt
path; the source fix makes the identifier explicit but does not claim that the
host dropped an attachment or that prompt compliance is structurally enforced.

Non-comment AI actions in all four editors now use the canonical request/draft
path instead of the legacy send-or-copy fallback. Exact diagnostic files,
slide/artboard identities and errors are retained; a saved append failure
retries the existing comment. Purposeful Copy commands and ordinary standalone
delivery keep their original behavior. The request audit is recorded in
[AI-REQUEST-ACCEPTANCE.md](AI-REQUEST-ACCEPTANCE.md).

Specific library categories create their own type directly from the heading
and empty state. All-page and sidebar global creation retain the type menu.
The later staged code also adds a shared app-only Save As folder browser and
verified filesystem save path, host theme/font token mapping for editor UI,
thumbnail aspect/letterbox repairs, and a host-colored seam separator. It passed
392 tests and portable relocation with 181 owned files. The earlier 340-test
result remains a baseline for the prior prepared source.
This prepared revision has not replaced installed 0.5.0. The current header
target is a named, nonclosable native home tab visible from first open, with a
quiet separator below it. A real full-view command reveals the sole home tab,
but rail reentry returned to the blank native row: automatic initialization and
persistence are not fixed. Entire-row removal is no longer the selected target.
The true host middle-sidebar slot is explicitly deferred. Comment pins retain
the upstream author avatar by explicit user choice.

## 0.5.0 global native draft workflow

The confirmed design is a global Codex Design workspace with a host-managed
selected/default local environment, without per-artwork user-chat binding or
arbitrary historical-chat switching. Native Add to chat prepares an immutable
request and appends to the native draft without sending or queueing. The user
sends; the real parent reads/accepts received request IDs, dispatches through its
actual native environment, and coordinates native children. Comments derive
their status from request receipts and actual job/reply records. UI service
bindings are separate from native execution identity. Old unconfirmed pending
requests are retained for explicit review rather than replayed automatically.

Trash adds confirmed single and visible-selection permanent deletion, with
safe preflight and accurate partial-failure retries. Acceptance evidence and
actual-host limits are recorded in [ACCEPTANCE-0.5.0.md](ACCEPTANCE-0.5.0.md).

The host top toolbar/shared-sidebar gaps and cross-window ownership remain open;
they are not replaced with private host patches or hidden duplicate editors.

## 0.4.3 menu regression hotfix

Fix transient menus closing during their own focus transfer. The shared window
blur capture listener must distinguish a descendant element losing focus from
the workspace window losing focus. This affects both Create controls, sorting,
list/grid artwork actions, and the artwork titlebar actions. Preserve the
existing hover grace, outside press, Escape, keyboard and touch behavior.

Cross-window editing ownership remains separate future work. No ownership or
host API changes are included in this hotfix.

## 0.4.2 agreed revision scope

The revision is limited to native delivery for all four artwork types, opaque
editor Properties-state recovery, Comments in existing editor toolbars or
navigation tools, transient-menu dismissal, and English-only plugin UI.
The earlier upper-right floating-dock prototype was superseded by the user's
toolbar/menu decision and is not the released design.

Public `open` requests the native artwork route, `check` preserves diagnostics
while returning native delivery hints, and `open-service` is internal data
service startup. `preview` is explicitly requested independent web access.
Native navigation acceptance does not prove a rendered editor. Existing
non-library directories are not silently copied or migrated.

Temporary in-document Web Storage restores UI switches inside opaque editors
without granting parent access or claiming preference persistence across reopen.
Comments retains its existing mode, list, filtering, reply and reopen handlers.
Only the existing editor tool seats are used; no duplicate native header is
created for the design system. User-authored text and comments retain their
language while the plugin UI stays English.

Cross-window editor ownership and the host-wide sidebar, toolbar and bound-chat
requirements remain outside this revision and are not claimed complete.

## 0.4.1 native startup follow-up

After the user's Desktop restart, live plugin tools recovered but artwork frames
were blocked. The actual Desktop log reports localhost HTTP frame navigation
and ERR_BLOCKED_BY_CSP; it does not establish that the data-shell path failed.
The installed 0.4 UI contains the native branch. Host resource caches include a
plugin revision, with persisted startup fallback, so a broken versionless cache
key must not be asserted as the proven cause.

The patch gives library/file resources release-specific URIs, rejects legacy or
HTTP bridges in the native entrypoint, and records bounded resource-read version
and HTML-hash diagnostics on stderr. Standalone previews retain their explicit
transport. Host CSP and the isolated editor architecture are unchanged. Actual
consuming-host verification is still required after installation.

## 0.4 correction and acceptance

The 2026-11-01 review identified that the browser preview had not established
native host correctness. The installed Codex resource parser rejects HTTP frame
domains, making the former localhost iframe path unusable in the real app.
The revision assembles the existing editors into a self-contained inner document
and routes file/API/events through an artwork-scoped MCP transport. Native
downloads use the standard SDK download method. Protocol and isolated sandbox
tests remain separate from actual installed-host visual acceptance.

The library now consumes host font/style/theme variables, uses a compact list
and anchored Create menu, supports internal navigation collapse, and exposes
content-only import/export plus recovery history. Native worker jobs establish
a content restore point before editing. Global design systems are discovered
from the global library in addition to explicitly configured folders.

The current public host API cannot replace Space's native middle sidebar,
remove the host-created workspace toolbar, or bind an independent native chat
to each internal artwork tab. These are unresolved host integration requirements,
not completed features. Do not patch the installed host, spoof the private
Meetings sidebar capability, or report browser layout as native parity.

See [NATIVE-TESTING.md](NATIVE-TESTING.md) for the required evidence layers and
acceptance matrix. The historical 0.3 scope and evidence below explain the
starting point; they are not final 0.4 consuming-app results.

The 0.3 basic release was agreed with the user on 2026-10-31. It extends the
existing `codex/plugin` branch and plugin identity, preserving all five skills,
the approved icon, and the four existing editors and comment workflows.

## 0.3 release scope

- A local artwork library with four kinds: slides, design, design-system, and
  dashboard. Dataviz remains a skill rather than a fifth editor/document kind.
- A global Codex Design entrypoint, category navigation, a permanent library
  tab, and one reusable tab per artwork. The four editors open real local
  artwork files. Browsing, creating blank artwork, opening tabs, and manual
  editing do not start model turns.
- UI-only Chinese/English localization through i18next for the library and all
  four editors. Chinese is selected for a Chinese system language; English is
  the fallback. Content, skill prompts, CLI/JSON contracts, comments, and chats
  are not translated.
- Existing editor comments and real native-worker CLI routing remain available.
  The parent chat still owns selecting, resuming, or creating native workers.
- Per-artifact bound native editing conversations are **not enabled** in 0.3.
  The unavailable large chat panel is hidden. The library does not create or
  send to a substitute shared chat and does not start a separate model daemon.
- Content and necessary assets can be imported, exported, duplicated, and
  restored from content snapshots. Chat, comments, bindings, pending jobs,
  execution records, tokens, PID files, server URLs, and local view state are
  excluded from portable bundles.

The default library is the global `~/.codex/CodexDesignLibrary`, independent of
the current project cwd and of `CODEX_HOME` overrides. Existing skill CLIs can
still work on explicitly selected project directories; installation does not
silently relocate those projects into the library.

## Installation and local build

The published plugin requires Node.js 22 or newer on PATH. Its MCP server and
UI are prebuilt with their runtime dependencies; end users do not run npm
install. No published launch configuration may contain a maintainer username,
source-checkout path, or temporary directory.

```powershell
codex plugin marketplace add doomclouds/baoyu-design --ref codex/plugin
codex plugin add codex-design@codex-design-marketplace
```

The AGP root manifest uses a real `mcp.json` with the required schema
`https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`. The host launches
`node` with `${PLUGIN_ROOT}/server/index.mjs` and cwd `${PLUGIN_ROOT}`. Local
stdio MCP can supply global and file entrypoints; it is not restricted to
remote account Apps. Dedicated entrypoint tools are app-only. Ordinary model
tools return concise status or resource references without attaching a full
inline library/editor panel to chat messages.

After installation or an entrypoint change, reload the plugin or reopen the
desktop app as necessary. An existing window or chat may still hold the old
catalog/cache. CLI installation alone does not prove native rendering.

Maintainers run these commands from the repository root:

```powershell
npm ci --prefix codex-plugins
npm run build:codex-plugin
npm run check:codex-plugin
npm run test:codex-plugin
```

The build copies upstream root skills and source assets, applies Codex and
annotation adapters, and bundles the MCP server, library UI, and editor
localization. The generated directory is committed for direct GitHub
installation. Build and test locally; do not add or invoke GitHub workflows.

## Verified evidence and remaining acceptance

A metadata-only client using the installed Codex Desktop runtime
`0.166.0-alpha.5.1` verified the installed AGP probe `0.0.5`: its stdio server
started with generic `node` and `${PLUGIN_ROOT}`, reported no tools error, and
returned `DesignLibrary` (global), `DesignFile` (file), and two MCP App UI
resources. The actual loader rejected the earlier schema-less AGP MCP file;
adding its required schema closed that failure. See
`research/native-mcp-discovery-20261031.md` for the narrowly recorded evidence.

This is catalog/startup evidence, not a claim that the currently running
Desktop window has refreshed or rendered the production 0.3 global entrypoint.
The release still needs its final generated-package check, complete local
tests, installation check, and consuming-app verification. Existing test
suites cover the library, MCP protocol and resources, editor localization,
and the prior native comment runtime; do not report unexecuted or failed
checks as passed.

Independent native chat creation, per-artifact native sending/history, and a
public project-selection/binding bridge remain outside the enabled release.
Public SDK `ui/message` exposes active/new targets, rather than an arbitrary
destination thread/project/cwd. App messages are untrusted app input; do not
invent human authorization, copy metadata into a private pipe, or bypass
native tool approval. Any future agent-mediated route needs separate real
host verification and a product decision about its visible authorization flow.

## Preserved product rules

- Global Codex Design sidebar entry, secondary category navigation, and a
  permanent library tab followed by unique artifact tabs. The approved visual
  references are `library-slides-v1.png` and `workspace-tabs-v2.png` in the user's
  `~/.codex/CodexDesignLibrary/designs/codex-design-library-prototype/` folder.
- One artifact has one tab. Other conversations may reference an artifact
  read-only; source editing returns to the artwork tab or its explicit local
  directory. One independently bound editing conversation per artifact remains
  a future target, not a released 0.3 capability.
- Empty creation persists content before opening an editor. Browsing, manually
  editing, and opening tabs do not start model turns.
- Keep existing comments, object anchors, replies, resolve/reopen, and explicit
  Send to agent. Preserve real native-agent routing, with the parent deciding
  whether to reuse, resume, or create a child.
- Closing a tab does not cancel an already-started AI task. Restore artifacts
  and tabs from disk, load the active editor on demand, and verify services
  before reuse. Never use runtime port/grant URLs as artifact identities.
- The library root is `~/.codex/CodexDesignLibrary`, independent of project cwd
  and of future changes to CODEX_HOME. Kinds: slides, design, design-system,
  dashboard. Dataviz is a skill, not an additional editor/document kind.
- Renaming preserves identity. Duplicating creates a new identity and copies
  only content/assets. Trash preserves local metadata; restoration does not
  replay historical requests. Active native writers must be stopped through
  the real native mechanism or allowed to finish before trashing an artifact.
- Preserve the editors' existing save behavior. Content snapshot APIs provide
  restore points; a future library AI route must take one before AI edits.
- Import/export/native backup contain only editable artifact content and
  necessary assets. Chat, comments, bindings, pending jobs, execution history,
  tokens, PID files, and server URLs are excluded. Existing local comments and
  chat remain available independently of exported content.
- Design systems are reference material read and followed by AI. Changing
  a source system never automatically changes other artifacts. Do not add an
  application/dependency-upgrade workflow.
- Bilingual support is UI ONLY, using i18next resources and system-language
  detection (Chinese for zh, English fallback). Library/editor controls,
  menus, dialogs, status, and errors are in scope. Artifact content, skill
  prompts, CLI/JSON contracts, comments, and conversations are not translated.

## Boundaries and ownership

Library backend: `source/library/**`, `tests/library.test.mjs` (runtime_smoke).
Library frontend: `source/ui/**` (native_design_probe).
Native MCP server: `source/server/**`, `tests/mcp-server.test.mjs`
(harness_inventory).
Editor localization: `source/scripts/editor-localization.js`, locale resources,
`editor-localization.mjs`, `tests/editor-localization.test.mjs`
(extensions_research).
Root coordinates build/dependencies, manifests, adapters, installation, native
verification, and compatibility checks. Do not edit generated output manually.

## Integration contract

`createLibraryStore({root, isBusy})` supplies async artifact, view-state, binding,
snapshot, and content-only import/export operations. Persist machine state
outside portable artifact content. UI bridge uses `invoke(action,payload)` and
`subscribe(handler)`; library/view actions delegate to this store. `editor.open`
returns a real checked editor URL. Opening from the library does not
automatically register or restore an agent. The prior skill and comment CLI
workflow remains documented in `source/README.md`.

Conversation methods currently report `NATIVE_EDIT_CHAT_UNAVAILABLE` and no
send capability. Binding metadata in the store does not establish a real host
conversation or authorize sending. No fabricated replies or invented thread
IDs may be used to make this appear implemented.

The public MCP Extensions global/thread/file entrypoints and composer mentions
are documented. However, the Space Slides composer/project picker and
artifact-session binding are first-party implementation details. Third-party
access must be verified in the current host before claiming the same behavior.
Do not silently replace per-artifact native conversations with one shared
global conversation or an unrelated background model daemon.
