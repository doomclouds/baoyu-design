# Codex Design 0.6.1 — acceptance record

Updated on **2026-11-03**. **0.6.1 was published and installed from the GitHub
plugin marketplace**, commit `6cb016400d7a980fadc09f230ed3f712b3c6e551`.
This record separates prior failures, source tests and actual installed-host
results. The newly discovered Dashboard startup failure remains open for
0.6.2; it is not covered by the successful checks below. No GitHub workflow
was used.

## Published package and regression checks

| Check | Observed result | Limit |
| --- | --- | --- |
| Published and installed 0.6.1 | 190 owned files plus the generated manifest, **191 files** in each of the release tree, fetched GitHub marketplace snapshot and installed cache; all three hashes match, with no missing, extra, different or symlink entries. | Baseline 0.6.0 was separately published at `b5cb0a988df90fc8943fcb13e1ae8a83ab9b864e` with the same file-count/hash checks. |
| Installed runtime | Five enabled skills and six tools verified against installed 0.6.1; the current desktop session hot-reloaded the plugin and made a live tool call without restarting Codex. | A fresh verifier process alone would not establish the existing desktop session loaded the plugin. |
| 0.6.0 full regression | First attempt **640/642**; after fixes, second attempt **643/643**, no failures, cancellations or skips. | Subsequent actual host QA still found the failures below. The earlier failed run is retained. |
| History preview and theme checks | **33/33**, no failures, cancellations or skips; focused changes independently reviewed. | Source/assembled-loader tests are separate from the installed rendering checks below. |
| Font decoder checks | **2/2**, no failures, cancellations or skips; focused changes independently reviewed. | Actual exported font records and PowerPoint rendering were checked separately below. |
| First full regression | **650/650**, no failures, cancellations or skips; `253083.6123 ms`. | This input-state pass preceded the Canvas settle/flush correction; it is not a pass for later edits. |
| Final complete regression | **654/654**, no failures, cancellations or skips; `75623.7297 ms`, exit 0. | The preceding **653/654** cleanup failure and its focused **3/3** rerun remain separate evidence, described below. |

The rebuilt 190-file package passed consistency and generic-node/Unicode-path
portable checks. Counts above must not be summed because suites overlap.

## Failures found in the actual 0.6.0 host

| Area | Actual observation | 0.6.1 correction / remaining gate |
| --- | --- | --- |
| Historical editor preview | The `Version 1 - Read only` overlay opened with a blank frame and timed out after 30 seconds. A production-bundled regression reproduced `ReferenceError: document2 is not defined`; the preserved diagnostic run was **21/22**. | The reflected opaque loader binds its own `window.document`. Installed 0.6.1 rendered Version 1 read-only and returned to the current editor with Back. Bounded diagnostics remain; sandbox permissions and timeout were not relaxed. |
| History surface | Host panel alpha made the History layer translucent, exposing controls underneath. | Composite the History panel over the host base. The installed History panel was visually opaque. This does not claim every other floating menu surface was already opaque. |
| Current-font PPTX decoder | The Google Noto Sans SC current-font export showed an unpack failure. The decoder depended on helpers imported from the old static editor index. | The self-contained reviewed decoder has a new immutable URL. Installed 0.6.1 exported embedded font records; the actual PPTX displayed Chinese regular and English bold text in PowerPoint without a Repair prompt. |
| Canvas close | Native create, rename, add-board, text editing and Properties controls succeeded. Closing the artwork Tab then waited indefinitely. | The canonical session settler was connected to native flush and passed **11** focused tests plus independent review. In installed 0.6.1, an active edit changed `Original` to `Verified`; one click on X closed the Tab; the stored file contained `Verified`, and reopening displayed it. |

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
| Google Noto Sans SC current-font PPTX, 0.6.0 | `Codex Design 0.6 Google CJK QA.pptx`, **15,756 bytes**; unpack warning observed. | Preserved failure; not overwritten by the successful 0.6.1 export. |
| Google Noto Sans SC current-font PPTX, 0.6.1 | `Codex Design 0.6.1 Google CJK QA.pptx`, **24,831 bytes**. ZIP records `ppt/fonts/font1.fntdata` and `font2.fntdata` are **6,408** and **6,372 bytes**. PowerPoint visibly rendered Chinese regular and English bold text without a Repair prompt. | Verified for this linked-font fixture and checked slides, not all fonts or every Office platform. Screenshot: `codex-design-0.6.1-cjk-pptx-office.png`. |
| Canvas PNG | Native Save As produced `Canvas-verified.png`, **49,731 bytes**, **1600 × 1200**; the image was visually checked. | Canvas PDF and HTML rendering/interaction remain pending. |
| Design System README download | Native Save As produced `DS-reference-README.md`, **1,136 bytes**, matching the source README SHA-256 `cb6c49240ed996f234f4511a92e725dae68d96566608a058d6db1e98f3ea2591`. Cancelling another README download left `README.md` absent in the destination. | This proves the checked single-file download and cancellation, not every Design System archive/export format. |
| Earlier HTML export | Browser policy denied opening the local HTML file. No policy bypass or alternative browser/protocol was used. | Static checks only; HTML visual rendering, board navigation and interaction are not claimed as native passes. |

