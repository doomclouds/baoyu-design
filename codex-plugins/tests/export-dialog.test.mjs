import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createExportDialog, directoryBreadcrumbs } from '../source/ui/export-dialog.mjs';
import { createLibraryTransfer } from '../source/ui/library-transfer.mjs';

const resource = { filename: 'Report.pdf', mimeType: 'application/pdf', base64: 'JVBERg==' };
const locations = { locations: [{ id: 'home', label: 'Home', path: '/home/user' }, { id: 'downloads', label: 'Downloads', path: '/home/user/Downloads' }], defaultDirectory: '/home/user/Downloads' };
const listing = directory => ({ path: directory, parent: directory.slice(0, directory.lastIndexOf('/')) || '/', entries: [{ name: 'Reports', path: directory + '/Reports' }] });
const saved = payload => ({ saved: true, path: payload.directory + '/' + payload.filename, filename: payload.filename, bytes: 4 });
async function settled(predicate) { for (let index = 0; index < 40 && !predicate(); index++) await setImmediate(); assert.ok(predicate(), 'the expected dialog transition completed'); }
function fixture(t, handler) {
  let handlers, model, ids = 0, closes = 0, destroyed = false;
  const calls = [], models = [];
  const dialog = createExportDialog({
    createId: () => '11111111-1111-4111-8111-' + String(++ids).padStart(12, '0'),
    async invoke(action, payload) {
      calls.push({ action, payload: structuredClone(payload) });
      const custom = await handler?.(action, payload, calls);
      if (custom !== undefined) return custom;
      if (action === 'export.locations') return locations;
      if (action === 'export.listDirectory') return listing(payload.path);
      if (action === 'export.save') return saved(payload);
      throw new Error('Unexpected export action: ' + action);
    },
    viewFactory(value) { handlers = value; return { render(value) { model = value; models.push(value); }, close() { closes++; }, destroy() { destroyed = true; } }; },
  });
  t.after(() => dialog.dispose());
  return { dialog, calls, models, get model() { return model; }, get closes() { return closes; }, get destroyed() { return destroyed; },
    open(value = resource) { const promise = dialog.save(value); promise.catch(() => {}); return promise; },
    action(action, path) { handlers.onAction(action, path); }, filename(value) { handlers.onFilename(value); }, location(value) { handlers.onLocation(value); } };
}
const writes = f => f.calls.filter(call => call.action === 'export.save');

