# Upstream 2.7.1 source synchronization

Checked on 2026-11-02. The fork parent is `JimLiu/baoyu-design`.
`main` merges the complete Codex Design history through `7ef4a70` and upstream
`6759e358eb88d83986c753b0fc60c84e4aabdb3a` (2.7.1). Relative to the old upstream
baseline `5a1a6f2` (2.4.1), this includes ten commits and 147 changed files.

## Release boundary

The GitHub marketplace still uses `codex/plugin`, containing the verified 0.5.3
package. This source synchronization does not rebuild, release or install a new
Codex plugin. Its existing source, generated package and marketplace definition
were unchanged by the merge. New upstream capabilities are not yet native Codex
acceptance results.

## Useful changes

| Priority | Upstream change | Incremental value for Codex Design |
| --- | --- | --- |
| First | Save-base validation, concurrent creation fixes and explicit Dashboard overwrite choice | Avoid unintended overwrite and improve recovery when an editor and AI both write. Preserve our native flush/CAS and per-request user-revision checks. The Dashboard choice fix depends on the new merge/history baseline; it is not an isolated drop-in cherry-pick. |
| First | TUN proxy interface handling during open | Improve opening when a proxy interface responds on every port. This differs from 0.5.3 stale-service recovery; it is not a diagnosis of the user's current environment. |
| Next | Fonts included in HTML/PPTX/Standalone exports, Unicode subsets and a 16 MiB limit | Improve exported typography and portability. Test actual fonts and Office output; earlier Arial-only acceptance is insufficient. |
| Next | Standalone Canvas HTML follows links between artboards | Make exported interactive prototypes retain their navigation. |
| Next | History diffs, previews, author information and partial restore | We already have whole-artwork checkpoints/history. Element/line/token-level changes and selective recovery are the useful additions. |
| Next | Read-only Design System page linked from Theme | Let users inspect the installed reference without editing its source or propagating changes into other artwork. |
| Later | Presence, cursors and live multi-user updates | Useful for collaboration after ownership, revision and native request handling are reconciled. |
| Later | LAN sharing and viewer/commenter/editor roles | A separate product/security decision; retain local-only operation by default. Upstream Copy link enables network sharing, so it must not silently replace an existing native link action. |

The unified Export menu is a useful layout reference, but Codex's verified Save
As remains the destination-selection path. Upstream Whole folder ZIP includes
history and can include comments; retain our content-only import/export boundary
instead of copying that behavior. DSH's Artifacts sidebar, exports-folder saving
and shell-command recognition are specific to that host; Codex already has its
own native library and Add to chat controller.

## Verification and known adaptation work

- Both upstream and the Codex release history are ancestors of merged `main`.
- Syntax checks passed for twelve updated artifact/server/share-UI files.
- Root `npm test` exited 0 but discovered **zero tests**; it is not a regression
  pass.
- `npm run check:codex-plugin` intentionally failed closed on newly introduced
  `Claude Data` wording in `codex-dashboard/.../dependent-calls.md`. No generated
  release files were replaced.
- Independent static inspection also found changed server-route and Dashboard
  write anchors used by `adapt-annotations.mjs`. Updating the wording alone is
  insufficient: rebase the adapters on the new server/editor contracts, then
  rebuild and run native-host acceptance before a plugin release.

Original update details: [upstream changelog](https://github.com/JimLiu/baoyu-design/blob/6759e358eb88d83986c753b0fc60c84e4aabdb3a/CHANGELOG.zh.md).
