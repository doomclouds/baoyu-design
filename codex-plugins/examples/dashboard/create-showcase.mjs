import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, '../../..');
const targetRoot = process.argv[2] ? path.resolve(process.argv[2]) : exampleRoot;
const cli = path.join(repoRoot, 'skills', 'claude-dashboard', 'scripts', 'artifact.mjs');
const start = Date.parse('2025-11-01T00:00:00Z');
const dayMs = 86_400_000;
let seed = 0xC0DE2026;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const events = [
  ['2025-11-27', 210000, .7], ['2026-01-08', 170000, 1.5], ['2026-02-18', 290000, .7],
  ['2026-03-28', 190000, .9], ['2026-05-21', 240000, .8], ['2026-07-29', 300000, .8],
  ['2026-08-17', 490000, .7], ['2026-08-30', 240000, 1.3], ['2026-09-07', 370000, 1.1],
  ['2026-09-13', 560000, .65], ['2026-09-20', 210000, 1.2], ['2026-10-03', 130000, .8],
].map(([date, magnitude, spread]) => ({ day: (Date.parse(date + 'T00:00:00Z') - start) / dayMs, magnitude, spread }));
const rows = Array.from({ length: 365 }, (_, index) => {
  const date = new Date(start + index * dayMs).toISOString().slice(0, 10);
  const weekly = Math.sin(index * Math.PI * 2 / 7) * 6500;
  const seasonal = Math.sin(index * Math.PI * 2 / 43) * 8500;
  const bursts = events.reduce((total, event) => total + event.magnitude * Math.exp(-Math.pow((index - event.day) / event.spread, 2) / 2), 0);
  const impressions = Math.round(Math.max(22000, (47000 + index * 270 + weekly + seasonal) * (.83 + random() * .34) + bursts));
  const activity = .88 + random() * .27 + .06 * Math.sin(index * Math.PI * 2 / 31);
  const profile_visits = Math.round(impressions * (.0012 + random() * .00035));
  const likes = Math.round(impressions * .0082 * activity);
  const bookmarks = Math.round(impressions * .0019 * activity);
  const replies = Math.round(impressions * .00065 * activity);
  const reposts = Math.round(impressions * .00105 * activity);
  const shares = Math.round(impressions * .00042 * activity);
  const engagements = likes + bookmarks + replies + reposts + shares + profile_visits;
  const followers_gained = Math.round(impressions * (.00034 + random() * .00012));
  const followers_lost = Math.round(4 + random() * 13 + index / 80);
  return { date, impressions, engagements, net_followers: followers_gained - followers_lost, profile_visits, likes, bookmarks, replies, reposts, shares, followers_gained, followers_lost, posts: 2 + Math.floor(random() * 7) };
});

const columns = Object.keys(rows[0]);
const csv = columns.join(',') + '\n' + rows.map((row) => columns.map((column) => row[column]).join(',')).join('\n') + '\n';
await mkdir(path.join(targetRoot, 'src'), { recursive: true });
const csvFile = path.join(targetRoot, 'src', 'x-account-daily.csv');
await writeFile(csvFile, csv);
for (const filename of ['index.html', 'dashboard.js', 'dashboard.css']) {
  const source = await readFile(path.join(exampleRoot, 'src', filename), 'utf8');
  if (targetRoot !== exampleRoot) await writeFile(path.join(targetRoot, 'src', filename), source);
}

const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }));
const upload = run('upload', targetRoot, csvFile);
const updatedAt = new Date().toISOString();
const batch = [
  { op: 'set', path: 'dash/meta', data: { title: 'X 账号数据看板（示例数据）' } },
  { op: 'set', path: 'dash/params', data: { end: '2026-10-31', metric: 'impressions', table_sort: 'date', table_dir: 'desc' } },
  { op: 'set', path: 'datasets/daily', data: { title: 'Sample · X 账号每日表现', description: '2025-11-01 至 2026-10-31 的 365 条确定性合成日记录，seed 0xC0DE2026。曝光含长期趋势、周周期和预设事件峰值；互动及增长由公开写明的生成公式产生。仅演示，不是用户或任何真实账号的数据。', source: { kind: 'file', url: upload.url, name: 'x-account-daily.csv', format: 'csv' }, fixed: true, updated: { at: updatedAt, by: 'Codex · synthetic showcase' } } },
  ...['index.html', 'dashboard.css', 'dashboard.js'].map((filename) => ({ op: 'set', path: 'files/' + filename, data: { text: { $file: path.join(targetRoot, 'src', filename) } } })),
];
const batchFile = path.join(targetRoot, 'src', 'write-batch.json');
await writeFile(batchFile, JSON.stringify(batch, null, 2) + '\n');
const written = run('write-db', targetRoot, batchFile);
const check = run('check', targetRoot);
assert.equal(check.problems, 0);

