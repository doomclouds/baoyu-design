# Codex Design library implementation

## Current release and evidence boundaries

0.6.5 is published on `main` and marketplace branch `codex/plugin` at
`a7c54c58a58adf11f3cb4feffed1589960ca7323`. The release tree, fetched GitHub
marketplace snapshot and installed cache match all 192 files (191 owned files
plus manifest). The complete regression passed 671/671; generated consistency
and generic-node/Unicode-path portable checks passed. A fresh runtime reports
five skills, six tools and no errors. The current desktop session completed
a live `view.get`; its running `server/index.mjs` is from installed 0.6.5,
with parent process 32632. Only the plugin was hot-switched; Codex was not
restarted. No GitHub workflow was used.

Implementation is distinct from complete native coverage. Installed 0.6.4
close/reopen, active-editor preservation, an actual same-location write race
with explicit conflict choice and History restoration of the overwritten
cover have now passed within the scope below. The four-editor operation,
comment lifecycle and per-format cancel/overwrite/error matrices are not fully
collected. The dedicated Bring back notice did not trigger and is not claimed
passed. See [the tracked implementation and acceptance scope](UPSTREAM-DEVELOPMENT-PLAN.md).

Actual prior installed-host evidence includes linked CJK font embedding and
PowerPoint rendering, Canvas save/close/reopen, read-only Theme/history preview
and Back, selected-file restoration with other content preserved, DS README
download, Dashboard data/Sources/CSV, and Canvas PNG/PDF/HTML output. Single-
and multi-artboard HTML were saved and statically checked, not opened or
navigated in a browser because local HTML navigation was denied by policy.
Multi-artboard PNG ZIP has independent safe-path/CRC/full-decode and image
inspection evidence (`codex-design-0.6.3-multi-pngzip-result.json`); its reviewer
did not independently observe Save As. These limits remain explicit.

Historical acceptance reports keep their failed attempts and then-current
pending gates. Later passes do not erase the 0.6.0 640/642 run, the 0.6.1
cleanup failure or the 0.6.2 657/659 identity failures; the latter's original
causes remain unproven. Historical sections below describe their release
cutoffs, while this section and the current acceptance record describe today.

## 0.6.5 native conflict-bar language

Actual 0.6.4 conflict testing exposed a separate shadow module selecting
Chinese directly from the system language, bypassing the English-only i18n
decision. The adapter fixes only this native Slides/Design branch.
The canonical conflict marker, language selector/table and labels guard the
patch; unknown shapes fail closed. Authored content, ordinary standalone
language selection, dictionaries, navigator/Intl and choice callbacks remain
unchanged. Design System and Dashboard do not contain this branch.

Focused language/assembled-document checks passed 15/15 with independent
approval. The first complete candidate run was 669/671: the packaged
`.codex-plugin` manifest and UI contract had missed the version bump. Those
failures are preserved; the first portable attempt also failed on resource
version mismatch. After correcting the metadata, a separate complete second
run passed 671/671, zero failures/skips/cancellations, concurrency 4,
73,774.9088 ms. The final build has 191 owned files; consistency and portable
0.6.5 checks passed using generic node, a Unicode path, no node_modules, six
tools and two resources. These results do not relabel the first failed run.
The formal GitHub marketplace installed 0.6.5; all 192 release/snapshot/cache
files agree, fresh runtime discovery and current-session `view.get` pass.
The actual native Slides conflict bar now displays its title, subtitle and
all three choice labels in English on the unchanged Chinese system. Use
theirs updated the visible editor to the retained external disk value and
closed the conflict bar. Restoring the QA baseline through the editor left
all 24 project hashes equal to the pre-test baseline. This native observation
does not claim a second Design race or notice-based Bring back pass.
See [ACCEPTANCE-0.6.5.md](ACCEPTANCE-0.6.5.md).

## 0.6.4 repeat native opening

