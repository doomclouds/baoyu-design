# Codex Design 0.5.1 acceptance

## Included code

- Category-aware creation: Slides, Design, Design systems and Dashboards create
  their own type directly from both category controls. All and global sidebar
  creation retain the universal picker.
- Every native draft body retains the exact immutable request URI. Newly sent
  requests and active-turn steering require their own receipt and dispatch.
- Non-comment AI actions use the canonical request/native draft path, including
  diagnostic repair, selection requests and the audited setup/file/remix flows.
  Native failures do not claim clipboard or agent-execution success. Saved
  append failures retry their existing canonical thread.
- The Design System's known built-in migration scaffold names the Codex skill
  in native mode; historical migration identities and authored content remain.
- Comment pins keep their original author-avatar rendering. The user explicitly
  revoked the briefly selected change to visible comment numbering.

## Checks actually run

The latest source and rebuilt package passed **409/409 tests**, zero failed,
skipped or cancelled tests. Consistency and portable relocation passed for
**182 owned files**. The 340/392-test counts below are retained historical
baselines, not the final count. See the additional caller audit below.

- **340 tests passed**, zero failed, skipped or cancelled tests.
- The full suite includes assembly/save/comment integration against each real
  editor data service, alongside actual compiled handoff-function tests.
- Package consistency and portable relocation passed: **179 owned files**, six
  tools, two static resources, generic Node command and Unicode/space paths
  without node_modules.
- Isolated browser-component QA verified Dashboard-specific text and buttons;
  clicking New dashboard saved one dashboard and loaded its actual editor.
  The test tab and its services were closed/stopped afterwards. No real user
  artwork was changed in this QA run.

Evidence retained locally: `codex-design-0.5.1-tests-combined.txt`,
`codex-design-0.5.1-category-ui.json` and
`codex-design-0.5.1-category-create.jpg`.

## Release and native-host limits

### Additional export, theme and thumbnail corrections

The extended prepared source passed **392/392 tests**, zero failed, skipped or
cancelled tests. The generated package contains **181 owned files**; consistency
and portable relocation passed with the same generic Node command, six tools
and two static resources. The earlier 340-test result remains a historical
baseline for the previous prepared source, not the count for these additions.

The shared native export route now opens a plugin-owned Save As dialog, rather
than delegating silently to the host download API. App-only folder browsing and
save operations support explicit target selection, overwrite confirmation,
idempotent retry, confirmed paths and last-folder persistence. No filesystem
browser action was added to model-visible READ_ACTIONS. The UI's directory Enter
and IME handling were independently reviewed: Enter in Location navigates only;
composition cannot trigger an early Save. Normal editor RPC timeouts remain
bounded; the interactive download waits for user completion/cancellation and is
cleaned up on unload.

### Additional Canvas export-caller audit

A subsequent actual-caller review found that Canvas classified a failed or
uncertain Save As result as `unsupported`, then started its browser fallback.
In the native editor that fallback became a second Save As with a new request.
The native-only adapter now preserves the original failure code and terminates
that export, without an automatic second download or saved-success feedback.
Explicit cancellation keeps the existing declined outcome. An artifact with
missing embedded content retains its real ready-to-download warning card;
only an explicit Download action starts saving it.

The raw canonical bundle's AST contains seven save calls in five owners:
image export, the delivery card, PDF, the registered export producer and HTML
ZIP. The producer's initial and retry save failures return a failed result and
finish only the captured request; they do not take or decline a newer queued
request. Its receive/result callback and active/busy cleanup are exercised by
the actual compiled-function tests. Other editor bundles are not matched by
this Canvas-only adapter. Standalone browser outcomes remain covered.

Seventeen new tests execute those actual compiled callers and verify the
generated four-editor assembly. Independent review reran all seventeen. The
final complete run passed **409/409** in about 37.5 seconds; package consistency
and Unicode/space relocation passed with **182 owned files**, six tools and two
resources. Logs are `codex-design-0.5.1-export-caller-final-tests.txt` and
`codex-design-0.5.1-export-caller-final-portable.txt`.

