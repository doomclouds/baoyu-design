# Codex Design 0.5.0 acceptance

## Confirmed implementation scope

The user selected a global Codex Design workspace and the host-managed local
environment. Artwork is not bound to a particular existing user chat. The host
continues to own native project/model/permission selection; the plugin does not
claim it can force a project or replace the native workspace composer.

- Native **Add to chat** saves an immutable artwork/comment/location revision
  and appends a compact reference to the active native draft with `send:false`.
  Preparation and model receipt do not queue a worker or start generation.
- Only request IDs actually received in a user message are read/accepted by the
  model-visible `design_request` tool. Its native-parent dispatch command uses
  the caller's real environment identity and queues each request once.
- Worker execution identity is separate from the UI data-service binding.
  Native children retain serial ownership and create pre-edit recovery points.
  Superseded requests cannot resume, and missing/mismatched receipts hold work
  for confirmation instead of silently editing or showing Working.
- Draft failures preserve the already-saved comment/reply. An explicit retry
  uses that thread's Send route, while per-attempt and RPC deduplication avoid
  replay. A new explicit Add attempt can recover a removed/lost draft.
- Request/journal changes reach the canonical comment controls in all four
  editors, including when an older data service is reused. Legacy unconfirmed
  submissions are not replayed automatically.
- Trash supports single-item permanent deletion, list/grid selection, Select
  all visible results, and selected-item deletion after a count/title warning.
  Partial filesystem failures retain accurate retry receipts and remaining
  selection. Native chat history and unrelated artwork are outside purge scope.

## Frozen checks

- **321/321 tests passed**, zero failures, skipped or cancelled tests.
- Generated-package consistency passed: **178 owned files**.
- Portable relocation passed: generic `node`, Unicode/space paths, no
  `node_modules`, six discovered tools and two static UI resources.
- Native UI resource: `ui://codex-design/0.5.0/library`.
- Four real data-service integrations covered create/reply/edit/native Send
  interception, legacy IDs and encoded routes, ad-hoc requests, actual file
  saving, request receipt, and state-only comment event updates.

The first full run retained **320 pass / 1 fail**: a packaging assertion still
required the old local-queue wording. It was replaced with assertions for
prepare/no-enqueue, user Send, explicit model acceptance and native dispatch;
the full suite was rerun. Earlier source integration failures included the
Dashboard logical-document-to-store mapping and a missing test import. Those
failures and their corrected reruns remain in the local acceptance archive.

## Actual native-child execution

A disposable artwork in an isolated user home was prepared and accepted through
the staged MCP protocol, then dispatched in the real parent's environment.
A platform-spawned native child registered its distinct inherited identity,
claimed the job, saved a recovery point, changed the requested first-slide
heading, ran the built-in check (**five slides, zero problems**) and completed
through the canonical comment-reply controller. The parent independently
verified the completed journal, saved agent reply and distinct actor identities.
The index and other four slides retained their hashes. The idle listener was
paused and returned `closed`; no background model daemon was used.

This establishes real native-parent/child backend execution. It does **not**
establish that a real Desktop composer sent that request: native Send was not
automated. The isolated browser fixture has an explicitly mocked draft receiver.

## UI observations and evidence limits

The packaged UI was checked in an isolated browser fixture with real editable
artwork copies. Trash Select all selected the two visible items; Delete selected
opened the correct irreversible count/title dialog; Cancel retained the items.
No permanent deletion of the user's real Trash was performed. Backend deletion
tests used disposable directories and covered partial failure and safe retries.
The native child's changed slide was rendered and visually inspected.

Nested-editor pointer/keyboard automation produced stale-focus and target
mapping failures, including an unintended navigation to another temporary
artwork. Those attempts are not reported as passed UI actions. The acceptance
comment was seeded through the canonical backend. All affected data was confined
to the isolated QA library. Full real-host **Add to chat → native Send → result**
interaction acceptance remains an operator gate after installation.

Retained local evidence includes `codex-design-0.5-tests-first.txt`,
`codex-design-0.5-tests-final.txt`, `codex-design-0.5-native-result.json`,
`codex-design-0.5-native-worker-result.jpg` and
`codex-design-0.5-trash-confirmation.jpg`.

## Release and outstanding work

Release commit `d389de564148ba096995243a40eb8e3a33b30549` was pushed to
`doomclouds/baoyu-design`, branch `codex/plugin`. The configured GitHub
marketplace snapshot was refreshed through the installed Desktop CLI, then
`codex-design@codex-design-marketplace` was installed as **0.5.0**.
The first install attempt failed with Windows Access Denied while the old
0.4.3 MCP entry processes held their cache directories. Only those exact
entry processes were stopped after identity revalidation; the supported
installation command then succeeded.

Read-only discovery through the real Desktop app-server
`0.166.0-alpha.5.1` verified all five enabled skills, six MCP tools, the global
entrypoint and no plugin diagnostics. All **178 installed-file hashes** match
the generated package. `gh run list` returned no workflow runs for this branch;
no GitHub workflow or tag was used.

The current long-lived chat connection still returned `Transport closed`
after the old MCP process was replaced. A normal Desktop restart/reconnect is
required before the final real-host Add to chat/native Send operator check.
This connection error is retained separately from the successful fresh-runtime
discovery and installed-file verification.

The full original goal is not claimed complete. The native host's empty top
toolbar and shared middle-sidebar slot remain outside the verified public
plugin API. Cross-window single-editor ownership is also not implemented.
The requested arbitrary user-chat binding/switching design was explicitly
superseded by the global-workspace decision and is not a remaining requirement.
