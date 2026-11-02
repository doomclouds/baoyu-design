# Codex Design 0.6.4 candidate — acceptance record

Recorded on **2026-11-03**. This is a **candidate source/package record**;
0.6.4 publication commit, marketplace installation and installed-host checks
are pending. The published/installed 0.6.3 baseline and HTML export evidence
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
| Authority and identity | Invalid app authorities, routes, fragments, credentials, ports, caller query/nonces and non-UUID targets fail before OS spawn. Canonical returned links, files and controller records stay unchanged. Replaying the old target is suppressed; a fresh target reopens the same UUID. Opening an already active Tab triggers no new guard, reload or duplicate. | Active-editor preservation is covered at the real-SDK bridge boundary; installed 0.6.4 active-draft behavior remains pending. |
| Source opener against installed 0.6.3 | With the Canvas Tab closed, the workspace had **5 Tabs**. The changed source opener issued a fresh native target and reopened Canvas `9ad5e287-4660-4e34-8de2-7203685167ec`; the workspace then had **6 Tabs**, exactly one with that artwork UUID, and it became active. Screenshot and before/after view states were retained. | This proves the changed source opener works with the actual installed 0.6.3 host. It is **not** an installed-0.6.4 package pass. |
| Complete regression | **665/665**, zero failures/skips/cancellations; test concurrency **4**, `72177.1478 ms`, exit 0. | Focused suite counts overlap the complete run and must not be added. |
| Build / consistency | **190 manifest-owned files** built; the consistency log reports the generated package current. | Publication and installed hash verification remain pending. |
| Portable package | Verified 0.6.4 with generic `node`, a relocated Unicode/space path, no `node_modules`, six tools and two resources. | A portable process does not prove the current desktop session loaded 0.6.4. |

## Pending consuming-host checks

- Publish/install through the GitHub plugin marketplace; record commit,
  release/snapshot/cache hash equality, five skills/six tools and a live
  current-session call. No manual installed-cache patching or GitHub workflow.
- From the installed 0.6.4 public opener, close and reopen the same artwork;
  verify exactly one stable UUID Tab. Reopen while an unsent/active draft or
  dirty editor is present and confirm no duplicate, reload or lost work.
- Preserve the 0.6.3 native HTML Save As and static audit results without
  treating them as browser rendering/navigation acceptance. Multi-artboard PNG
  ZIP generation was still pending at the prior cutoff.
- Keep local-file browser policy restrictions intact; no bypass or alternate
  serving/protocol is used to claim exported HTML interaction.

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
- Focused source coverage: `codex-plugins/tests/artifact-delivery.test.mjs`
  and `codex-plugins/tests/ui-bridge.test.mjs`; independent review/run results
  were reported to the release owner before the final build.
