# Codex Design 0.6.2 — acceptance record

Updated on **2026-11-03**. **0.6.2 was published and installed from the GitHub
plugin marketplace**, commit `1a7a6312ab8210cab0c66c7257d2ad7de13a7ac7`.
Release tree, fetched marketplace snapshot and installed cache matched all
**191 files** (190 owned files plus manifest), with no missing, extra, different
or symlink entries. A fresh runtime check found five skills and six tools;
the current desktop session read its view successfully after an enable off/on
reload. Main app-server PID **32632** stayed unchanged; Codex was not restarted.
The previous installed baseline is in `ACCEPTANCE-0.6.1.md`. No GitHub workflow
was used.

## Changes and focused evidence

| Change | Source evidence | Actual host gate |
| --- | --- | --- |
| Dashboard opaque-origin startup | The genuine shipped presence initializer contains `new URL("./", location.href).href`. The old adapter missed the whitespace and the actual line throws on `about:srcdoc`. The corrected selector accepts formatting only around the existing `./` and language lookups. **9/9** editor-document tests passed independently, including the actual initializer, native opaque documents, ordinary HTTP fallback, historical presence bypass and all four assembled editors. | Installed 0.6.2 rendered the same Dashboard, its three-row table and Sources panel. CSV download and overwrite cancellation were checked separately below. |
| Collapsed startup diagnostics | Error cards retain Retry and expose only escaped plain error code/message under closed-by-default **Error details**. Code is validated and limited to 96 characters; message to 4,000. Disallowed C0/C1 and bidi controls are removed. Stack, cause and object payloads are not serialized; no HTML or links are activated. **58/58** actual UI-controller tests passed independently, covering malformed diagnostics, truncation, retry and stale/post-ready callbacks. | Check the actual failure card if a startup failure occurs; successful opening must remain unobstructed. No large diagnostic panel is inserted into chat. |
| Opaque floating surfaces | Menus, dialogs and toast surfaces composite host colors over an opaque active-theme base; export-dialog layering and error-toast precedence retain their special rules. Independent review approved; CSS parsed with zero warnings. | Actual menus and dialogs were visually opaque in the installed Codex host. This checked appearance is separate from source coverage of every toast/error state. |

The Dashboard correction preserves ordinary HTTP fallback and does not rewrite
authored artwork. The diagnostic changes do not weaken session identity,
sandbox, Save As, pending-draft or native-request controls. Global content-only
artwork ownership, copied reference systems and English UI remain unchanged.

## Complete-run history

| Run | Result | Interpretation |
| --- | --- | --- |
| First full run | **657/659**, two failures, zero skips/cancellations; `74525.8827 ms`. | `editor-refused-recovery.test.mjs` concurrent no-agent recovery and `editor-runtime-upgrade.test.mjs` preview-entry tests returned `EDITOR_IDENTITY_UNVERIFIED` (exit 2 instead of expected 0). The original log is retained. Its input state preceded the final diagnostic control-filter change. |
| Focused identity diagnosis | **60/60**, zero failures/skips/cancellations; `31496.6334 ms`, concurrency 1. | Archive-only observation recorded health responses and hashed disposable-fixture state. No product/test rules or 2-second identity deadlines were changed. Scheduling may be affected by observation. This is not a retroactive pass for the first full run. |
| Final frozen-source full run | **659/659**, zero failures/skips/cancellations; test concurrency **4**, `72222.7353 ms`, exit 0. | Separate complete run after the final control-filter change. No identity guard was weakened to obtain the pass. |

The exact causes of the two original identity rejections remain **unproven**;
the original run has no rejection-detail/health trace and its disposable
fixtures were cleaned up. Do not label either failure as definitively caused
by load, ports or external processes. A later green run does not erase them.

The final build produced **190 manifest-owned files** and passed consistency.
Portable verification passed with generic `node`, a relocated Unicode/space
path, no `node_modules`, six tools and two resources. Publication/installation
checks are recorded above. Focused suite counts overlap the complete run and
must not be added to it.

## Actual installed-host checks and remaining limits

