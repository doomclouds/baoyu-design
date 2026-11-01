# Native artwork request entrypoints

## Scope

The 0.5.1 revision connects non-comment AI actions to the same native draft
pipeline as Comments. This inventory was checked against the actual packaged
editor modules, not inferred from button wording. It is a source/protocol
acceptance record; it does not claim that every button was clicked in the
installed Desktop host.

| Editor | Actual entrypoints | Native handoff boundary |
| --- | --- | --- |
| Slides | A slide cannot be read or compiled; repair the held slide | `askAgentToRepairSlide`, before legacy diagnostic truncation |
| Design | Repair the problems summary; repair one artboard | `sendArtboardErrorsToClaude`, retaining canvas title, exact filenames and messages |
| Design System | Finish migration/setup, contrast repair, GitHub starter, empty-system setup, build from a dropped file, unsupported-file handoff | String and object delivery helpers shared by the two root UI callers |
| Dashboard | Repair stopped content, make content editable, source failure, sharing rewrite, filter limit, connect live data, chart/text selection, page check | Eight selection-request callers through the common session handoff |
| Dashboard | Remix form/action | The same common handoff with its completion callback |
| All four | New comments, replies, edits and explicit Add to chat | Existing canonical Comments controller and immutable edit request store |

Data-source Retry/Retry all remain local data queries. Deliberate Copy CSS,
Copy text and other copy commands retain their clipboard behavior. Native
adaptation does not replace a global clipboard API.

## Request lifecycle

1. A native-only, negotiated-capability check requires
   `canDraftComments === true`.
2. The action saves a canonical artwork request through
   `__comments/agent/requests`; no worker is queued at this point.
3. The normal frame broker appends the immutable reference to the native draft
   with `send:false`. The visible body contains its exact Request URI.
4. Only confirmed drafting reports: "Added to chat. Send in Codex to start
   editing." It does not claim Working or a completed agent edit.
5. The user presses native Send. Each received ID, including later active-turn
   steering, requires its own read, accept and native-parent dispatch before a
   child receives it. Reusing a child does not replace that request's receipt.
6. Actual completion and canonical result replies retain the worker protocol.

A saved comment whose native append failed is retained. Retrying sends that
same thread through `__comments/<id>/send`, instead of creating another comment.
Unconfirmed receipts and unavailable draft capabilities fail explicitly. Error
context above the canonical comment limit is refused with an actionable
message rather than silently removing filenames or diagnostic details.

## Evidence and limits

- Adapter tests execute the actual packaged handoff functions with native and
  standalone contexts. They cover outcome shapes, truthful messages, complete
  diagnostic context, pending-call deduplication, saved-failure retry, capability
  rejection and bounded vendor anchors.
- Category creation has separate interaction checks for all four kinds and
  actual browser-component creation/loading evidence for Dashboard.
- The operator confirmed the installed 0.5.0 comment Add to chat/native Send
  flow, and its actual native receipt, child execution and reply were inspected.
- The new 0.5.1 non-comment error/fix actions still need installed-host operator
  checks after this package is released. A simulated draft receiver is not that
  evidence.
- Host-owned toolbar removal, shared native sidebar slots and cross-window
  editor ownership are separate requirements; this adapter does not establish
  them.