Each explicit OS navigation now carries a fresh request UUID inside the
app-relative query. The returned artwork link and internal Tab UUID remain
stable. This avoids the installed host's identical-target suppression after
an internal Tab was closed, while the existing bridge keeps active editors
mounted. Delivery and actual-SDK bridge checks passed 30/30 independently;
the complete frozen-source run passed 665/665. A source opener also reopened
the closed artwork in the installed 0.6.3 host and preserved its active editor
loader/visible draft across repeated opens. That source-opener check remains
separate from the subsequent installed-0.6.4 check: after closing the artwork,
five Tabs remained; public CLI open restored six Tabs with exactly one of the
same artwork UUID. Two active opens preserved the visible draft and same
editor loader (SHA-256 prefix `a84451f`), without a duplicate or reload.
Package installation and actual native results are tracked in
[ACCEPTANCE-0.6.4.md](ACCEPTANCE-0.6.4.md).

The first manual/external-write attempt let `local-held` autosave and produced
no conflict; it is retained as a nonconflict observation. A second immediate
CUA edit and external file write produced the actual conflict bar. Disk text
`External raced save` stayed intact until the explicit Keep mine choice, after
which it became `Local raced save`. This is a deterministic external-writer
test, not a newly sent model task. It also exposed the language defect above.

In the actual History UI, the cover entry labelled 03:32 was selected via
Changes and Restore just this to recover `Local concurrent edit`. The 02:05
baseline then restored `Font QA original`. All 24 final content hashes matched
the saved baseline; the other 23 files stayed unchanged throughout. This proves
the checked selected-file recovery path. The dedicated notice's Bring back
was not triggered, and arbitrary manually selected hunk restoration is not
implemented or claimed.

## 0.6.3 native HTML integrity follow-up

Native opaque editors now support the SHA-384 digest required by the actual
standalone HTML export's bundled React SRI checks. SHA-256 content identity,
strict algorithm/base64/32 MiB checks and the read-only History broker remain
intact. Actual generated vendor bytes and their original SRI constants are
covered by the new integration test; the complete regression passed 662/662.
Installed 0.6.3 completed native HTML Save As: the single-artboard file is
119,326 bytes and the multi-artboard file is 235,037 bytes. Static checks cover
loader/JSON/resources/templates plus two ordered pages, their dimensions and
bidirectional relative-link mappings. They do not prove browser rendering,
clicks or Back. The old Exporting hang and incomplete first inspector remain
preserved; the exact cause of that earlier native hang was not isolated.
See [ACCEPTANCE-0.6.3.md](ACCEPTANCE-0.6.3.md).

## 0.6.2 Dashboard and floating-surface follow-up

The Dashboard bootstrap now resolves its whitespace-formatted local base URL
through the native virtual base. Floating menus/dialogs composite host alpha
colors over an opaque theme base, and editor startup failures retain bounded,
escaped diagnostics in collapsed Error details. The final complete regression
passed 659/659 with concurrency 4; the earlier two identity-verification
failures remain in the record with their cause unconfirmed. The installed
Dashboard then rendered its three-row data and Sources; CSV Save As and
overwrite cancellation preserved the existing file's hash/mtime. Menus and
dialogs were visually opaque. Actual History diff and selected-file restore
changed only the cover among 24 content files and created a recovery point.
The checked Canvas PDF rendered as one 600 × 450 point page. These results and
format-specific limits are tracked in
[ACCEPTANCE-0.6.2.md](ACCEPTANCE-0.6.2.md).

## 0.6.1 native acceptance follow-up

0.6.0 was published at `b5cb0a9`, installed through the GitHub marketplace and
verified against the generated package (191 identical files). Real native
comment dispatch, registered-child reuse and a separate guarded 0.5.3 data
service upgrade passed. Host testing then found historical-loader closure,
History opacity, WOFF2 module-import and Canvas live-session flush issues.
Installed 0.6.1 repaired those checked paths: historical preview and Back,
opaque History surface, CJK embedded-font PPTX in PowerPoint, active Canvas
save/close/reopen, copied read-only Theme and DS README Save As passed. Its
new Dashboard boot failure was preserved and subsequently fixed in 0.6.2.
See [ACCEPTANCE-0.6.1.md](ACCEPTANCE-0.6.1.md) for exact evidence and limits.

## 0.6.0 upstream migration

