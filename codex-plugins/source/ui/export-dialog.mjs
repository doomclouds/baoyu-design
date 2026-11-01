const fail = (message, code = 'EXPORT_FAILED') => Object.assign(new Error(message), { code });
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const absolute = value => /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(value);
const noWriteFailures = new Set(['INVALID_ARGUMENTS', 'EXPORT_INVALID_REQUEST', 'EXPORT_INVALID_DIRECTORY', 'EXPORT_INVALID_FILENAME', 'EXPORT_INVALID_CONTENT',
  'EXPORT_LIMIT_EXCEEDED', 'EXPORT_INVALID_CONFIRMATION', 'EXPORT_REQUEST_CONFLICT', 'EXPORT_DIRECTORY_CHANGED', 'EXPORT_UNSAFE_TARGET', 'EXPORT_TARGET_CHANGED']);

export function directoryBreadcrumbs(directory) {
  if (typeof directory !== 'string' || !directory) return [];
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(directory), separator = windows ? '\\' : '/';
  const normalized = windows ? directory.replaceAll('/', '\\') : directory;
  const root = windows ? (/^[a-z]:\\/i.exec(normalized)?.[0] || /^\\\\[^\\]+\\[^\\]+\\?/.exec(normalized)?.[0]) : normalized.startsWith('/') ? '/' : null;
  if (!root) return [{ name: directory, path: directory }];
  const crumbs = [{ name: root, path: root }];
  let current = root;
  for (const name of normalized.slice(root.length).split(separator).filter(Boolean)) {
    current = current.endsWith(separator) ? current + name : current + separator + name;
    crumbs.push({ name, path: current });
  }
  return crumbs;
}

