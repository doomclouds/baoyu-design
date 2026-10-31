# Codex Design library implementation

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
