# Codex Design 0.5.2 candidate

## Status correction — 2026-11-02

The sections below retain the earlier candidate and 0.5.1 observation history;
their statements that 0.5.2 was not installed, 0.5.1 remained installed, or the
second request was still unsent are **historical, not the current status**.
0.5.2 was subsequently installed and its actual runtime/package identity was
checked. The second request was received in a real parent message at
`2026-11-02T05:26:13Z` and eventually completed through the native request flow.

That completion required **manual restoration of the authentic 0.5.1 cache**
after dispatch failed against an empty old cache directory. It is not an
automatic-upgrade pass. The retained operator report is
`codex-design-0.5.2-native-operator-result.json` in the acceptance archive.

Later actual 0.5.2 Canvas acceptance also exposed a Resize failure: the index
saved `900 × 620`, while the generated component retained `$preview` at
`800 × 600`; the unchanged checker returned one problem. The earlier targeted
test results below do not erase that real-host failure.

A separate self-created 0.5.2 QA request also completed its actual native
Send/parent/child flow, checker 0 and exact `Upgrade QA first passed.` reply.
Its idle cleanup retained zero active/pending jobs, unchanged checked control
files, and a completed idle child turn. This separate success does not replace
the empty-cache or Resize counterexamples.

The old production Design System was subsequently reopened and rendered in
the native UI with a verified HTTP-200 session at PID 52392; 44 project-file
hashes were unchanged across that observation. The old PID 49932 had already
exited. This was an **ordinary dead-PID fresh start**, not proof of the strict
connection-refused recovery branch. Its evidence is
`codex-design-0.5.2-old-ds-reopen.json` and
`codex-design-0.5.2-old-ds-native.png` in the acceptance archive.

These two operational gaps motivated
[0.5.3 and its release acceptance](ACCEPTANCE-0.5.3.md). Its first complete run
was **513/514**, with an `EBUSY` temporary-editor cleanup failure whose cause is
not established. The later full **514/514** run, GitHub installation, live
Properties Resize/reopen and automatic empty-cache migration/child reuse are
recorded separately there; the first failure is not erased.

All earlier failures and evidence scopes below are preserved.

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
  observers are cleaned up on disposal. The compact 72-pixel reserve and public
  safe-area hints do not measure an expanded desktop composer. Standalone
  comment layout is unchanged.
- Native request dispatch can migrate an idle artwork's skill binding to a
  newer verified executing package. It verifies the exact skill kind and
  manifest-owned package files. A removed old cache is supported only within
  the current package's canonical `CODEX_HOME/plugins/cache/<marketplace>/codex-design/`
  family, with no fixed marketplace name or user-directory path. Same-parent
  upgrades retain their token; the existing fully idle parent-handoff contract
  generates a new token and requires explicit child registration. Active
  writers, live listeners, inconsistent ownership and unrelated packages remain
  refused. A prepared request is never accepted or queued by upgrading.
- An internal native editor open can recover a conclusively connection-refused
  data service. Its startup-lock owner rechecks the local endpoint, original
  state bytes and worker ownership, archives the exact stale record, and starts
  one newly verified service. It does not kill the recorded live PID, replace
  an active/pending job, or rebind a native parent/child. Timeouts, responding
  endpoints, custom hooks, legacy process ownership and unsafe paths remain
  refused. A failed recovery retains its evidence and cannot become an
  automatic fresh binding on Retry.

The shared controller repairs apply to all four native artwork types. Rename
and metadata hydration reuse the existing data service; only the guarded
connection-refused recovery can replace its unavailable runtime. The candidate
does not automatically create chats, accept drafts, dispatch unsent requests,
or claim a native fixed-home header API. The previously accepted top-bar limit,
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
comment viewport additions, an intermediate rebuilt candidate passed **464/464
tests**, zero failed, cancelled or skipped tests, in **35,475.99 ms**. Generated
consistency passed for **184 owned files**. Portable relocation again passed
with generic `node`, Unicode/space paths, no node_modules, six tools and two
resources, including `ui://codex-design/0.5.2/library`. The final logs are
`codex-design-0.5.2-final-tests.txt` and
`codex-design-0.5.2-final-portable.txt`. The 435/435 and 182-file evidence above
is retained as the earlier candidate, not relabeled as this later package.
These 464-test/184-file results also precede the skill-binding migration and
connection-refused recovery additions below.

