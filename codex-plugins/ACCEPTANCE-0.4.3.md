# Codex Design 0.4.3 menu hotfix acceptance

## Fault and correction

0.4.2 introduced a shared menu-dismissal regression. Its capturing window
`blur` listener also received descendant element blur. Opening a dropdown
focuses its first option, blurring the trigger and immediately removing the
new menu. Create, Sort and artwork actions all share this path.

0.4.3 dismisses through that listener only when `event.target === window`.
Element focus changes inside the trigger/menu do not close it. Outside
interaction, real window blur, Escape, the cancellable hover delay, keyboard
and touch behavior retain their existing paths. No editor, artwork format,
worker, host integration or ownership changes are part of this hotfix.

## Reproduction and automated coverage

- The complete 0.4.2 library UI reproduced both list actions and Create closing
  immediately: zero menu elements, collapsed trigger, and focus returning to
  the body after activation.
- The controller fixture now focuses clicked triggers and propagates the
  resulting element blur before focus reaches a menu item. Before the fix,
  this exposed two failures, including the previously passing Rename test.
- Added coverage includes Create, Sort and artwork actions in library and
  artwork views, item-to-item focus, and genuine window blur. Dedicated menu,
  controller and geometry tests passed **22/22**.
- Final full suite passed **237/237**, with no failed, skipped or cancelled
  tests. An earlier full run retained **236 pass / 1 fail**: the compatibility
  manifest still named 0.4.2. Both source manifests were corrected and the
  package rebuilt; the failing assertion was not loosened.

## Complete UI observations

These are browser/component checks using the generated package, its real
library service, and the existing opaque native-editor document transport.
They do not claim a complete Codex Desktop consuming-host interaction pass.

Verified through actual browser controls:

- Both sidebar and library-header Create menus remain open.
- Sort opens and switching between different menus leaves one menu.
- List and grid artwork action menus remain open.
- Rename opens a real modal; Cancel keeps the original title.
- Escape closes the menu and returns focus to the trigger.
- An outside press closes the menu.
- Slides, Canvas, Design System and Dashboard titlebar action menus remain
  open while their actual embedded editors render.
- Choosing Slides from Create persists a new artwork, opens its unique tab,
  and renders Slide 1 of 1. This used the isolated acceptance library, not the
  user's global library.

Evidence retained locally includes the old failure screenshot, new Create and
grid menus, all four artwork-header menus, the created Slides editor, and
`codex-design-0.4.3-tests-final.txt`. Native pointer-exit timing is covered by
the controller/helper tests; a complete real-host hover pass is not inferred
from those results.

## Release gate

The generated package has 174 owned files and versioned UI resources under
`ui://codex-design/0.4.3/`. Package consistency and portable relocation checks
passed: generic `node`, Unicode/space paths, no `node_modules`, five tools and
two resources. The formal GitHub marketplace installation is recorded after
completion.

The broader goal remains open: native shared middle-sidebar integration,
per-artwork bound native chat, cross-window single-editor ownership, and
comprehensive actual-host interaction acceptance are not claimed complete.