// Independently check the source arithmetic and execute the page's actual calc functions.
assert.equal(rows.length, 365);
assert.equal(rows[0].date, '2025-11-01');
assert.equal(rows.at(-1).date, '2026-10-31');
for (let i = 0; i < rows.length; i++) {
  assert.equal(Date.parse(rows[i].date + 'T00:00:00Z'), start + i * dayMs);
  assert.equal(rows[i].engagements, rows[i].likes + rows[i].bookmarks + rows[i].replies + rows[i].reposts + rows[i].shares + rows[i].profile_visits);
  assert.equal(rows[i].net_followers, rows[i].followers_gained - rows[i].followers_lost);
}
const sum = (days, key) => days.reduce((total, row) => total + row[key], 0);
const recent = rows.slice(-28), previous = rows.slice(-56, -28);
const recentTotals = Object.fromEntries(['impressions', 'engagements', 'net_followers', 'profile_visits'].map((key) => [key, sum(recent, key)]));
const previousTotals = Object.fromEntries(['impressions', 'engagements', 'net_followers', 'profile_visits'].map((key) => [key, sum(previous, key)]));
const calculations = new Map();
const context = vm.createContext({ dash: { calc: (id, spec) => calculations.set(id, spec), draw: () => {}, onData: () => {} }, document: { querySelectorAll: () => [] }, Intl });
vm.runInContext(await readFile(path.join(targetRoot, 'src', 'dashboard.js'), 'utf8'), context, { timeout: 5000 });
const sourceRows = rows.map((row) => Object.fromEntries(columns.map((key) => [key, String(row[key])])));
const periods = calculations.get('periods').fn(sourceRows);
const trend = calculations.get('trend').fn(sourceRows);
assert.equal(calculations.get('source_meta').fn(sourceRows)[0].rows_count, rows.length);
const latest = periods.at(-1);
const calcOutputBytes = { trend: Buffer.byteLength(JSON.stringify(trend)), periods: Buffer.byteLength(JSON.stringify(periods)) };
assert.ok(Object.values(calcOutputBytes).every((bytes) => bytes < 256 * 1024), 'each calculation result must fit comfortably within a local document');
for (const [key, value] of Object.entries(recentTotals)) assert.equal(latest[key], value);
assert.equal(latest.engagement_rate, recentTotals.engagements / recentTotals.impressions);
assert.equal(latest.impressions_change, recentTotals.impressions / previousTotals.impressions - 1);
assert.equal(latest.current_start, '2026-10-04');
assert.equal(latest.previous_start, '2026-09-06');
assert.equal(latest.previous_end, '2026-10-03');
assert.equal(trend.at(-1).impressions_avg7, sum(rows.slice(-7), 'impressions') / 7);
assert.equal(trend.filter((row) => row.impressions_avg7 !== null).length, 359);
const blueValidation = execFileSync(process.execPath, [path.join(repoRoot, 'skills/dataviz/scripts/validate_palette.js'), '#2a78d6', '--mode', 'light', '--surface', '#ffffff'], { encoding: 'utf8', windowsHide: true });
const css = await readFile(path.join(targetRoot, 'src', 'dashboard.css'), 'utf8');
const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4)).reduce((total, value, i) => total + value * [.2126, .7152, .0722][i], 0);
const textColors = [...new Set([...css.matchAll(/(?:^|[;{])\s*color:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1]))];
const contrasts = textColors.flatMap((color) => ['#ffffff', '#fafaf8'].map((surface) => ({ color, surface, ratio: (luminance(surface) + .05) / (luminance(color) + .05) })));
assert.ok(contrasts.every((item) => item.ratio >= 4.5), 'all declared text colors must remain readable on both page surfaces');
const evidence = {
  dataset: { kind: 'deterministic synthetic sample', seed: '0xC0DE2026', rows: rows.length, first: rows[0].date, last: rows.at(-1).date, csvSha256: createHash('sha256').update(csv).digest('hex'), uploadedUrl: upload.url },
  currentPeriod: { from: recent[0].date, to: recent.at(-1).date, ...recentTotals, engagementRate: latest.engagement_rate },
  previousPeriod: { from: previous[0].date, to: previous.at(-1).date, ...previousTotals, engagementRate: previousTotals.engagements / previousTotals.impressions },
  changes: { impressions: latest.impressions_change, engagements: latest.engagements_change, engagementRatePoints: latest.rate_change_points, netFollowers: latest.followers_change, profileVisits: latest.visits_change },
  last7DayMeans: { impressions: trend.at(-1).impressions_avg7, engagements: trend.at(-1).engagements_avg7, netFollowers: trend.at(-1).net_followers_avg7, profileVisits: trend.at(-1).profile_visits_avg7 },
  pageCalcChecks: { contiguousDates: true, engagementComponentsMatch: true, followerComponentsMatch: true, periodRows: periods.length, trendRows: trend.length, weightedRateMatches: true, validSevenDayMeans: 359, calcOutputBytes },
  writeResult: written, check, paletteValidation: blueValidation.trim(),
  textContrast: { minimumRatio: Math.min(...contrasts.map((item) => item.ratio)), checkedForegrounds: textColors, surfaces: ['#ffffff', '#fafaf8'] },
  notRun: ['Browser rendering and native UI interaction are left to the parent agent; this script does not start an editor or model.'],
};
await writeFile(path.join(targetRoot, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
process.stdout.write(JSON.stringify({ root: targetRoot, sourceRows: rows.length, upload: upload.url, problems: check.problems, currentPeriod: evidence.currentPeriod, changes: evidence.changes, evidence: path.join(targetRoot, 'verification.json') }, null, 2) + '\n');
