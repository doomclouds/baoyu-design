# Design Library UI

Production workspace UI for the library and editor views. The app owns its category navigation and workspace; it does not recreate Codex's outer rail or add another editor Comments control. Host-wide navigation remains owned by Codex. The optional floating conversation is shown only when a real per-artifact binding and send capability exist.

Bundle `entry.js` with the installed `i18next` dependency, preserve `styles.css` and `assets/brand.svg`, and serve/in-line the result from the workspace-only UI resource. Ordinary tool results must not mount this full app in a chat. There is no CDN or sample-library fallback.

## Host adapter

`createUi({root, bridge})` is exported from `library-ui.js`. `entry.js` accepts `window.codexDesignBridge`, exposes `window.installCodexDesignBridge(bridge)`, and listens for `codex-design:bridge-ready`. The returned controller provides `refresh()`, `activateArtifact(id)`, and `destroy()`.

The bridge implements:

```js
{
  invoke(action, payload): Promise<result>,
  subscribe(handler): unsubscribe,
  capabilities: {actions: ['library.list', /* ... */]}, // optional whitelist
  initialState: {artifacts: [], viewState: {}}, // optional real initial tool result
}
```

Actions and results:

| Action | Payload | Result |
| --- | --- | --- |
| `library.list` | `{includeDeleted:true}` | record array or `{artifacts}` |
| `library.create` | `{kind,title}` | record or `{artifact}` |
| `library.rename` / `library.duplicate` | `{id,title}` | record or `{artifact}` |
| `library.setFavorite` | `{id,favorite}` | record |
| `library.trash` / `library.restore` | `{id}` | record |
| `view.get` | `{}` | view state or `{viewState}` |
| `view.openTab` / `view.activateTab` / `view.closeTab` | `{id}` | view state |
| `view.reorderTabs` | `{ids}` including fixed library first | view state |
| `editor.open` | `{id,force?}` | `{url}` for the real existing editor |
| `editor.document` | `{id,language:'en',channel,force?}` | self-contained native editor HTML and scoped transport metadata |
| `conversation.get` | `{id}` | `{binding,messages,status,capabilities,reasonCode?}` |
| `conversation.send` | `{id,text}` | actual delivery result; UI reloads conversation |

A record has `id`, `kind`, `title`, `createdAt`, `updatedAt`, `favorite`, `contentStatus` and optional `deletedAt`, `projectName`, `thumbnailUrl`. Missing optional metadata is represented honestly. View state is `{version:1,tabs:[{id:'library',type:'library'},{id,artifactId:id,type:'artifact'}],activeTabId}`. The backend owns durable identity, unique tabs, bindings, autosave, recovery points and recycling. Closing a tab never invokes a worker/editor-stop action.

Conversation sending is enabled only when an actual binding and `capabilities.sendMessage === true` are returned. `reasonCode: 'NATIVE_EDIT_CHAT_UNAVAILABLE'` receives a localized unavailable state. The app never creates chats, switches a global active chat, starts a model, synthesizes an assistant reply, or treats an accepted request as a completed edit.

When the bridge advertises `supportsInlineEditor`, the UI opens the self-contained document through `native-editor.mjs`, with a fresh channel and fixed artifact identity. The helper validates the frame source/channel and brokers only scoped editor requests, event subscriptions and downloads. The inner document must retain an opaque origin relative to the MCP host. Tab changes, retry, restore and teardown dispose subscriptions. A real editor readiness signal clears the loading overlay; failed startup offers a localized retry state. The standalone HTTP preview retains its existing loopback iframe path.

Before switching away, closing an active artwork tab, reopening, exporting, creating a recovery point or replacing content, the native path waits for the editor's real save barrier. A rejected barrier leaves the current tab and editor open. The controller supplies the same guard to native deep-link navigation and the host teardown request. Category state and keyboard focus also remain on the current work when navigation fails.

Subscription events can contain `viewState`, or use `type: 'library.changed'|'artifact.updated'|'view.changed'|'conversation.changed'|'worker.changed'|'capabilities.changed'|'host-context.changed'`. Legacy language-change events are ignored. Conversation events may identify `artifactId`. Active running conversations are observed while visible; inactive editor iframes are unloaded and restored only on activation. This does not stop backend AI work.

`createHttpBridge({endpoint,eventsUrl?,headers?,language?})` is an explicitly configured alternative transport, never an automatic endpoint guess. Production MCP hosts can map `invoke` to `design_action({action,payload})` and supply the actual initial result.

## Interface language and access

The interface uses `locales/en.js` through an English-only i18next instance. Existing stored `zh` or `system` preferences and host/browser locale changes do not change it. There is no language selector, follow-system option, or empty Settings dialog. Native editor requests, standalone editor URL parameters, and editor language messages explicitly use English. Artifact titles, content, prompts, comment text, conversation messages, and custom recovery-point labels retain their original text.

Tabs support arrows/Home/End, Alt+Shift+arrows for reordering, and pointer drag. Menus support arrows/Home/End/Escape. `menu-dismissal.mjs` keeps a transient dropdown open while the mouse crosses the trigger/menu gap, then closes it 220 ms after leaving both. Entering either region cancels that timer. Programmatic first-item focus does not suppress mouse dismissal; keyboard interaction does, until mouse navigation resumes. Touch interaction does not depend on hover. Outside presses, focus leaving, editor-iframe pointer boundaries, and window blur close only the dropdown; Escape also returns focus to its trigger. Opaque editor documents and the host parent are never inspected. Rename, history, restore and other modal dialogs have separate lifecycles and are not closed by dropdown dismissal. Dialogs use native modal focus handling; destructive actions require a concrete confirmation. Search, favorites and sorting use only actual library records. Native editors keep their own comments, location pins, replies, resolve/reopen and native Add to chat behavior.

Global sidebar Create and All-page creation controls open an anchored content menu. In Slides, Design, Design systems and Dashboards, the heading and empty-state actions create the current type directly with a matching label and icon. Creation saves a blank native artifact before opening its unique tab. The editor title and item menu provide renaming. List view uses compact type icons and 58px rows; Grid view keeps real artwork previews. Category navigation can be collapsed and reopened, with its local preference retained.

The MCP adapter applies host theme, font CSS and standard style variables. The UI consumes `--font-sans`, `--font-text-md-size`, host weights, heading sizes and semantic colors; text sizes use relative units so Codex typography changes propagate. Standalone previews have an explicit light/dark fallback palette.

Import and Export transfer content-only `.codexdesign.json` packages through `library-transfer.mjs`, with a 16 MB UI transfer limit. The native bridge uses the MCP download API; standalone previews use browser downloads. Version history lists content recovery points. Restoring confirms saved edits, unmounts the current editor to stop autosave, saves a recovery point, replaces content and reopens the editor. Comments, conversations and runtime state remain separate.
