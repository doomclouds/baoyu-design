# Design Library UI

Production workspace UI for the approved library and editor views. The app owns the secondary sidebar and workspace; it does not recreate Codex's outer rail or add another editor Comments control. The floating panel contains only one artifact's bound editing conversation, short status, and artifact reference.

Bundle `entry.js` with the installed `i18next` dependency, preserve `styles.css` and `assets/brand.svg`, and serve/in-line the result from the workspace-only UI resource. Ordinary tool results must not mount this full app in a chat. There is no CDN or sample-library fallback.

## Host adapter

`createUi({root, bridge})` is exported from `library-ui.js`. `entry.js` accepts `window.codexDesignBridge`, exposes `window.installCodexDesignBridge(bridge)`, and listens for `codex-design:bridge-ready`. The returned controller provides `refresh()`, `setLanguage('system'|'en'|'zh')`, `activateArtifact(id)`, and `destroy()`.

The bridge implements:

```js
{
  invoke(action, payload): Promise<result>,
  subscribe(handler): unsubscribe,
  language: 'zh-CN', // optional host/system UI language
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
| `conversation.get` | `{id}` | `{binding,messages,status,capabilities,reasonCode?}` |
| `conversation.send` | `{id,text}` | actual delivery result; UI reloads conversation |

A record has `id`, `kind`, `title`, `createdAt`, `updatedAt`, `favorite`, `contentStatus` and optional `deletedAt`, `projectName`, `thumbnailUrl`. Missing optional metadata is represented honestly. View state is `{version:1,tabs:[{id:'library',type:'library'},{id,artifactId:id,type:'artifact'}],activeTabId}`. The backend owns durable identity, unique tabs, bindings, autosave, recovery points and recycling. Closing a tab never invokes a worker/editor-stop action.

Conversation sending is enabled only when an actual binding and `capabilities.sendMessage === true` are returned. `reasonCode: 'NATIVE_EDIT_CHAT_UNAVAILABLE'` receives a localized unavailable state. The app never creates chats, switches a global active chat, starts a model, synthesizes an assistant reply, or treats an accepted request as a completed edit.

Subscription events can contain `viewState`, or use `type: 'library.changed'|'artifact.updated'|'view.changed'|'conversation.changed'|'worker.changed'|'capabilities.changed'|'language.changed'`. Conversation events may identify `artifactId`; language events may include `language`. Active running conversations are observed while visible; inactive editor iframes are unloaded and restored only on activation. This does not stop backend AI work.

`createHttpBridge({endpoint,eventsUrl?,headers?,language?})` is an explicitly configured alternative transport, never an automatic endpoint guess. Production MCP hosts can map `invoke` to `design_action({action,payload})` and supply the actual initial result.

## Localization and access

`locales/en.js` and `locales/zh.js` share keys and use i18next. The language preference is UI-only local storage, follows system/host language by default, observes the browser `languagechange` event, and emits `codex-design:languagechange`. Artifact titles, content, skill text, prompts and conversation messages are not translated.

Tabs support arrows/Home/End, Alt+Shift+arrows for reordering, and pointer drag. Menus support arrows/Home/End/Escape. Dialogs use native modal focus handling; destructive actions require a concrete confirmation. Search, favorites and sorting use only actual library records. Native editors keep their own comments, location pins, replies, resolve/reopen and Send to agent behavior.