The blank-artboard suite executes the real compiled creation/content-update
owners, checks default, portrait and custom dimensions with the original raw
checker, and retains the legacy blank's expected checker failure. Its targeted
run passed **14/14**, independently reproduced. Early fixture constant-lookup
and drift-anchor failures remain distinct from those passing runs. Native
comment geometry tests exercise the real canonical components across all four
editors plus transport/observer lifecycle; they are not an installed 0.5.2
visual acceptance result.

The migration author passed **29/29 focused tests**: sixteen existing dispatch
cases plus thirteen new upgrade cases. The independent reviewer ran only those
**13/13 upgrade cases**. The refused-service recovery author passed **59/59
targeted related tests**, including **28 new recovery cases**; its independent
reviewer ran **28/28 recovery cases**. These are separate targeted scopes,
not an aggregate whole-package count or installed-host acceptance. The exact
recorded history and its logging limits are in
[native-skill-upgrade-052.md](research/native-skill-upgrade-052.md).

The combined upgrade/recovery package was rebuilt with **184 owned files**.
Generated consistency and portable relocation passed: generic `node`, Unicode
and space paths, no node_modules, six tools, two resources and the 0.5.2 UI URI.
The final complete run passed **505/505 tests**, zero failed, skipped or
cancelled tests, in **51,775.71 ms**. Logs are
`codex-design-0.5.2-upgrade-recovery-build.txt`,
`codex-design-0.5.2-upgrade-recovery-tests-attempt2.txt` and
`codex-design-0.5.2-upgrade-recovery-portable.txt` in the local archive.

The first complete run was **504/505**, not green. A temporary detached-library
preview CLI open returned `PREVIEW_IDENTITY_UNVERIFIED`; the old fixture did not
identify whether this was initial open or reuse, then removed its state despite
failed graceful cleanup. The raw failure remains in
`codex-design-0.5.2-upgrade-recovery-tests-attempt1.txt`. Its exact orphaned test
process was revalidated by executable, full temporary-root arguments and
creation time before cleanup; no artwork or unrelated process was stopped.
The unchanged isolated HTTP suite passed **6/6**, separately recorded in
`codex-design-0.5.2-preview-failure-isolated.txt`.

The fixture now records named CLI stages and preserves state/log diagnostics
when a stage or authenticated cleanup fails. No product identity check was
weakened, no retry or test skip was added, and test concurrency was unchanged.
The first run overlapped the independent consistency and portable checks; the
second ran after those checks finished. The second complete run passed as
recorded above. The original intermittent
failure did not recur; its cause is **not established**, and no source fix for
that preview failure is claimed. Earlier 435/182 and 464/184 results remain
historical candidate evidence.

This package has not been promoted to the configured GitHub marketplace ref or
installed in Codex. The installed version remains 0.5.1. Do not promote
controller/protocol evidence to a real-host repair save/reopen pass. The second
reuse request remains an unsent native draft; it must not be accepted or
processed merely to complete candidate checks. Waiting for its Send is not an
installation approval prerequisite: the idle QA listener has been safely
retired independently, as recorded below.

After an authorized GitHub-marketplace upgrade and normal reconnection/restart,
real-host acceptance must still verify draft text/attachment retention, live
0.5.2 MCP reads, active Rename followed by edit/save/reopen, new blank-board
contract after text and size edits, recovery of the old refused Design System
service, and current-package dispatch paths. Native child reuse requires its
own actually sent request and receipt; the existing draft is not that evidence.

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

The root operator subsequently checked that the QA journal had zero pending
and zero active jobs, then called the installed `stopWorker` with
`onlyWhenIdle:true`. The local listener returned
`listener-paused-or-replaced`; the actual child
`01a199c8-d2c6-7dc3-986c-16e080e86dd8` ended its turn and was verified idle.
Its single completed job remained completed. Artwork and `comments.json` hashes
were unchanged, and cleanup did not send the draft or invoke its request
read/accept/dispatch flow. This is idle QA cleanup, not a second-request reuse
test or an interruption of content editing. The local evidence is
`codex-design-0.5.1-idle-qa-cleanup.json` in the acceptance archive.

The installed 0.5.1 native export checks remain separate from this candidate.
The PNG was decoded and visually inspected; HTML was parsed and its inline
JavaScript compiled without execution. Browser policy explicitly denied
`file://` navigation, so no alternate navigation was used and HTML visual
acceptance remains pending. See the 0.5.1 local export reports; these checks do
not establish an installed 0.5.2 UI pass.
