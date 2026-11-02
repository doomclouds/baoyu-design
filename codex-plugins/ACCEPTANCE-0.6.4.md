# Codex Design 0.6.4 — acceptance record

Recorded on **2026-11-03**. Published on `main` and `codex/plugin` at
`9ea2ad57b67da7e23c5b7985ccf7adb6d6da3f46`, then installed through the formal
GitHub marketplace. All 191 files agree between release, fetched snapshot and
installed cache. The published/installed 0.6.3 baseline and HTML export evidence
are recorded in `ACCEPTANCE-0.6.3.md`. No GitHub workflow is used.

## Native artwork reopen correction

The installed host was observed deduplicating identical app-relative path/query
targets even after the plugin's internal artwork Tab was closed. The public
opener now adds a fresh `openRequest` UUID **only to the OS navigation URI's
encoded inner path query**, after validating the exact canonical app authority,
route and artwork UUID. The returned canonical `appUrl`, artwork identity and
internal Tab UUID stay unchanged. Caller-supplied route queries/nonces remain
invalid; `--no-native` still cannot select a silent web fallback.

Windows passes the URI as environment data to the existing shell-free hidden
helper; macOS/Linux retain a single literal URI argument. No artwork files,
conversation, worker, runtime, private host control or broader navigation
authority is introduced. Reopening an active artwork keeps the existing Tab
instead of reloading it.

The deduplication cause is based on matching installed-host source and the real
native check below, **not an official API guarantee**. Official URI compatibility
and query-encoding material does not itself establish host target deduplication
behavior.

## Verification

| Check | Observed result | Limit |
| --- | --- | --- |
| Focused independent review/run | **30/30**: 12 artifact-delivery tests plus 18 real-SDK bridge tests; zero failures/skips/cancellations, `3563.1039 ms`. Review approved the three changed files: `artifact-delivery.mjs`, its tests and `ui-bridge.test.mjs`. | The host dedupe boundary is modeled from observed behavior; the actual check below is separate evidence. |
| Authority and identity | Invalid app authorities, routes, fragments, credentials, ports, caller query/nonces and non-UUID targets fail before OS spawn. Canonical returned links, files and controller records stay unchanged. Replaying the old target is suppressed; a fresh target reopens the same UUID. Opening an already active Tab triggers no new guard, reload or duplicate. | Actual installed-host preservation is recorded below, separately from controller tests. |
| Source opener against installed 0.6.3 | With the Canvas Tab closed, the workspace had **5 Tabs**. The changed source opener issued a fresh native target and reopened Canvas `9ad5e287-4660-4e34-8de2-7203685167ec`; the workspace then had **6 Tabs**, exactly one with that artwork UUID, and it became active. Screenshot and before/after view states were retained. | This proves the changed source opener works with the actual installed 0.6.3 host. It is **not** an installed-0.6.4 package pass. |
| Complete regression | **665/665**, zero failures/skips/cancellations; test concurrency **4**, `72177.1478 ms`, exit 0. | Focused suite counts overlap the complete run and must not be added. |
| Build / consistency | **190 manifest-owned files** built; generated package current; all 191 files including manifest agree in release, fetched snapshot and installed cache. | Hash equality does not itself prove UI behavior. |
| Portable package | Verified 0.6.4 with generic `node`, a relocated Unicode/space path, no `node_modules`, six tools and two resources. | A portable process does not prove the current desktop session loaded 0.6.4. |

## Installed consuming-host checks

- Fresh desktop-runtime discovery reports five enabled skills, six tools and
  no errors. After toggling only this plugin off/on, current-session `view.get`
  succeeded. Running installed `0.6.4/server/index.mjs` processes have parent
  32632, the unchanged Codex app-server; Codex was not restarted.
- The installed 0.6.4 public CLI reopened Canvas UUID
  `9ad5e287-4660-4e34-8de2-7203685167ec` after its internal Tab was closed.
  Current-session view states changed from five to six Tabs, exactly one with
  that UUID; it became active and both artboards rendered.
