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
chat connection, which still returned **Transport closed** after old MCP
replacement. That current-chat failure is retained; it needs normal reconnect
or restart before the new request/steering operator gate can pass.

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

Native Slides/Design System controls, current-chat Add to chat/Send/steering,
and complete save/reopen remain pending. The actual UI actions above must not
be expanded into an all-features/native-operator pass.

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
