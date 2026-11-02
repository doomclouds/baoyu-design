# Native skill upgrades and refused data-service recovery in 0.5.2

## Observed upgrade boundary

The installed 0.5.1 QA has an immutable, prepared second request,
`3ccccaad-57da-49f1-9ae2-a27e4f34aa3b`. It has not been sent or accepted.
The persisted request uses schema version 1 and captures the artwork, comment
revision and file revisions; it does not freeze a plugin-cache CLI path.
`service.readEditRequest` derives `skillFile`, `dispatchCommand` and worker-status
commands from the currently executing package when the request is read.
The resource URI remains `codex-design://edit-requests/<requestId>`.

The separate native binding did retain its absolute 0.5.1 `skillDir`. Before
this repair, `safeBinding` required that path to match the dispatching CLI's
skill directory, so a current-package command could fail with
`BINDING_CONFLICT` after an upgrade. Merely pausing the old listener did not
update the path. Retaining an old absolute CLI command was not a portable
upgrade solution, particularly if the installer removed its old cache.

The installed npm launcher and the desktop's bundled CLI have different
versions. Matching-version `plugin add` source was not established by this
review, so it does not assert that the installer always retains or removes old
cache directories. The implementation covers a verified existing old package
and a narrowly verified fully removed managed-cache directory separately.

## Controlled binding migration

Migration is part of dispatching an independently accepted current request,
not a background draft action. It holds the existing binding and worker locks
and preserves the artifact/kind, actual native actor and request validation.

- The supplied new skill must belong to the package executing the dispatcher,
  at its exact `skills/codex-<kind>` location. Plugin metadata, repository and
  manifest-owned file hashes are checked. This is local package consistency,
  not a remote signature or authentication of unlisted extra files.
- An existing old package receives the same consistency and exact-kind checks;
  verified complete portable packages are supported. The target version must
  be strictly newer under the supported semantic-version comparison.
- When the old package is fully absent, the executing package must be in the
  actual `CODEX_HOME/plugins/cache/<marketplace>/codex-design/<version>` layout.
  The old path must be a lower version in that same canonical family. The
  marketplace name is derived, not fixed. Loose clones, other families,
  malformed versions and aliases cannot use this fallback. Its audit result
  explicitly records `previousPackageBytesVerified:false`: removed bytes
  cannot be verified.
- Old parent metadata and the registry origin must be coherent. Any active
  job, live listener, reserved active job ID or active registry status refuses
  migration. A child cannot dispatch as its own parent.
- Same-parent upgrades retain the existing token. The preexisting completely
  idle handoff to a different real native parent remains available and creates
  a new token. Neither path silently rebinds the registered child's origin;
  explicit child registration is required, and the same real child/thread can
  be reused. Old jobs and receipts remain intact.
- A prepared request still fails `REQUEST_NOT_ACCEPTED` without changing the
  binding or publishing a job. Historical completed dispatches remain
  duplicates, not new work or a replacement receipt. A newly accepted request
  retains its own immutable ID, origin and exactly-once job/reply path.

Only `source/scripts/edit-request-dispatch.mjs` and the new
`tests/edit-request-upgrade.test.mjs` were changed for this repair. Worker
client/core code and real QA bindings, requests and journals were not modified
by its author or reviewer. The fixtures copy the actual dispatcher and worker
modules into disposable Unicode/space-path packages. They complete an earlier
request, prepare a separate one, and exercise migration and normal conditional
comment completion without a model process or real host conversation.

## Separate connection-refused service recovery

The other new repair addresses an old data-service record whose PID is still
alive but whose exact loopback session endpoint refuses connection. It does
not treat a timeout, malformed/HTTP response, DNS/reset error, mixed address
failure or identity mismatch as proof that an editor disappeared.

Only the internal native startup path's binding-lock owner may recover. Under
the worker lock it rechecks the endpoint and original state/binding snapshots,
requires no pending or active work, and refuses unsafe paths, unknown/legacy
ownership and custom or main hooks. It archives the exact original state to a
unique `.artifact-server.refused-*.json`, without killing the recorded PID.
An idle native listener and its parent/child identity can be preserved while
only the unavailable data runtime is replaced.

The original short-lived startup command must succeed and the fresh session
must verify before runtime coordinates are updated. An external replacement
during the locked checks is preserved. A failed startup retains its archive
and original binding; a later Retry cannot reinterpret that archive as
authority to fresh-bind or invent a parent/token. Concurrent CLI processes,
failure recovery and preservation of artwork, comments and worker records are
tested with real isolated local services. These fixtures are not an installed
Design System recovery result.

