# Codex Design 0.5.1 prepared revision

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

This revision is prepared in source; it has not been published to the primary
GitHub marketplace branch or installed. The active installation remains 0.5.0.
The operator's successful single-comment native interaction is recorded in
[ACCEPTANCE-0.5.0.md](ACCEPTANCE-0.5.0.md). The new error/fix actions and steered
request correction still need installed-host operator checks.

The earlier entire-row-removal requirement was superseded by the named-home-tab
and visual mitigation direction above. Earlier mainToolbar-null reasoning
was incomplete and is retained/corrected in
[native-shell-layout-proposal.md](research/native-shell-layout-proposal.md).
No host code was modified and no native header fix is claimed.

Cross-window single-editor ownership is not established by this revision; its
scope was explained to the user and is not presented as completed. The goal
remains open, and the user still holds the primary release at installed 0.5.0.
