# Codex Design 0.6.1 candidate — native QA follow-up

Recorded on **2026-11-03**. **0.6.1 is not yet published or installed.**
This record separates the published 0.6.0 baseline, candidate source tests,
and consuming-host checks that still need to be repeated after installation.
No GitHub workflow is used for the release.

## Published baseline and candidate checks

| Check | Observed result | Limit |
| --- | --- | --- |
| Published and installed 0.6.0 | Commit `b5cb0a988df90fc8943fcb13e1ae8a83ab9b864e`; 190 owned files plus the generated manifest, **191 files** in each of the release tree, fetched GitHub marketplace snapshot and installed cache; all three hashes match, with no missing, extra, different or symlink entries. | This verifies 0.6.0, not the pending 0.6.1 package. |
| Installed runtime | Five enabled skills and six tools verified against the installed 0.6.0 package; a current-session tool call and native off/on check succeeded without restarting Codex. | A fresh verifier process alone would not establish the existing desktop session loaded the plugin. |
| 0.6.0 full regression | First attempt **640/642**; after fixes, second attempt **643/643**, no failures, cancellations or skips. | Subsequent actual host QA still found the failures below. The earlier failed run is retained. |
| Candidate History preview and theme checks | **33/33**, no failures, cancellations or skips; focused changes independently reviewed. | Source/assembled-loader tests are not an actual host rendering pass. |
| Candidate font decoder checks | **2/2**, no failures, cancellations or skips; focused changes independently reviewed. | Executable decoder and immutable-URL checks do not prove a font is embedded in an exported PPTX. |
| Candidate first full regression | **650/650**, no failures, cancellations or skips; `253083.6123 ms`. | This input-state pass precedes the ongoing Canvas settle/flush correction. It is not the final release gate for later edits. |

The first candidate build produced 190 owned files. A final build, consistency
check and applicable regression checks are required after the remaining source
changes; counts above must not be summed because suites overlap.

## Failures found in the actual 0.6.0 host

| Area | Actual observation | 0.6.1 correction / remaining gate |
| --- | --- | --- |
| Historical editor preview | The `Version 1 - Read only` overlay opened with a blank frame and timed out after 30 seconds. A production-bundled regression reproduced `ReferenceError: document2 is not defined`; the preserved diagnostic run was **21/22**. | The reflected opaque loader now binds its own `window.document` instead of capturing the installer's renamed outer binding. Tests exercise document delivery, inner request forwarding, host context and app-ready using the assembled production loader. Bounded loader error reporting remains; no sandbox relaxation or timeout increase. Actual installed-host retest is pending. |
| History surface | Host panel alpha made the History layer translucent, exposing controls underneath. | Composite the History panel over the host base to obtain an opaque resolved surface. Focused tests cover light/dark/transparent cases without changing authored artwork or unrelated UI alpha semantics. Actual installed visual retest is pending. |
| Current-font PPTX decoder | The Google Noto Sans SC current-font export showed an unpack failure. The decoder depended on helpers imported from the old static editor index. | Package only reviewed pure interop helpers with the decoder and give the rewritten decoder a new immutable URL. Dependency drift fails closed. Actual current-font export and Office inspection remain pending. |
| Canvas close | Native create, rename, add-board, text editing and Properties controls succeeded. Closing the artwork Tab then waited indefinitely. | **Unresolved host gate, not a Canvas pass.** The canonical session settler is being connected to native flush; repeat dirty save, close and reopen after the final build. |

## Native request and upgrade evidence already completed

Two real native Send requests were processed on the same disposable Slides
artwork `0af7d407-d922-49a4-8c6c-ef8807f8bc27`:

| Stage | Result |
| --- | --- |
| Installed 0.5.3 baseline | Actual user message, read/accept and its own dispatch created and registered a real native child; a pre-edit snapshot was recorded; `Migration baseline` became `Migration verified`; the checker returned zero problems; `Migration baseline passed.` was written once. Read-only audit: **18 checks true**. |
| Installed 0.6.0 follow-up | A separate actual Send, read/accept and its own dispatch reused child `01a19cc5-730c-78f0-8cc5-3a2304ec9150` and registration `21b92012-03dd-469f-bc97-ca9bd7bff8ea`. The binding upgraded from 0.5.3 to 0.6.0 with the old package cache empty; a separate pre-edit snapshot preceded `Migration verified` becoming `Migration final`; the checker returned zero problems; `Migration upgrade passed.` was written once. Read-only audit: **22 checks true**. |
| Idle cleanup | Public idle cleanup paused only this QA listener after each completed request. First-party snapshots show the child turn completed and the listener closed naturally; the final state had two completed jobs, zero pending/active jobs, and unchanged checked content hashes. |

This proves actual native delivery, controller reuse and binding migration. The
old data-runtime process exit was not observed on that Slides artwork, so this
case does **not** prove guarded data-runtime retirement.

