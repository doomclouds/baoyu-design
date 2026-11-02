# Codex Design 0.6.2 candidate — acceptance record

Recorded on **2026-11-03**. This is a **candidate source/package record**;
0.6.2 publication commit, GitHub marketplace installation, installed hashes
and consuming-host results are pending the release owner's checks. The
previous installed 0.6.1 baseline is recorded in `ACCEPTANCE-0.6.1.md`.
No GitHub workflow is used.

## Changes and focused evidence

| Change | Source evidence | Actual host gate |
| --- | --- | --- |
| Dashboard opaque-origin startup | The genuine shipped presence initializer contains `new URL("./", location.href).href`. The old adapter missed the whitespace and the actual line throws on `about:srcdoc`. The corrected selector accepts formatting only around the existing `./` and language lookups. **9/9** editor-document tests passed independently, including the actual initializer, native opaque documents, ordinary HTTP fallback, historical presence bypass and all four assembled editors. | Open the same Dashboard in the installed candidate, confirm its shell and authored content load, then exercise its native controls/export paths. A VM reproduction is not a native pass. |
| Collapsed startup diagnostics | Error cards retain Retry and expose only escaped plain error code/message under closed-by-default **Error details**. Code is validated and limited to 96 characters; message to 4,000. Disallowed C0/C1 and bidi controls are removed. Stack, cause and object payloads are not serialized; no HTML or links are activated. **58/58** actual UI-controller tests passed independently, covering malformed diagnostics, truncation, retry and stale/post-ready callbacks. | Check the actual failure card if a startup failure occurs; successful opening must remain unobstructed. No large diagnostic panel is inserted into chat. |
| Opaque floating surfaces | Menus, dialogs and toast surfaces composite host colors over an opaque active-theme base; export-dialog layering and error-toast precedence retain their special rules. Independent review approved; CSS parsed with zero warnings. | Inspect menus/dialogs/toasts over artwork in the real host, including the export dialog. No claim that a source review proves final visual appearance. |

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

The final build produced **190 manifest-owned files**. Final package
consistency/portable verification and publication/install identifiers are to
be recorded by the release owner; the completed full run above does not
substitute for those package or host gates. Focused suite counts overlap the
complete run and must not be added to it.

## Pending installed-host acceptance

- Publish through GitHub and install from its plugin marketplace. Record the
  commit and release/snapshot/cache hash comparison, five skills, six tools
  and a live current-session call. No manual installed-cache changes.
- Reopen Dashboard QA `75639596-6af9-4cc4-b43f-394ab6bd7362`; verify loading,
  data content, native controls and CSV download/cancel where applicable.
- Check floating menu/dialog/toast opacity in the actual Codex host. Preserve
  the existing host font/theme inheritance and authored artwork appearance.
- Retain the 0.6.1 History preview, embedded-font PPTX, Canvas save/close/reopen
  and copied-reference results as baseline evidence; repeat affected cases
  when the installed candidate exposes a regression.
- Canvas PDF/HTML and any still-unchecked export/diff/restore cases remain
  explicitly pending. The earlier local HTML navigation was denied by browser
  policy; no policy bypass or alternate browser/protocol is used to claim a pass.

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
  `codex-design-0.6.2-portable.txt`: final package checks are owned by the
  release owner and must be read before recording their status here.