| Case | Observed result | Limit |
| --- | --- | --- |
| Dashboard | Artwork `75639596-6af9-4cc4-b43f-394ab6bd7362` opened, rendered the three source rows and exposed Sources. | This closes the checked startup failure, not every authored dashboard variation. |
| CSV Save As / cancellation | `qa_records.csv`, **59 bytes**, contains header `record,label,value` and rows `qa-a,Alpha,10`, `qa-b,Beta,20`, `qa-c,Gamma,30`. An existing-file overwrite prompt was observed, then cancelled with X. SHA-256 `e52ae2a1432a3bc181cbaf78f99974627e4ade3391ac1e7d9f3f70025a22233a` and modification time, compared at normalized millisecond precision, were unchanged. | Overwriting was deliberately cancelled; this is not an overwrite-success claim. |
| History diff and Restore just this | The actual diff was displayed. Restore just this and its confirmation restored only `slides/cover.html`: among **24** relative content files, **1** changed, none were missing, and the other **23** hashes stayed identical. The live cover displayed `Original`. History showed version 7 with restore-to-version-3/user `10062` metadata. | Selected-file restoration was checked; arbitrary selected-line/hunk restoration is not claimed. |
| Recovery before partial restore | Automatic `Before partial restore` recovery point, ID prefix `b8348213`, recorded at **2026-11-02T18:05:39.733Z**. Before/after hash evidence and the restored editor screenshot were retained. | Content recovery remains separate from comments, chat and worker state. |
| Canvas PDF | Native Save As produced `Canvas-verified.pdf`, **38,878 bytes**, one page, **600 × 450 points**. Its rendered page was visually checked. | Separate from the previously checked 1600 × 1200 PNG and the unresolved HTML export. |
| Canvas HTML | The actual 0.6.1 native attempt remained at Exporting and never reached Save As; screenshot `codex-design-0.6.1-canvas-html-export-wait.png` is retained. | **Not passed.** No proven cause is assigned to this hang here. The 0.6.3 candidate needs a new actual native attempt. |

The earlier local HTML navigation was denied by browser policy. No policy
bypass or alternate browser/protocol was used, and HTML visual/interaction
acceptance remains unclaimed. The 0.6.1 History preview, font-embedded PPTX,
Canvas save/close/reopen and copied Theme reference results remain baseline
evidence; unchecked formats and interactions are not implied by those passes.

## Evidence archive

Archive root:
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.
This is a local QA archive, not a distributable configuration path.

- `codex-design-0.6.1-dashboard-open-failure.png` preserves the installed
  pre-fix failure; `editor-document.test.mjs` contains the actual initializer
  reproduction and corrected fallback regression.
- `codex-design-062-diagnostic-ui-independent.txt`: independent **58/58**
  UI-controller result after the final control-filter change.
- `codex-design-0.6.2-full-attempt1.txt`: unchanged **657/659** failed run.
- `codex-design-0.6.2-cli-focused-attempt1.txt`,
  `codex-design-0.6.2-cli-focused-diagnosis.json`,
  `codex-design-0.6.2-cli-focused-health.jsonl` and
  `codex-design-0.6.2-cli-focused-snapshots/`: separate focused diagnosis,
  limitations and masked own-fixture evidence.
- `codex-design-0.6.2-build-final.txt` and
  `codex-design-0.6.2-full-attempt2.txt`: final 190-file build and separate
  **659/659** complete run.
- `codex-design-0.6.2-consistency.txt` and
  `codex-design-0.6.2-portable.txt`: completed package checks.
- `codex-design-0.6.2-marketplace-upgrade-attempt1-TLS-failure.txt` preserves
  the failed first marketplace attempt;
  `codex-design-0.6.2-marketplace-upgrade-no-proxy.txt`,
  `codex-design-0.6.2-installed-hashes.json` and
  `codex-design-0.6.2-installed-runtime.txt` record the successful installation.
- `codex-design-0.6.2-dashboard-rendered.png`,
  `codex-design-0.6.2-csv-before-overwrite-cancel.json`,
  `codex-design-0.6.2-csv-overwrite-confirm.png`,
  `codex-design-0.6.2-opaque-menu.png`,
  `codex-design-0.6.2-opaque-dialog.png`.
- `codex-design-0.6.2-before-partial-restore.json`,
  `codex-design-0.6.2-history-diff.png`,
  `codex-design-0.6.2-partial-restore-result.json`,
  `codex-design-0.6.2-partial-restored.png`.
- `native exports 0.6.0/qa_records.csv`,
  `native exports 0.6.0/Canvas-verified.pdf`,
  `native exports 0.6.0/canvas-pdf-page1.png`,
  `codex-design-0.6.1-canvas-html-export-wait.png`.
