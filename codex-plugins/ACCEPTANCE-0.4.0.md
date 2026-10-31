# Codex Design 0.4.0 acceptance record

Recorded on 2026-11-01. This records local checks, isolated browser acceptance,
and real native-worker execution. **The final 0.4.0 GitHub installation and
visual acceptance inside Codex Desktop are still pending.** A browser sandbox
must not be described as the actual Codex host.

This is a checkpoint report. Comment reopen has its own status row below;
persisted resolution must not be treated as acceptance of the reopen UI.

## Evidence boundaries

| Layer | Recorded result | Authority and limit |
| --- | --- | --- |
| Latest frozen full local suite | **194/194 passed**, zero failures, cancellations, or skipped tests | Automated checks for the frozen snapshot; this run predates the final two display-label edits |
| Final display-label regression | **50/50 passed**, zero failures, cancellations, or skipped tests | Localization, annotations, four real comment components and editor-document checks after the last two label changes; final build/check/portable also passed |
| Generated package | **179 owned files**; build ownership/check and portable relocation verification passed | Package completeness and portable execution at that checkpoint; does not establish Desktop rendering |
| Isolated browser workspace | Four real editors, local artwork files, native-style scoped transport, and captured output exercised | Browser/component acceptance; the bridge and host fixture are controlled test infrastructure |
| Native worker | The same real platform-spawned child completed two comment jobs | Actual native-agent execution; does not establish the installed 0.4.0 app's sidebar or composer behavior |
| Installed Codex Desktop 0.4.0 | **Pending** | Requires the final GitHub-installed package and the real consuming-app surface |

The local release checks use the repository scripts:

```powershell
npm run build:codex-plugin
npm run check:codex-plugin
npm run test:codex-plugin
npm run verify:codex-plugin-portable
```

Build and verification run locally. No GitHub workflow is required or used for
this release process. Installed-version hashes, temporary-probe discovery, and
older release results must not be carried forward as 0.4.0 host acceptance.

The 194-test run does not automatically cover later text-only corrections to
the visible `No open comments` and `Resolved` labels. Their targeted regression
status is tracked separately below; the frozen full-suite log remains unchanged.

## Browser and persistence acceptance

The sandbox uses real editable copies of the four example formats and the real
library/service implementation. It exercises the self-contained editor path
without an HTTP loopback iframe dependency. Its opaque shell and inner editor
retain the MCP-parent isolation boundary; the observed guard markers reported
blocked parent access and a null serialized editor origin. These observations
are sandbox evidence, not a claim about an untested Desktop policy.

| Case | Result | Recorded observation |
| --- | --- | --- |
| Slides | Passed in sandbox | Existing five-slide content and assets rendered; saved text remained after reopening |
| Design canvas | Passed in sandbox | Two existing artboards rendered, including the real 1200 × 1200 coffee-bean image; rendered asset data was kept separate from persisted artwork references |
| Design system | Passed in sandbox | Tokens, README and component previews loaded; a real React weather component changed **18 °C to 64 °F** through keyboard interaction |
| Dashboard | Passed in sandbox | Existing KPI values, charts, sources and the 365-row dataset rendered |
| Four blank artwork types | Passed in sandbox | Slides, Design, Design System and Dashboard were each created through the UI and actually loaded in their editors; the Chinese canvas empty state was also inspected |
| Chinese/English UI workflow | Passed in sandbox; final label regression separate | Library/editor controls, menus and dialogs changed language; authored Chinese text and artwork names remained unchanged; the later two-label correction is tracked below |
| Host-style contract | Passed with source-derived fixture values | Host font variables were consumed; `--color-background-ghost: transparent` did not erase selected-state backgrounds |
| Save before navigation | Passed in sandbox | Editing followed by an immediate tab switch retained the changed bytes on disk; reopening recovered the saved content |
| Artwork identity and tabs | Passed in sandbox | Reopening reused the artwork identity/tab; library and artwork tabs survived workspace reload |
| Content export/import | Passed in sandbox | A content-only export was imported as a **new UUID**; source artwork identity and conversation/job state were not reused |
| Windows trash/restore | Passed in sandbox | An imported work was opened in its editor, moved to Trash, and restored with the same UUID and content after the owned idle-editor lifecycle fix |
| Content recovery points | Passed | Restoring artwork content preserved existing comments and durable worker-job records |

Portable artwork bundles contain native content and necessary assets. They do
not contain chat history, comments, worker jobs, bindings, process records,
session tokens, or local runtime state. Import creates a separate artwork;
restore operates on the existing artwork.