- Two repeated installed-CLI opens preserved visible `Installed 064 active
  draft` and the same editor loader URI digest
  `a84451f19d169dce64b12eeffff915d68dd27763fa00fb3ef87497afb9537ebf`.
  The Tab count remained six with one matching UUID. This proves the observed
  editor instance/content, not that OS navigation never blurs or autosaves.
  The original `Canvas QA verified` text was restored through the editor and
  confirmed on disk afterwards.
- The 0.6.3 native HTML Save As and static audit results remain separate from
  browser rendering/navigation acceptance. Multi-artboard PNG ZIP completed:
  88,929 bytes, exactly two PNGs, 1600×1200 and 800×600, safe paths/CRC/full
  decode and image inspection passed.
- Keep local-file browser policy restrictions intact; no bypass or alternate
  serving/protocol is used to claim exported HTML interaction.

## Native concurrency follow-up

The own Slides QA fixture had zero pending/active jobs and a real pre-edit
checkpoint before controlled UI/file writes. Its first local edit autosaved
before the external write, so that first sequence is not claimed as an
unsaved conflict. A second immediate file write during UI editing did produce
the canonical conflict choice. Before choosing, disk retained `External raced
save` while the editor showed `Local raced save`; explicit Keep mine then
saved `Local raced save`. This was an actual editor/file race, not a fabricated
worker or notice.

That native check exposed a separate English-only UI gap: the shadow conflict
bar still used the system's Chinese language, despite English main chrome.
The original screenshot is retained; a follow-up patch and new regression are
required before final migration closeout. No absence of Bring back notice
after explicit Keep mine is classified as a bug: chosen overwrites deliberately
suppress that notification. Selected-file History restore and notice-based
Bring back are distinct operations.

History Changes then restored the previously overwritten `Local concurrent
edit` version using Restore just this. Restoring the earlier baseline cover
returned `Font QA original`; all 24 project file hashes matched the pre-test
baseline. Across the intermediate writes/restoration, only `slides/cover.html`
changed and the other 23 files stayed identical. The final editor rendered
the baseline text. This is file-level recovery, not a notice-based Bring back
pass. See `codex-design-0.6.4-native-concurrency-result.json`.

## Additional source-opener active-editor check

Two more requests through the changed source opener were made while the
installed 0.6.3 editor displayed `Canvas nonce draft`. Both were accepted;
the editor loader URI SHA-256 stayed
`974a16dc00beecb79f3e7937b93a7db0cc67853fb7ba67ca4fd0fa4f115b714d`,
and the same visible draft survived. The immediate before/after file reads
were identical. This verifies that observed editor instance and draft content,
not a claim about final installed 0.6.4 or every later autosave timing. The
test text was restored through the editor afterwards. The evidence is
`codex-design-0.6.4-source-active-draft-result.json`.

## Evidence archive

Archive root:
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.
This is a local evidence location, not a distributable configuration path.

- `codex-design-0.6.4-build.txt`, `codex-design-0.6.4-consistency.txt`,
  `codex-design-0.6.4-portable.txt`.
- `codex-design-0.6.4-full-attempt1.txt`: complete **665/665** run.
- `codex-design-0.6.4-source-opener-result.json` and
  `codex-design-0.6.4-source-opener-reopened.png`: source-opener proof against
  installed 0.6.3, with the same single artwork UUID.
- `codex-design-0.6.4-installed-hashes.json`,
  `codex-design-0.6.4-installed-runtime.txt`,
  `codex-design-0.6.4-installed-reopen-result.json`,
  `codex-design-0.6.4-installed-reopen.png`,
  `codex-design-0.6.4-installed-active-draft-result.json` and
  `codex-design-0.6.4-installed-active-draft.png`.
- `codex-design-0.6.4-concurrency-before.json`, `-local-held.json`,
  `-external.json`, `-raced.json`, `-kept-mine.json` and
  `codex-design-0.6.4-native-conflict-language-leak.png` retain the actual
  concurrency attempt and observed language leak.
- Focused source coverage: `codex-plugins/tests/artifact-delivery.test.mjs`
  and `codex-plugins/tests/ui-bridge.test.mjs`; independent review/run results
  were reported to the release owner before the final build.