The development branch now targets upstream 2.7.1 (`6759e35`) while retaining
the established 0.5.3 library, native comment/request and content-only transfer
contracts. Updated skill/server/vendor adapters, local-only service startup,
save/port reliability, canonical detailed History and isolated read-only
reference/history previews are implemented in the candidate. History manual
restore selects a file/version; overwrite recovery restores its compared lost
content, not an arbitrary manually selected hunk.

The after-DOM-fix build reports 190 owned files. The first complete suite was
640/642 and exposed head-before-body preview initialization plus an obsolete
port-1 boot fixture. Those results remain in the acceptance record. The next
complete run passed 643/643, with no failures, skips or cancellations. Generated
consistency and portable checks passed; actual host acceptance found the
follow-up issues above. See [ACCEPTANCE-0.6.0.md](ACCEPTANCE-0.6.0.md) for overlapping
focused evidence, retained failures and the exact native gates.

## Upstream source synchronization

`main` includes upstream 2.7.1, and the configured marketplace still uses
`codex/plugin`. The initial synchronization required an adapter migration
before rebuilding; 0.6.0 contains that work, and 0.6.1 through 0.6.4 address
subsequent native acceptance findings. See
[the synchronization and value assessment](UPSTREAM-2.7.1.md) for the original
baseline and failed compatibility check.

## 0.5.3 released repairs

This revision addresses two failures observed after installing 0.5.2:

- A verified older version directory in the same managed plugin-cache family
  can contain no files while its empty directory tree remains. Native request
  migration now treats that narrowly validated state as an unavailable old
  package. Nonempty remnants, corrupt package records, links, wrong families and invalid
  versions remain refused; the old directory is not deleted.
- The real Canvas Resize writer serializes an in-memory `artboards` array,
  which the files publisher later converts to the disk v3 `boards` map. Owned
  generated-preview synchronization now accepts that validated live shape at
  the existing local-state boundary. It retains the same-file marker, unchanged
  generated logic and index-string cache guards; custom content and copies are
  not claimed, and the original checker is unchanged.

The installed 0.5.2 second request eventually completed only after manually
restoring the authentic 0.5.1 cache. Its earlier automatic dispatch failures
remain failures. An actual 0.5.2 Resize also left the generated preview at the
old dimensions and failed the checker. These are the baseline defects, not
successful acceptance of the 0.5.3 fixes.

The GitHub marketplace revision is published, installed and enabled. All 185
package files match the release and market snapshot. Native plugin off/on
refreshed the current window's MCP connection without restarting Codex. The
subsequent full suite passed **514/514**; its earlier **513/514** temporary-editor
`EBUSY` failure is preserved and its cause remains unestablished.

Actual 0.5.3 Properties Resize/save/Recent reopen now keeps the owned preview and
index at `900 × 620`, with checker 0. A second actual native Send automatically
migrated the naturally empty old 0.5.2 cache binding and reused the same real
child, completed its own receipt/job/check, and replied exactly once. Idle-only
QA cleanup retained all three content/comment hashes. Detailed scope and the
remaining native coverage limits are in
[ACCEPTANCE-0.5.3.md](ACCEPTANCE-0.5.3.md).

## 0.5.2 candidate follow-ups (historical)

The candidate keeps the global workspace and host-selected/default local
environment. It repairs active Rename save bases, uncached externally created
artwork metadata, generated blank-artboard contracts, and native comment safe
areas. Further installed-0.5.1 investigation found two upgrade/reopen cases:
versioned skill paths need verified migration, and a refused old service record
must not mistake an unrelated reused PID for this artwork's live editor.

Skill migration preserves the existing native-parent and idle-handoff rules;
every new request still needs its own actual user Send, receipt and dispatch.
Refused-service recovery is limited to the internal native open-service route,
with original-state checks and startup locking. It archives the stale record
without stopping its recorded PID. A genuinely failed subsequent startup keeps
its error and identity; it is not silently retried as a new binding.

