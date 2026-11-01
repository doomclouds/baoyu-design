# Codex Design 0.5.1 prepared revision

## Included code

- Category-aware creation: Slides, Design, Design systems and Dashboards create
  their own type directly from both category controls. All and global sidebar
  creation retain the universal picker.
- Every native draft body retains the exact immutable request URI. Newly sent
  requests and active-turn steering require their own receipt and dispatch.
- Non-comment AI actions use the canonical request/native draft path, including
  diagnostic repair, selection requests and the audited setup/file/remix flows.
  Native failures do not claim clipboard or agent-execution success. Saved
  append failures retry their existing canonical thread.
- The Design System's known built-in migration scaffold names the Codex skill
  in native mode; historical migration identities and authored content remain.
- Comment pins keep their original author-avatar rendering. The user explicitly
  revoked the briefly selected change to visible comment numbering.

## Checks actually run

- **340 tests passed**, zero failed, skipped or cancelled tests.
- The full suite includes assembly/save/comment integration against each real
  editor data service, alongside actual compiled handoff-function tests.
- Package consistency and portable relocation passed: **179 owned files**, six
  tools, two static resources, generic Node command and Unicode/space paths
  without node_modules.
- Isolated browser-component QA verified Dashboard-specific text and buttons;
  clicking New dashboard saved one dashboard and loaded its actual editor.
  The test tab and its services were closed/stopped afterwards. No real user
  artwork was changed in this QA run.

Evidence retained locally: `codex-design-0.5.1-tests-combined.txt`,
`codex-design-0.5.1-category-ui.json` and
`codex-design-0.5.1-category-create.jpg`.

## Release and native-host limits

This revision is prepared in source; it has not been published to the primary
GitHub marketplace branch or installed. The active installation remains 0.5.0.
The operator's successful single-comment native interaction is recorded in
[ACCEPTANCE-0.5.0.md](ACCEPTANCE-0.5.0.md). The new error/fix actions and steered
request correction still need installed-host operator checks.

The user requires the entire native workspace tab/control row to be absent,
with the library beginning below the legitimate window/menu chrome. Populating
that row with native artwork tabs is not an accepted substitute. The current
public API does not establish this behavior. Earlier mainToolbar-null reasoning
was incomplete and is corrected in
[native-shell-layout-proposal.md](research/native-shell-layout-proposal.md).
No host code was modified and no native header fix is claimed.

True shared native-middle-sidebar integration and cross-window single-editor
ownership are also not established by this revision. The goal remains open.
