import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptSkillMarkdown } from '../adapt-skills.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const sources = {
  'codex-slides': 'claude-slides', 'codex-design': 'claude-design', 'codex-design-system': 'claude-design-system',
  'codex-dashboard': 'claude-dashboard', 'codex-motion': 'claude-motion', 'codex-motion-director': 'motion-director', 'codex-dataviz': 'dataviz',
};
async function files(root, relative = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}
const documents = [], inventory = new Set(['NOTICE.md']);
for (const [skill, source] of Object.entries(sources)) {
  const root = path.join(repository, 'skills', source);
  for (const relative of await files(root)) {
    inventory.add(`skills/${skill}/${relative}`);
    if (relative.endsWith('.md')) {
      const original = await fs.readFile(path.join(root, relative), 'utf8');
      documents.push({ skill, relative, original, text: adaptSkillMarkdown(original, skill, relative) });
    }
  }
  if (!['codex-dataviz', 'codex-motion-director'].includes(skill)) inventory.add(`skills/${skill}/scripts/codex-artifact.mjs`);
}
const prose = text => text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
const localLinks = text => [...prose(text).matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:[^)]*)\)/g)]
  .map(match => match[1]).filter(target => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'));
const find = (skill, relative) => documents.find(document => document.skill === skill && document.relative === relative).text;

test('all adapted skill documents reject unavailable synchronization and frame scripts', () => {
  assert.ok(documents.length >= 72, 'audit the complete Markdown inventory, including supporting references');
  for (const document of documents) {
    assert.doesNotMatch(document.text, /\/design-sync\b|\bframes\.ts\b/, `${document.skill}/${document.relative}`);
    assert.doesNotMatch(document.text, /(?:bun\s+run|node)\s+[^\n`]*(?:make|check|export|frames)\.ts\b/, `${document.skill}/${document.relative}: do not advertise an unbundled producer command`);
  }
});

test('local Markdown links and declared packaged paths exist without interpreting fenced format grammar as links', () => {
  assert.deepEqual(localLinks('```css\ntransform: skew[X|Y](ANGLE ±60)\n```'), []);
  for (const document of documents) {
    const owner = `skills/${document.skill}/${document.relative}`;
    for (const target of localLinks(document.text)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(owner), decodeURIComponent(target.split('#')[0])));
      assert.ok(inventory.has(resolved), `${owner}: missing local Markdown link ${target}`);
    }
    const withoutComments = document.text.replace(/<!--[\s\S]*?-->/g, '');
    for (const match of withoutComments.matchAll(/(?:artifact-type\/(?:reference\/)?|references\/|scripts\/|guides\/)[A-Za-z0-9_./-]+\.(?:md|json|js|mjs|py|ts|html|css)/g)) {
      const target = match[0];
      // Director setup explicitly delegates Motion's format files and CLI to M.
      const skill = document.skill === 'codex-motion-director' && /^(?:artifact-type|scripts)\//.test(target) ? 'codex-motion' : document.skill;
      assert.ok(inventory.has(`skills/${skill}/${target}`), `${owner}: missing packaged path ${target}`);
    }
  }
});

test('Motion frame references use supported selection flags and do not invent contact-sheet support', async () => {
  for (const relative of ['motion.md', 'walkthrough.md', 'recreate-ui.md']) {
    const text = find('codex-motion', 'artifact-type/reference/' + relative);
    assert.match(text, /stills <root> --(?:at|every)/);
  }
  const walkthrough = find('codex-motion', 'artifact-type/reference/walkthrough.md');
  assert.match(walkthrough, /separate PNG\/JPEG frames, not a contact sheet/);
  assert.match(walkthrough, /at most 120 frames per call/);
  assert.doesNotMatch(walkthrough, /`stills[^`]*--sheet/);
  const runtime = await fs.readFile(path.join(repository, 'skills/claude-motion/scripts/artifact.mjs'), 'utf8');
  assert.match(runtime, /var MAX_STILLS = 120;/);
  for (const flag of ['at', 'every', 'scenes']) assert.ok(runtime.includes(`flags.has("${flag}")`), 'reference flag exists in the actual CLI: ' + flag);
  assert.ok(!runtime.includes('flags.has("sheet")'), 'do not imply the actual CLI writes contact sheets');
});

test('upstream producer notes preserve format rules without promising local rendering or MIDI checks', () => {
  const api = find('codex-motion', 'artifact-type/reference/film-api.md');
  assert.match(api, /local structural check does not measure rendering cost/);
  assert.match(api, /not checks run by the local structural `check` command/);
  assert.doesNotMatch(api, /which fail `check\.ts`|`make\.ts` turns|`check\.ts`'s ms\/frame/);
  const sound = find('codex-motion', 'artifact-type/reference/sound.md');
  assert.match(sound, /`score <root> --levels`/);
  assert.match(sound, /MIDI-file export flag is not exposed/);
  for (const relative of ['images.md', 'fonts.md']) {
    const text = find('codex-slides', 'artifact-type/reference/' + relative);
    assert.doesNotMatch(text, /scripts\/make\.ts|appifact-slides skill is installed/);
    assert.match(text, /not bundled|Do not invoke an upstream single-file producer/);
  }
  const cover = find('codex-design-system', 'artifact-type/reference/cover.md');
  assert.match(cover, /structural validation does not render it/);
});

test('the optional typography example links the real package notice and retains supplied-brand font stacks', async () => {
  const relative = 'artifact-type/reference/brand-typography.md';
  const text = find('codex-design', relative);
  assert.match(text, /Optional supplied-brand example, not a default for Codex artwork/);
  assert.match(text, /\[NOTICE\.md\]\(\.\.\/\.\.\/\.\.\/\.\.\/NOTICE\.md\)/);
  assert.equal(path.posix.normalize(path.posix.join('skills/codex-design/artifact-type/reference', '../../../../NOTICE.md')), 'NOTICE.md');
  assert.ok((await fs.stat(path.join(repository, 'NOTICE.md'))).isFile());
  const original = documents.find(document => document.skill === 'codex-design' && document.relative === relative).original;
  const stacks = value => [...value.matchAll(/'Anthropic (?:Sans|Serif|Mono)'[^`\n]*/g)].map(match => match[0]);
  assert.deepEqual(stacks(text), stacks(original));
});
