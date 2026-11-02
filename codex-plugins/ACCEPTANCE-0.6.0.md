# Codex Design 0.6.0 — migration acceptance record

Recorded on **2026-11-02**. The migration targets upstream 2.7.1 at
`6759e358eb88d83986c753b0fc60c84e4aabdb3a`, starting from the verified Codex
Design 0.5.3 behavior. The candidate builds **190 manifest-owned files**.
It was published at `b5cb0a9` and installed from the configured GitHub
marketplace without workflows. Generated, marketplace and installed packages
matched for all **191 files**, including the 190 owned files and manifest.
Fresh Desktop discovery found five enabled skills, six tools and no plugin
errors; a current-session read succeeded after reloading only this plugin.
These checks do not establish that every native interaction/export passed.

## Subsequent native findings

Real-host checks exposed defects after the complete code suite passed:
the historical preview's reflected loader captured a renamed outer `document`
binding; History's panel background retained a host alpha channel; and the
WOFF2 decoder retained a circular static import of the old editor entry URL.
Canvas closing also stalled after a text edit: the native flush did not call
the canonical live-session settler before waiting for the file publisher.
The follow-up fixes and their separate native gates are recorded in
[0.6.1 acceptance](ACCEPTANCE-0.6.1.md). These failures are not retroactively
counted as successful 0.6.0 UI tests.

## Scope and retained product rules

- All five skills use the native artwork workflow, the global
  `~/.codex/CodexDesignLibrary` and the default/selected local environment.
  New dependent-data instructions describe authorized sequential retrieval
  followed by attached file snapshots, not a hosted viewer query service.
- Updated server/vendor adapters retain unknown-contract failures, authenticated
  artwork identity, the original save/publish queue, comment user-revision
  checks, Properties controls, English UI and host-theme handling.
- Add to chat still prepares an immutable draft only. Each actually sent request
  must have its own read/accept/dispatch, and the parent decides whether to
  reuse, resume or create a real native child. Neither a rebuild nor a retry
  authorizes consuming an unsent draft.
- Native services are explicitly local-only. They do not reactivate persisted
  LAN sharing. Raw sharing mutations, folder archives and exports-to-`exports/`
  paths are not substitutes for the native controls and Save As. The CLI rejects
  `share`, `archive` and `--lan` in this workflow.
- Artwork import/export remains content-only. Comments, chat, history, worker
  records, credentials and runtime state remain separate. Source design-system
  changes do not automatically propagate into other artwork.
- Existing 0.5.3 active-Rename, uncached metadata, generated blank-board/preview,
  idle skill-cache migration and stale-service identity protections remain
  regression requirements. Their earlier installed-host results are historical
  baseline evidence, not new 0.6.0 passes.

## Reliability and runtime integration

New metadata/boot routes stay behind the upstream owner and artwork-base
checks, including Dashboard's stable `/dashboard/<id>/` path. The adapter
retries only the comments transaction's Windows atomic rename; unrelated
archive writes keep their original behavior.

The inherited port probe excludes interfaces that answer every tested port,
while retaining real port-occupancy and bind-race checks. Related tests model
a synthetic TUN interface; they do not establish a physical VPN acceptance.
Save-base tests exercise missing/stale revisions and batch preservation against
real temporary services. Dashboard concurrent first creation keeps both sets
of nonconflicting fields. Its explicit overwrite choice remains tied to the
new merge/history model rather than a separate unreviewed write path.

The runtime upgrade work verifies the existing local editor before changing
its service protocol. It must retain the idle ownership, startup locking,
identity and evidence rules when upgrading an old 0.5.3 runtime. Busy, unsafe
or unverifiable instances are not authority to kill or replace a process.

## History and read-only references

The existing Version history entry retains whole-artwork recovery points and
adds **Edit history** for the actual upstream History controller. It does not
add another always-visible History toolbar or invent a parallel history model.
Opening detailed History waits for the mounted editor, the real app-ready
message, a successful complete save flush and its matching acknowledgement.
Dialog closure, navigation, replacement and disposal cancel the pending action.