Opaque editor origins do not provide ordinary localStorage access. Artwork
files and library tabs were retained, but this run does not establish that all
original editor tool/view preferences survive reopening. That preference
persistence remains a limitation rather than an implicit pass.

## Comments and native-worker acceptance

Two explicit comment tasks were handled by the **same real native child**.
The first task changed the requested design token and replied to the comment.
Closing the artwork tab did not stop the accepted task. A second task reused
that child, restored the original token, and posted its reply. The execution
record distinguishes accepted, active, completed and replied states; queue
acceptance alone was not counted as completion.

This verifies worker reuse for those two tasks. It does not prove automatic
worker recovery after a Desktop restart or a native conversation binding for
every artwork tab. The parent remains responsible for deciding whether to
reuse, resume, or create a native child.

| Comment operation | Status at this checkpoint | Evidence boundary |
| --- | --- | --- |
| Save comment and explicitly Send to agent | Passed | Durable task/comment state plus actual native-child execution |
| Reply and reuse the same native child | Passed | Two completed tasks, two replies, and restoration of the original token |
| Continue after artwork-tab closure | Passed | Accepted native work completed after the tab was closed |
| Preserve comments/jobs during content restore | Passed | Existing comment and job records remained after recovery-point restoration |
| Resolve | Passed on disk | The persisted resolved state was read back |
| Reopen from the editor UI | **Passed in sandbox and on disk** | Actual keyboard navigation through the same lower-right floating control reopened comment `c_6bfc6ce967`; the same ID retained four messages, disk status became `open`, and the Resolve button reappeared |

The verified reopen path was: **批注选项 → 全部批注 → 筛选：显示已解决 →
更多选项 → 重新打开**, starting from the existing lower-right floating control.
The retained screenshot was inspected for the correct control position. This
closes the sandbox reopen-entry gap; actual installed-host comment acceptance
remains a separate gate.

## Export acceptance

| Output | Verified result | Limit |
| --- | --- | --- |
| PDF | **935,879 bytes**, five pages, page dimensions **960 × 540** in PDF page coordinates | The exported PDF was rendered and visually inspected |
| PowerPoint | **34,247 bytes**, five slide XML parts, ZIP CRC validation passed, **76 `a:t` text elements**, Chinese Unicode codepoints checked | File structure/text integrity was checked; this is not a native PowerPoint visual-open result |
| Ordinary HTTP PDF download | Actual download succeeded from the loopback fixture on port **6092** and was saved in the operator's Downloads directory | A direct HTTP browser download does not establish Codex Desktop's native download flow |

The isolated host's download capture validates the produced bytes and transport
path. The final installed Codex host's download/save interaction remains part of
native acceptance.

## Earlier failures remain part of the record

The final passing checks do not overwrite these earlier observations:

- The former native localhost iframe approach failed under the Codex host's
  HTTP frame-domain policy. The implementation now uses a self-contained,
  scoped editor transport. Its final actual-host visual retest is still pending.
- Earlier parent-created Blob, full data-URL and self-Blob navigation variants
  failed to start in the browser fixture. The final sandbox uses a small opaque
  data-origin shell with a normal inner srcdoc editor. Failed captures remain
  failed captures.
- Translating a conditional icon identifier changed `Comment` into display
  text and caused `String.fromCodePoint` failures. Localization was narrowed to
  UI labels, with identifier-preservation regression coverage.
- Opaque-context UUID/digest availability and dynamic asset rebasing caused
  real runtime failures and missing images. The final sandbox checks were
  performed after the scoped runtime/asset fixes; the earlier blank or broken
  previews are not treated as successful renderings.
- Design-system previews initially fell back to a static cover because their
  React runtime was unavailable. The later React interaction above is a
  separate successful run after the trusted packaged-runtime fix.
- PDF selection failed in both the ordinary HTTP and native-style paths at the
  sheet dialog's React context hook. Source comparison showed the relevant
  canonical hook and initializer were unchanged by localization; it did not
  establish a complete raw-canonical UI export pass. The generated/native
  adapters now initialize the existing sheet measurement dependency before the
  dialog hook. The later PDF download, byte checks and rendered pages are new
  evidence after that correction.
- Windows moving an artwork with an opened editor initially returned `EBUSY`.
  The later trash/restore result followed the verified owned-idle-editor stop
  fix. Unrelated file locks can still produce a busy error; it is presented as
  file use, not incorrectly as a permissions problem.
