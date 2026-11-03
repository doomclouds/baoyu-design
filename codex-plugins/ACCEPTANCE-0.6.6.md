# Codex Design 0.6.6 — shared library selection

Recorded on 2026-11-03. Implements the approved Image Gen proposal for Library
multi-selection and compact Trash actions. Final publication and installed-host
checks are pending at this source cutoff. No GitHub workflow is used.

## Behavior

- Library and Trash share independent row/card checkboxes and a visible-results
  select-all control, including a real native indeterminate state.
- Selected rows receive a subtle theme-derived tint. The contextual top toolbar
  offers Clear selection plus Move to trash, or Restore / Delete selected in
  Trash. It is absent at zero selection; it does not overlap the native composer.
- Trash row actions are one horizontal Restore button and a muted icon-only
  permanent-delete button with tooltip and a complete accessible name. The
  latter uses the existing titled confirmation and cancellation flow.
- Batch Move/Restore reuses existing single-artwork APIs serially. IDs are
  frozen, successful items leave selection, and failures remain with reasons.
  Search/category/favorites changes clear selection; layout changes retain
  visible IDs. Ambiguous responses are read back before any retry, including
  after Clear selection and reselect.
- Only an active target editor is saved before trashing. The backend already
  closes its persistent Tab, so the UI reconciles the final validated view and
  does not issue a second close/save. Late replies cannot affect replacement
  dialogs. Disposal stops later operations, including subsequent purge batches.

## Verification

- Build: 191 owned files; portable 0.6.6 generic-node/Unicode-space path check
  passed with six tools, two resources and no node_modules requirement.
- Initial focused run: 60/67. Five failures were fixture/expectation boundaries
  (real checkbox selection and failure-detail location); two exposed the old
  single-trash duplicate-close behavior. The latter was fixed in production.
- Second focused run: 69/69, zero failures/skips/cancellations, 532.6157 ms.
  Subsequent independent review identified additional disposal/view/dialog
  edges, which were fixed and reviewed before the final run.
- Final focused run: **73/73**, zero failures/skips/cancellations, 586.8855 ms.
  It exercises disposal during preflight/save, malformed view identity,
  late single-trash completion versus a replacement dialog, and disposal
  between 200-ID purge batches. The final independent review approved the
  production changes without remaining must-fix findings.
- Final complete frozen-source regression: **686/686**, zero failures/skips/
  cancellations; concurrency 4, 80357.8364 ms, exit 0. Focused suite counts
  overlap and must not be added to this total. Build consistency and portable
  verification passed for the same package inputs.
- Isolated controller checks preserve permanent-delete confirmation, partial
  failure reporting, and 200-ID request batches. Real UI verification must
  distinguish confirmation/cancel checks from executing permanent deletion.

## Evidence

Approved visual target:
`C:\Users\10062\.codex\generated_images\01a1919d-3e78-7e13-b718-4f75fc8d59ee\exec-2626c782-25bf-425f-af52-37edfb4eca6e.png`.

Local evidence archive (not distributable configuration):
`C:\Users\10062\.codex\visualizations\2026\10\31\01a1919d-3e78-7e13-b718-4f75fc8d59ee`.

Raw records include `codex-design-bulk-selection-ui-attempt1.txt`,
`codex-design-bulk-selection-ui-attempt2.txt`, the final focused/full logs,
build/consistency/portable records, and `codex-design-0.6.6-bulk-fixtures.json`.
Only the six explicitly recorded QA artworks may be used for native mutation
tests; unrelated user content remains outside the test selection.
