# Codex Design 0.5.2 candidate

## Scope

This candidate follows two cases discovered during actual installed 0.5.1
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

The rebuilt 0.5.2 candidate passed **435/435 tests**, zero failed, cancelled or
skipped tests, in about 34.6 seconds. Generated consistency passed for **182
owned files**. Portable relocation passed with a generic `node` command,
Unicode/space paths, no node_modules, six tools and two static resources,
including `ui://codex-design/0.5.2/library`.

The logs are `codex-design-0.5.2-candidate-tests.txt` and
`codex-design-0.5.2-candidate-portable.txt` in the local acceptance archive.
There was no failed whole-suite run of this candidate before this result; the
earlier focused Rename fixture failures remain documented separately.

This package has not been promoted to the configured GitHub marketplace ref or
installed in Codex. Do not promote controller/protocol evidence to a real-host
repair save/reopen pass. The installed version remains 0.5.1 while the native
request already prepared for the operator waits for their Send; it must not be
accepted or processed from its unsent draft to complete this candidate's checks.

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
worker-status observation after draft preparation returned zero pending/active
jobs and no registered native worker. No native Send was automated. Operator
Send, actual receipt/dispatch/worker and reply are still outstanding.