function renderExportView({ document, onAction, onFilename, onLocation }) {
  if (!document?.body || typeof document.createElement !== 'function') throw fail('The Save As dialog is unavailable in this environment.', 'EXPORT_DIALOG_UNAVAILABLE');
  const dialog = document.createElement('dialog');
  dialog.className = 'design-dialog codex-export-dialog';
  dialog.setAttribute('aria-labelledby', 'codex-export-title');
  let current, composition = null, ignoreCompositionSubmit = false;
  const inputField = target => target?.matches?.('[data-export-field="location"]') ? 'location'
    : target?.matches?.('[data-export-field="filename"]') ? 'filename' : null;
  const updateField = (field, value) => {
    if (field === 'filename' && value !== current?.filename) { onFilename(value); return true; }
    if (field === 'location' && value !== current?.locationInput) { onLocation(value); return true; }
    return false;
  };
  const go = () => {
    if (!current?.loading && !current?.saving && !current?.uncertain && !current?.restartRequired && !current?.result) onAction('go');
  };
  dialog.addEventListener('click', event => {
    if (!composition) ignoreCompositionSubmit = false;
    const button = event.target.closest('[data-export-action]');
    if (button && !button.disabled) onAction(button.dataset.exportAction, button.dataset.path);
  });
  dialog.addEventListener('input', event => {
    const field = inputField(event.target);
    if (!field) return;
    if (composition || event.isComposing) {
      composition = { field, value: event.target.value };
      return;
    }
    updateField(field, event.target.value);
  });
  dialog.addEventListener('compositionstart', event => {
    const field = inputField(event.target);
    if (field) composition = { field, value: event.target.value };
  });
  dialog.addEventListener('compositionend', event => {
    const field = inputField(event.target);
    if (!field || !composition) return;
    composition = null;
    if (!updateField(field, event.target.value)) view.render(current);
  });
  dialog.addEventListener('keydown', event => {
    const field = inputField(event.target);
    if (!field) return;
    if (event.isComposing || event.keyCode === 229 || composition) {
      // Let the IME commit text. Its Enter must never become Go or Save.
      if (event.key === 'Enter' || event.keyCode === 229) ignoreCompositionSubmit = true;
      return;
    }
    ignoreCompositionSubmit = false;
    if (event.key === 'Enter' && field === 'location') { event.preventDefault(); go(); }
  });
  dialog.addEventListener('keyup', event => {
    if (event.key === 'Enter' || event.keyCode === 229) queueMicrotask(() => { ignoreCompositionSubmit = false; });
  });
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    if (composition || ignoreCompositionSubmit) return;
    // A programmatic/assistive implicit submit in Location is navigation too.
    // Clicking the explicit Save submitter still saves after folder validation.
    if (inputField(document.activeElement) === 'location' && !event.submitter) go();
    else onAction('save');
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); onAction(current?.result ? 'done' : 'cancel'); });
  document.body.append(dialog);
  const view = {
    render(model) {
      current = model;
      if (composition) return;
      const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
      const focusField = focused?.dataset.exportField;
      const selection = focused ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
      const locked = model.saving || model.uncertain || model.restartRequired;
      const disabled = locked ? ' disabled' : '';
      if (model.result) {
        dialog.innerHTML = '<section class="dialog-form"><header><h2 id="codex-export-title">Export saved</h2></header><p class="dialog-description">Saved to</p><output class="export-saved-path">' + escape(model.result.path) + '</output><p class="field-hint">' + escape(model.result.bytes.toLocaleString()) + ' bytes</p><footer><button type="button" class="button primary" data-export-action="done" autofocus>Done</button></footer></section>';
      } else {
        const locationList = model.locations.map(location => '<button type="button" class="export-place' + (location.path === model.directory ? ' is-selected' : '') + '" data-export-action="location" data-path="' + escape(location.path) + '" title="' + escape(location.path) + '"' + (locked || model.loading ? ' disabled' : '') + '>' + escape(location.label) + '</button>').join('');
        const breadcrumbs = directoryBreadcrumbs(model.directory).map((crumb, index, values) => '<button type="button" data-export-action="location" data-path="' + escape(crumb.path) + '" title="' + escape(crumb.path) + '"' + (locked || model.loading ? ' disabled' : '') + (index === values.length - 1 ? ' aria-current="location"' : '') + '>' + escape(crumb.name) + '</button>').join('<span aria-hidden="true">/</span>');
        const folders = model.entries.map(entry => '<button type="button" class="export-folder" data-export-action="location" data-path="' + escape(entry.path) + '"' + (locked || model.loading ? ' disabled' : '') + '><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7V5h7l2 2h9v13H3z"/></svg><span>' + escape(entry.name) + '</span></button>').join('');
        const collision = model.collision ? '<section class="export-collision" aria-labelledby="export-replace-title"><h3 id="export-replace-title">Replace existing file?</h3><p>' + (model.collisionChanged ? 'The file changed since the previous confirmation. Review it before replacing.' : 'A file already exists at this location.') + '</p><p class="export-target-path">' + escape(model.collision.path) + '</p><p class="field-hint">' + escape(Number(model.collision.existing?.size || 0).toLocaleString()) + ' bytes · ' + escape(model.collision.existing?.modifiedAt || 'Unknown modification time') + '</p><div><button type="button" class="button secondary" data-export-action="rename"' + disabled + '>Choose another name</button><button type="button" class="button destructive" data-export-action="replace"' + disabled + '>Replace</button></div></section>' : '';
        dialog.innerHTML = '<form class="dialog-form"><header><h2 id="codex-export-title">Save As</h2><button type="button" class="icon-button" data-export-action="cancel" aria-label="Close Save As"' + (model.saving ? ' disabled' : '') + '>×</button></header><div class="export-location-row"><label for="export-location">Location</label><div><input id="export-location" data-export-field="location" value="' + escape(model.locationInput) + '" spellcheck="false" autocomplete="off"' + disabled + '><button type="button" class="button secondary" data-export-action="go"' + (locked || model.loading ? ' disabled' : '') + '>Go</button></div></div><div class="export-browser"><nav class="export-places" aria-label="Export locations">' + locationList + '</nav><section class="export-directory"><div class="export-directory-toolbar"><button type="button" class="button secondary" data-export-action="up"' + (!model.parent || locked || model.loading ? ' disabled' : '') + '>Up</button><button type="button" class="button secondary" data-export-action="home"' + (!model.home || locked || model.loading ? ' disabled' : '') + '>Home</button><nav class="export-breadcrumbs" aria-label="Current folder">' + breadcrumbs + '</nav></div><div class="export-folders" aria-label="Folders" aria-busy="' + model.loading + '">' + (model.loading ? '<p class="field-hint" role="status">Loading folders…</p>' : folders || '<p class="field-hint">No subfolders</p>') + '</div>' + (model.nextCursor ? '<button type="button" class="button secondary export-more" data-export-action="more"' + (locked || model.loading ? ' disabled' : '') + '>More folders</button>' : '') + '</section></div><label class="export-filename" for="export-filename">File name<input id="export-filename" data-export-field="filename" value="' + escape(model.filename) + '" spellcheck="false" autocomplete="off"' + disabled + '></label>' + collision + (model.uncertain ? '<p class="export-uncertain" role="status">The save result could not be confirmed. The file may already exist at the chosen location. Check save to retry this same operation safely.</p>' : '') + (model.error ? '<p class="dialog-error export-error" role="alert">' + escape(model.error) + '</p>' : '') + '<footer><button type="button" class="button secondary" data-export-action="cancel"' + (model.saving ? ' disabled' : '') + '>' + (model.uncertain || model.restartRequired ? 'Close' : 'Cancel') + '</button>' + (!model.collision && !model.restartRequired ? '<button type="submit" class="button primary"' + (model.saving || model.loading || !model.directory || !model.filename.trim() ? ' disabled' : '') + '>' + (model.saving ? 'Saving…' : model.uncertain ? 'Check save' : 'Save') + '</button>' : '') + '</footer></form>';
      }
      if (!dialog.open) dialog.showModal();
      if (model.result) dialog.querySelector('[data-export-action="done"]')?.focus();
      else if (focusField) {
        const field = dialog.querySelector('[data-export-field="' + focusField + '"]');
        field?.focus();
        if (typeof selection?.start === 'number') field?.setSelectionRange?.(selection.start, typeof selection.end === 'number' ? selection.end : selection.start, selection.direction || 'none');
      }
    },
    close() { if (dialog.open) dialog.close(); },
    destroy() { if (dialog.open) dialog.close(); dialog.remove(); },
  };
  return view;
}