See [ACCEPTANCE-0.5.2.md](ACCEPTANCE-0.5.2.md) for candidate checks and the
remaining consuming-host gates. Earlier 435- and 464-test results are historical
candidate baselines. The first combined 505-test run was 504/505, with an explicit
temporary HTTP-preview identity failure. The later isolated 6/6 and complete
505/505 results do not erase it; its original cause was not established. The
fixture now preserves named-stage diagnostics and failed-cleanup state. Package
consistency and portable relocation passed for 184 owned files. The generated
package was subsequently installed; see the dated correction and 0.5.3 results
instead of treating this earlier candidate section as current status.

## 0.5.1 request and category corrections

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
409 tests and portable relocation with 182 owned files after the additional
Canvas export-caller correction. Native save errors terminate their original
operation, registered export requests complete without consuming a newer
queued request, and missing-content warning cards wait for explicit Download.
The earlier 340/392-test results remain baselines for prior prepared source;
the intermediate 403/404 fixture failure is retained in the acceptance report.
The user accepted retaining the current top bar for this release. Code commit
`40146a6` is published on the GitHub marketplace ref `codex/plugin`, and the
Desktop CLI installed 0.5.1 from that Git snapshot. All 182 owned files plus
the generation manifest matched the release and downloaded snapshot. Actual
native Dashboard creation, Sources, menu dismissal and Save As passed their
recorded cases. Native Canvas Properties opened, but Rename followed by adding
an artboard exposed a save conflict that did not recover on a normal retry.
That issue is tracked in a separate unpublished repair branch. After the user's
restart, current-chat MCP reads and the first actual native edit/reply passed.
Slides and Design System controls, content save/reopen, QA Trash/Restore,
native content-package import, and actual PDF/PPTX exports were also checked.
The second native request remains an unsent draft. The idle QA listener was
retired without editing content, and its actual native turn ended normally; see
[ACCEPTANCE-0.5.1.md](ACCEPTANCE-0.5.1.md) for the exact evidence boundaries.
The future header
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

This is the historical 0.3 scope. Its bilingual UI decision was later cancelled;
the current plugin interface is English-only, as stated in the preserved rules.

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

## Historical 0.3 discovery evidence and then-pending acceptance

This subsection preserves the early probe/candidate evidence. It is not the
current installed-version status; final release and host evidence are above.

A metadata-only client using the installed Codex Desktop runtime
`0.166.0-alpha.5.1` verified the installed AGP probe `0.0.5`: its stdio server
started with generic `node` and `${PLUGIN_ROOT}`, reported no tools error, and
returned `DesignLibrary` (global), `DesignFile` (file), and two MCP App UI
resources. The actual loader rejected the earlier schema-less AGP MCP file;
adding its required schema closed that failure. See
`research/native-mcp-discovery-20261031.md` for the narrowly recorded evidence.

This is catalog/startup evidence, not a claim that the currently running
Desktop window has refreshed or rendered the production 0.3 global entrypoint.
At that historical cutoff, the release still needed its final generated-package
check, complete local tests, installation check and consuming-app verification. Existing test
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

The current follow-up scope is the remaining native acceptance matrix and
defects it reveals. Multiuser/LAN collaboration and cross-window single-editor
ownership require separate product decisions. Host-wide sidebar/toolbar
replacement, per-artifact native chat binding, bilingual UI, automatic source
design-system propagation and arbitrary manual hunk restoration are not added
to this migration's completion criteria.

- Global Codex Design sidebar entry, secondary category navigation, and a
  permanent library tab followed by unique artifact tabs. The approved visual
  references are `library-slides-v1.png` and `workspace-tabs-v2.png` in the user's
  `~/.codex/CodexDesignLibrary/designs/codex-design-library-prototype/` folder.
- One artifact has one tab in the workspace. Other conversations may reference
  an artifact read-only; source editing returns to the artwork tab or its
  explicit local directory. The earlier per-artifact bound-conversation target
  was superseded by the global workspace and native draft workflow.
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
- Plugin controls, menus, dialogs, status and errors stay English. The user
  cancelled the earlier bilingual UI request. Artwork content, user titles,
  comments and conversations retain their authored language.

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
The approved global workspace uses the host's native composer and selected or
default local environment. It does not create per-artifact bound conversations
or an unrelated background model daemon. Native job ownership records do not
turn an artwork into a permanently bound user conversation.
