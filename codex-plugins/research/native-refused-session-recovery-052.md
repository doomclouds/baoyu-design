# Native refused-session recovery for 0.5.2

This note records the bounded recovery change and its evidence. The real affected artwork was inspected read-only and was **not recovered, opened, stopped, or modified** by this task. Release build and full-suite validation belong to the root task.

## Observed persisted-library failure

The existing global Design System artwork was:

```text
C:\Users\10062\.codex\CodexDesignLibrary\design-system\2c477b07-cf80-4407-95d4-cbed6f048b44
```

Its `.artifact-server.json` recorded PID `49932`. Read-only process metadata showed that this PID instead belonged to the Design artwork:

```text
C:\Users\10062\.codex\CodexDesignLibrary\design\231ffe84-28c7-4ffd-a71c-8d665b236941
```

One invocation of the **installed 0.5.1** exported `verifyEditorInstance` function issued only a GET to the already-recorded loopback identity endpoint. At `2026-11-02T04:08:15.433Z`, it returned `EDITOR_IDENTITY_UNVERIFIED`; the underlying transport failure was `ECONNREFUSED`. No HTTP response/status or live identity body was received. The state file's SHA-256 before and after was identical:

```text
e898c4b924b23cad9ef3c74faece8bd42b2e72057c44a41722259fe3d33a0041
```

The sanitized, existing probe report is:

```text
C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee\installed051-ds-identity-probe-2026-11-02T04-08-15-433Z.json
```

Separate read-only eligibility checks found a version-1 legacy bridge with `deliveryMode: native`, matching artwork root/PID, a UUID-shaped token, and skill leaf `codex-design-system`. No worker registry or active/pending journal entry was observed. These checks did not authorize or perform a production recovery. No grant URL or token value is included here.

## Recovery and ownership boundaries

- Automatic recovery applies only to the original internal `open-service` entrypoint. Explicit `preview`, custom-hook, `main`, missing-source, and foreground service cases retain their original identity failure instead of silently losing a hook.
- The recorded root/kind must match the requested artwork. The identity URL must be strict loopback HTTP without credentials, query, or fragment. Only a connection-establishment failure with exact `ECONNREFUSED` leaves receives the safe recovery reason. An aggregate qualifies only when every leaf is refused. Timeout, reset, DNS failure, HTTP errors, invalid JSON, and a responding identity mismatch do not qualify.
- `openLocalEditor` does not modify the record. It delegates to the existing CLI startup owner, which holds the **binding startup lock** across revalidation, archival, raw startup, and verification of the replacement session.
- A short nested **worker lock** covers the fresh refused probe, ownership/queue checks, final state/binding byte-and-stat comparisons, and archive rename. It is released before raw service startup. It does not claim to exclude a newly submitted job throughout startup.
- Active/pending jobs, including orphan journal entries, active/working registry state, an active job reference, legacy process fields, and unverifiable ownership block recovery. An idle native listener is left unchanged.
- Artwork/control directories, control files, and lock owners are checked for symlinks or hard-link aliases. The original state is atomically renamed to a unique local `.artifact-server.refused-*.json` backup, then its bytes and file identity are checked again. The dotfile is runtime evidence, not exported artwork content.
- The binding lock serializes cooperative CLI startup writers, including independent native/no-agent CLI processes. Node does not provide an arbitrary external-writer compare-and-rename transaction. An unexpected archived object causes failure without spawning or automatically restoring over another record; its evidence is preserved.
- No old PID is signaled, killed, or stopped. The original short-lived `artifact.mjs open` is called directly rather than recursively acquiring the wrapper lock. Foreground `serve` does not gain a lock held for its entire lifetime.
- Only after verifying the replacement's real identity and rechecking the legacy bridge does the change update its data-runtime fields `serverPid` and `skillDir`. Existing token, thread ID, root, delivery mode, and other legacy metadata are preserved. Native-binding, comments, job state, and idle registry bytes remain unchanged.

Native Add to chat does not depend on reinstalling the old generated hook: `source/server/native-comments.mjs` intercepts `__comments/<id>/send` to prepare the immutable draft. New/replied comments carrying `send: true` are forwarded to the canonical data service with `send: false` before draft preparation. This is distinct from standalone preview delivery, which is excluded from automatic recovery.

## Failure and Retry boundary

A genuine raw startup failure preserves its specific stderr/exit result, the archived record, and the old identity. It is **not** reported as a successful recovery.

If startup leaves no state or a new dead-PID state, a canonical refused backup matching the original native bridge's PID/root/kind prevents the next Retry from falling into ordinary fresh-binding behavior. The backup is used only to deny a fresh rebind; it does not authorize automatic replay or restoration. Retry does not silently change the old token/thread or spawn the raw service again. Such startup failures require diagnosis; this change does **not** make every Retry automatically succeed.

The existing behavior for a normal dead-PID record without matching refused-recovery evidence remains unchanged.

## Validation evidence

All runtime fixtures were isolated temporary artworks/services. Their services and unrelated helper processes were cleaned up. No production or existing QA artwork/service/UI was changed. No build, full-suite run, installation, publication, or commit was performed by the author of this change.

| Run | Result | Evidence location |
| --- | --- | --- |
| First new recovery run | **17/18 passed, 1 failed.** The fixture expected comment creation HTTP 200; the real canonical endpoint returned HTTP 201. This failure is retained, not relabeled as a passing run. | Conversation tool history, output chunk `d5140b`. No independent local log file was written. |
| Corrected intermediate recovery run | 19/19 passed, after correcting only that fixture expectation and adding a rename-race case. | Conversation tool history, output chunk `0e68be`. No independent local log file was written. |
| Final author targeted run | **28/28 passed.** Includes real closed-port/live-unrelated-PID recovery, independent competing CLI processes, strict negative cases, idle listener, alias/CAS races, and missing/dead-state failed-start Retry. | Conversation tool history, exec session `63447`, output chunks `c91605` and `06d2b4`. No independent local log file was written. |
| Final author related combined run | **59/59 passed.** New targeted file plus existing comment bridge, artifact delivery, and trash lifecycle tests. Syntax checks and scoped `git diff --check` also passed. | Conversation tool history, exec session `27836`, output chunks `0690af` and `2d3328`. No independent local log file was written. |
| Independent final review | **APPROVE**, independent targeted **28/28 passed**; reviewer reported clean diff/fixture checks and completed cleanup. | Reviewer tool history/session `3023` and its final review message. No independent local raw log path was supplied. |

Final author targeted command:

```powershell
node --test codex-plugins/tests/editor-refused-recovery.test.mjs
```

Final author related combined command:

```powershell
node --test codex-plugins/tests/editor-refused-recovery.test.mjs codex-plugins/tests/comment-bridge.test.mjs codex-plugins/tests/artifact-delivery.test.mjs codex-plugins/tests/editor-trash-lifecycle.test.mjs
```

The identity-probe JSON above is the exact existing filesystem report path. Test pass/failure outputs were retained in tool history only; this note is not a substitute raw test log. Tests were not rerun to manufacture log files during documentation.