An earlier whole-suite run was **403/404**, not green: its drift fixture read
an already adapted generated bundle and incorrectly expected fresh adaptation
to reject it. That failure is retained in
`codex-design-0.5.1-export-caller-intermediate-403-of-404.txt`. The drift fixture
now reads the actual raw build input; the generated-bundle checks remain. Two
earlier focused fixture/parser failures are also retained separately from the
final result. These code/protocol/component checks do not establish a new
installed-host UI pass.

### Browser-component validation of export, theme and thumbnails

In the isolated browser fixture, a real Nimbus content bundle was cancelled
without a file/receipt, then saved under a chosen temporary folder and a Chinese
filename. The saved file was **37,216 bytes**, parsed as a 16-file design-system
content bundle, and the UI displayed its actual full path. The next export
remembered the folder. A same-name export displayed Replace confirmation and
was cancelled; the existing file's SHA-256 remained unchanged. No production
user file was saved or replaced. Backend replacement tests used disposable
directories. Windows denied actual file-symlink creation, so that refusal path
used an injected filesystem; real junction canonicalization passed. External
process changes in the final stat-to-rename window are not claimed impossible.

Actual compiled Design UI in the fixture used Segoe UI at **14px** under dark
host tokens, and Georgia at **18px** under light host tokens. The authored page
heading remained Trebuchet MS at **58px**, with identical foreground and cream
content background; all six project-file hashes remained unchanged. The preview
backdrop can follow the renderer theme and is not the authored content surface.
Icon fonts were preserved. These are browser-component checks with controlled
host context, not actual Codex preference changes. Dynamic snapshot/partial-map
and canonical comment ShadowRoot behavior are covered by the focused tests.
Pointer and keyboard attempts on the nested Properties control encountered
automation hit-test/focus-root errors; they are not counted as passed actions.
An additional isolated attempt against this generated package found the correct
Design `dc-props-toggle` button and its DOM, but AX, pointer and nested locator
input were rejected by the browser tool's opaque-frame routing. Its final
pressed state remained false; neither a successful toggle nor a product defect
was established. The Design/Slides twelve-file hash comparison covered only the
interval after that attempt's baseline, not initialization. The temporary tab,
fixture and editor service were closed/stopped; integrity and cleanup evidence
are retained as `properties-qa-integrity-14d7c5e2.json` and
`properties-qa-cleanup-14d7c5e2.json`.

Thumbnail content ratio and transparent letterboxing were checked in a real
browser at a naturally fractional width of **296.6328125 CSS px**. The frame had
no layout border. Pixel samples on both navy-cover edges stayed dark while the
default-white artwork remained white. The original meet/fit behavior and
non-16:9 content were retained. The screenshot was delivered at CSS-pixel
resolution while the browser reported DPR 2; this is not a multi-device raster
coverage claim.

The browser test tab, temporary data service and fixture server were stopped.
Evidence includes `codex-design-0.5.1-export-theme-thumbnail-tests.txt`,
`codex-design-051-save-as-chooser.jpg`, `codex-design-051-save-as-result.jpg`,
`codex-design-051-editor-light-18.jpg`, `codex-design-051-thumbnail-pixels.json`
and the project hash comparison JSON files in the local acceptance archive.

### Current native-tab requirement

The user changed the target from removing the entire native row to keeping a
named, nonclosable Codex Design home tab visible by default, with a subtle
separator and compact plugin chrome below it. No independent window is wanted.
The shared host middle sidebar is explicitly deferred; the internal collapsible
category pane remains the accepted implementation for this revision. Comment
pins continue to show the original author avatar by user choice.

A real installed 0.5.0 probe showed that **Ctrl+Shift+F / Enter full view** reveals
the existing sole home tab without creating a second tab or sending a message.
Its screenshot is `codex-design-native-single-home.jpg`. Leaving and re-entering
the global app again showed the blank native row, so default initialization and
navigation persistence are **not passed**. Earlier interrupted/ineffective input
attempts were excluded. The scoped `tabsHidden` source behavior explains a
testable mechanism, but no private runtime state or automatic plugin setter was
used. This is a manual transient workaround, not a completed default-view fix.

