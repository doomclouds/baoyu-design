import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLibraryStore } from '../source/library/index.mjs';
import { createArtifactThumbnail } from '../source/library/thumbnail.mjs';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const css = await fs.readFile(new URL('../source/ui/styles.css', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(escaped + '\\s*\\{([^}]+)\\}', 'g'))];
  assert.equal(matches.length, 1, `One unambiguous ${selector} rule is expected.`);
  return Object.fromEntries(matches[0][1].split(';').filter(value => value.trim()).map(value => {
    const colon = value.indexOf(':'); return [value.slice(0, colon).trim(), value.slice(colon + 1).trim()];
  }));
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-thumbnail-edge-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), temporary);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const store = createLibraryStore({ root: path.join(temporary, 'Library') });
  await store.initialize();
  return store;
}

test('grid separators do not reduce a 16:9 preview viewport at integer or fractional card widths', () => {
  const preview = rule('.card-open .design-thumbnail');
  const caption = rule('.card-open .record-copy');
  assert.equal(preview['aspect-ratio'], '16/9');
  const baseBorder = Number.parseFloat(preview.border || '0');
  const border = side => Number.parseFloat(preview['border-' + side] || preview['border-' + side + '-width'] || String(baseBorder));
  const [aspectWidth, aspectHeight] = preview['aspect-ratio'].split('/').map(Number);
  for (const width of [260, 381.375, 692, 692.25, 1031.5]) {
    const contentWidth = width - border('left') - border('right');
    const contentHeight = width * aspectHeight / aspectWidth - border('top') - border('bottom');
    assert.ok(Math.abs(contentWidth / contentHeight - aspectWidth / aspectHeight) < 1e-9,
      `The border-box preview must not manufacture letterboxing at width ${width}.`);
  }
  assert.match(caption['border-top'], /^1px solid /, 'The separator belongs to metadata, outside the artwork viewport.');
  assert.equal(rule('.thumbnail-frame').background, 'transparent', 'Unused fit area must not expose an unrelated pale frame color.');
});

test('navy and white slide previews keep their full artwork background inside transparent framing without editing the source', async t => {
  const store = await fixture(t);
  for (const [name, background] of [['Navy', '#0a1025'], ['White', '#fff'], ['Default white', null]]) {
    const item = await store.create({ kind: 'slides', title: name });
    const source = `<section id="cover"${background ? ` style="background:${background};color:${background === '#0a1025' ? '#fff' : '#111'}"` : ''}><h1>${name} 原始作品</h1><p>Keep both canvas edges.</p></section>`;
    const file = path.join(item.path, 'project/slides/cover.html');
    await fs.writeFile(file, source);
    const before = sha(await fs.readFile(file));
    const preview = await createArtifactThumbnail(store, item.id);
    const frame = /<svg class="codex-cover-svg"[^>]+>/.exec(preview.srcdoc)?.[0];
    assert.match(frame, /viewBox="0 0 1920 1080"/);
    assert.match(frame, /preserveAspectRatio="xMidYMid meet"/);
    assert.match(preview.srcdoc, /<head>[\s\S]*?html,body\{background:transparent\}/);
    assert.match(preview.srcdoc, /<foreignObject[^>]+><div[^>]+class="codex-cover-surface"[^>]+style="[^"]*background:#fff"/,
      'The ordinary white canvas fallback is bounded by the original artwork viewBox.');
    if (background) assert.ok(preview.srcdoc.includes(`background:${background};color:`));
    assert.ok(preview.srcdoc.includes(name + ' 原始作品'));
    assert.equal(sha(await fs.readFile(file)), before);
    assert.equal(await fs.readFile(file, 'utf8'), source);
  }
});

test('non-16:9 artboards and design-system covers stay contained without replacing authored background styles', async t => {
  const store = await fixture(t);
  for (const [kind, dimensions] of [['design', [1440, 780]], ['design-system', [960, 288]]]) {
    const item = await store.importArtifact({ sourcePath: path.join(examples, kind), kind });
    const before = new Map();
    for (const file of await store.listFiles(item.id)) before.set(file.path, sha((await store.readFile(item.id, file.path, { encoding: 'base64' })).data));
    const preview = await createArtifactThumbnail(store, item.id);
    assert.deepEqual([preview.previewWidth, preview.previewHeight], dimensions);
    const frame = /<svg class="codex-cover-svg"[^>]+>/.exec(preview.srcdoc)?.[0];
    assert.ok(frame.includes(`viewBox="0 0 ${dimensions.join(' ')}"`));
    assert.match(frame, /preserveAspectRatio="xMidYMid meet"/);
    assert.doesNotMatch(frame, /\bslice\b/);
    assert.ok(preview.srcdoc.includes(kind === 'design' ? 'Good coffee' : 'Nimbus'));
    for (const [file, hash] of before) assert.equal(sha((await store.readFile(item.id, file, { encoding: 'base64' })).data), hash);
  }
});

test('authored document background rules remain visible instead of being covered by the default white canvas', async t => {
  const store = await fixture(t);
  for (const selector of ['body', ':root', 'html[data-theme="dark"]', '.theme body']) {
    const item = await store.create({ kind: 'slides', title: 'Document background' });
    const source = `<style>${selector}{background:#173354;color:#fff}</style><section id="cover"><h1>Keep document color</h1></section>`;
    await fs.writeFile(path.join(item.path, 'project/slides/cover.html'), source);
    const preview = await createArtifactThumbnail(store, item.id);
    assert.ok(preview.srcdoc.includes('background:#173354;color:#fff'));
    assert.match(preview.srcdoc, /class="codex-cover-surface"[^>]+style="[^"]*background:transparent"/);
    assert.doesNotMatch(preview.srcdoc, /background:transparent!important/,
      'The frame default must not override a deliberate document background.');
  }
  const item = await store.create({ kind: 'slides', title: 'Only a child background' });
  await fs.writeFile(path.join(item.path, 'project/slides/cover.html'), '<style>body .tile{background:#173354}</style><section id="cover"><div class="tile">A tile on a normal white canvas</div></section>');
  const preview = await createArtifactThumbnail(store, item.id);
  assert.match(preview.srcdoc, /class="codex-cover-surface"[^>]+style="[^"]*background:#fff"/);
  await fs.writeFile(path.join(item.path, 'project/slides/cover.html'), '<style>@media (min-width:1px){body{background-color:#173354}}</style><section id="cover">Nested document background</section>');
  const nested = await createArtifactThumbnail(store, item.id);
  assert.match(nested.srcdoc, /class="codex-cover-surface"[^>]+style="[^"]*background:transparent"/);
});

test('a large unfinished stylesheet cannot trap the thumbnail background check in a rule-search retry', { timeout: 5000 }, async t => {
  const store = await fixture(t), item = await store.create({ kind: 'slides', title: 'Incomplete CSS' });
  const file = path.join(item.path, 'project/slides/cover.html');
  await fs.writeFile(file, '<style>' + 'body '.repeat(20_000) + '{</style><section id="cover">Readable cover</section>');
  const preview = await createArtifactThumbnail(store, item.id);
  assert.ok(preview.srcdoc.includes('Readable cover'));
  assert.match(preview.srcdoc, /class="codex-cover-surface"[^>]+style="[^"]*background:#fff"/);
});