## Reference UI and remaining gaps

The installed Theme reference opened the artwork's own copied Design System
as a read-only page. Tokens, typography, spacing and guide content were visible,
and Back returned to the editor (`codex-design-0.6.1-theme-reference.png`).
This does not create automatic propagation from a source Design System.

Fresh Dashboard QA artwork `75639596-6af9-4cc4-b43f-394ab6bd7362` failed before
the editor frame became ready. The actual shipped presence initializer uses
`new URL("./", location.href).href`, with whitespace after the comma. The native
adapter's old expression missed that formatting; executing the actual adapted
line against `about:srcdoc` reproduced `TypeError: Invalid URL`. The whitespace
correction and its production-line VM regression are part of 0.6.2, not a
successful 0.6.1 Dashboard acceptance. The fixture's `dash.draw`/`dash.data`
usage was not changed speculatively.

Native Dashboard opening/CSV export, Canvas PDF/HTML and any still-unchecked
History diff/restore or Design System archive cases remain distinct gates.
Existing source/HTTP tests do not establish their unchecked native behavior.

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
  `codex-design-0.6.1-build-after-settle.txt`,
  `codex-design-0.6.1-consistency.txt`, `codex-design-0.6.1-portable.txt`,
  `codex-design-0.6.1-marketplace-upgrade-no-proxy.txt`,
  `codex-design-0.6.1-installed-hashes.json`,
  `codex-design-0.6.1-installed-runtime.txt`,
  `codex-design-0.6.1-preview-theme.txt`,
  `codex-design-font-decoder-focused-attempt1.txt`,
  `codex-design-061-canvas-settle-independent.txt`,
  `codex-design-0.6.1-full-attempt1.txt`,
  `codex-design-0.6.1-full-attempt2.txt`,
  `codex-design-0.6.1-full-attempt2-cleanup-failure.json`,
  `codex-design-0.6.1-full-attempt3.txt`.
- `codex-design-0.6.1-history-preview.png`,
  `codex-design-0.6.1-cjk-pptx-office.png`,
  `codex-design-0.6.1-canvas-reopened.png`,
  `codex-design-0.6.1-theme-reference.png`,
  `codex-design-0.6.1-dashboard-open-failure.png`.
- `codex-design-0.6.0-baseline-native-result.json`,
  `codex-design-0.6.0-upgrade-native-result.json`,
  `codex-design-0.6.0-upgrade-firstparty-final.json`,
  `codex-design-0.6.0-baseline-idle-cleanup.json`,
  `codex-design-0.6.0-post-upgrade-idle-cleanup.json`,
  `codex-design-0.6.0-real-runtime-upgrade.json`.
- `codex-design-0.6.0-font-fixture.json` and `native exports 0.6.0/`.
  The folder retains the 0.6.0 failures alongside the separately named 0.6.1
  PPTX, checked PDF/PNG, README download and `font-qa-pdf-page1.png`.