A separate real CLI lifecycle test does prove guarded retirement on disposable
Design artwork `180cb771-c935-46b1-9a88-60de2f968a89`: a genuine generated 0.5.3
runtime was started, the installed 0.6.0 CLI reported its guarded upgrade, the
old PID retired, the new PID reported version 2/local-only identity, and the
archived raw record matched the old state. All **16 checks** passed; content,
bridge token and stable metadata were preserved, and the checker returned zero
problems. This artwork had no native controller, worker, jobs or comments before
or after the test; it did not send a native request or exercise populated-state
preservation. Its own runtime was stopped after the check.

## Native export evidence and limits

| Fixture / export | Observed result | Remaining validation |
| --- | --- | --- |
| Uploaded Deng.ttf | Real font size **16,324,168 bytes**, below the **16,777,216-byte** budget. | This is actual large-font input evidence, not a synthetic Arial fixture. It does not by itself establish PPTX glyph embedding. |
| Deng PDF | Native Save As produced `Codex Design 0.6 font QA.pdf`, **59,716 bytes**; the rendered page was visually checked. | Keep this scoped to the checked PDF. |
| Uploaded-font current-font PPTX | `Codex Design 0.6 font QA.pptx`, **15,748 bytes**. The actual Current fonts menu kept the DengXian name and warned that it was not embedded. Upstream only attempts PPTX embedding for linked Google Fonts; uploaded `src` faces do not enter that path. | This is supported fallback behavior, not a positive font-embedding or budget pass. There is no separate source-only menu choice. |
| Google Noto Sans SC current-font PPTX | `Codex Design 0.6 Google CJK QA.pptx`, **15,756 bytes**; unpack warning observed on 0.6.0. | Retest after the decoder fix, inspect the package and open in Office; presently a preserved failure. |
| Earlier HTML export | Browser policy denied opening the local HTML file. No policy bypass or alternative browser/protocol was used. | Static checks only; HTML visual rendering, board navigation and interaction are not claimed as native passes. |

## Remaining release gates

- The canonical Canvas settle/flush correction passed 11 focused tests and
  independent review, and the rebuilt 190-file package passed consistency and
  generic-node/Unicode-path portable checks. Confirm the final complete run,
  then verify actual close/reopen preserves the edits.
- Publish 0.6.1 through GitHub and install from the GitHub plugin marketplace;
  compare release/snapshot/installed hashes, verify the five skills and six
  tools, and make a current-session call. No installed-cache patching.
- In the installed host, repeat historical preview open/close, History opaque
  surface, relevant diff/restore controls and current editor usability. Keep
  the read-only preview's write/download/draft restrictions intact.
- Repeat real current-font PPTX export and Office verification. Preserve the
  source-only warning, large Unicode-font boundary and native Save As behavior.
- Complete any still-open native export/reference cases for Canvas HTML,
  content-only Design System, Dashboard CSV and copied read-only Theme pages.
  Existing source/HTTP coverage must not be substituted for unchecked native
  rendering or dialogs.

The second full run was **653/654**, with no skips or cancellations. Its only
failure was `EBUSY` removing the temporary lifecycle fixture after all lifecycle
assertions and service shutdown succeeded (the recorded primary error is
absent). The raw log and `codex-design-0.6.1-full-attempt2-cleanup-failure.json`
are retained. Only the test fixture's already-scoped cleanup gained five
bounded retries for Node's documented transient removal errors. The focused
lifecycle rerun passed **3/3**; it is not relabeled as a complete-suite pass.
The third complete run passed **654/654**, zero failures, skips or
cancellations, in **75,623.7297 ms** (exit 0). Its separate raw log is
`codex-design-0.6.1-full-attempt3.txt`; the previous failed log is unchanged.

The final native results and final release identifiers are intentionally left
pending for the release owner to record.

## Evidence archive

Local archive root:
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.
This is a QA evidence location, not a distributable plugin path or requirement.

- `codex-design-0.6.0-full-attempt1.txt`,
  `codex-design-0.6.0-full-attempt2.txt`,
  `codex-design-0.6.0-installed-hashes.json`,
  `codex-design-0.6.0-installed-runtime.txt`.
- `native-preview-published-regression-20261102T161151898Z.txt`,
  `codex-design-0.6.0-history-preview-failed.png`,
  `codex-design-0.6.0-history-transparency-observation.png`,
  `codex-design-0.6.0-canvas-close-wait.png`.
- `codex-design-0.6.1-build-attempt1.txt`,
  `codex-design-0.6.1-preview-theme.txt`,
  `codex-design-font-decoder-focused-attempt1.txt`,
  `codex-design-0.6.1-full-attempt1.txt`.
- `codex-design-0.6.0-baseline-native-result.json`,
  `codex-design-0.6.0-upgrade-native-result.json`,
  `codex-design-0.6.0-upgrade-firstparty-final.json`,
  `codex-design-0.6.0-baseline-idle-cleanup.json`,
  `codex-design-0.6.0-post-upgrade-idle-cleanup.json`,
  `codex-design-0.6.0-real-runtime-upgrade.json`.
- `codex-design-0.6.0-font-fixture.json` and `native exports 0.6.0/`
  (PDF, two distinct PPTX exports and `font-qa-pdf-page1.png`).
