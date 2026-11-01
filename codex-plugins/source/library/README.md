# Local artwork library backend

`createLibraryStore(options)` returns a `LibraryStore`. Call `await store.initialize()` or any public method before use. The default location is the user's `~/.codex/CodexDesignLibrary`, independently of `CODEX_HOME`; tests and host integrations can explicitly pass `root`.

No method starts an editor, creates a chat or native agent, sends messages, or interrupts an existing agent. The host must connect a truthful `isBusy(artifact)` callback, returning a boolean or `{busy, reason}`, before exposing destructive operations against live projects.

```js
import { createLibraryStore } from './library/index.mjs';

const library = createLibraryStore({ root, isBusy });
await library.initialize();
const artifact = await library.create({ kind: 'design', title: 'Homepage' });
await library.openTab(artifact.id);
```

Kinds are `slides`, `design`, `design-system`, and `dashboard`. Each new artwork has a persistent UUID and lives at `<kind>/<UUID>/artifact.json` beside its unchanged native `project/` or `db/` and `_blobs/` layout. Renaming preserves the UUID and updates the native index title; duplication and import create new UUIDs. Design systems are ordinary AI-reference artwork, with no automatic application or dependency updates.

Records contain `id`, `kind`, `title`, `formatVersion`, `createdAt`, `updatedAt`, `favorite`, `path`, `deleted`, and `contentStatus` (`ok`, `missing`, or `invalid`). Missing content stays missing; reads and list operations never recreate a blank artwork. `contentStatus` performs bounded native-format/index/material checks; it does not claim visual or full runtime verification.

Public asynchronous operations:

- `list({kind?, query?, favoritesOnly?, includeDeleted?})`, `get(id, {includeDeleted?})`
- `create({kind, title})`, `rename(id, title)`, `setFavorite(id, boolean)`, `duplicate(id, {title?})`
- `trash(id)`, `restore(id)`, `purge(ids)`; purge accepts only explicitly confirmed trash selections and returns exact deleted/failed IDs
- `snapshot(id, {label?})`, `listSnapshots(id)`, `restoreSnapshot(id, snapshotId)`
- `exportArtifact(id)`, `importArtifact({bundle | sourcePath, kind?, title?})`
- `listFiles(id)`, `readFile(id, packageRelativePath, {encoding: 'utf8' | 'base64'})`
- `scanLegacy()`
- `getBinding(id)`, `bindChat(id, {threadId, projectId?})`, `unbindChat(id)`
- `getViewState()`, `openTab(id)`, `activateTab('library' | id)`, `closeTab('library' | id)`, `reorderTabs(ids)`

Chat binding and tab/view state are machine-local metadata in `_state/`, outside artwork directories. Binding a different editing conversation fails with `BINDING_CONFLICT`; callers must explicitly unlink first. The host supplies real identifiers and owns conversation creation and authorization. The fixed library tab is always first. Each artwork has exactly one tab whose tab ID equals its artifact UUID, and the tab list/order/active selection survive reopening the store.

The legacy chat-binding records are separate from the global native draft workflow.
Immutable edit requests live under `_state/edit-requests/`; preparation and model
receipt do not create worker jobs. The real native parent performs dispatch with
its own execution identity. These requests and their runtime records are never
part of content exports. Purge preflights all selected trash identities, rejects
active/unknown execution, validates every deletion target, and removes only the
selected artwork plus its local snapshots/bindings/requests. External native
conversation history is preserved. Partial filesystem failures return exact
deleted/failed IDs and a retry receipt rather than pretending rollback.

Native export is a bounded JSON bundle:

```json
{
  "format": "codex-design-artifact",
  "version": 1,
  "kind": "design",
  "title": "Homepage",
  "files": [{"path": "project/canvas.json", "encoding": "base64", "data": "..."}]
}
```

Only native artwork files and materials are included. Root comments, chat relationships, worker/task records, runtime bindings, library view state, snapshots, and recycle metadata are excluded. Private `_state`/`_trash` subtrees and `comments.json` are excluded even when placed inside an imported content subtree. Dashboard exports include current `db/files`, `db/datasets`, `db/dash/{meta,params,look}.json` and `_blobs`, excluding user diagnostics and historical controller data. Snapshot restoration changes the artwork only; current comments, chat binding, favorites, and tabs remain local and are not rolled back.

Default limits are 2,048 files, 32 MiB per file, 128 MiB decoded content, and 180 MiB serialized bundle. Hosts can pass explicit positive integer limits. Relative paths reject traversal, alternate streams, reserved names, and nonportable aliases; content reads, imports, and exports reject symbolic links and stay within their authorized real root. JSON state updates are atomic and a file lock serializes independent local store instances. The catalog can be rebuilt from persistent artifact manifests.

`scanLegacy()` only scans direct folders beneath the four library kind directories. A native folder without `artifact.json` is validated and copied into a new UUID directory; its source, local comments, and runtime records stay untouched. A local migration record prevents repeated copies. Broken or previously missing registrations are reported without replacing them with empty artwork. It never scans the user's home directory or Temp.
