# Codex Design 0.6.3 — acceptance record

Updated on **2026-11-03**. **0.6.3 was published and installed from the GitHub
plugin marketplace**, commit `4908aafae295cd088346cc0d4fc65099f09b683d`.
Release tree, fetched marketplace snapshot and installed cache matched all
**191 files** (190 owned files plus manifest). A fresh check found five skills
and six tools, and the current desktop session read its view after plugin
enable off/on. Codex was not restarted; main app-server PID **32632** stayed
unchanged. The previous baseline is in `ACCEPTANCE-0.6.2.md`. No GitHub workflow
was used.

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
| Build / consistency | **190 manifest-owned files** built; the consistency log reports the generated package current. | Release/install verification is recorded above. |
| Portable package | Verified 0.6.3 using generic `node`, a relocated Unicode/space path, no `node_modules`, six tools and two resources. | A portable process check does not establish the current Codex desktop session loaded 0.6.3. |

The prior native Canvas HTML attempt stayed at Exporting without Save As.
Missing SHA-384 support was a demonstrated required-path gap. The successful
0.6.3 Save As checks below do not isolate the exact cause of that earlier hang;
the previous failure screenshot remains preserved.

## Actual native exports and inspection limits

| Case | Observed result | Limit |
| --- | --- | --- |
| Single-artboard HTML | The installed editor completed export and native Save As saved `Canvas-standalone-verified.html`, **119,326 bytes**, SHA-256 `6e111f89675f2914cc45dc04eee4e8741a70a7b0a4e6c03f18655ec2f7e637ef`. Static inspection verified the doctype, **1** parsed loader script, **5** JSON sections, **3** embedded resources (**239,842 decoded bytes**), template references and expected artwork text. | Native generation/Save As and static structure passed. No browser opening, rendering or interaction was performed. |
| Multi-artboard HTML | `Canvas-multi-artboard-verified.html`, **235,037 bytes**, SHA-256 `d0ea27f3ed2e4dc33875da3fa1ff7ee37a28002c319c0accdf2053f9b71375c1`. Static audit verified **2 ordered pages**, **800 × 600** and **400 × 300**, expected page text, matching frame/preview sizes, links in both directions, target-to-page mappings and embedded runtime lookup resources. | The byte/JSON/gzip/syntax/template/path-map audit did not execute the loader or navigate in a browser. Resolved static links are not successful browser clicks. |
| Multi-artboard PNG ZIP | Generation in the native UI was still pending at this record's cutoff. | Not a completed download or archive pass. |

The first single-HTML inspector incorrectly treated bundled JSON as JavaScript
and searched artwork text only in the resource manifest. Its incomplete report
was retained; the corrected inspector checks the JSON sections and page
template separately. This was an inspection correction, not a hidden rerun of
a native export failure.

The browser's earlier local-file navigation denial remains in effect. No
restriction bypass, serving or alternative browser/protocol was used to claim
HTML rendering. Native export cancellation and other unchecked formats or
interactions remain separate gates. Historical read-only restrictions remain
unchanged.

## Evidence archive

Archive root:
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.
This is a local QA archive, not distributable configuration.

- `codex-design-0.6.3-build.txt`, `codex-design-0.6.3-consistency.txt`,
  `codex-design-0.6.3-portable.txt`.
- `codex-design-0.6.3-full-attempt1.txt`: complete **662/662** run.
- `codex-design-0.6.3-marketplace-upgrade-no-proxy.txt`,
  `codex-design-0.6.3-installed-hashes.json`,
  `codex-design-0.6.3-installed-runtime.txt`.
- `codex-plugins/tests/native-html-integrity.test.mjs`: actual generated
  Canvas SRI helper/bytes, serialized transport and real service regressions;
  independent focused review/results were reported separately to the release
  owner, not substituted for native execution.
- `codex-design-0.6.1-canvas-html-export-wait.png` preserves the actual native
  HTML attempt that did not reach Save As.
- `codex-design-0.6.3-html-export-saved.png`,
  `codex-design-0.6.3-html-inspector-incomplete-attempt.json`,
  `codex-design-0.6.3-html-static-result.json`,
  `codex-design-0.6.3-multi-artboard.png`,
  `codex-design-0.6.3-multi-html-static-result.json`.
- `native exports 0.6.0/Canvas-standalone-verified.html` and
  `native exports 0.6.0/Canvas-multi-artboard-verified.html`: separately named
  saved artifacts; the archive folder name does not change their 0.6.3 provenance.