The canonical History UI provides file differences, a historical preview,
manual restoration of a **selected file/version**, and recovery of content
identified by an overwrite notice. The latter preserves the compared revision
and requires a fresh choice if that base changes. This is **not** an arbitrary
manually selected hunk/line restore interface. A restore is a new revision;
unrelated later content and active-writer restrictions still matter.

The native History extraction excludes Share, Archive, Save and Presence code,
uses English, owns its hidden positioning anchor and cleans up its actual
nodes, listeners and timers. Its historical banner's Back to current control
calls the native preview-close callback instead of navigating to a virtual URL.

Historical editors use separate opaque loaders and an artifact/version-scoped
read-only broker. Only permitted reads, bounded digests and owned event streams
are forwarded; download, chat and write actions are refused. Request and
response caching is byte-bounded, and owned subscription receipts survive read
cache eviction. A late stream open is reclaimed after preview disposal.

Theme links open the installed design-system copy as a passive reference.
Detached template content is sanitized before insertion into a Blob document
with a fixed restrictive CSP and an empty sandbox. The original source system
is not edited. DOM-contract tests are not a real-browser network observation.

## Export migration scope

The candidate carries the upstream font-packaging and standalone Canvas
cross-artboard navigation improvements, while retaining native Save As and
content-only transfer. The exported-format matrix still needs real installed
UI checks. In particular, the old Arial-only PowerPoint results do not prove
Chinese/mixed fonts, subsets or 16 MiB boundary behavior in the new candidate.
Neither static HTML compilation nor a PNG pass proves all other export formats.

## Focused evidence

The following scopes **overlap** and must not be added together to manufacture
a whole-package count. Author-only, code-review-only and independent execution
remain distinct.

| Scope | Recorded result | Evidence limit |
| --- | --- | --- |
| Skill/workflow adaptation | 12/12 author tests | Real upstream Markdown inventory and local delivery rules; no installed-host claim. |
| Annotation/server adaptation | 27/27, independently executed and approved | Temporary real HTTP/CLI services, CAS and simulated TUN probe; no physical VPN or UI pass. |
| Runtime upgrade | 32/32 author tests; independent read-only review approved | Controlled upgrade fixtures; actual 0.5.3 installation upgrade remains a native gate. |
| Vendor adapters | 77/77, independent review/execution | Compiled vendor/control paths, not final native rendering. |
| Export migration | 26/26 related focused tests | Source/runtime and temporary-service export behavior; not all final UI formats or Office/font cases. |
| Canonical History helper | 10/10 author tests | Actual controller in a minimal DOM: diff, confirmed file restore, changed-base notice recovery and lifecycle. |
| Library/History integration | 70/70 related author tests; independent read-only review | Existing UI controller and mounted-frame protocol tests; scopes include older related regressions. |
| Native preview helper | 19/19, independently executed and approved | Opaque loader, scoped reads, budgets, template/CSP contract and cleanup; fake DOM is not browser rendering. |
| Service integration | 15/15, independent review/execution | Artifact/version-bound backend paths, separate from UI interaction. |
| Root native protocol | 11/11 related tests, including the new head-initialization case | Protocol/initialization behavior; no live Desktop screenshot assertion. |
| Host theme | 9/9 related tests | Host-style propagation/control contracts; new native theme visuals remain pending. |

## Build and failure history

Local raw logs are retained in:

```text
C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee
```

The candidate build logs are `codex-design-0.6.0-build-attempt1.txt`,
`codex-design-0.6.0-build-attempt2.txt`,
`codex-design-0.6.0-build-final.txt` and
`codex-design-0.6.0-build-after-dom-fix.txt`. These record successful builds
at their respective input states. The final after-DOM-fix build reports 190
owned files; an earlier build is not relabeled as containing later fixes.

