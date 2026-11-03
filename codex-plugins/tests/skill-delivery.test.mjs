import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSkillMarkdown, adaptSkills } from '../adapt-skills.mjs';

const upstream = fileURLToPath(new URL('../../skills/', import.meta.url));
const kinds = ['slides', 'design', 'design-system', 'dashboard', 'motion'];
const skillKinds = [...kinds, 'motion-director', 'dataviz'];
const sourceName = kind => ['dataviz', 'motion-director'].includes(kind) ? kind : 'claude-' + kind;
const section = (text, heading) => text.split(new RegExp(`^## ${heading}[^\\n]*\\n`, 'm'))[1]?.split(/^## /m)[0] || '';

for (const kind of kinds) {
  test(`${kind}: real authoring, command and handover instructions consistently deliver its native artwork Tab`, async () => {
    const source = await fs.readFile(path.join(upstream, 'claude-' + kind, 'SKILL.md'), 'utf8');
    const adapted = adaptSkillMarkdown(source, 'codex-' + kind, 'SKILL.md');
    assert.match(adapted, /^name: codex-/m);
    const execution = section(adapted, 'Codex execution');
    assert.match(execution, /Keep the `appUrl` returned by `create`/);
    assert.match(execution, /check\.next.*scripts\/codex-artifact\.mjs/);
    assert.match(execution, /navigationRequested: true.*accepted/);
    assert.match(execution, /renderVerified: false.*does not prove/);
    assert.match(execution, /Opening artwork does not create or resume a worker or another chat/);
    assert.match(execution, /preview <root>.*only when the user explicitly asks/);
    assert.match(execution, /non-library root.*nativeAvailable: false/);
    assert.doesNotMatch(execution, /\*\*Native annotations:\*\* Use the built-in browser/);
    const calls = section(adapted, 'The calls');
    const open = calls.split('\n').find(line => /(?:`open <root>`|`node \$A open <root>`)/.test(line));
    const preview = calls.split('\n').find(line => /`(?:node \$A )?preview <root>/.test(line));
    assert.match(open, /appUrl.*navigationRequested.*renderVerified/);
    assert.doesNotMatch(open, /\{url|127\.0\.0\.1|starts the (?:editor )?page.*background/);
    assert.match(preview, /only when the user explicitly/);
    const creating = section(adapted, kind === 'motion' ? 'A new film' : 'Creating');
    assert.match(creating, kind === 'motion' ? /open <root>[\s\S]*?native Codex Design artwork Tab/ : /open(?: <root>)?`[\s\S]*?`appUrl`/);
    const revising = section(adapted, kind === 'dashboard' ? 'Changing and refreshing' : 'Revising');
    if (kind === 'motion') assert.match(revising, /Never start the film over; the store is the truth/);
    else assert.match(revising, /open <root>[\s\S]*?`appUrl`/);
    assert.doesNotMatch(adapted, /give the (?:user|person) (?:its |the )?`url`|`open`'s `url` \+ `#slide-/);
    assert.equal(await fs.readFile(path.join(upstream, 'claude-' + kind, 'SKILL.md'), 'utf8'), source, 'The upstream skill stays untouched.');
  });
}

test('delivery adaptation distinguishes app navigation from upload URLs, dataset sources and ordinary text', () => {
  const data = 'Upload result: `{url:"/_blob/0123456789abcdef", bytes:42}`.\nDataset: `{"source":{"url":"http://127.0.0.1:1234/data.csv"}}`.\nHTML: `<img src="/_blob/image"><a href="https://example.org/report">Source</a>`.\n';
  const source = '---\nname: claude-slides\ndescription: Example\n---\n\n# Slides\n\n' + data
    + '\n## The calls\n\n- `open <root>` → `{url, pid}`: starts the editor page.\n';
  const adapted = adaptSkillMarkdown(source, 'codex-slides', 'SKILL.md');
  assert.ok(adapted.includes(data), 'Content/source URLs are byte-for-byte unchanged.');
  assert.match(section(adapted, 'The calls'), /open <root>.*appUrl/);
  assert.throws(() => adaptSkillMarkdown(adapted, 'codex-slides', 'SKILL.md'), /Unexpected upstream skill name|already adapted/);
});

test('actual supporting handover references use native links without inventing slide-specific routes', async () => {
  const deck = await fs.readFile(path.join(upstream, 'claude-slides/artifact-type/reference/deck-files.md'), 'utf8');
  const adaptedDeck = adaptSkillMarkdown(deck, 'codex-slides', 'artifact-type/reference/deck-files.md');
  assert.match(adaptedDeck, /check <root>[\s\S]*?wrapper-based `next`[\s\S]*?native `appUrl`/);
  assert.match(adaptedDeck, /slide-specific URL anchors are not implemented/);
  assert.doesNotMatch(adaptedDeck, /#slide-/);
  const dashboard = await fs.readFile(path.join(upstream, 'claude-dashboard/artifact-type/reference/design-defaults.md'), 'utf8');
  const adaptedDashboard = adaptSkillMarkdown(dashboard, 'codex-dashboard', 'artifact-type/reference/design-defaults.md');
  assert.match(adaptedDashboard, /### Handing over\n\nUse the native `appUrl`/);
  const canvas = await fs.readFile(path.join(upstream, 'claude-design/artifact-type/reference/make-from-this.md'), 'utf8');
  const adaptedCanvas = adaptSkillMarkdown(canvas, 'codex-design', 'artifact-type/reference/make-from-this.md');
  assert.match(adaptedCanvas, /new creation result's exact root and native appUrl/);
});

test('adapting a disposable plugin writes native workflows for five editors and keeps the director beside Motion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-skill-delivery-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const kind of skillKinds) {
    const directory = path.join(root, 'skills', 'codex-' + kind);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${sourceName(kind)}\ndescription: Example\n---\n\n# ${kind}\n\n## The calls\n\n- \`open <root>\` → \`{url, pid}\`: starts the editor page.\n`);
  }
  await adaptSkills(root);
  for (const kind of kinds) {
    const directory = path.join(root, 'skills', 'codex-' + kind);
    const skill = await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8');
    assert.match(section(skill, 'The calls'), /open <root>.*appUrl/);
    assert.match(await fs.readFile(path.join(directory, 'scripts/codex-artifact.mjs'), 'utf8'), /runArtifactCommand/);
  }
  assert.doesNotMatch(await fs.readFile(path.join(root, 'skills/codex-dataviz/SKILL.md'), 'utf8'), /Open and deliver in Codex Design/);
  const director = await fs.readFile(path.join(root, 'skills/codex-motion-director/SKILL.md'), 'utf8');
  assert.match(director, /\.\.\/codex-motion\/SKILL\.md/);
  assert.match(director, /adds no separate artwork type, player or format/);
  await assert.rejects(fs.access(path.join(root, 'skills/codex-motion-director/scripts/codex-artifact.mjs')), { code: 'ENOENT' });
});

test('all real upstream editor workflows retain local delivery and content-only transfer instead of LAN/archive recipes', async () => {
  for (const kind of kinds) {
    const source = await fs.readFile(path.join(upstream, 'claude-' + kind, 'SKILL.md'), 'utf8');
    const adapted = adaptSkillMarkdown(source, 'codex-' + kind, 'SKILL.md');
    const calls = section(adapted, 'The calls');
    assert.doesNotMatch(calls, /`(?:node \$A )?(?:share|archive|serve) <root>/, kind);
    assert.doesNotMatch(calls, /--lan/, kind);
    const sharing = section(adapted, 'Sharing');
    assert.match(sharing, /appUrl.*local navigation link/);
    assert.match(sharing, /content export action and Save As/);
    assert.match(sharing, /chats, comments, history, worker records, credentials and runtime state stay local/);
    assert.match(sharing, /do not authorize network sharing/);
    assert.match(sharing, /Do not invoke upstream sharing commands/);
    assert.doesNotMatch(sharing, /`share <root>`|http:\/\/|whoever has one gets/);
    const git = section(adapted, 'Keeping it in git');
    assert.match(git, /Do not initialize a repository over that library/);
    assert.match(git, /only when the user asks/);
    assert.match(git, /exclude chats, comments, history/);
    assert.match(git, /Preserve any existing user-owned/);
    assert.doesNotMatch(git, /comments\.json.*included|history included|whole folder/);
    assert.match(adapted, kind === 'motion' ? /## The store documents: exact shapes/ : kind === 'dashboard' ? /## The documents/ : kind === 'slides' ? /## The slide format/ : kind === 'design' ? /## One artboard: the skeleton/ : /## tokens.json, in brief/);
    assert.equal(await fs.readFile(path.join(upstream, 'claude-' + kind, 'SKILL.md'), 'utf8'), source);
  }
});

test('detailed editor history does not claim to replace whole-artwork checkpoints or bypass current writer ownership', async () => {
  for (const kind of kinds) {
    const source = await fs.readFile(path.join(upstream, 'claude-' + kind, 'SKILL.md'), 'utf8');
    const history = section(adaptSkillMarkdown(source, 'codex-' + kind, 'SKILL.md'), 'History');
    assert.match(history, /whole-artwork restore points and the editor's detailed edit history are separate/);
    assert.match(history, /check worker ownership/);
    assert.match(history, /restore creates a new revision.*preserve unrelated later edits/);
    assert.match(history, /Do not bypass an active writer or a changed restore base/);
    assert.match(history, /existing `history\/index\.json` when present/);
    assert.match(history, /64-character hexadecimal SHA-256/);
    assert.match(history, /do not follow filesystem links or edit history records/);
    assert.match(history, /do not invent a history CLI command/);
    assert.doesNotMatch(history, /Nothing here is refused as out of date|the later one win|the page's change wins/);
  }
});

test('dependent dashboard retrievals are materialized as attached snapshots rather than hosted viewer queries', async () => {
  const relative = 'artifact-type/reference/dependent-calls.md';
  const source = await fs.readFile(path.join(upstream, 'claude-dashboard', relative), 'utf8');
  assert.match(source, /Claude Data/);
  const adapted = adaptSkillMarkdown(source, 'codex-dashboard', relative);
  assert.match(adapted, /CSV, TSV or JSON snapshots/);
  assert.match(adapted, /obtain that answer first/);
  assert.match(adapted, /preserve the type/);
  assert.match(adapted, /valid zero\/false value/);
  assert.match(adapted, /No viewer connector, shared credentials/);
  assert.match(adapted, /codex-artifact\.mjs upload <root> <file>/);
  assert.match(adapted, /A parameter change filters a snapshot; it does not rerun/);
  assert.match(adapted, /Keep their dates\/ids consistent/);
  assert.doesNotMatch(adapted, /claude|datasets\/latest|semantic_query|sharer then approves|runs as the sharer/i);
  assert.equal(await fs.readFile(path.join(upstream, 'claude-dashboard', relative), 'utf8'), source);
});

test('comment list order is not documented as the author-avatar pin label', async () => {
  for (const kind of kinds) {
    const source = await fs.readFile(path.join(upstream, 'claude-' + kind, 'SKILL.md'), 'utf8');
    const comments = section(adaptSkillMarkdown(source, 'codex-' + kind, 'SKILL.md'), 'Comments');
    assert.match(comments, /diagnostic list order `n` \(separate from the author-avatar pin label\)/);
    assert.doesNotMatch(comments, /numbered like (?:the editor's|the page's) pins/);
    assert.match(comments, /Add to chat.*snapshot.*native workspace draft/);
    assert.doesNotMatch(comments, /run `comments <root> --wait` as a background/);
  }
});

test('every actual upstream markdown reference adapts, while unknown host wording still fails closed', async () => {
  let files = 0;
  for (const kind of skillKinds) {
    const base = path.join(upstream, sourceName(kind));
    const walk = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(filename);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const relative = path.relative(base, filename).split(path.sep).join('/');
          const adapted = adaptSkillMarkdown(await fs.readFile(filename, 'utf8'), 'codex-' + kind, relative);
          assert.doesNotMatch(adapted, /claude/i, kind + '/' + relative);
          assert.doesNotMatch(adapted, /\n\n$/, 'Instruction Markdown has no excess final blank line: ' + relative);
          files++;
        }
      }
    };
    await walk(base);
  }
  assert.ok(files >= 52, 'The real upstream markdown inventory must be exercised.');
  assert.throws(() => adaptSkillMarkdown('# Unknown\n\nUse Claude Example Service.\n', 'codex-dashboard', 'artifact-type/reference/new-service.md'), /Unadapted host wording/);
});