The current requirement, reproduction and supported-API boundary are collected
separately in [native-home-tab-acceptance.md](research/native-home-tab-acceptance.md)
so the superseded whole-row-removal investigation is not mistaken for this gate.

The earlier release hold was lifted when the user explicitly accepted retaining
the current top-bar limitation for 0.5.1. This revision is now published to the
primary GitHub marketplace branch and installed; see the release record below.
The operator's successful single-comment native interaction is recorded in
[ACCEPTANCE-0.5.0.md](ACCEPTANCE-0.5.0.md). The new error/fix actions and steered
request correction still need installed-host operator checks.

The earlier entire-row-removal requirement was superseded by the named-home-tab
and visual mitigation direction above. Earlier mainToolbar-null reasoning
was incomplete and is retained/corrected in
[native-shell-layout-proposal.md](research/native-shell-layout-proposal.md).
No host code was modified and no native header fix is claimed.

Cross-window single-editor ownership is not established by this revision; its
scope was explained to the user and is not presented as completed. The top-bar
limitation is accepted for this release, not fixed or reported as passed.

## GitHub release and installed verification

The user authorized publishing 0.5.1, installing it from the existing GitHub
marketplace, and retaining the current top bar. Release code commit
`40146a6374288683072181648860297e33acafa3` was fast-forwarded to `codex/plugin`
and pushed to `doomclouds/baoyu-design`. Existing commits contain `[skip ci]`;
no tag or workflow was invoked, and `gh run list --branch codex/plugin` returned
no workflow runs.

The Desktop's actual CLI, `0.166.0-alpha.5.1`, refreshed the configured
`codex-design-marketplace` Git snapshot and installed
`codex-design@codex-design-marketplace` as **0.5.1**. The first attempt failed
with Windows Access Denied while four exact old 0.5.0 MCP entry processes held
their cache directory. Their path, executable, parent and creation time were
revalidated before stopping only those entries; the second supported install
succeeded. No artwork data service or model worker was stopped for that retry.

An independent three-way comparison verified all **182 owned files plus the
generation manifest** across the release checkout, downloaded GitHub marketplace
snapshot and installed cache. Missing/extra files, hash differences and symlinks
were zero. Snapshot provenance and its install marker identify the same GitHub
URL, `codex/plugin` ref and release code commit.

A fresh real Desktop app-server discovered five enabled skills, six MCP tools,
the global entrypoint and `ui://codex-design/0.5.1/library`, without plugin
diagnostics. Its successful discovery is separate from the current long-lived
chat connection, which initially returned **Transport closed** after old MCP
replacement. That failure is retained. The user then restarted Codex; direct
current-chat reads and the first native operator request passed afterwards,
as recorded below. The later successful reads do not erase the initial failure.

### Actual installed UI observations

The native plugin page displayed version **0.5.1** and five skills. The real
left-rail entry opened the global library; the running main Desktop app-server
spawned the MCP entry from the installed 0.5.1 cache. These observations use the
actual native host, not the earlier isolated browser fixture.

- Dashboards showed **New dashboard**. Clicking it directly created and loaded
  one real dashboard, without a type picker. Rename to
  `Codex Design 0.5.1 - Dashboard QA` persisted in the global library.
- The dashboard Sources panel opened and closed normally. The artwork action
  menu opened, and clicking outside dismissed it.
- Export artwork opened the real Save As UI. Enter in Location navigated to a
  chosen folder containing spaces without writing a file. Cancel also wrote
  nothing. A subsequent explicit Save wrote a **737-byte**, three-file dashboard
  bundle; the UI showed the exact saved path. Its top-level fields were only
  `format`, `version`, `kind`, `title`, and `files`.
- The next export remembered the saved folder. The same name required Replace
  confirmation. Cancelling retained the existing file byte-for-byte, with
  SHA-256 `be2aa456bb6dc845fb24fe88e40d6b86286ffaba8098693aa122ba1d46620e6a`.
- Design showed **New design** and opened a real empty canvas. Its global
  Properties control opened the visible Properties/Code/Tweaks/Theme panel.
  This establishes the control action, not successful content persistence.

