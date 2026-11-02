# Rename/save recovery after installed 0.5.1 acceptance

## Actual observation

The installed GitHub-marketplace 0.5.1 was opened through the real Codex global
sidebar. A newly created Design canvas was renamed to
`Codex Design 0.5.1 - Canvas QA`. Adding its first blank artboard then displayed
the artboard, but the sync control reported that a newer page version had saved
first. One normal Retry did not recover during the observation. The disk still
contained only `project/canvas.json`, with empty `boards` and `order`.

The Properties panel opened successfully. That control result does not prove
that its displayed artboard was saved. The dirty QA tab was retained; no
preexisting user artwork was edited or replaced to recover the test.

The library Rename path flushes the active editor and changes its native index
title while retaining the old loaded editor. That lifecycle permits a stale
index base after the metadata write. The upstream retry path already performs
listing/reload/merge/base refresh; this report does not claim that retry never
reloads, or that every part of this observed persistent conflict is diagnosed.

## Separate source repair

The Rename repair in branch `codex/rename-save-recovery` changes the shared
library controller and its tests. For native inline editors it:

1. Blocks stale/duplicate mounts of the target while Rename is in progress.
2. Requires the existing saved/flush acknowledgement before disposing its exact
   old frame. A refused flush preserves the dirty frame and does not rename.
3. Retires the saved frame before the native index title is changed.
4. Rebuilds the same still-active artwork from its current disk base after
   success or failure, without creating a different artwork Tab or chat.

The existing data service is reused. No worker is stopped and no conversation
is created or rebound. Standalone URL mode does not gain an unconfirmed forced
disposal. In-flight document responses, replaced forms, navigation and complete
workspace disposal are covered by the target barrier and lifecycle checks.

## Verification boundary

The author and independent reviewer each ran the actual `createUi` controller
suite: **37/37 passed**, including thirteen new lifecycle cases covering all
four native artwork types. Diff checks passed. The initial focused run was
33/35 because two new assertions used raw text rather than the existing
localization mapping; that result is not recast as an initial green run.

An initial review hypothesis about a detached B frame during A-to-B-to-A
navigation was withdrawn after reading the existing pre-swap disposal. The
explicit regression is retained and passes.

The first source-only review preceded packaging. The repair has since been
built as a separate 0.5.2 candidate; its full test and portable results are in
[ACCEPTANCE-0.5.2.md](../ACCEPTANCE-0.5.2.md). It is not installed or real-host
repair-verified and has not altered the published 0.5.1 bytes. Do not apply
remounting to an already dirty live QA tab: its unsaved artboard must first be
recovered or explicitly discarded.

## Post-restart control and external-opening case

The current chat's real `design_read view.get` call succeeded after the user
restarted Codex. A fresh canvas was created with its intended QA name through
the installed skill CLI, so no active Rename preceded its first artboard.
The actual host saved one artboard, its component and a text edit to disk.
The text floating-toolbar Properties action opened the selected text controls.
This control case separates the earlier active-Rename conflict from a general
new-artboard save failure.

A separate isolated protocol probe exercised the installed publisher, native
transport, design service and actual data service. New-file/index publication
succeeded; an existing component with `ifMatch:null` was refused. After an
external Rename, old-index writes were refused until a new listing/index SHA
was read. Publication with that refreshed SHA succeeded and kept the new name.
The protocol carries `files[path].ifMatch` in JSON, not HTTP ETag headers.

Opening the freshly CLI-created QA in an already open library also exposed a
metadata-cache gap: the record existed and `library.get` succeeded, while the
UI showed a missing-artwork error. Returning to Library refreshed the list;
opening the same tab then loaded the canvas. The next source change resolves
unknown IDs through a deduplicated, validated `library.get` before mounting.
Late results cannot replace the current artwork, overwrite a newer record, or
mount through the Rename/disposal barrier. Actual controller coverage grew to
50 passing cases; that is still not an installed-host repair verification.

## Blank-template contract and actual native request

The saved no-Rename control component was 468 bytes before the verification
request and had no `data-dc-script` block. Executing the actual upstream,
installed 0.5.1 and native-assembled `blankDcDocument` functions produced the
same 331-byte template after LF normalization, SHA-256
`61369b582dfdd02d8d60706ec4c87908e2c6c729cf0bb5eda8c451b34459c7a4`.
None contained the required logic block. The raw parser accepts a missing
script and the template replacement keeps outside scripts intact, while the
original authoring checker unconditionally requires a unique `DCLogic` block
with correctly sized `$preview` metadata. This was an upstream default-template
and checker contract mismatch, not evidence that native adaptation removed a
script from the user's saved component.

The next candidate fixes only new native blank creation at its real UI/batch
owners after final dimensions are known. Its identified generated templates
also keep preview dimensions synchronized during local content updates. A
per-store index-string cache avoids scanning all artboard HTML during ordinary
typing. Copies, unmarked/custom scripts and standalone creation are preserved;
the checker is not weakened. Real compiled-owner and raw-checker tests passed
14/14, including the performance boundary. The newer complete package result
is 464/464 tests and 184 owned files; the earlier 435/435 and 182-file candidate
remains historical evidence in the acceptance document. Neither result proves
an installed 0.5.2 repair.

After the operator's first native Send, request `f5b...` completed through the
actual parent and child `01a199c8-d2c6-7dc3-986c-16e080e86dd8`, with the requested
text-only change and canonical `Verified in Codex 0.5.1` reply. The original
check still failed with the one preexisting missing-logic-block issue. A second
child-reuse request is only drafted and awaits human Send; it has not been
received, dispatched or accepted as a completed reuse test. The 0.5.2 candidate,
including the separate native comment viewport safe-area correction, is built
but not promoted to the marketplace or installed.
