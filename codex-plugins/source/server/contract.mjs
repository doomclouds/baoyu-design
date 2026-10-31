export const LIBRARY_UI_URI = 'ui://codex-design/library';
export const FILE_UI_URI = 'ui://codex-design/file';
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';
export const KINDS = Object.freeze(['slides', 'design', 'design-system', 'dashboard']);
export const READ_ACTIONS = Object.freeze(['library.list', 'library.get', 'view.get', 'conversation.get', 'reference.get', 'reference.readFile']);
export const ACTIONS = Object.freeze([...READ_ACTIONS, 'library.create', 'library.rename', 'library.setFavorite', 'library.duplicate',
  'library.trash', 'library.restore', 'library.snapshot', 'library.listSnapshots', 'library.restoreSnapshot',
  'library.exportArtifact', 'library.importArtifact', 'thumbnail.get', 'view.openTab', 'view.activateTab', 'view.closeTab', 'view.reorderTabs', 'editor.open']);
export const UNSUPPORTED_CHAT_CODE = 'NATIVE_EDIT_CHAT_UNAVAILABLE';
export const referenceUri = id => `codex-design://artifacts/${encodeURIComponent(id)}/reference`;
export const fileUri = (id, relative) => `codex-design://artifacts/${encodeURIComponent(id)}/files/${encodeURIComponent(relative)}`;