### Discovered rename/save conflict: failed acceptance case

In `Codex Design 0.5.1 - Canvas QA`, renaming the open blank canvas and then
adding an artboard displayed a white artboard, but the editor reported that a
newer version of the page had saved first. A normal click on its red sync/retry
control did not recover during this observation. The disk index still had zero
boards and zero order entries, and only `project/canvas.json` existed. The tab
is retained because its new blank artboard is only in memory. This is **not a
passed save/reopen case** and not an edit to preexisting user artwork.

The active Rename path flushes and changes the index title while retaining the
loaded editor instance; it does not refresh that instance's base. This is a
concrete conflict trigger. The upstream publisher does have reload/merge and
base-refresh retry logic, so the persistent failure must not be described as
an absolute absence of retry. Its exact continuing conflict path is not yet
fully established. A separate unpublished repair branch is preparing a safe
editor lifecycle change; it does not alter the already published 0.5.1 bytes.

Targeted native Slides/Design System controls and save/reopen now have the
additional evidence below. Active-turn steering, worker reuse and complete
0.5.2 repair save/reopen remain pending. These actual UI actions must not be
expanded into an all-features/native-operator pass.

Retained evidence includes `codex-design-0.5.1-marketplace-upgrade.txt`,
`codex-design-0.5.1-install-first-access-denied.txt`,
`codex-design-0.5.1-install-final.txt`,
`codex-design-0.5.1-installed-hashes.json`,
`codex-design-0.5.1-installed-runtime.txt`,
`codex-design-0.5.1-native-ui-artifacts.json`,
`codex-design-0.5.1-native-save-as.png`,
`codex-design-0.5.1-native-export-saved.png`,
`codex-design-0.5.1-native-export-result.json`, and
`codex-design-0.5.1-native-canvas-save-conflict.png` in the local archive.

## Post-restart request and selected-text acceptance

After the user's normal restart, this same chat successfully called installed
`design_read` routes for view, artwork metadata and content-only references.
The read-only reference carried no mounted UI; requesting `comments.json`
through the content route was refused with `CONTENT_ONLY`.

A separate pre-named disposable canvas saved its first artboard and the text
`Native QA original` without prior active Rename. The text toolbar's Properties
action opened the actual selected-text controls. This successful control case
narrows the earlier failure; it does not pass the Rename case. The live UI also
temporarily called a newly CLI-created artwork missing despite a valid current
MCP record. Refreshing Library recovered it; 0.5.2 contains a separate metadata
hydration repair that is not yet installed.

An object-located comment, with Add to chat selected, staged an immutable
request and attachment in the real native composer. Before the user's Send,
the worker journal had no pending/active job or registered child. No native
Send was automated. After the user sent request
`f5b1c29e-43eb-4313-b9c5-9e9599edfc26`, the real native parent read, accepted
and dispatched that request and created child
`01a199c8-d2c6-7dc3-986c-16e080e86dd8`. The parent used the host's default
local Documents/Codex environment. The child created a before-edit snapshot,
changed only the literal to `Native QA verified`, ran the checker and posted
the canonical reply `Verified in Codex 0.5.1.`. Independent disk comparison
confirmed an unchanged canvas index and an otherwise byte-identical component;
the native UI displayed both the new text and the original comment's reply.

The checker reported **one pre-existing missing DCLogic/data-dc-script error**.
Execution and reply passed; structural checking did not. Both the raw upstream
and installed blank factory produce that incomplete document, so no stripping
by the Codex adapter is claimed. The text-only request was respected. A separate
0.5.2 source repair adds the contract only to generated blank artboards and
keeps their preview dimensions in sync; it does not alter these installed bytes.

The native compact composer overlapped a long comment's lower controls. Panning
the canvas exposed them for this test. A native-only comment viewport repair is
prepared for 0.5.2, with an explicit limit: public safe-area hints do not guarantee
the geometry of a long native input draft. A second request asking the same child
to repair the QA document and finish listening is staged, awaiting the user's
separate Send. No unsent request has been accepted or counted as worker reuse.

