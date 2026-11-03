const fail = (code, message) => Object.assign(new Error(message), { code });
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

/** Confirm the exact changed files before the local copy is replaced. */
export function createSystemSyncDialog({ document = globalThis.document } = {}) {
  let active, disposed = false;
  const finish = confirmed => {
    if (!active) return;
    const { dialog, resolve } = active; active = null;
    dialog.close(); dialog.remove(); resolve(confirmed);
  };
  return {
    confirm(detail) {
      if (disposed || !document?.body) return Promise.reject(fail('SYSTEM_SYNC_DIALOG_UNAVAILABLE', 'The synchronization review is unavailable.'));
      if (active) return Promise.reject(fail('SYSTEM_SYNC_BUSY', 'Finish the current synchronization review first.'));
      if (!Array.isArray(detail.changed) || detail.changed.some(file => typeof file !== 'string') || !Array.isArray(detail.removed)) return Promise.reject(fail('SYSTEM_SYNC_INVALID_DIFF', 'The design system differences could not be verified.'));
      const dialog = document.createElement('dialog');
      dialog.className = 'design-dialog codex-system-sync-dialog';
      dialog.setAttribute('aria-labelledby', 'codex-system-sync-title');
      dialog.innerHTML = '<section class="dialog-form"><header><h2 id="codex-system-sync-title">Sync design system?</h2></header>'
        + '<p class="dialog-description">Update ' + escape(detail.title || detail.namespace) + ' in ' + escape(detail.artifactTitle || 'this artwork') + '.</p>'
        + '<p>These ' + detail.changed.length + ' files will be replaced with the source versions. Local changes in these files will be replaced. A recovery point will be saved first.</p>'
        + '<ul style="max-height:240px;overflow:auto;padding-inline-start:24px">' + detail.changed.map(file => '<li><code>' + escape(file) + '</code></li>').join('') + '</ul>'
        + (detail.removed.length ? '<p>' + detail.removed.length + ' files missing from the source will remain in this artwork.</p>' : '')
        + '<footer><button type="button" class="button secondary" data-system-sync="cancel" autofocus>Cancel</button><button type="button" class="button primary" data-system-sync="confirm">Sync files</button></footer></section>';
      const result = new Promise(resolve => { active = { dialog, resolve, artifactId: detail.artifactId }; });
      dialog.addEventListener('click', event => { const button = event.target.closest('[data-system-sync]'); if (button) finish(button.dataset.systemSync === 'confirm'); });
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
      document.body.appendChild(dialog);
      try { dialog.showModal(); } catch (error) { finish(false); return Promise.reject(error); }
      return result;
    },
    cancel(artifactId) { if (active?.artifactId === artifactId) finish(false); },
    dispose() { disposed = true; finish(false); },
  };
}
