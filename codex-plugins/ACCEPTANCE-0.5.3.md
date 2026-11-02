# Codex Design 0.5.3 candidate — acceptance draft

Status recorded on **2026-11-02**. This is a candidate record, not a published or
installed-host acceptance claim. The root task will append subsequent complete
test and native operator results. Earlier failures remain evidence.

## Revision scope

1. **Empty older managed cache directory.** Native request migration accepts
   an older directory with zero files, including an otherwise empty directory
   tree, only after verifying the current executing package and the same
   canonical managed cache family/version relationship. It does not delete or
   reconstruct that old cache. Complete older packages retain their existing
   verified-package migration path. File remnants, corrupt packages, symlinks or
   junctions, unrelated families and invalid versions remain refused. Existing
   receipt, idle ownership and native-parent rules continue to apply.
2. **Actual Canvas Resize metadata.** The generated-preview helper now accepts
   the real live `artboards` array as well as the disk v3 `boards` map. The
   existing metadata writer, KV adapter, local document owner and publisher
   carry matching generated component/index changes without an HTTP-body
   repair. Invalid/duplicate layouts are not used to synchronize previews. Only
   an exact same-file generated marker and unchanged generated logic authorize
   a preview update;
   copied, authored and custom logic remain outside that ownership. Ordinary
   typing with an unchanged index keeps the existing cache fast path. The
   original checker is not relaxed.

For small tested payloads, the real publisher sends the component and index in
the same batch. This does not assert an all-or-nothing filesystem transaction
for every payload size or a different server protocol.

## Actual 0.5.2 baseline: successes and retained failures

0.5.2 was installed and its runtime/package identity was checked. The later
second request was received in an actual native parent message, read/accepted,
eventually dispatched to the existing child, edited and replied to once. Its
structural check passed. **This happened only after manually restoring the
authentic 0.5.1 cache**: two dispatch attempts against the empty old cache had
failed first. It is not evidence that 0.5.2 automatically migrated that cache
state, nor a visual rendering or native-child-turn-completion claim.

The retained local operator report is:

```text
C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee\codex-design-0.5.2-native-operator-result.json
```

In the self-created native 0.5.2 Canvas QA, Rename, adding a blank board and text
editing saved and initially checked cleanly. A real Properties Resize to
`900 × 620` then persisted the new index dimensions but left the owned
`Artboard-9z68.dc.html` preview at `800 × 600`; the original checker returned
one problem. The marker, filename and empty `renderVals` logic still matched
the generated contract. That actual failure exposed the live legacy metadata
shape missed by the earlier v3-only fixture.

A separate self-created 0.5.2 QA request completed its actual native Send,
parent/child work, checker 0 and exact `Upgrade QA first passed.` reply; its
later idle cleanup and completed idle child turn were observed. This separate
operator case does not erase the empty-cache or Resize failures above.

The older production Design System was also reopened and rendered natively,
with a correct HTTP-200 session at PID 52392 and 44 project-file hashes
unchanged across that observation. Since the old PID 49932 had already exited
and no strict-refused replacement was exercised, that is an ordinary dead-PID
fresh start, **not** an installed-host pass for refused-state recovery. The
local evidence is `codex-design-0.5.2-old-ds-reopen.json` and
`codex-design-0.5.2-old-ds-native.png` in the same archive.

The dated correction in [ACCEPTANCE-0.5.2.md](ACCEPTANCE-0.5.2.md) distinguishes
these later facts from the earlier never-installed/unsent-draft observations.

## Targeted evidence

| Scope | Author result | Independent result | Limit |
| --- | --- | --- | --- |
| Managed-cache migration | 19/19 related tests | 6/6 new migration cases, approved | Isolated migration fixtures; no 0.5.3 installed-host upgrade claim. |
| Generated Canvas previews | 17/17 targeted tests | 17/17, approved; syntax/diff checks passed | Actual compiled metadata/KV/document/publisher functions with a temporary filesystem port and the unchanged checker; no real 0.5.3 UI was operated. |

The Resize tests execute the actual metadata arrow, serializer, KV adapter,
complete files document and publisher. They retain the real live `artboards`
shape, check a text edit before Resize, verify the same small publish batch,
and cover mutable A-to-B-to-A payloads and two stores sharing one runtime.
Invalid layouts, unchanged-index typing, failed computations, custom content,
copies and ordinary standalone behavior retain their guards.

An early new Resize-chain fixture failed the unchanged checker because its
initial index omitted `launch.view`. The fixture was corrected to use the
proper blank initial launch metadata. That failed run is retained as fixture
history; it is not relabeled as a passing run or a product checker change.

These targeted counts are separate scopes and must not be summed into a
whole-package or installed-host count.

## Complete candidate checks: first attempt is not green

The recorded build, generated-consistency and portable-relocation commands
returned exit code 0. The first complete test run returned exit code 1:
**513 passed out of 514, one failed**, in approximately **81.68 seconds**.

The failure was `EBUSY` while removing a temporary Design System directory in
the editor-trash lifecycle fixture. Its cause is **not established**. No
successful whole-suite result, product fix for this failure, or completed
release gate is claimed here. Later investigation/runs belong in a dated
addendum and must preserve this first result.

The exact existing local files are in:

```text
C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee
```

- `codex-design-053-final-build-20261102T070051612Z.txt` and `.json`
- `codex-design-053-final-consistency-20261102T070051612Z.txt` and `.json`
- `codex-design-053-final-portable-20261102T070051612Z.txt` and `.json`
- `codex-design-053-final-tests-20261102T070051612Z.txt` and `.json`

The `.json` files contain command, exit-code, elapsed-time and raw-log metadata.
The documentation task read these existing records; it did not rerun tests to
create new evidence.

## Pending consuming-host gates

### Final complete test decision, 2026-11-02

The lifecycle fixture now records named stages, preserves the original failure
alongside stop/remove failures, and retains temporary diagnostics when it fails.
Its assertions, timeout, production guards and test concurrency were unchanged;
no retry or skip was added. Independent review approved this test-only change.
The isolated fixture passed **3/3**. This does not determine the cause of the
earlier EBUSY result.

The subsequent single full run passed **514/514**, with zero failures, skips or
cancellations, in **70,942.86 ms**. Its raw log is
`codex-design-053-final-tests-recheck-20261102T071357206Z.txt` in the same archive.
The earlier **513/514** log remains unchanged. The generated package still has
**184 owned files**; build, consistency and portable relocation passed. Portable
verification used generic `node`, Unicode/space paths, no node_modules, six tools
and two resources including `ui://codex-design/0.5.3/library`.

The root accepted these checks for publishing the two scoped fixes. Native
installation and the consuming-host scenarios below remain separate gates.

- Install the exact final 0.5.3 candidate from the intended GitHub marketplace
  ref and confirm the consuming runtime/package identity after any required
  normal reconnect/restart. This draft author performed no installation.
- Exercise an actually sent native request across a validated zero-file old
  cache directory without manual restoration; verify its own receipt,
  dispatch and canonical completion.
- In a self-created 0.5.3 native Canvas, create and edit an owned blank board,
  resize it through real Properties, save/reopen, and compare index dimensions
  with component preview metadata using the unchanged checker.

All of these final 0.5.3 consuming-host decisions remain **pending** in this
draft. The record covers the two revision fixes and their stated evidence
scopes.