Evidence: `codex-design-0.5.1-native-operator-result.json`,
`codex-design-0.5.1-native-no-rename-baseline.png`,
`codex-design-0.5.1-native-text-properties.png`,
`codex-design-0.5.1-native-comment-completed.png` and
`codex-design-0.5.1-native-canonical-reply.png` in the local acceptance archive.

## Additional native Slides, Design System and Trash checks

These checks used the actually installed 0.5.1 in Codex. They did not install
or validate the separate 0.5.2 candidate.

### Slides Properties, text save and same-artwork reopen

The Slides category's **New slides** action directly created artwork
`b6df303a-1e17-4e2a-8a49-5398b2e787e8`, without Rename. Its actual Properties
panel opened. The Text tool accepted `Native slides QA`, and the edit saved to
`project/slides/cover.html` with SHA-256
`39A346C72B3B24311520D51F3A6DB069069FB6EDE79ECD38C130FF2D52E1D07A`.
Closing its artwork Tab removed that Tab. Opening it again from Recent showed
the same text under the same artwork ID, and the component hash was unchanged.

The original checker returned **problems: 0**, with a default-font warning
retained. This establishes this structural/save/reopen case; it is not a
complete visual or typography-quality check.

### Design System token save and reopen

The Design System category's **New design system** action directly created
artwork `302c2803-cc94-4618-b590-b306a7ddc2c6`. Colors and the Add color dialog
worked, and the token `qa/qa-gray` with value `#888888` saved. Its color-value
editing popover opened. The original checker returned **problems: 0**.

A long unsent native draft obscured the dialog's Add button. The first click
did not save a token and is not counted as a successful Add. Temporarily
minimizing the native chat exposed the control; a later explicit Add succeeded.
The native draft was preserved and was not sent.

Closing and reopening this same artwork showed the saved token. The
`project/tokens.json` SHA-256 was
`98211697E210D7437D595BE0F16EA69A37AF7B20DC1E3E8789D62D64745D4372`
before and after reopen.

### QA-only Trash, cancelled permanent deletion and Restore

Only that Design System QA artwork was moved to Trash after confirmation.
Its active `library.get` returned `NOT_FOUND`, and its artwork Tab disappeared.
Trash displayed the one QA artwork. Select all selected that one item; Delete
selected opened the permanent-deletion confirmation. Cancel did not permanently
delete it. Restore then returned the same UUID to the active library with
`deleted: false`; the token file retained the SHA-256 recorded above. No
permanent deletion is claimed as executed by this case.

Screenshots retained in the local acceptance archive:
`codex-design-0.5.1-native-slides-properties.png`,
`codex-design-0.5.1-native-slides-edited.png`,
`codex-design-0.5.1-native-slides-reopened.png`,
`codex-design-0.5.1-native-ds-token.png`,
`codex-design-0.5.1-native-ds-reopened.png`, and
`codex-design-0.5.1-native-trash-confirmation.png`.

These observations do not establish every export format, every editor control,
or the 0.5.2 repairs as passed. The second native request still awaits the
user's Send in its draft; it has not been accepted or counted as worker reuse.

## Native import and Slides PDF/PPTX exports

### Dashboard import, explicit Save and independent reopen

The actual Windows file picker imported the previously exported 737-byte
Dashboard QA content bundle. Its source artwork was
`fc635147-09af-40e4-bad6-2a7948bac101`; import created a distinct artwork,
`a2ceaca0-d159-4e49-a746-96f142ff448f`. At import, the exact three-file content
set and each file's SHA-256 matched its decoded bundle bytes. The bundle's only
top-level fields were `format`, `version`, `kind`, `title` and `files`; it
contained no comments or worker queue.

The new copy rendered its `Untitled dashboard` content. In Edit page (Beta),
the selected heading was changed to `Native imported dashboard QA`. Merely
blurring the field did not save it: **Save 1 change** remained available. The
later explicit Save persisted `db/files/index.html.json` with SHA-256
`36F23334E8367A203682900C2C3A6CE1A340A08FCC7538789F023BCF93226E02`.
Closing its Tab and reopening from Recent showed the changed text under the
same new UUID, with the same hash. The source artwork's page hash, beginning
`2AA483`, remained unchanged. The blur-only attempt is not counted as a save.

