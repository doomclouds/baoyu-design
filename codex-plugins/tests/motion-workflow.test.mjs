import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixtures.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../codex-design/skills/codex-motion/scripts/codex-artifact.mjs', import.meta.url));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const chromeCandidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chrome = (await Promise.all(chromeCandidates.map(async file => await fs.access(file).then(() => file, () => null)))).find(Boolean);

// Deterministic tones with a pause exercise local audio handling. This is not speech or a TTS-quality sample.
function offlineTake(seconds = 1.2, rate = 16000) {
  const samples = Math.round(seconds * rate), bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    const t = index / rate;
    const from = t >= .08 && t < .5 ? .08 : t >= .65 && t < 1.08 ? .65 : null;
    const end = from === .08 ? .5 : 1.08;
    const envelope = from === null ? 0 : Math.min(1, (t - from) / .01, (end - t) / .01);
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (from === .08 ? 440 : 660) * t) * .22 * 32767 * envelope), 44 + index * 2);
  }
  return bytes;
}

function wavStats(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let channels, rate, format, bits, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (tag === 'fmt ') {
      format = bytes.readUInt16LE(offset + 8); channels = bytes.readUInt16LE(offset + 10);
      rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22);
    } else if (tag === 'data') data = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size));
    offset += 8 + size + size % 2;
  }
  assert.ok(data && rate > 0 && channels > 0);
  assert.ok(format === 1 && bits === 16 || format === 3 && bits === 32, `Expected PCM16 or float32 WAV, got ${format}/${bits}.`);
  let peak = 0;
  for (let at = 0; at + bits / 8 <= data.length; at += bits / 8) peak = Math.max(peak, Math.abs(format === 3 ? data.readFloatLE(at) : data.readInt16LE(at) / 32768));
  return { seconds: data.length / (rate * channels * bits / 8), peak };
}

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'codex-motion-workflow-'));
  const film = await createFixture('motion', directory);
  t.after(async () => {
    const relative = path.relative(temporaryRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(directory, { recursive: true, force: true });
  });
  // Only local runtime settings are inherited; provider credentials and command hooks are absent.
  const env = { PATH: process.env.PATH || '', TMPDIR: temporaryRoot, CODEX_DESIGN_NATIVE_SESSION: '1',
    CODEX_THREAD_ID: '', CODEX_DESIGN_THREAD_ID: '', ...(chrome ? { CHROME_PATH: chrome } : {}) };
  const command = async (...args) => {
    const result = await execute(process.execPath, [cli, ...args], { env, timeout: 45_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const write = async (name, writes) => {
    const batch = path.join(directory, name + '.json'); await fs.writeFile(batch, JSON.stringify(writes));
    return command('write-db', film.root, batch);
  };
  const input = path.join(directory, 'synthetic-tone-test-only.wav'); await fs.writeFile(input, offlineTake());
  const lines = ['Offline audio fixture.'];
  await write('voice-track', [{ op: 'set', path: 'modules/voice.json', data: { kind: 'json', text: JSON.stringify({ v: 1, lang: 'en', gap: .2, lead: .05,
    scenes: [{ id: 'intro', lines }] }) } }]);
  const prepare = async () => {
    const adopted = await command('voice', film.root, '--take', 'intro=' + input, '--format', 'keep');
    const aligned = await command('align', film.root, '--aligner', 'silence');
    const synced = await command('sync', film.root);
    return { adopted, aligned, synced };
  };
  return { ...film, directory, input, lines, command, write, prepare };
}

test('offline Motion takes pass real voice adoption, silence alignment, timing sync and word beats without a speech provider', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const dry = await f.command('voice', f.root, '--take', 'intro=' + f.input, '--format', 'keep', '--dry-run');
  assert.equal(dry.dryRun, true); assert.equal(dry.would[0].id, 'intro');
  const { adopted, aligned, synced } = await f.prepare();
  assert.equal(adopted.adopted.length, 1); assert.equal(adopted.adopted[0].mime, 'audio/wav');
  assert.equal(adopted.adopted[0].seconds, 1.2);
  assert.equal(aligned.aligner, 'silence'); assert.equal(aligned.aligned[0].id, 'intro');
  assert.equal(synced.seconds, 1.4);
  const voice = JSON.parse((await readJson(path.join(f.root, 'db/modules/voice.json.json'))).text);
  const scene = voice.scenes[0];
  assert.equal(scene.speech, 1.2); assert.equal(scene.align, 'silence'); assert.ok(scene.hash);
  assert.equal(scene.chars.length, f.lines.join('').length + 1);
  assert.ok(scene.chars.every((time, index) => index === 0 || time >= scene.chars[index - 1]));
  const scenes = JSON.parse((await readJson(path.join(f.root, 'db/modules/scenes.json.json'))).text);
  assert.equal(scenes.scenes[0].dur, 1.4);
  const beats = await f.command('beats', f.root, '--words');
  assert.equal(beats.scenes[0].aligned, true);
  assert.equal(beats.scenes[0].lines[0].text, f.lines[0]);
  assert.deepEqual(beats.scenes[0].lines[0].words.map(word => word.w), ['Offline', 'audio', 'fixture']);
  assert.equal((await f.command('sync', f.root, '--dry-run')).changed.length, 0);
  assert.equal((await f.command('align', f.root, '--aligner', 'silence')).skipped[0].id, 'intro');
  assert.equal((await f.command('check', f.root)).problems, 0);
  await assert.rejects(f.command('voice', f.root, '--take', 'unknown=' + f.input, '--format', 'keep'), error => {
    assert.equal(JSON.parse(error.stderr).error, 'UNKNOWN_SCENE'); return true;
  });
  assert.deepEqual(JSON.parse((await readJson(path.join(f.root, 'db/modules/voice.json.json'))).text), voice);
});

test('offline Motion music analysis and arrangement preserve actual local samples and produce a non-silent bounded WAV', async t => {
  const f = await fixture(t), original = await fs.readFile(f.input);
  const measured = await f.command('music', f.input, '--bpm', '120', '--step', '.5');
  assert.equal(measured.seconds, 1.2); assert.equal(measured.tempo.bpm, 120);
  assert.ok(measured.loudness.peak > -30); assert.ok(measured.sections.length > 0);
  const output = path.join(f.directory, 'arranged-test-audio.wav');
  const arranged = await f.command('arrange', '--in', f.input, '--bpm', '120', '--map', JSON.stringify([
    { at: 0, from: .1, dur: .35 }, { at: .35, from: .65, dur: .35 },
  ]), '--xfade', '.02', '--fade-out', '.05', '--out', output);
  assert.equal(arranged.seconds, .7); assert.equal(arranged.pieces.length, 2);
  const rendered = wavStats(await fs.readFile(output));
  assert.ok(Math.abs(rendered.seconds - .7) < .01); assert.ok(rendered.peak > .05);
  assert.deepEqual(await fs.readFile(f.input), original);
});

test('the real offline Motion player emits SRT/VTT, selected stills, score metrics and audible audio-only output', { timeout: 120_000,
  skip: chrome ? false : 'Chrome is required for the actual bundled player; no substitute renderer is used.' }, async t => {
  const f = await fixture(t); await f.prepare();
  await f.write('score-track', [{ op: 'set', path: 'modules/score.js', data: { kind: 'js', text: `kit.score(function(S) {
  S.tempo(120); S.program('qa', 'ep');
  S.note('qa', 'C4', { t: 0, dur: .45, vel: 48 });
  S.note('qa', 'E4', { t: .65, dur: .3, vel: 48 });
  S.master({ gain: -18, fadeOut: .1 });
});\n` } }]);
  for (const format of ['srt', 'vtt']) {
    const output = path.join(f.directory, 'captions.' + format);
    const captions = await f.command('captions', f.root, '--format', format, '--out', output);
    assert.equal(captions.captions, 1); assert.ok(Math.abs(captions.seconds - 1.4) < .02);
    const text = await fs.readFile(output, 'utf8');
    assert.ok(text.includes(f.lines[0]));
    assert.match(text, format === 'srt' ? /00:00:00,\d{3} --> 00:00:01,\d{3}/ : /^WEBVTT\n[\s\S]*00:00:00\.\d{3} --> 00:00:01\.\d{3}/);
  }
  const stills = await f.command('stills', f.root, '--at', '0.25', '--width', '320', '--out', path.join(f.directory, 'stills'));
  assert.equal(stills.width, 320); assert.equal(stills.height, 180); assert.equal(stills.stills.length, 1);
  assert.equal(stills.stills[0].t, .25);
  const image = await fs.readFile(stills.stills[0].file);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 320); assert.equal(image.readUInt32BE(20), 180);
  const score = await f.command('score', f.root, '--levels');
  assert.ok(score.events >= 2); assert.equal(score.voice.takes, 1);
  assert.equal(score.voice.seconds, 1.2); assert.ok(score.loudness.peak > -60);
  assert.ok(score.levels.some(level => level > -60));
  const audio = await f.command('export', f.root, '--audio-only', '--out', path.join(f.directory, 'mix.wav'));
  assert.ok(audio.seconds >= score.duration && audio.seconds <= score.duration + 2, 'Audio may preserve the synthesizer release tail after the film ends.');
  const wave = wavStats(await fs.readFile(audio.out));
  assert.ok(Math.abs(wave.seconds - audio.seconds) < .02); assert.ok(wave.peak > .01);
  assert.ok(audio.loudness.peak > -60);
  assert.equal((await f.command('check', f.root)).problems, 0);
});
