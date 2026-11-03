# Codex Design 0.6.6 visual QA

Date: 2026-11-03.

Final result: **passed** for the requested dark desktop Library multi-select
and compact Trash actions. No actionable P0/P1/P2 visual findings remain.

## Target and evidence

Approved visual: `exec-2626c782-25bf-425f-af52-37edfb4eca6e.png` under
`~/.codex/generated_images/01a1919d-3e78-7e13-b718-4f75fc8d59ee/`.
It shows two stacked interaction states, not two alternative designs.

Actual installed 0.6.6 captures under
`~/.codex/visualizations/2026/10/31/01a1919d-3e78-7e13-b718-4f75fc8d59ee/`:

- `codex-design-0.6.6-native-multi-select.jpg`: three selected of six results.
- `codex-design-0.6.6-native-trash-actions.jpg`: normal Trash row actions.
- `codex-design-0.6.6-native-delete-confirm.jpg`: actual three-item confirmation.
- `codex-design-0.6.6-native-grid-selection.jpg`: six selected cards after layout switch.

The source and native captures were inspected together by an independent
reviewer. Comparison excludes outer host chrome and aligns corresponding
components/states by proportion. The generated two-state sheet is 948×1660
pixels; each native capture is 1500×890 pixels. This is not an equal-viewport
pixel match or a claim about a separate device scale factor.
The reference does not specify a grid state, so grid checks concern consistent
selection, readable controls and scrolling rather than claimed image fidelity.

## Required surfaces

| Surface | Result and limits |
| --- | --- |
| Fonts and typography | Existing host font/size tokens retained. Native labels, metadata, count and actions have readable hierarchy and consistent weights. No new display font or authored-content changes. Exact generated-image glyph metrics are not asserted. |
| Spacing and layout | Dedicated checkbox column precedes the type icon; table columns align. Count/Clear/Move toolbar sits above rows. Restore and delete stay on one baseline. Wider names/whitespace reflect the real viewport. Lower grid card actions remained accessible after scrolling. |
| Colors and tokens | Existing host surfaces/text/borders used. Selected rows use a restrained gray tint. Destructive styling is limited to appropriate actions rather than repeated large red row labels. Dark desktop contrast visually clear. |
| Images and icons | Existing product outline icons reused, with no new raster assets or replacement icon system. Blank QA previews represent real blank artworks, not invented content. No thumbnail stretching was introduced. |
| Copy and content | Interface remains English: Clear selection, Move to trash, Restore, Delete selected, and descriptive permanent-delete tooltips/accessibility names. Confirmation lists the exact selected QA titles. |

## Acceptable differences and limits

- The real host viewport is wider than one generated frame. Name-column
  whitespace, three Trash rows, host typography scale and outer chrome differ.
- Selected rows have individual subtle corner rounding while the reference
  reads as a more continuous selected group; this is minor P3 polish.
- No native light-theme, narrow-window, hover or focus screenshots were taken.
  Existing theme variables, native checkbox semantics and focus styles remain;
  these are not relabeled as visual passes.
- Single and bulk permanent-delete confirmation/Cancel were exercised in the
  native host. The irreversible submit was not executed; isolated tests cover
  deletion, partial failure and bounded request batches.

## Implementation checks

- [x] Native list mixed-state selection and exact three-item move.
- [x] Native Trash compact actions, confirmation/Cancel and batch Restore.
- [x] Native six-item selection survives Grid switch and supports batch move.
- [x] 73 focused controller tests and 686 complete regression tests pass.
- [x] Formal marketplace package matches all 192 files; live host tool works.
- [x] Six own QA artworks retained recoverably in Trash; unrelated metadata unchanged.
