# Codex Design 0.4.2 revision acceptance

## Agreed scope

1. Slides, Design, Design System and Dashboard use native Codex Design delivery.
   Public `open` requests the official artwork URI; `check` returns native
   delivery hints. Internal data startup uses `open-service`. Independent web
   access requires explicit `preview`; non-library folders are never silently
   imported, moved or opened as a web fallback.
2. Opaque editor UI preferences use consistent document-local memory storage
   when Web Storage is unavailable. This restores Properties switches without
   changing origin isolation or artwork autosave.
3. Comments uses existing editor tools: Slides/Canvas toolbar seats, Dashboard
   trailing tools, and Design System chapter/navigation tools. The user replaced
   the earlier upper-right floating-dock proposal; that prototype is not shipped.
4. Transient menus dismiss after a cancellable 220 ms pointer exit and on real
   outside interaction or Escape; keyboard and touch paths are retained.
5. Plugin UI is English-only. Old language preferences and system locale do not
   switch it to Chinese. Authored titles, body, dataset names and comments retain
   their original language. Host UI and OS dialogs remain host-controlled.

## Frozen package checks

- **235/235 full tests passed**, zero failures, cancellations or skipped tests.
- Build ownership/consistency passed with **174 owned files**.
- Portable relocation passed using generic `node`, Unicode/space-containing
  directories, no `node_modules`, five tools and two resources.
- UI resource URI is `ui://codex-design/0.4.2/library`.
- Retained final log: `codex-design-0.4.2-final-checks.txt`.

Earlier checks are retained as earlier stages. The initial 232-test run had
seven fixture failures because local-service setup still called public `open`;
those setup calls were corrected to `open-service` without loosening public
native-open behavior. The later English/toolbar run exposed an obsolete browser
annotation assertion and a missing new builder-filter module in the safety
fixture. Those fixtures were corrected; the original failed logs remain.

## Browser/component observations

These observations use the actual packaged code and existing temporary artwork
copies behind an isolated browser bridge. They are not full Codex Desktop UI
acceptance. Where the pointer helper could not map nested frames, a focused
keyboard activation was used and the resulting DOM/panel was checked; failed
automation calls remain part of the transcript.

- Old installed 0.4.1 reproduced `SecurityError` while setting
  `dc-editor-props-open-v2`, with a closed, zero-width Properties pane.
- The revised Canvas global and selection-toolbar Properties routes opened
  the real panel. Continuous open/close state reads remained consistent.
- Slides opened its Properties panel with Transition and Appearance controls.
- Dashboard opened its Sources panel and retained authored dataset names.
- Design System has no generic Properties button; its chapter tools and
  complete existing comment list were checked instead.
- All four editors showed exactly one visible Comments control and one
  Comment-options control, zero custom floating docks and zero added comment
  headers. Design System's wide sidebar also had its expected tool seat.
- The existing four-message comment and replies remained readable in the
  canonical list. Plugin controls were English while authored Chinese remained.
- During parent-menu direct-input automation, a previous child-frame focus
  activated Resolve on the QA thread. That parent-menu attempt is retained as
  failed automation. The temporary thread was reopened using its bundled CLI;
  all four original message IDs remained. Metadata timestamps therefore changed
  normally; byte-identical comment metadata is not claimed.
- Menu pointer timing, iframe boundaries, modal isolation and keyboard paths
  passed the dedicated helper/controller tests. Automated pointer/focus control
  did not reliably retain the parent menu, so native hover dismissal remains an
  operator acceptance item rather than an inferred visual pass.

Evidence is retained outside the published plugin: toolbar matrix JSON,
Canvas/Slides Properties screenshots, Dashboard Sources screenshot, Design
System comment/wide-mode screenshots, and the old Properties failure record.

## Installation and remaining gates

Code commit `98cb7d73329bb40c923bfe347e222bcc7daf8724` was pushed to
`codex/plugin` and installed from the formal GitHub marketplace as **0.4.2**.
All **174** installed file hashes match the generated package. Actual Codex
Desktop runtime discovery found the five enabled skills, global/file
entrypoints and tools without a loading error. GitHub run listing was empty;
no workflow or tag was used.

The first install attempt encountered the existing Windows cache-backup access
denial. Only four identity-verified old 0.4.1 MCP index processes were stopped;
artwork editor processes and files were preserved. The supported install then
succeeded. The current Desktop connection needs a normal reload/restart to
consume the replacement package.

The older global validation UUID was no longer on disk; that failed check is
retained and its folder was not recreated. A fresh installed-CLI create/check
smoke ran with an isolated temporary user home instead. It reported zero
problems, a native `appUrl`, and a wrapper `open` next-step without localhost or
the raw CLI. This did not navigate the real Desktop or mutate the user's global
artwork library.

Installed evidence in the local acceptance archive:
`codex-design-0.4.2-installed-verification.txt`,
`codex-design-0.4.2-installed-hashes.json`, and
`codex-design-0.4.2-installed-delivery.json`.

Native OS dispatch remains distinguished from rendered content:
`navigationRequested` does not mean `renderVerified`. Complete actual-host
interaction acceptance after reload remains an operator gate.

### Actual-host resource observation, 2026-11-01

The running Desktop log now records the real global route requesting
`ui://codex-design/0.4.2/library` at **09:28:32 +08:00**, completing that resource
read, and committing its correlated sandbox widget frame at **09:28:38**.
The installed 0.4.2 `server/index.mjs` process was also present. This advances the
host-resource loading gate; it does not establish a visual or interaction pass.

The same log retains a failed refresh of the old `0.4.1` resource immediately
before that navigation. It is not counted as a successful upgrade of the old
view. The calling chat's `design_read({action: "view.get"})` still returned
`Transport closed`, while the supported MCP Apps browser inventory exposed no
app target. Current-chat reconnection and actual Properties, Comments and menu
interaction checks therefore remain unverified. No ordinary browser preview,
private host IPC or extra plugin installation was substituted for these gates.

The full original objective is not claimed complete. Host shared-middle-sidebar
content, native workspace-toolbar replacement, per-artwork bound native chat,
cross-window single-editor ownership, and comprehensive actual-host acceptance
remain open. Document-local UI preferences do not persist across editor reopen.