/** One themed Save As surface serializes native exports without a host download fallback. */
export function createExportDialog({ invoke, document = globalThis.document, createId = () => globalThis.crypto.randomUUID(), viewFactory = renderExportView } = {}) {
  if (typeof invoke !== 'function') throw new TypeError('An export API connection is required.');
  const queue = [];
  let active = null, disposed = false, view;
  const current = entry => !disposed && active === entry;
  const render = entry => { if (current(entry)) view.render(structuredClone(entry.model)); };
  const changeTarget = entry => { entry.requestId = createId(); entry.retryToken = undefined; entry.model.collision = null; entry.model.collisionChanged = false; entry.model.error = ''; };
  const finish = (entry, result, error) => {
    if (active !== entry) return;
    active = null;
    view?.close();
    error ? entry.reject(error) : entry.resolve(result);
    if (!disposed) queueMicrotask(pump);
  };
  const observe = (entry, promise) => { void promise.catch(error => { if (current(entry)) finish(entry, entry.model.result, entry.model.result ? null : error); }); };
  const navigate = async (entry, requested, append = false) => {
    if (!current(entry) || entry.model.saving || entry.model.uncertain || entry.model.restartRequired || entry.model.loading && append) return false;
    const directory = String(requested ?? '').trim();
    if (!absolute(directory)) { entry.model.error = 'Enter an absolute folder path.'; render(entry); return false; }
    const sequence = ++entry.navigation;
    entry.model.loading = true; entry.model.error = ''; render(entry);
    try {
      const value = await invoke('export.listDirectory', { path: directory, ...(append && entry.model.nextCursor ? { cursor: entry.model.nextCursor } : {}) });
      if (!current(entry) || sequence !== entry.navigation) return false;
      if (!value || typeof value.path !== 'string' || !Array.isArray(value.entries)) throw fail('The folder response is invalid.', 'EXPORT_DIRECTORY_INVALID');
      if (!append && value.path !== entry.model.directory) changeTarget(entry);
      const entries = append ? [...entry.model.entries, ...value.entries] : value.entries;
      entry.model.directory = value.path; entry.model.locationInput = value.path; entry.model.parent = value.parent || null;
      entry.model.entries = [...new Map(entries.filter(item => typeof item?.name === 'string' && typeof item?.path === 'string').map(item => [item.path, item])).values()];
      entry.model.nextCursor = value.nextCursor || null;
      return true;
    } catch (error) { if (current(entry) && sequence === entry.navigation) entry.model.error = error.message || 'The folder could not be opened.'; return false; }
    finally { if (current(entry) && sequence === entry.navigation) { entry.model.loading = false; render(entry); } }
  };
  const initialize = async entry => {
    entry.model.loading = true; render(entry);
    try {
      const value = await invoke('export.locations', {});
      if (!current(entry)) return;
      if (!value || !Array.isArray(value.locations) || value.defaultDirectory !== null && typeof value.defaultDirectory !== 'string') throw fail('Export locations are unavailable.', 'EXPORT_LOCATIONS_INVALID');
      entry.model.locations = value.locations.filter(item => typeof item?.id === 'string' && typeof item?.label === 'string' && typeof item?.path === 'string');
      entry.model.home = entry.model.locations.find(item => item.id === 'home')?.path || value.defaultDirectory || null;
      entry.model.loading = false;
      if (value.defaultDirectory) await navigate(entry, value.defaultDirectory);
      else render(entry);
    } catch (error) { if (current(entry)) { entry.model.loading = false; entry.model.error = error.message || 'Export locations could not be loaded.'; render(entry); } }
  };
  const save = async (entry, replace = false) => {
    if (!current(entry) || entry.model.saving || entry.model.loading || entry.model.result || entry.model.restartRequired) return;
    if (entry.model.collision && !replace) return;
    if (!entry.model.uncertain && entry.model.locationInput.trim() !== entry.model.directory) {
      if (!await navigate(entry, entry.model.locationInput) || !current(entry)) return;
    }
    if (!entry.model.directory || !entry.model.filename.trim()) { entry.model.error = 'Choose a folder and file name.'; render(entry); return; }
    const token = replace ? entry.model.collision?.overwriteToken : entry.retryToken;
    entry.retryToken = token;
    entry.model.saving = true; entry.model.error = ''; render(entry);
    try {
      const value = await invoke('export.save', { ...entry.resource, requestId: entry.requestId, directory: entry.model.directory, filename: entry.model.filename,
        ...(token ? { overwriteToken: token } : {}) });
      if (!current(entry)) return;
      if (value?.saved === true && typeof value.path === 'string' && typeof value.filename === 'string' && Number.isSafeInteger(value.bytes) && value.bytes >= 0) {
        entry.model.result = value; entry.model.uncertain = false; entry.model.collision = null;
      } else if (value?.saved === false && value.exists === true && typeof value.path === 'string' && typeof value.overwriteToken === 'string' && value.overwriteToken) {
        entry.model.collision = value; entry.model.collisionChanged = Boolean(token); entry.model.uncertain = false; entry.retryToken = undefined;
      } else throw fail('The save result could not be confirmed.', 'EXPORT_UNCONFIRMED');
    } catch (error) {
      if (current(entry)) {
        entry.model.error = error.message || 'The export could not be saved.';
        entry.model.restartRequired = ['EXPORT_REQUEST_CONFLICT', 'EXPORT_RESULT_CHANGED', 'EXPORT_INVALID_STATE'].includes(error.code);
        if (entry.model.restartRequired) entry.terminalError = error;
        entry.model.uncertain = !entry.model.restartRequired && !noWriteFailures.has(error.code);
        if (entry.model.uncertain) entry.model.collision = null;
      }
    } finally { if (current(entry)) { entry.model.saving = false; render(entry); } }
  };
  const onAction = (action, path) => {
    const entry = active;
    if (!entry) return;
    if (action === 'done' && entry.model.result) return finish(entry, entry.model.result);
    if (action === 'cancel') {
      if (entry.model.saving) return;
      if (entry.model.result) return finish(entry, entry.model.result);
      if (entry.model.restartRequired) return finish(entry, null, entry.terminalError);
      return finish(entry, null, entry.model.uncertain ? fail('The export may already have been saved. Check the selected folder.', 'EXPORT_UNCONFIRMED') : fail('Export cancelled.', 'DOWNLOAD_CANCELLED'));
    }
    if (entry.model.result || entry.model.saving || entry.model.restartRequired) return;
    if (action === 'save' || action === 'replace') return observe(entry, save(entry, action === 'replace'));
    if (entry.model.uncertain) return;
    if (action === 'rename') { entry.model.collision = null; entry.retryToken = undefined; render(entry); return; }
    if (action === 'go') return observe(entry, navigate(entry, entry.model.locationInput));
    if (action === 'location') return observe(entry, navigate(entry, path));
    if (action === 'up' && entry.model.parent) return observe(entry, navigate(entry, entry.model.parent));
    if (action === 'home' && entry.model.home) return observe(entry, navigate(entry, entry.model.home));
    if (action === 'more' && entry.model.nextCursor) return observe(entry, navigate(entry, entry.model.directory, true));
  };
  function pump() {
    if (disposed || active || !queue.length) return;
    const entry = active = queue.shift();
    try {
      view ??= viewFactory({ document, onAction,
        onFilename(value) { if (active && !active.model.saving && !active.model.uncertain && !active.model.restartRequired && !active.model.result) { active.model.filename = value; changeTarget(active); render(active); } },
        onLocation(value) { if (active && !active.model.saving && !active.model.uncertain && !active.model.restartRequired && !active.model.result) { active.model.locationInput = value; render(active); } },
      });
      observe(entry, initialize(entry));
    } catch (error) { finish(entry, null, error); }
  }
  return {
    save(resource) {
      if (disposed) return Promise.reject(fail('The export dialog has closed.', 'BRIDGE_UNAVAILABLE'));
      const same = [active, ...queue].find(entry => entry && ['filename', 'mimeType', 'text', 'base64'].every(key => entry.resource[key] === resource[key]));
      if (same) return same.promise;
      if (queue.length + Number(Boolean(active)) >= 3) return Promise.reject(fail('Finish the current exports before starting another.', 'EXPORT_BUSY'));
      const entry = { resource: Object.freeze({ ...resource }), navigation: 0, requestId: createId(), model: { filename: resource.filename, locations: [], directory: '', locationInput: '', parent: null, entries: [], nextCursor: null, home: null, loading: true, saving: false, uncertain: false, restartRequired: false, error: '', collision: null, collisionChanged: false, result: null } };
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      queue.push(entry); pump();
      return entry.promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) {
        const entry = active; active = null;
        if (entry.model.result) entry.resolve(entry.model.result);
        else entry.reject(entry.terminalError || (entry.model.saving || entry.model.uncertain ? fail('The export save result could not be confirmed before the connection closed.', 'EXPORT_UNCONFIRMED') : fail('Export cancelled.', 'DOWNLOAD_CANCELLED')));
      }
      for (const entry of queue.splice(0)) entry.reject(fail('Export cancelled.', 'DOWNLOAD_CANCELLED'));
      view?.destroy();
    },
  };
}
