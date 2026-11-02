# Codex Design 0.6.5 — native conflict language follow-up

Recorded on **2026-11-03**. This patch follows the upstream 2.7.1 migration
and installed 0.6.4 native opening/concurrency checks in
[ACCEPTANCE-0.6.4.md](ACCEPTANCE-0.6.4.md). Publication and final installed
0.6.5 language verification are pending at this record's initial cutoff.
No GitHub workflow is used.

## Observed defect and scope

On a Chinese Windows system, a real Slides UI/file write race correctly
offered the canonical conflict choices but the shadow conflict bar still
displayed Chinese. Its independent `navigator.language` selector bypassed
the existing English-only editor catalog. Slides and Design share this
module; the actual Design System and Dashboard entry bundles do not contain
that branch. Their History locale is handled separately.

The native adapter verifies the unique conflict layer, selector, selector-bound
dictionaries, English subtitle/actions and dictionary end anchor before
changing only that selector when the native transport exists. Unknown,
removed, mismatched or duplicate anchors fail closed. It does not alter
`navigator`, `Intl`, authored Chinese text/names/board labels, standalone
language selection or conflict choice callbacks.

## Verification before publication

| Check | Result |
| --- | --- |
| Independent focused review/run | Approved; **15/15**, `1883.7454 ms`, zero failures/skips/cancellations. Actual generated Slides/Design conflict factories and choices exercised under zh-CN, zh-TW and en-US; standalone Chinese/English and all four editor assembly paths checked. |
| Complete final frozen-source run | **671/671**, zero failures/skips/cancellations; concurrency 4, `73774.9088 ms`, exit 0. |
| Build / consistency | **191 owned files**, plus generated manifest; generated package current. |
| Portable package | 0.6.5 resource URI, generic `node`, relocated Unicode/space path, no `node_modules`, six tools and two resources verified. |

The first full attempt was **669/671**, `74230.2043 ms`: the UI resource
contract and compatibility manifest still advertised 0.6.4 after the initial
version bump. The first portable check also rejected the resource-version
mismatch. Both production metadata fields were corrected and the package
rebuilt before the complete final run. Those failures are retained, not
classified as flakes or hidden by a focused retry.

## Installed-host gate

- Pending formal GitHub marketplace installation, release/snapshot/cache
  comparison, fresh runtime discovery and current-session call.
- Pending actual installed 0.6.5 conflict bar on the unchanged Chinese system:
  English title/subtitle and Use theirs / Keep mine / Keep both; explicit
  choice must save the selected value without changing unrelated files.
- This gate does not expand earlier HTML static checks into a browser
  rendering/navigation pass. Notice-based Bring back, real TUN networking,
  the complete four-editor interaction matrix and all format/error variants
  remain bounded as tracked in the development plan.

## Evidence

Archive root:
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.
This is a local evidence path, not distributable configuration.

- `codex-design-0.6.5-full-attempt1.txt` and
  `codex-design-0.6.5-full-attempt2.txt`.
- `codex-design-0.6.5-portable-attempt1-resource-version-mismatch.txt`,
  `codex-design-0.6.5-build.txt`, `codex-design-0.6.5-consistency.txt` and
  `codex-design-0.6.5-portable.txt`.
- `codex-design-0.6.4-native-conflict-language-leak.png` and
  `codex-design-0.6.4-native-concurrency-result.json` preserve the actual
  preceding UI/file test and its limits.