Evidence: `codex-design-0.5.1-native-import-result.json`,
`codex-design-0.5.1-native-import-rendered.png` and
`codex-design-0.5.1-native-import-reopened.png` in the local acceptance archive.

### Slides PDF through the real Save As flow

For the same Slides QA artwork
`b6df303a-1e17-4e2a-8a49-5398b2e787e8`, the actual Download menu's PDF Best
action opened Save As. Choosing the native-exports QA directory and
`Native slides QA.pdf` saved **38,018 bytes**, SHA-256
`5E38A4965ABB88BF9946F226D8EFF8B17F944515936DC53810019B4F85AD717D`.
Independent `pdfinfo` inspection reported one page, 960 by 540 points and PDF
1.7. A `pdftoppm` rendering visibly contained the QA text without clipping.

Evidence: `codex-design-0.5.1-native-pdf-saved.png` and
`codex-design-0.5.1-native-slides-pdf-render.png`.

### Both observed Slides PPTX variants

Both actual PPTX menu variants saved files through the native UI:

| Recorded variant | Bytes | SHA-256 |
| --- | ---: | --- |
| Basic | 15,539 | `F1B1A021E586AD002E883F5C2A305E9197DA8CB18B4938F23C708C78F5B22B95` |
| Current | 15,540 | `1780D135544674A3D80A5A9261BAFC02BA88AE2FA47582D8F1258639CE6123EE` |

Independent ZIP checks passed every entry's CRC; all 22 XML/relationship
documents parsed and all 20 internal relationship targets existed. Each deck
contained one 16:9 slide with the QA text. Both files were then opened in real
Microsoft PowerPoint, where `Native slides QA` was visible without a Repair
prompt. The basic variant initially had an ordinary OfficePLUS promotion in an
auxiliary window; closing that window exposed the deck. It was not a document
repair failure.

These samples used only Arial. They do not establish custom-font embedding or
other typography cases. The source `project/slides/cover.html` retained the
`39A346...` SHA-256 recorded above throughout these exports.

Evidence: `codex-design-0.5.1-native-pptx-basic-powerpoint.png`,
`codex-design-0.5.1-native-pptx-current-powerpoint.png`,
`codex-design-0.5.1-native-pptx-basic-structure.json` and
`codex-design-0.5.1-native-pptx-current-structure.json`.

At that point HTML/PNG exports, the Canvas export variants, individual Design
System file exports and data-backed Dashboard CSV export remained unverified. These
targeted successes do not close all formats, all UI, or the separate 0.5.2
repair acceptance. The second native request is still only drafted, pending
human Send; it is not counted as a completed receipt or worker-reuse case.

### Additional PNG and HTML checks

The same installed Slides editor exported its current page through Save As as
`Native slides QA.png`: **179,746 bytes**, 3840 by 2160 RGBA. Pillow fully verified
and decoded the PNG, and direct image inspection showed the QA text intact.
Its SHA-256 is
`A4752C9EC47D2F8CE783B3C877E366A30079B8A88D7FC33B661DB61D1ABE35AE`.

Web page export saved `Native slides QA.html`: **440,864 bytes**, SHA-256
`6C6B8E203432BE8A7CF63495EFD48ABFAE73503EBC966274992487EC57F0DA06`.
Independent static parsing found the doctype, title and QA text, no actual
external resource or CSS URL references, valid embedded JSON, and one inline
JavaScript program that compiled without execution. This is static evidence.
The browser tool explicitly denied local file-protocol navigation; no alternate
navigation was attempted. HTML visual/interaction acceptance remains pending.
The static report is `codex-design-0.5.1-native-html-static.json` in the archive.

The idle native QA listener was subsequently retired with the installed public
`stopWorker(..., {onlyWhenIdle:true})` after confirming zero active/pending jobs.
Its actual native turn completed normally. Artwork and comments were unchanged;
the second draft remained unsent and was not accepted or dispatched. The receipt
is `codex-design-0.5.1-idle-qa-cleanup.json`. This cleanup is independent of the
draft's instructions and does not establish a second-request reuse pass.