## Targeted test history and exact evidence locations

The local acceptance archive is:

`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`

The upgrade focused runs below have **no standalone filesystem log**. Their
evidence is the retained tool history, identified here rather than assigning
an invented log filename. None was rerun just to manufacture a log.

| Run | Recorded scope and outcome | Exact available evidence |
| --- | --- | --- |
| Initial upgrade author run | Existing dispatch 16 passed; all 11 initial upgrade cases failed during fixture initialization because `.codex-plugin` had not been created before `atomicJson`. Migration code was not reached: **16/27**, not green. | `/root/export_save_backend` tool-history `exec_command` output chunk `fab3be` |
| After the fixture directory correction | Initial migration scope **11/11 passed**, before custom-marketplace and idle-parent-handoff additions. | Same agent, process session `79736`; initial chunk `98b135`, completed chunk `ae9883` |
| Final upgrade author run | **29/29 passed** in **50,175.626 ms**: the unchanged sixteen dispatch cases plus thirteen upgrade cases. | Same agent, process session `89242`; initial chunk `adcea2`, completed chunk `5aeddb` |
| Independent upgrade review | **13/13 upgrade cases passed** in about **51.37 s**; no whole-suite rerun. | `/root/remaining_acceptance_audit` tool-history process session `68984`, completion and approval reported to the root operator |
| Refused-service recovery author | **59/59 targeted related tests passed**, including 28 new recovery cases. | Author's retained tool history; no separate focused-log path was supplied in this documentation handoff |
| Independent refused-service review | **28/28 recovery cases passed**; distinct from the author's related-test batch. | Reviewer's retained tool history; no separate focused-log path was supplied in this documentation handoff |

The earlier whole-package **435/435 tests with 182 owned files** and then
**464/464 tests with 184 owned files** remain historical candidate results.
Their existing archive logs are named in
[ACCEPTANCE-0.5.2.md](../ACCEPTANCE-0.5.2.md). The combined upgrade/recovery
build log is `codex-design-0.5.2-upgrade-recovery-build.txt`. Final combined
whole-suite, consistency and relocation outcomes await the root operator;
no combined total is inferred from targeted counts here.

## Actual idle QA cleanup and remaining host acceptance

The root operator used the installed 0.5.1 `stopWorker(root,
{onlyWhenIdle:true})` after observing zero pending and zero active jobs. This
was independent of the prepared second request. The waiting listener closed
normally with `listener-paused-or-replaced`; the actual child
`01a199c8-d2c6-7dc3-986c-16e080e86dd8` finished its turn and was verified idle.
Its single completed job was retained. Canvas/component and `comments.json`
hashes were unchanged. Cleanup did not send the draft or invoke its request
read/accept/dispatch flow. Evidence is
`codex-design-0.5.1-idle-qa-cleanup.json` in the local archive.

Waiting for the operator's Send is a boundary for processing that request,
not a user-approval prerequisite for installing an otherwise authorized
revision. The second request remains unsent and is not a completed reuse test.
The 0.5.2 package is not yet promoted to the configured GitHub marketplace ref
or installed. Published 0.5.1 bytes remain unchanged.

After a real upgrade, verify the following in the consuming Codex runtime:

1. The native draft text and resource attachment remain visible. The previous
   Add acknowledgement or one earlier successful restart does not guarantee
   retention across every later upgrade.
2. Harmless current-session MCP reads identify and use 0.5.2 after the necessary
   normal reconnection/restart. They do not accept the unsent request.
3. Active Rename followed by editing, saving and reopening retains the new
   title/content; new blank boards satisfy the original checker after text and
   size edits.
4. The old refused Design System data service recovers through the guarded
   runtime path without rebinding its native parent or losing content.
5. Request reads derive the current installed CLI/skill path. An independently
   received and accepted request can migrate the idle binding, then reuse or
   resume the selected real child with its own receipt and canonical reply.

Installed 0.5.1 native exports are separate evidence. The PNG was fully decoded
and visually inspected. The exported HTML received static parsing and
compile-only JavaScript syntax checks. Browser policy explicitly denied its
`file://` navigation; no HTTP/data/other-browser alternative was used to reopen
the same blocked content. HTML visual and interactive acceptance remains
pending. None of these export results is an installed 0.5.2 repair pass.