The initial related core run was **33/34**: a resource-JSON match incorrectly
triggered the agent-handoff adapter's contract guard. The next core run was
also **33/34**, exposing the changed original parent-branch/flush-capture
shape. After targeting that exact upstream branch, the related core suite
passed **34/34**. Raw `core-attempt1.txt`, `core-attempt2.txt` and
`core-attempt3.txt` logs retain those separate results with the common
`codex-design-0.6.0-` prefix. The guards were not removed to make the tests pass.

The first complete run was **640/642**, with two failures, zero skips or
cancellations, in **79,803.8771 ms**. It is not a green result:

1. The new preview installer was invoked by a real packaged head bootstrap
   before `document.body` existed. Product initialization now defers until the
   body is available/DOMContentLoaded, with a focused head-execution test.
2. An older static-chrome fixture used port 1 and no real data service. Native
   assembly now legitimately reads grant-scoped dynamic boot metadata, so that
   fixture's fetch failed with `bad port`. The fixture now supplies an actual
   temporary HTTP service for boot only while retaining packaged static chrome;
   it does not bypass the new boot read or weaken service identity.

The post-fix targeted run passed **16/16**, including actual four-runtime HTTP
assembly. The subsequent single complete run passed **643/643**, zero failures,
skips or cancellations, in **83,001.2936 ms**, exit 0. Its raw log is
`codex-design-0.6.0-full-attempt2.txt`; the first failure remains unchanged in
`codex-design-0.6.0-full-attempt1.txt`.

Generated consistency passed for **190 owned files**. Portable verification
passed with generic `node`, a Unicode/space relocation, no node_modules, six
tools and two resources, including `ui://codex-design/0.6.0/library`. The serial
logs are `codex-design-0.6.0-consistency.txt` and
`codex-design-0.6.0-portable.txt`. No installation result is inferred from a
build or complete-suite pass.

## Pending consuming-host gates

- [x] Record generated consistency and generic-node/Unicode-space portable
  verification for the exact final package.
- [x] Publish/install the final candidate through the configured GitHub
  marketplace, without GitHub workflows or a temporary marketplace; verify
  package hashes, five skills, six tools and current-session calls.
- [ ] Exercise create, rename, Properties, menus, save and close/reopen in all
  four installed native editors.
- [x] Exercise actually sent comments and follow-up replies, per-request
  dispatch, real-child reuse, canonical reply and safe idle cleanup.
- [x] Check the actual installed 0.5.3 runtime/cache upgrade cases without
  replacing native identity or recovering a busy writer blindly.
- [ ] Check Design System single-file export, a data-backed Dashboard CSV and
  the actual Canvas export menu formats, including destination/cancel/overwrite.
- [ ] Check Chinese/mixed-font and relevant size-boundary exports using real
  files and Office where applicable; retain failed/unsupported cases.
- [ ] Inspect Theme's passive read-only reference and detailed History in the
  real host, including comparison, selected-file restore, overwritten-content
  recovery, preview/back/close and navigation/disposal behavior.
- [ ] Inspect host fonts, theme, menu/Properties layout and the existing
  comment/avatar behavior. The accepted top-bar/shared-sidebar limits remain.

These pending rows must be filled from actual observations. Explicit browser
or host-policy limits remain unverified scope; no alternative route is used
to bypass a denied interaction. P2 LAN collaboration and presence remain outside
this native migration release.

The two actual native comment sends used the same registered child and
retained its identity. The follow-up used its own read/accept/dispatch,
modified the captured QA text, checked successfully and replied exactly once.
An independent fresh-artwork check exercised genuine 0.5.3 service retirement,
the archived original state and a v2 local-only replacement with content and
identity preserved. The original comment fixture's old process exit was not
observed, so that fixture alone is not claimed as guarded-retirement proof.
The separate raw evidence files are `codex-design-0.6.0-upgrade-native-result.json`,
`codex-design-0.6.0-upgrade-firstparty-final.json` and
`codex-design-0.6.0-real-runtime-upgrade.json` in the recorded local archive.
