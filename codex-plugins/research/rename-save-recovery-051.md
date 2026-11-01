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

Branch `codex/rename-save-recovery` changes only the shared library controller
and its tests. For native inline editors it:

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

This source change has not been built into a new package, installed, or tested
in the actual host. It has not altered the published 0.5.1 bytes. Full package,
portable and real Rename-to-edit-to-save/reopen verification still belongs to
the next revision. Do not apply remounting to the already dirty live QA tab:
its unsaved artboard must first be recovered or explicitly discarded.