test('opening and cancelling Save As reads locations only and never writes or reports Exported', async t => {
  const f = fixture(t), promise = f.open();
  await settled(() => f.model.directory && !f.model.loading);
  assert.equal(f.model.filename, 'Report.pdf');
  assert.deepEqual(f.calls.map(call => call.action), ['export.locations', 'export.listDirectory']);
  f.action('cancel');
  await assert.rejects(promise, { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(writes(f).length, 0);
  assert.equal(f.models.some(model => model.result), false);
});

test('Save As browses named locations, folders, parent, Home, other disks and paginated directories', async t => {
  const f = fixture(t, (action, payload) => action === 'export.listDirectory' && payload.path === 'D:\\Work' ? {
    path: 'D:\\Work', parent: 'D:\\', entries: [{ name: payload.cursor ? 'Second' : 'First', path: 'D:\\Work\\' + (payload.cursor ? 'Second' : 'First') }], ...(payload.cursor ? {} : { nextCursor: 'page-two' }),
  } : undefined);
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('location', '/home/user/Downloads/Reports'); await settled(() => f.model.directory.endsWith('/Reports') && !f.model.loading);
  f.action('up'); await settled(() => f.model.directory === '/home/user/Downloads' && !f.model.loading);
  f.action('home'); await settled(() => f.model.directory === '/home/user' && !f.model.loading);
  f.location('relative/path'); f.action('go');
  assert.match(f.model.error, /absolute/);
  f.location('D:\\Work'); f.action('go'); await settled(() => f.model.directory === 'D:\\Work' && !f.model.loading);
  assert.equal(f.model.nextCursor, 'page-two');
  f.action('more'); await settled(() => !f.model.loading && f.model.entries.length === 2);
  assert.deepEqual(f.model.entries.map(entry => entry.name), ['First', 'Second']);
  assert.equal(f.calls.find(call => call.payload.cursor)?.payload.cursor, 'page-two');
  assert.equal(writes(f).length, 0);
  f.action('cancel'); await assert.rejects(promise, { code: 'DOWNLOAD_CANCELLED' });
});

test('a chosen directory and editable filename are saved once and actual completed path remains until Done', async t => {
  const f = fixture(t), promise = f.open();
  let completed = false; promise.then(() => { completed = true; });
  await settled(() => f.model.directory && !f.model.loading);
  f.filename('Final 作品.pdf'); f.location('/home/user/Reports');
  f.action('save'); f.action('save');
  await settled(() => f.model.result);
  assert.equal(writes(f).length, 1);
  assert.equal(writes(f)[0].payload.filename, 'Final 作品.pdf');
  assert.equal(writes(f)[0].payload.directory, '/home/user/Reports');
  assert.equal(writes(f)[0].payload.base64, resource.base64);
  assert.equal(f.model.result.path, '/home/user/Reports/Final 作品.pdf');
  assert.equal(completed, false, 'a visible completion receipt has not been dismissed');
  f.action('done'); const result = await promise;
  assert.equal(result.saved, true); assert.equal(result.path, '/home/user/Reports/Final 作品.pdf');
});

test('existing files require Replace and a changed target requires another explicit confirmation', async t => {
  let attempts = 0;
  const f = fixture(t, (action, payload) => {
    if (action !== 'export.save') return;
    if (++attempts < 3) return { saved: false, exists: true, path: payload.directory + '/' + payload.filename, overwriteToken: 'token-' + attempts, existing: { size: 19 + attempts, modifiedAt: '2026-11-02T00:00:00Z' } };
  });
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('save'); await settled(() => f.model.collision);
  assert.equal(writes(f).length, 1); assert.equal(writes(f)[0].payload.overwriteToken, undefined);
  f.action('save'); await setImmediate(); assert.equal(writes(f).length, 1);
  f.action('replace'); await settled(() => f.model.collision?.overwriteToken === 'token-2');
  assert.equal(f.model.collisionChanged, true); assert.equal(writes(f).length, 2);
  f.action('replace'); await settled(() => f.model.result);
  assert.deepEqual(writes(f).map(call => call.payload.overwriteToken), [undefined, 'token-1', 'token-2']);
  assert.equal(new Set(writes(f).map(call => call.payload.requestId)).size, 1);
  f.action('done'); await promise;
});

test('renaming a collision target resets its confirmation and request identity without an overwrite', async t => {
  const f = fixture(t, (action, payload) => action === 'export.save' && payload.filename === resource.filename ? { saved: false, exists: true, path: payload.directory + '/' + payload.filename, overwriteToken: 'original-file', existing: { size: 4 } } : undefined);
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('save'); await settled(() => f.model.collision);
  f.filename('Another.pdf'); assert.equal(f.model.collision, null);
  f.action('save'); await settled(() => f.model.result);
  assert.notEqual(writes(f)[0].payload.requestId, writes(f)[1].payload.requestId);
  assert.equal(writes(f)[1].payload.overwriteToken, undefined);
  f.action('done'); await promise;
});

test('a changed name never inherits a previously rejected overwrite token', async t => {
  let attempts = 0;
  const f = fixture(t, (action, payload) => {
    if (action !== 'export.save') return;
    if (++attempts === 1) return { saved: false, exists: true, path: payload.directory + '/' + payload.filename, overwriteToken: 'bound-to-old-name', existing: { size: 4 } };
    if (attempts === 2) throw Object.assign(new Error('The directory changed before saving.'), { code: 'EXPORT_DIRECTORY_CHANGED' });
  });
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('save'); await settled(() => f.model.collision); f.action('replace'); await settled(() => f.model.error && !f.model.saving);
  f.filename('New target.pdf'); f.action('save'); await settled(() => f.model.result);
  assert.equal(writes(f)[2].payload.overwriteToken, undefined);
  assert.notEqual(writes(f)[1].payload.requestId, writes(f)[2].payload.requestId);
  f.action('done'); await promise;
});

test('lost save acknowledgement locks the target and retries the same UUID and bytes instead of writing a new export', async t => {
  let attempts = 0;
  const f = fixture(t, action => { if (action === 'export.save' && ++attempts === 1) throw Object.assign(new Error('Connection closed after save.'), { code: 'TRANSPORT_CLOSED' }); });
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('save'); await settled(() => f.model.uncertain && !f.model.saving);
  assert.match(f.model.error, /Connection closed/);
  f.filename('Do not change.pdf'); f.location('/another'); f.action('home');
  assert.equal(f.model.filename, resource.filename);
  assert.equal(f.model.locationInput, '/home/user/Downloads');
  f.action('save'); await settled(() => f.model.result);
  assert.deepEqual(writes(f)[0].payload, writes(f)[1].payload);
  f.action('done'); await promise;
});

test('definitive validation failures keep Save As editable with no false completed state', async t => {
  const f = fixture(t, (action, payload) => { if (action === 'export.save' && payload.filename === 'bad:filename.pdf') throw Object.assign(new Error('Invalid file name.'), { code: 'EXPORT_INVALID_FILENAME' }); });
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.filename('bad:filename.pdf'); f.action('save'); await settled(() => f.model.error && !f.model.saving);
  assert.equal(f.model.uncertain, false); assert.equal(f.model.result, null);
  f.filename('Valid.pdf'); f.action('save'); await settled(() => f.model.result);
  assert.notEqual(writes(f)[0].payload.requestId, writes(f)[1].payload.requestId);
  f.action('done'); await promise;
});

test('identical exports are single-flight and distinct exports queue without overlapping dialogs', async t => {
  const f = fixture(t), first = f.open(), same = f.open(), second = f.open({ ...resource, filename: 'Other.pdf' });
  assert.equal(first, same);
  await settled(() => f.model.directory && !f.model.loading);
  assert.equal(f.model.filename, 'Report.pdf');
  f.action('cancel'); await assert.rejects(first, { code: 'DOWNLOAD_CANCELLED' });
  await settled(() => f.model.filename === 'Other.pdf' && !f.model.loading);
  f.dialog.dispose(); await assert.rejects(second, { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(f.destroyed, true); assert.equal(writes(f).length, 0);
});

test('cancelling during Save path validation cannot publish a deferred write', async t => {
  let release;
  const f = fixture(t, (action, payload) => action === 'export.listDirectory' && payload.path === '/slow-folder' ? new Promise(resolve => { release = () => resolve(listing('/slow-folder')); }) : undefined);
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.location('/slow-folder'); f.action('save'); await settled(() => f.model.loading && Boolean(release));
  f.action('cancel'); await assert.rejects(promise, { code: 'DOWNLOAD_CANCELLED' });
  release(); await setImmediate(); assert.equal(writes(f).length, 0);
});

test('teardown distinguishes an uncertain in-flight write from an already confirmed saved file', async t => {
  let release;
  const f = fixture(t, action => action === 'export.save' ? new Promise(resolve => { release = resolve; }) : undefined);
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('save'); await settled(() => f.model.saving && Boolean(release));
  f.action('cancel'); assert.equal(f.destroyed, false); assert.equal(f.model.saving, true);
  f.dialog.dispose(); await assert.rejects(promise, { code: 'EXPORT_UNCONFIRMED' });
  release({ saved: true, path: '/home/user/Downloads/Report.pdf', filename: 'Report.pdf', bytes: 4 }); await setImmediate();
  assert.equal(f.models.some(model => model.result), false, 'a destroyed view cannot be reopened by an acknowledgement');
  const confirmed = fixture(t), done = confirmed.open(); await settled(() => confirmed.model.directory && !confirmed.model.loading);
  confirmed.action('save'); await settled(() => confirmed.model.result); confirmed.dialog.dispose();
  assert.equal((await done).path, '/home/user/Downloads/Report.pdf');
});

test('breadcrumbs retain Unix roots, drive roots, UNC shares and user folder names', () => {
  assert.deepEqual(directoryBreadcrumbs('/home/user/Reports'), [{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'user', path: '/home/user' }, { name: 'Reports', path: '/home/user/Reports' }]);
  assert.deepEqual(directoryBreadcrumbs('D:\\Work\\中文'), [{ name: 'D:\\', path: 'D:\\' }, { name: 'Work', path: 'D:\\Work' }, { name: '中文', path: 'D:\\Work\\中文' }]);
  assert.deepEqual(directoryBreadcrumbs('\\\\server\\share\\Folder'), [{ name: '\\\\server\\share\\', path: '\\\\server\\share\\' }, { name: 'Folder', path: '\\\\server\\share\\Folder' }]);
});

test('library transfer propagates cancellation and reports the actual renamed saved path', async () => {
  const bundle = { format: 'codex-design-artifact', version: 1, kind: 'design', title: 'Artwork', files: [{ path: 'project/canvas.json', encoding: 'base64', data: 'e30=' }] };
  const cancelled = createLibraryTransfer({ invoke: async () => bundle, download: async () => { throw Object.assign(new Error('Cancelled'), { code: 'DOWNLOAD_CANCELLED' }); } });
  await assert.rejects(cancelled.exportArtifact('artwork'), { code: 'DOWNLOAD_CANCELLED' });
  const transfer = createLibraryTransfer({ invoke: async () => bundle, download: async () => ({ saved: true, path: 'D:\\Exports\\Final.codexdesign.json', filename: 'Final.codexdesign.json', bytes: 42 }) });
  const result = await transfer.exportArtifact('artwork');
  assert.equal(result.path, 'D:\\Exports\\Final.codexdesign.json');
  assert.equal(result.filename, 'Final.codexdesign.json');
});

test('a lost overwrite acknowledgement retains the confirmed token for an idempotent Check save', async t => {
  let attempts = 0;
  const f = fixture(t, (action, payload) => {
    if (action !== 'export.save') return;
    if (++attempts === 1) return { saved: false, exists: true, path: payload.directory + '/' + payload.filename, overwriteToken: 'confirmed-target', existing: { size: 4 } };
    if (attempts === 2) throw new Error('Save acknowledgement lost.');
  });
  const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
  f.action('save'); await settled(() => f.model.collision); f.action('replace'); await settled(() => f.model.uncertain && !f.model.saving);
  assert.equal(f.model.collision, null, 'Check save is reachable instead of disabled Replace controls');
  f.action('save'); await settled(() => f.model.result);
  assert.deepEqual(writes(f)[1].payload, writes(f)[2].payload);
  assert.equal(writes(f)[2].payload.overwriteToken, 'confirmed-target');
  f.action('done'); await promise;
});

test('terminal receipt conflicts require a new export instead of blind replay or target changes', async t => {
  for (const code of ['EXPORT_REQUEST_CONFLICT', 'EXPORT_RESULT_CHANGED', 'EXPORT_INVALID_STATE']) {
    const f = fixture(t, action => { if (action === 'export.save') throw Object.assign(new Error('Close and start a new export.'), { code }); });
    const promise = f.open(); await settled(() => f.model.directory && !f.model.loading);
    f.action('save'); await settled(() => f.model.restartRequired && !f.model.saving);
    f.filename('Different.pdf'); f.action('save'); await setImmediate();
    assert.equal(writes(f).length, 1); assert.equal(f.model.filename, resource.filename);
    f.action('cancel'); await assert.rejects(promise, { code });
  }
});

test('no automatic location still permits an explicit manual destination without claiming the protocol failed', async t => {
  const f = fixture(t, action => action === 'export.locations' ? { locations: [], defaultDirectory: null } : undefined);
  const promise = f.open(); await settled(() => !f.model.loading);
  assert.equal(f.model.directory, ''); assert.equal(f.model.error, '');
  f.location('/chosen/path'); f.action('go'); await settled(() => f.model.directory === '/chosen/path' && !f.model.loading);
  f.action('save'); await settled(() => f.model.result); f.action('done');
  assert.equal((await promise).path, '/chosen/path/Report.pdf');
});

test('the default themed dialog binds filename, folder, Save, Done and Escape controls without browser downloads', async t => {
  const listeners = new Map(), calls = [];
  const element = { innerHTML: '', dataset: {}, open: false, className: '', setAttribute() {},
    addEventListener(name, handler) { listeners.set(name, handler); }, contains() { return false; },
    showModal() { this.open = true; }, close() { this.open = false; }, remove() {}, querySelector() { return { focus() {} }; } };
  const document = { body: { append(value) { assert.equal(value, element); } }, activeElement: null, createElement(name) { assert.equal(name, 'dialog'); return element; } };
  const dialog = createExportDialog({ document, invoke: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'export.locations') return locations;
    if (action === 'export.listDirectory') return { ...listing(payload.path), entries: [{ name: '<Folder>', path: payload.path + '/<Folder>' }] };
    return saved(payload);
  } });
  t.after(() => dialog.dispose());
  const promise = dialog.save(resource);
  await settled(() => element.innerHTML.includes('&lt;Folder&gt;'));
  assert.match(element.className, /design-dialog codex-export-dialog/);
  assert.match(element.innerHTML, /id="codex-export-title">Save As/);
  assert.match(element.innerHTML, /data-export-field="filename"/);
  assert.match(element.innerHTML, /aria-label="Folders"/);
  listeners.get('input')({ target: { value: 'Name & final.pdf', matches: selector => selector === '[data-export-field="filename"]' } });
  assert.match(element.innerHTML, /value="Name &amp; final\.pdf"/);
  const click = (action, path) => listeners.get('click')({ target: { closest: () => ({ disabled: false, dataset: { exportAction: action, path } }) } });
  click('location', '/home/user/Reports'); await settled(() => element.innerHTML.includes('value="/home/user/Reports"'));
  let prevented = false;
  listeners.get('submit')({ preventDefault() { prevented = true; } });
  await settled(() => element.innerHTML.includes('Export saved'));
  assert.equal(prevented, true);
  assert.match(element.innerHTML, /\/home\/user\/Reports\/Name &amp; final\.pdf/);
  click('done'); assert.equal((await promise).filename, 'Name & final.pdf');
  const cancelled = dialog.save(resource); cancelled.catch(() => {});
  await settled(() => element.innerHTML.includes('>Save As<'));
  listeners.get('cancel')({ preventDefault() {} }); await assert.rejects(cancelled, { code: 'DOWNLOAD_CANCELLED' });
  assert.equal(calls.filter(call => call.action === 'export.save').length, 1);
});

function inputView(t, handler) {
  const listeners = new Map(), calls = [], fields = new Map();
  const document = { activeElement: null, body: { append() {} } };
  let html = '', renders = 0, ids = 0;
  const done = { focus() { document.activeElement = done; } };
  const element = {
    open: false, className: '', setAttribute() {}, addEventListener(name, callback) { listeners.set(name, callback); },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; renders++; fields.clear();
      for (const match of value.matchAll(/data-export-field="(location|filename)" value="([^"]*)"/g)) {
        const name = match[1];
        const field = { dataset: { exportField: name }, value: match[2], selectionStart: 0, selectionEnd: 0, selectionDirection: 'none',
          matches(selector) { return selector === '[data-export-field="' + name + '"]'; },
          focus() { document.activeElement = this; },
          setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
        fields.set(name, field);
      }
    },
    contains(target) { return [...fields.values()].includes(target); },
    querySelector(selector) { return selector.includes('done') ? done : fields.get(/data-export-field="([^"]+)"/.exec(selector)?.[1]) || null; },
    showModal() { this.open = true; }, close() { this.open = false; }, remove() {},
  };
  document.createElement = () => element;
  const dialog = createExportDialog({ document, createId: () => '11111111-1111-4111-8111-' + String(++ids).padStart(12, '0'),
    invoke: async (action, payload) => {
      calls.push({ action, payload }); const custom = await handler?.(action, payload);
      if (custom !== undefined) return custom;
      if (action === 'export.locations') return locations;
      if (action === 'export.listDirectory') return listing(payload.path);
      return saved(payload);
    } });
  t.after(() => dialog.dispose());
  const promise = dialog.save(resource); promise.catch(() => {});
  const emit = (name, target, values = {}) => {
    let prevented = false;
    listeners.get(name)?.({ target, preventDefault() { prevented = true; }, ...values });
    return prevented;
  };
  return { calls, promise, element, document, done, get renders() { return renders; }, get ids() { return ids; },
    field: name => fields.get(name), emit,
    input(name, value, values = {}) { const field = fields.get(name); field.focus(); field.value = value; emit('input', field, values); return fields.get(name); },
    enter(name, values = {}) {
      const field = fields.get(name); field.focus();
      const prevented = emit('keydown', field, { key: 'Enter', ...values });
      if (!prevented) emit('submit', null, { submitter: null });
      emit('keyup', fields.get(name), { key: 'Enter', ...values });
      return prevented;
    },
    doneSave() { emit('click', { closest: () => ({ dataset: { exportAction: 'done' } }) }); },
  };
}

test('Location Enter and implicit submits only navigate; filename Enter and explicit Save still save', async t => {
  let release;
  const f = inputView(t, (action, payload) => action === 'export.listDirectory' && payload.path === '/slow' ? new Promise(resolve => { release = () => resolve(listing('/slow')); }) : undefined);
  await settled(() => f.calls.some(call => call.action === 'export.listDirectory') && f.element.innerHTML.includes('aria-busy="false"'));
  f.input('location', '/chosen/folder');
  f.emit('submit', null, { submitter: null });
  await settled(() => f.calls.some(call => call.action === 'export.listDirectory' && call.payload.path === '/chosen/folder') && f.element.innerHTML.includes('aria-busy="false"'));
  assert.equal(f.calls.some(call => call.action === 'export.save'), false, 'implicit Location submit must not write');
  f.input('location', '/slow'); assert.equal(f.enter('location'), true);
  await settled(() => Boolean(release));
  const reads = f.calls.length;
  assert.equal(f.enter('location'), true); f.emit('submit', null, { submitter: null }); await setImmediate();
  assert.equal(f.calls.length, reads, 'Enter during a folder load neither navigates again nor saves');
  release(); await settled(() => f.element.innerHTML.includes('aria-busy="false"'));
  assert.equal(f.enter('filename'), false);
  await settled(() => f.element.innerHTML.includes('Export saved'));
  assert.equal(f.calls.filter(call => call.action === 'export.save').length, 1);
  assert.equal(f.calls.find(call => call.action === 'export.save').payload.directory, '/slow');
  assert.equal(f.document.activeElement, f.done);
  f.doneSave(); await f.promise;
  const explicit = inputView(t); await settled(() => explicit.element.innerHTML.includes('aria-busy="false"'));
  explicit.input('location', '/explicit-save'); explicit.emit('submit', null, { submitter: { type: 'submit' } });
  await settled(() => explicit.element.innerHTML.includes('Export saved'));
  assert.equal(explicit.calls.find(call => call.action === 'export.save').payload.directory, '/explicit-save');
  explicit.doneSave(); await explicit.promise;
});

test('IME composition retains its input DOM, commits the complete Chinese filename once and never turns Enter 229 into Save', async t => {
  const f = inputView(t); await settled(() => f.element.innerHTML.includes('aria-busy="false"'));
  const field = f.field('filename'); field.focus(); field.setSelectionRange(1, 3, 'backward');
  const before = { renders: f.renders, ids: f.ids };
  f.emit('compositionstart', field);
  field.value = '报告 初稿.pdf'; f.emit('input', field, { isComposing: true });
  f.emit('keydown', field, { key: 'Enter', keyCode: 229, isComposing: true });
  f.emit('submit', null, { submitter: null });
  assert.equal(f.renders, before.renders); assert.equal(f.ids, before.ids);
  assert.equal(f.field('filename'), field, 'the active IME input remains connected during composition');
  assert.equal(f.calls.some(call => call.action === 'export.save'), false);
  f.emit('compositionend', field);
  const committed = f.field('filename');
  assert.equal(committed.value, '报告 初稿.pdf'); assert.equal(f.ids, before.ids + 1);
  assert.deepEqual([committed.selectionStart, committed.selectionEnd, committed.selectionDirection], [1, 3, 'backward']);
  const rendered = f.renders;
  f.emit('input', committed, { isComposing: false });
  assert.equal(f.renders, rendered, 'the trailing composition input event does not rebuild the committed field again');
  f.emit('keyup', committed, { key: 'Enter', keyCode: 229 }); await setImmediate();
  f.enter('filename', { keyCode: 229, isComposing: false }); await setImmediate();
  assert.equal(f.calls.some(call => call.action === 'export.save'), false, 'Safari-style keyCode 229 is guarded even without isComposing');
  f.enter('filename'); await settled(() => f.element.innerHTML.includes('Export saved'));
  assert.equal(f.calls.find(call => call.action === 'export.save').payload.filename, '报告 初稿.pdf');
  f.doneSave(); await f.promise;
});

test('Location IME Enter commits text without navigation, then a later ordinary Enter navigates only', async t => {
  const f = inputView(t); await settled(() => f.element.innerHTML.includes('aria-busy="false"'));
  const location = f.field('location'); location.focus(); f.emit('compositionstart', location);
  location.value = '/home/user/报告'; f.emit('input', location, { isComposing: true });
  const before = f.calls.length;
  f.emit('keydown', location, { key: 'Enter', keyCode: 229, isComposing: true }); f.emit('submit', null, { submitter: null });
  assert.equal(f.calls.length, before);
  f.emit('compositionend', location); f.emit('keyup', f.field('location'), { key: 'Enter', keyCode: 229 }); await setImmediate();
  f.enter('location'); await settled(() => f.calls.some(call => call.action === 'export.listDirectory' && call.payload.path === '/home/user/报告'));
  assert.equal(f.calls.some(call => call.action === 'export.save'), false);
  f.emit('cancel', null); await assert.rejects(f.promise, { code: 'DOWNLOAD_CANCELLED' });
});
