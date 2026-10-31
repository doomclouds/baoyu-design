import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const createdAt = '2026-10-31T00:00:00.000Z';
const marker = { v: 1, at: createdAt };

async function write(root, relative, text) {
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
}

/** Make a disposable, valid project for a real editor. No installed skill files are changed. */
export async function createFixture(kind, parentDir = tmpdir()) {
  if (!['slides', 'design', 'design-system', 'dashboard'].includes(kind)) throw new Error(`Unknown fixture: ${kind}`);
  await mkdir(parentDir, { recursive: true });
  const root = await mkdtemp(path.join(parentDir, `codex-design-test-${kind}-`));
  const title = `Codex Design ${kind} verification`;
  const fixture = { root, kind, skill: `codex-${kind}`, sourceSkill: `claude-${kind}`, title };
  if (kind === 'slides') {
    fixture.indexFile = 'project/deck.json';
    fixture.contentFile = 'project/slides/cover.html';
    await write(root, fixture.indexFile, {
      v: 4, createdOnFiles: marker, lists: 'css', title,
      order: ['cover'], cover: 'cover', sections: { s1: { description: 'Verify the installed editor.', start: 'cover' } },
      faces: {}, designSystems: [],
    });
    await write(root, fixture.contentFile, '<section id="cover" style="background:#ffffff;color:#172033;font-family:Arial, sans-serif;padding:128px;display:flex;flex-direction:column;gap:48px"><h1 style="font-size:80px;font-weight:600;line-height:1.1">Codex Design verification</h1><p style="font-size:32px;line-height:1.4">A local presentation with editable content.</p><aside>Disposable installation verification fixture.</aside></section>\n');
    fixture.comment = { anchor: 'slide:cover', label: 'Cover slide', detail: 'slide 1, cover' };
  } else if (kind === 'design') {
    fixture.indexFile = 'project/canvas.json';
    fixture.contentFile = 'project/Main.dc.html';
    await write(root, fixture.indexFile, {
      v: 3, createdOnFiles: marker, title, launch: { view: 'canvas' }, pages: [],
      boards: { 'Main.dc.html': { x: 0, y: 0, w: 880, h: 560, title: 'Verification board' } },
      order: ['Main.dc.html'], notes: {}, designSystems: [],
    });
    await write(root, fixture.contentFile, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Verification board</title><script src="./support.js"></script></head><body><x-dc><helmet><style>body { margin: 0; }</style></helmet><div style="padding:48px;font-family:Arial, sans-serif;color:#172033;background:#ffffff"><h1 style="font-size:48px">Codex Design verification</h1><p style="font-size:24px">An editable local artboard.</p></div></x-dc><script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":880,"height":560}}'>class Component extends DCLogic { renderVals() { return {}; } }</script></body></html>\n`);
    fixture.comment = { anchor: 'board:Main.dc.html', label: 'Verification board', detail: 'Main.dc.html heading' };
  } else if (kind === 'design-system') {
    fixture.indexFile = 'project/design-system.json';
    fixture.contentFile = 'project/README.md';
    await write(root, fixture.indexFile, {
      v: 3, layout: 'files', createdOnFiles: marker, title, namespace: 'CodexVerification',
      libraries: [], sections: {}, groups: [], assetGroups: {}, blobs: {}, docs: { readme: 'project/README.md', sections: [] },
    });
    await write(root, fixture.contentFile, '# Codex Design verification\n\nA small local design system for installation verification.\n');
    await write(root, 'project/tokens.json', {
      name: title, version: 1,
      color: { themes: [{ id: 'light', name: 'Light' }], tokens: [{ name: 'surface', value: '#ffffff', usage: 'Page background.' }, { name: 'ink', value: '#172033', usage: 'Text.' }] },
      type: { fonts: [], families: { sans: 'Arial, sans-serif' }, groups: [{ name: 'Text', family: 'sans', styles: [{ name: 'body', fontSize: '16px', lineHeight: '24px', fontWeight: 400 }] }] },
      spacing: { tokens: [{ name: 'space-4', value: '16px', usage: 'Card padding.' }] },
    });
    await write(root, 'project/components/Cover/preview.html', '<!-- @dsCard group="Overview" height=160 -->\n<div style="padding:24px;font-family:Arial, sans-serif"><h1>Codex Design verification</h1><p>Local design-system editor.</p></div>\n');
    fixture.comment = { anchor: 'token:ink', label: 'Ink token', detail: 'tokens.json ink token' };
  } else {
    fixture.indexFile = 'db/dash/meta.json';
    fixture.contentFile = 'db/files/index.html.json';
    const csv = 'month,value\nOctober,120\nNovember,150\n';
    const blobId = createHash('sha256').update(csv).digest('hex').slice(0, 32);
    await write(root, `_blobs/${blobId}`, csv);
    await write(root, `_blobs/${blobId}.json`, { name: 'verification.csv', contentType: 'text/csv', bytes: Buffer.byteLength(csv) });
    await write(root, fixture.indexFile, { title });
    await write(root, 'db/datasets/revenue.json', {
      title: 'Monthly revenue', description: 'Disposable test data for editor verification.',
      source: { kind: 'file', url: `/_blob/${blobId}`, name: 'verification.csv', format: 'csv' },
      updated: { at: createdAt, by: 'Codex verification' },
    });
    await write(root, fixture.contentFile, {
      text: '<style>body{font-family:Arial,sans-serif;color:#172033;background:#fff;padding:40px}h1{font-size:36px}.metric{font-size:48px}</style><h1>Codex Design verification</h1><p>Monthly revenue</p><p class="metric" data-source="revenue" data-field="value" data-row="0">120</p>',
    });
    fixture.comment = { anchor: 'metric:revenue', label: 'Revenue metric', detail: 'October revenue value' };
  }
  return fixture;
}
