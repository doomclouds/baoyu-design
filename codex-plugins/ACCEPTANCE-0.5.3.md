# Codex Design 0.5.3 — release acceptance

Status recorded on **2026-11-02**. The scoped revision is published on
`codex/plugin` at `d1f8ba98f83378f75d4ebdb0e626d9a7b075f0f4` and installed/enabled
from the configured GitHub marketplace. The checks and native results below
close its two repair gates. Earlier failures remain evidence; this is not a
claim that every editor action or export format was exercised natively.

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

## Complete-suite decision

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

The root accepted these checks for publishing the two scoped fixes. The
consuming-host results are recorded separately below.

## GitHub installation and live host

The actual Desktop CLI refreshed the existing Git marketplace without a GitHub
workflow or a second temporary marketplace. The release tree, Git snapshot and
installed `0.5.3` cache matched all **185 files**, including the 184 owned files
and generated manifest, with no missing, extra, different or linked entries.
The actual Desktop verifier discovered five enabled skills, six MCP tools,
the global entrypoint and `ui://codex-design/0.5.3/library`, with no diagnostics.

The long-lived window initially retained old 0.5.2 MCP connections. The root
used the host's normal plugin enable switch to turn only Codex Design off and
back on. New MCP processes used the installed 0.5.3 entrypoint under the same
Desktop app-server PID. The current chat then called `design_read(view.get)`
successfully. **Codex was not restarted.** A redundant reinstall was not used.

Evidence: `codex-design-0.5.3-installed-hashes.json`,
`codex-design-0.5.3-installed-runtime.txt`,
`codex-design-0.5.3-live-install.json` and
`codex-design-0.5.3-marketplace-upgrade-no-proxy.txt` in the local archive.

## Actual Canvas Resize and reopen

The self-created QA artwork retained its original UUID and generated component.
In installed 0.5.3, the root changed Width and Height through real Properties
from `800 × 600` to `900 × 620`. Disk `boards` and that component's owned
`$preview` both became `900 × 620`; the unchanged checker returned **0 problems**.
The root closed its artwork Tab, then reopened it from Recent. The resized
board and prior text were visible in the new Tab. This used normal UI saving;
no project HTML, index or runtime-control file was hand-repaired.

Evidence: `codex-design-0.5.3-native-resize.png` and
`codex-design-0.5.3-native-resize-check.json`. The second request's independent
before-edit snapshot also retained these matching dimensions.

## Actual empty-cache migration and child reuse

The updater naturally left the old 0.5.2 cache as a canonical ordinary empty
directory. Before the second request, independent inspection recorded zero
entries, the directory identity, the old skill binding, a paused idle worker
and its real native child. No cache was deleted or restored for this test.

Using the original comment's Reply and Add to chat, the root prepared request
`ca0160ab-5993-41cc-b352-1f18f13021b2` and clicked the actual native Send button.
The real parent read and accepted that exact request and ran its own 0.5.3
dispatch command. Migration succeeded automatically with
`previousBytesVerified:false`, the same binding-token digest and the same
child `01a19b11-98ca-7dd3-a953-164b2b21effa` and registration ID.

The child changed only `Native upgrade verified` to `Native upgrade final`,
retained the `900 × 620` dimensions/layout, ran the original check with exit 0
and zero problems, and completed its separate job and restore point. The
canonical original comment received **`Upgrade QA second passed.` exactly
once**, alongside the single first reply. The old cache remained the same empty
directory; no manual restoration or model process replaced this lifecycle.

After zero active/pending jobs were confirmed, public idle-only cleanup paused
the QA listener without changing the canvas, component or comments. Independent
first-party inspection then confirmed the listener returned
`closed:true / listener-paused-or-replaced`, its turn completed normally, and
the real child was idle. No native interruption was used.

Evidence: `codex-design-0.5.3-upgrade-qa-before-second-request.json`,
`codex-design-0.5.3-upgrade-qa-second-native-result.json`,
`codex-design-0.5.3-upgrade-qa-idle-cleanup.json`,
`codex-design-0.5.3-native-second-result.png` and
`codex-design-0.5.3-native-second-comment.png`.

## Coverage limits and accepted follow-ups

These checks close the two revision repairs and installation gates. They do
not turn the old Design System's ordinary dead-PID startup into a strict-refused
recovery pass. The earlier request and export reports remain scoped evidence:
Slides PDF/PNG and both observed PPTX variants, content-package import/export,
and the additional actual Canvas PNG Save As/decode/visual check passed.
HTML export has static validation only because browser policy refused local
file navigation. Individual Design System file exports, data-backed Dashboard
CSV, every non-comment AI entry and custom-font embedding were not all exercised
natively in this revision.

The public host API still does not provide a shared middle-sidebar slot or an
expanded floating composer's exact rectangle. The compact native comment safe
area therefore does not guarantee avoidance of every expanded composer; the
operator temporarily narrowed and then restored the native chat width during
this long reply test. The accepted host top-bar behavior and deferred
cross-window exclusive editor ownership remain unchanged. No independent window,
host patch, private IPC or artificial browser Tab was introduced.
