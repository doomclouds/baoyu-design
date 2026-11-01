import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSkillMarkdown, adaptSkills } from '../adapt-skills.mjs';

const upstream = fileURLToPath(new URL('../../skills/', import.meta.url));
const kinds = ['slides', 'design', 'design-system', 'dashboard'];
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
    const creating = section(adapted, 'Creating');
    assert.match(creating, /open(?: <root>)?`[\s\S]*?`appUrl`/);
    const revising = section(adapted, kind === 'dashboard' ? 'Changing and refreshing' : 'Revising');
    assert.match(revising, /open <root>[\s\S]*?`appUrl`/);
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

test('adapting a disposable plugin writes the same native workflow and Codex command wrapper for all four kinds', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-skill-delivery-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const kind of [...kinds, 'dataviz']) {
    const directory = path.join(root, 'skills', 'codex-' + kind);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${kind === 'dataviz' ? kind : 'claude-' + kind}\ndescription: Example\n---\n\n# ${kind}\n\n## The calls\n\n- \`open <root>\` → \`{url, pid}\`: starts the editor page.\n`);
  }
  await adaptSkills(root);
  for (const kind of kinds) {
    const directory = path.join(root, 'skills', 'codex-' + kind);
    const skill = await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8');
    assert.match(section(skill, 'The calls'), /open <root>.*appUrl/);
    assert.match(await fs.readFile(path.join(directory, 'scripts/codex-artifact.mjs'), 'utf8'), /runArtifactCommand/);
  }
  assert.doesNotMatch(await fs.readFile(path.join(root, 'skills/codex-dataviz/SKILL.md'), 'utf8'), /Open and deliver in Codex Design/);
});
