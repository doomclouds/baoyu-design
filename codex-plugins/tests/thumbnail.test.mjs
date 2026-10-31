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
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-design-thumbnail-test-'));
  t.after(async () => { const relative = path.relative(os.tmpdir(), temporary); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(temporary, { recursive: true, force: true }); });
  const store = createLibraryStore({ root: path.join(temporary, 'Library') }); await store.initialize(); return { store, temporary };
}
const assertInert = document => {
  assert.doesNotMatch(document, /<script\b|<iframe\b|<object\b|\son[a-z]+\s*=|javascript\s*:|@import\b|url\(\s*["']?https?:/i);
  assert.match(document, /script-src &#39;none&#39;|script-src 'none'/);
  assert.match(document, /connect-src &#39;none&#39;|connect-src 'none'/);
};

test('real Slides, Design and Design System examples yield actual first-screen markup and inline materials', async t => {
  const { store } = await fixture(t);
  const slide = await store.importArtifact({ sourcePath: path.join(examples, 'slides'), kind: 'slides' });
  const slides = await createArtifactThumbnail(store, slide.id);
  assert.equal(slides.sourceFile, 'project/slides/clear-ideas.html'); assert.equal(slides.previewWidth, 1920); assert.equal(slides.previewHeight, 1080); assert.equal(slides.fidelity, 'native-static');
  assert.match(slides.srcdoc, /把复杂的事/); assert.match(slides.srcdoc, /Clear ideas, considered design/); assert.match(slides.srcdoc, /clip-path:polygon/); assertInert(slides.srcdoc);
  const artboard = await store.importArtifact({ sourcePath: path.join(examples, 'design'), kind: 'design' });
  const design = await createArtifactThumbnail(store, artboard.id);
  assert.equal(design.sourceFile, 'project/Main.dc.html'); assert.equal(design.previewWidth, 1440); assert.equal(design.previewHeight, 780);
  assert.match(design.srcdoc, /Good coffee/); assert.match(design.srcdoc, /data:image\/svg\+xml;base64,/); assert.match(design.srcdoc, /#B64B20/); assert.doesNotMatch(design.srcdoc, /A slower start|A good routine, in three easy choices|{{|&lt;!doctype/); assertInert(design.srcdoc);
  const system = await store.importArtifact({ sourcePath: path.join(examples, 'design-system'), kind: 'design-system' });
  const ds = await createArtifactThumbnail(store, system.id);
  assert.equal(ds.sourceFile, 'project/components/Cover/preview.html'); assert.equal(ds.previewWidth, 960); assert.equal(ds.previewHeight, 288); assert.equal(ds.fidelity, 'native-static');
  assert.match(ds.srcdoc, /Nimbus/); assert.match(ds.srcdoc, /天气，轻声说/); assert.match(ds.srcdoc, /--surface:#F3F9FD/); assert.match(ds.srcdoc, /font-size:112px/); assertInert(ds.srcdoc);
});

test('Dashboard honestly returns actual content reference without pretending scripts rendered its charts', async t => {
  const { store } = await fixture(t);
  const item = await store.importArtifact({ sourcePath: path.join(examples, 'dashboard'), kind: 'dashboard' });
  const preview = await createArtifactThumbnail(store, item.id);
  assert.equal(preview.fidelity, 'content-reference'); assert.equal(preview.sourceFile, 'db/files/index.html.json');
  assert.match(preview.srcdoc, /X 账号数据看板/); assert.match(preview.srcdoc, /近 28 天/); assert.match(preview.notes.join(' '), /not executed|not a rendered chart screenshot/);
  assert.doesNotMatch(preview.srcdoc, /dash\.calc|dash\.draw|4050400|55828/); assertInert(preview.srcdoc);
});

test('script, event, remote URL, frame, form-navigation and hostile SVG content are inert or removed', async t => {
  const { store } = await fixture(t); const item = await store.create({ kind: 'slides', title: 'Untrusted cover' });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>SVG_PWNED()</script><foreignObject><iframe src="https://evil.invalid"></iframe></foreignObject><rect width="10" height="10" fill="#f00" onload="PWNED()"></rect></svg>';
  const id = createHash('sha256').update(svg).digest('hex').slice(0, 32);
  await fs.mkdir(path.join(item.path, 'project/assets'), { recursive: true }); await fs.writeFile(path.join(item.path, 'project/assets', id + '.svg'), svg);
  await fs.writeFile(path.join(item.path, 'project/slides/cover.html'), `<section id="cover" style="background:#fff"><script>HTML_PWNED()</script><img src="https://evil.invalid/tracker.png" onerror="PWNED()"><img src="/_blob/${id}" onload="PWNED()"><a href="jav&#97;script:PWNED()" ping="https://evil.invalid">Actual content</a><iframe srcdoc="<script>PWNED()</script>">FRAME_CONTENT</iframe><form action="https://evil.invalid"><button onclick="PWNED()">Action</button></form><style>@import "https://evil.invalid/a.css";section{background-image:url(https://evil.invalid/a.png)}</style></section>`);
  const preview = await createArtifactThumbnail(store, item.id); assertInert(preview.srcdoc);
  assert.match(preview.srcdoc, /Actual content/); assert.match(preview.srcdoc, /disabled=""/); assert.doesNotMatch(preview.srcdoc, /HTML_PWNED|FRAME_CONTENT|href="jav|ping="/);
  const material = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/.exec(preview.srcdoc);
  assert.ok(material); const decoded = Buffer.from(material[1], 'base64').toString('utf8');
  assert.doesNotMatch(decoded, /script|foreignObject|iframe|onload|PWNED/i); assert.match(decoded, /<rect/);
});

test('revision is stable for local comments/bindings and changes for actual first-screen content/materials', async t => {
  const { store } = await fixture(t); const item = await store.create({ kind: 'design-system', title: 'Revision' });
  const a = await createArtifactThumbnail(store, item.id); assert.equal(a.revision.length, 64);
  await fs.writeFile(path.join(item.path, 'comments.json'), '{"version":1,"threads":[]}'); await store.bindChat(item.id, { threadId: 'real-host-thread' });
  const b = await createArtifactThumbnail(store, item.id); assert.equal(a.revision, b.revision);
  await fs.writeFile(path.join(item.path, 'project/components/Cover/preview.html'), '<!-- @dsCard height=160 --><div style="color:#123456">Actual revised cover</div>');
  const c = await createArtifactThumbnail(store, item.id); assert.notEqual(b.revision, c.revision); assert.match(c.srcdoc, /Actual revised cover/);
});

test('limits and store path boundaries prevent large-resource or private-file thumbnail reads', async t => {
  const { store, temporary } = await fixture(t); const item = await store.create({ kind: 'slides', title: 'Limits' });
  await fs.writeFile(path.join(item.path, 'comments.json'), 'PRIVATE_COMMENT_MUST_NOT_RENDER');
  await fs.writeFile(path.join(item.path, 'project/slides/cover.html'), '<section id="cover"><h1>Real heading</h1><img src="../../comments.json"><img src="file:///private/secret.png"></section>');
  const safe = await createArtifactThumbnail(store, item.id); assert.doesNotMatch(safe.srcdoc, /PRIVATE_COMMENT_MUST_NOT_RENDER|file:\/\/\/private/); assert.match(safe.srcdoc, /Real heading/);
  await assert.rejects(createArtifactThumbnail(store, item.id, { maxSourceBytes: 10 }), { code: 'THUMBNAIL_LIMIT' });
  const outside = path.join(temporary, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET');
  await fs.symlink(outside, path.join(item.path, 'project/leak'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createArtifactThumbnail(store, item.id), { code: 'SYMLINK_REFUSED' });
});
