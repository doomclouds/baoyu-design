# Codex Design 0.6.3 candidate — acceptance record

Recorded on **2026-11-03**. This is a **candidate source/package record**.
Publication commit, marketplace installation, installed file hashes and actual
native HTML export results are pending. The published/installed 0.6.2 baseline
and its native checks are recorded in `ACCEPTANCE-0.6.2.md`. No GitHub workflow
is used.

## Narrow change and verified scope

The isolated current-editor digest fallback and its artwork-owned service add
**SHA-384**, which the actual Canvas HTML export uses to verify its packaged
React assets with SRI. The RPC permits only canonical **SHA-256 / SHA-384**,
valid base64 and at most **32 MiB** of decoded data. Buffer views retain their
actual offset/length; unsupported algorithms and oversized input are rejected.
Existing content-addressed asset identities continue to use SHA-256.

This does not change sandbox authority, external resource policy, Save As,
request ownership or the historical preview broker. The nested read-only
History preview retains its existing SHA-256-only bounded digest interface;
it gains no writes, downloads or drafts.

| Check | Observed result | Limit |
| --- | --- | --- |
| Actual Canvas HTML SRI regression | **3/3** focused tests passed; independent **3/3** and selected-test **3/3** checks also passed. The test extracts the genuine generated Canvas helper and expected SRI values and verifies the exact distributed React/ReactDOM bytes through the serialized native digest RPC. Mutating either buffer fails integrity. No newline normalization or substitute fixture digest is used. | This proves the exercised integrity path, not complete native HTML export. Counts overlap and must not be summed. |
| Bounds and ownership | The real service enforces the algorithm allowlist, strict base64, the 32 MiB limit and existing artwork identity. Tests reject invalid/missing/deleted artwork and unaudited algorithms. | No general-purpose crypto, broader resource access or weaker session verification is introduced. |
| Full suite | **662/662**, zero failures, skips or cancellations; test concurrency **4**, `71073.658 ms`, exit 0. | This is source/package regression evidence. The separate failures retained in the 0.6.2 record are not relabeled. |
| Build / consistency | **190 manifest-owned files** built; the consistency log reports the generated package current. | Release commit and installed hashes remain pending. |
| Portable package | Verified 0.6.3 using generic `node`, a relocated Unicode/space path, no `node_modules`, six tools and two resources. | A portable process check does not establish the current Codex desktop session loaded 0.6.3. |

The prior native Canvas HTML attempt stayed at Exporting without a Save As
dialog. Missing SHA-384 support is a demonstrated required-path gap; this
record does **not** claim it caused that observed hang or that the gap's fix
made native HTML export succeed. A fresh installed-host attempt is required.

## Pending consuming-host checks

- Publish/install through the GitHub plugin marketplace, record commit and
  release/snapshot/cache hashes, verify five skills/six tools and make a live
  current-session call. No manual cache patching or GitHub workflow.
- Export Canvas HTML in the installed candidate. Observe completion or a
  concrete failure, native Save As, chosen location and the actual saved bytes;
  exercise cancellation where applicable. Keep the earlier hang screenshot.
- Validate the saved archive's content, relative board navigation and packaged
  resources to the extent available. Static inspection is not visual or
  interaction acceptance.
- Preserve the browser's earlier local-file navigation denial. No restriction
  bypass or alternative browser/protocol is used to claim HTML rendering.
- Recheck affected current-editor behavior if the installed candidate reveals
  a regression; keep historical read-only restrictions unchanged.

## Evidence archive

Archive root:
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.
This is a local QA archive, not distributable configuration.

- `codex-design-0.6.3-build.txt`, `codex-design-0.6.3-consistency.txt`,
  `codex-design-0.6.3-portable.txt`.
- `codex-design-0.6.3-full-attempt1.txt`: complete **662/662** run.
- `codex-plugins/tests/native-html-integrity.test.mjs`: actual generated
  Canvas SRI helper/bytes, serialized transport and real service regressions;
  independent focused review/results were reported separately to the release
  owner, not substituted for native execution.
- `codex-design-0.6.1-canvas-html-export-wait.png` preserves the actual native
  HTML attempt that did not reach Save As.
