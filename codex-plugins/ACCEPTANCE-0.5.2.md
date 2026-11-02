# Codex Design 0.5.2 candidate

## Scope

This candidate follows cases discovered during actual installed 0.5.1
acceptance. It does not overwrite or hot-edit the published 0.5.1 cache.

- Active Rename now waits for a confirmed flush, retires the exact saved native
  editor, mutates the index title, and rebuilds the same still-active artwork
  with the new base. Refused flushes retain their dirty frame. Failure,
  navigation, replaced forms, in-flight document responses and disposal have
  lifecycle protection.
- External skill/CLI-created artworks can be absent from a live UI's cached
  list. Unknown IDs are resolved through a validated per-ID single-flight read
  before opening. A genuine missing record is distinguished from connection or
  permission failure; late responses cannot open the wrong artwork. Existing
  dirty-navigation protection and unique Tab behavior remain in control.
- New native blank artboards receive the required external `data-dc-script`
  block, `Component extends DCLogic`, and single-quoted `$preview` metadata
  matching the actual final board size. The UI and batch creation owners are
  adapted; the shared upstream factory, standalone mode, copies and custom
  markup/page rules retain their original bytes. The original checker remains
  unchanged. Text replacement preserves the generated script. Local size changes
  synchronize only a validated generated marker belonging to the same file,
  with index and component changes in the same local save state.
- Generated-preview synchronization caches each store's last index filename
  and immutable index string through its update-function identity. Ordinary
  text edits with an unchanged index do not read or scan other artboard HTML.
  Only successful computations update that cache; mutable prior state,
  A-to-B-to-A changes and independent stores are covered.
- Native comment cards and All comments lists respect the reserved bottom
  composer area. The existing anchors, toolbar seats and author avatars remain;
  oversized cards/lists scroll within their available area. Geometry hints and
  observers are cleaned up on disposal. Standalone comment layout is unchanged.

The repair changes the shared controller for all four native artwork types.
It does not create chats, queue workers, restart an artwork data service or
claim a native fixed-home header API. The previously accepted top-bar limit,
English plugin UI and original author-avatar comment pins remain unchanged.

## Evidence before packaging

The author and independent reviewer each passed **50/50** actual-controller
tests, including thirteen Rename lifecycle cases and thirteen external-record
loading cases added to the earlier suite. The installed 0.5.1 native control
case saved an artboard and edited text without active Rename. An isolated
installed-runtime CAS probe preserved raw payloads and demonstrated conflict
refusal plus refreshed-base recovery. These scopes are recorded in
[rename-save-recovery-051.md](research/rename-save-recovery-051.md).

## Packaged candidate checks

The earlier rebuilt 0.5.2 candidate passed **435/435 tests**, zero failed, cancelled or
skipped tests, in about 34.6 seconds. Generated consistency passed for **182
owned files**. Portable relocation passed with a generic `node` command,
Unicode/space paths, no node_modules, six tools and two static resources,
including `ui://codex-design/0.5.2/library`.

The logs are `codex-design-0.5.2-candidate-tests.txt` and
`codex-design-0.5.2-candidate-portable.txt` in the local acceptance archive.
There was no failed whole-suite run before that 435-test result; the
earlier focused Rename fixture failures remain documented separately.

After the blank-artboard contract, index-change performance guard and native
comment viewport additions, the latest rebuilt candidate passed **464/464
tests**, zero failed, cancelled or skipped tests, in **35,475.99 ms**. Generated
consistency passed for **184 owned files**. Portable relocation again passed
with generic `node`, Unicode/space paths, no node_modules, six tools and two
resources, including `ui://codex-design/0.5.2/library`. The final logs are
`codex-design-0.5.2-final-tests.txt` and
`codex-design-0.5.2-final-portable.txt`. The 435/435 and 182-file evidence above
is retained as the earlier candidate, not relabeled as this later package.

The blank-artboard suite executes the real compiled creation/content-update
owners, checks default, portrait and custom dimensions with the original raw
checker, and retains the legacy blank's expected checker failure. Its targeted
run passed **14/14**, independently reproduced. Early fixture constant-lookup
and drift-anchor failures remain distinct from those passing runs. Native
comment geometry tests exercise the real canonical components across all four
editors plus transport/observer lifecycle; they are not an installed 0.5.2
visual acceptance result.

This package has not been promoted to the configured GitHub marketplace ref or
installed in Codex. Do not promote controller/protocol evidence to a real-host
repair save/reopen pass. The installed version remains 0.5.1 while the native
second reuse request waits for the operator's Send; it must not be accepted or
processed from its unsent draft to complete this candidate's checks.

## Post-restart native 0.5.1 control evidence

The current chat directly called its installed `design_read view.get` and
`library.get` successfully after the user restarted. A pre-named new canvas
saved its first artboard and a `Native QA original` text edit without active
Rename. Disk inspection confirmed one board/order entry and the component file.
The floating text toolbar's Properties action opened actual selected text
controls. The earlier active-Rename failure remains a failed case.

The actual global library initially misreported that newly CLI-created canvas
as missing, although the live MCP read returned an existing valid record.
Selecting Library refreshed the list; opening the same already-created Tab
then loaded it. This is the real-host evidence motivating metadata hydration.

An object-located comment on the new QA text was saved with Add to chat selected.
The native composer showed its immutable Request URI and attachment. A read-only
worker-status observation after the first draft preparation returned zero
pending/active jobs and no registered native worker. That was a pre-Send
observation, not the final request state. No native Send was automated.

The operator subsequently sent the first immutable request,
`f5b1c29e-43eb-4313-b9c5-9e9599edfc26`. Its actual native parent received and dispatched it to child
`01a199c8-d2c6-7dc3-986c-16e080e86dd8`. The requested text-only verification
change completed, and the canonical comment received `Verified in Codex 0.5.1.`.
The original structural checker still reported **one problem**: the component
was already missing its required `DCLogic` block before the AI request. This
is a completed native edit/reply flow, not a structurally clean artwork or an
installed-host pass for the new candidate's blank-template fix.

A second request intended to exercise reuse of that child is prepared only in
the native draft. It remains pending human Send and is not counted as received,
dispatched, completed or reuse-verified.
