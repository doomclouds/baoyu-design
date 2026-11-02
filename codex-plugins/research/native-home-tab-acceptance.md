# Native home Tab: current requirement and acceptance gap

## Required behavior

Opening the global Codex Design sidebar app must immediately show one named,
nonclosable native home Tab. It must remain visible after leaving the app,
returning through the left rail, and restarting Codex. Artwork tabs remain
inside the app. A dummy second native Tab, an automatic chat message, a separate
window, and a private host patch are not acceptable substitutes.

The user superseded the earlier whole-row-removal request with this target.
The plugin-owned seam may use a subtle separator; it cannot control the native
row's height or visibility through CSS inside the resource.

Release decision: the user later explicitly accepted retaining the current
top-bar behavior for 0.5.1 and authorized GitHub publication and installation.
The fixed-home target remains future work. Acceptance of that limitation does
not turn the failed default-visibility/persistence checks below into passes.

## Version and evidence boundary

- Installed desktop: `OpenAI.Codex 26.1027.3384.0`, rechecked for this report.
- Installed plugin: `0.5.0`; prepared feature source: `0.5.1`.
- Packaged public Extensions SDK: `@openai/mcp-extensions@0.2.1`.
- Native observations below use the installed plugin, not a browser fixture.
- No host files, private IPC, security settings, or conversation content were
  changed to obtain these observations.

| Action | Actual result | Acceptance |
| --- | --- | --- |
| Open Codex Design from the left rail | Plugin library renders; the native row can be blank except for host controls | Default visibility failed |
| Invoke the normal Enter full view command, `Ctrl+Shift+F` in the inspected Windows keymap | The existing sole named home Tab becomes visible and has no close button | Manual workaround only |
| Leave through normal navigation and return through the left rail | The blank native row returns | Navigation persistence failed |
| Restart with an automatically fixed initial state | No automatic plugin implementation is available to test | Not passed |

The successful command is captured in `codex-design-native-single-home.jpg` in
the local acceptance archive. Earlier interrupted or ineffective input attempts
are excluded. Opening and then closing a second native Tab can preserve the
visible home within one active workspace; that does not prove first-open or
navigation persistence. No dummy Tab was used for this report's successful
full-view observation.

## Correct plugin registration

`source/server/register.mjs` registers:

```js
// Tool metadata, global app entrypoint.
{ "openai/ui": { entrypoints: [{ type: "global" }] } }

// UI resource metadata.
{ "openai/ui": {
  preferredDisplayMode: "fullscreen",
  availableDisplayModes: ["fullscreen"]
} }
```

This matches the [official sidebar-app registration guidance](https://developers.openai.com/plugins/build/extensions#sidebar-apps).
It is not a missing global entrypoint or a localhost browser launch. Resource
display mode and the desktop's workspace Tab presentation are different state
boundaries; requesting fullscreen does not establish that the home Tab is shown.

In SDK `0.2.1`, `dist/shared/ui.js:13-32` defines strict entrypoint, tool UI and
resource UI metadata schemas. There is no native `tabsHidden`, initial full-view,
home visibility or Tab-row height field. Do not add invented metadata to the
package or report its acceptance by an unrelated parser as native support.

The current public specification was also checked at commit
`15e0f4745e7c95865ee2195de5b79f4148b21418`:

- [Global entrypoint](https://github.com/openai/mcp-extensions/blob/15e0f4745e7c95865ee2195de5b79f4148b21418/docs/spec.md#L76-L92).
- [Deep links](https://github.com/openai/mcp-extensions/blob/15e0f4745e7c95865ee2195de5b79f4148b21418/docs/spec.md#L120-L147).
- [Display modes](https://github.com/openai/mcp-extensions/blob/15e0f4745e7c95865ee2195de5b79f4148b21418/docs/spec.md#L836-L863).

The display-mode section states that entrypoints use fullscreen. This is not a
native home-Tab visibility contract. The current public specification and the
inspected desktop are separate version evidence, not interchangeable runtime
proof. No matching public setter was found in either the pinned SDK or the
current specification; that is not a claim about all future host versions.

## Inspected host mechanism

The shipped source was inspected as inert text, not executed or injected:

- `view-c43892ae83d7.js.readable.txt:234-248` restores/registers the global home
  through `persistentWorkspace.homeTabId`.
- `app-initial-4267e52fe5b0.js.readable.txt:76519-76529` initializes the
  workspace-scoped `tabsHidden` state from the content-primary surface.
- The normal full-view action clears that state. Opening a non-home Tab can
  also clear it; that explains why a second Tab appears to reveal the home.
- `requestDisplayMode` enters through
  `widget-9db463e435db.js.readable.txt:2612-2620`, then the MCP App display-state
  actions in `app-initial-4267e52fe5b0.js.readable.txt:253072-253124`. Those are
  distinct from the full-view layout actions at `297852-297867,297944-297953`.
- Global deep-link handling in
  `view-frame-faf45bc8eb2c.js.readable.txt:438-470` updates the app route; it does
  not invoke the full-view layout action.
- Persistence has draft/session conditions. Static source alone does not
  identify which private runtime branch caused a particular reentry reset.

These observations explain a reproducible state boundary. They do not authorize
or prove a safe plugin call to a private host setter.

## Completion gate

Keep this requirement open until a supported interface can control the relevant
state, or a host update fixes initialization/persistence. A valid verification
must observe the named home on first open, left-rail reentry and restart, with
no preliminary second Tab or full-view shortcut. Then recheck native composer,
artwork focus and save/reopen behavior in that same installed host.

This report is a local, unsent reproduction and API-boundary record. It does not
publish an issue, install a plugin, modify the marketplace branch, or relax the
user's current release hold.