- Hiding the native comment toolbar exposed a reopen-entry reachability gap in
  the floating control. Its canonical split entry and list filter were later
  repaired and separately verified through the path above. The earlier failure
  remains part of the record; disk resolution alone did not close it.

Earlier full logs containing 155/155, 174/174 and 189/189 passing tests describe
their own source snapshots. They did not prove that subsequent UI paths worked.
The latest frozen 194/194 run is recorded separately and must not be extended
to the later two-label edits without their own regression result.

## Retained evidence inventory

Evidence files are held in the operator's local acceptance archive, outside the
distributed plugin. The following basenames identify them; no maintainer-specific
absolute paths are embedded in this document or the published package.

| Evidence basename | Purpose |
| --- | --- |
| `codex-design-0.4-tests-initial.txt` | Earlier 155-test run |
| `codex-design-0.4-tests-final.txt` | Earlier 174-test run |
| `codex-design-0.4-tests-after-runtime-fixes.txt` | Earlier 189-test run, preserved |
| `codex-design-0.4-tests-release-frozen.txt` | Latest frozen 194-test run, before the final two display-label edits |
| `codex-design-0.4-tests-final-copy.txt` | Final related 50-test run after the two label edits |
| `codex-design-0.4-library-final-qa.jpg` | Library layout/type-column browser evidence |
| `codex-design-0.4-canvas-native-sandbox.jpg` | Actual artboard/image rendering in the isolated sandbox |
| `codex-design-0.4-slides-native-sandbox.jpg` | Reopened saved slide content in the sandbox |
| `codex-design-0.4-english-interface-qa.jpg` | UI-language/content separation; captured at its recorded runtime stage |
| `codex-design-0.4-ds-react-keyboard-verified.jpg` | Real design-system component keyboard interaction |
| `codex-design-0.4-native-worker-comment-proof.jpg` | Native-worker/comment execution evidence |
| `codex-design-0.4-comment-reopen-verified.jpg` | Actual keyboard reopen path in the same lower-right floating control |
| `codex-design-0.4-comment-empty-zh-final.jpg` | Final Chinese empty-list wording in the same floating control |
| `codex-design-0.4-blank-slides-created.jpg` | Blank Slides created and loaded through the UI |
| `codex-design-0.4-blank-design-created.jpg` | Blank Design created and loaded; Chinese empty state inspected |
| `codex-design-0.4-blank-system-created.jpg` | Blank Design System created and loaded through the UI |
| `codex-design-0.4-blank-dashboard-created.jpg` | Blank Dashboard created and loaded through the UI |
| `codex-design-pdf-baseline-failure-before-fix.jpg` | Retained pre-fix PDF failure |
| `slides-pdf-hook-evidence-20261101.json` | Bounded source comparison and the PDF dependency correction |
| `codex-design-0.4-export-pdf-page1.png` | Rendered exported PDF page inspected for layout |
| `codex-design-0.4-ordinary-pdf-fixed.jpg` | Later successful ordinary HTTP PDF flow |

An artifact name containing “native” identifies the path under test; it does
not upgrade a sandbox screenshot into installed-Codex visual evidence. Images
from earlier stages retain their original state and must be captioned accordingly.

## Remaining native-host gates and API gaps

Follow [NATIVE-TESTING.md](NATIVE-TESTING.md) for the final GitHub installation,
installed-file/hash check, actual SDK initialization, native global/file
entrypoints, real visuals, styles, comments and downloads. Also see
[IMPLEMENTATION.md](IMPLEMENTATION.md) for scope and ownership.

| Requirement | Current status |
| --- | --- |
| Final GitHub marketplace installation of 0.4.0 | **Pending** |
| Actual Codex Desktop 0.4.0 visual/interaction acceptance | **Pending** |
| Final `No open comments` / `Resolved` display-label regression | **50/50 related checks passed**; Chinese empty-list text was also observed in the running sandbox, independently of the earlier 194-test run |
| Replace the host-wide middle sidebar with app categories | **No current public API; not implemented** |
| Remove/replace the host-created workspace top toolbar | **No current public API; not implemented** |
| Bind one independent native chat/composer to each internal artwork tab | **No current public API; not implemented** |

The app's collapsible category pane is internal navigation. It must not be
reported as replacing Codex's shared middle sidebar. A shared global composer
must not be reported as one bound editing conversation per artwork. Do not
label this checkpoint fully native-verified, feature-complete, or a finished
Space-equivalent integration while these rows remain open.
