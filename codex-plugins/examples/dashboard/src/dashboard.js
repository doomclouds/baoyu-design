dash.calc('source_meta', {
  inputs: ['daily'], title: '示例数据覆盖范围', description: '统计原始 CSV 的记录行数及起止日期。',
  fn: (daily) => { const dates = daily.map((row) => row.date).sort(); return [{ rows_count: daily.length, first: dates[0] || '', last: dates[dates.length - 1] || '' }]; },
});

dash.calc('trend', {
  inputs: ['daily'], title: '每日表现与 7 日均值', description: '逐日转为数值；互动率为互动数除以曝光量；7 日均值为当天及之前六天的算术平均。',
  fn: (daily) => {
    const rows = daily.map((r) => ({ date: r.date, impressions: Number(r.impressions), engagements: Number(r.engagements), net_followers: Number(r.net_followers), profile_visits: Number(r.profile_visits), engagement_rate: Number(r.engagements) / Number(r.impressions) })).sort((a, b) => a.date.localeCompare(b.date));
    return rows.map((r, i) => {
      const out = { ...r };
      for (const field of ['impressions', 'engagements', 'net_followers', 'profile_visits']) out[field + '_avg7'] = i < 6 ? null : rows.slice(i - 6, i + 1).reduce((sum, day) => sum + day[field], 0) / 7;
      return out;
    });
  },
});

dash.calc('periods', {
  inputs: ['daily'], title: '近 28 天与前 28 天', description: '每个截止日汇总最近 28 天与紧邻的前 28 天；互动率使用区间总互动数除以总曝光量，变化率以此前区间为分母。',
  fn: (daily) => {
    const rows = daily.slice().sort((a, b) => a.date.localeCompare(b.date));
    const out = [];
    for (let i = 55; i < rows.length; i++) {
      const now = rows.slice(i - 27, i + 1), before = rows.slice(i - 55, i - 27);
      const sum = (days, field) => days.reduce((total, r) => total + Number(r[field]), 0);
      const current = { impressions: sum(now, 'impressions'), engagements: sum(now, 'engagements'), net_followers: sum(now, 'net_followers'), profile_visits: sum(now, 'profile_visits') };
      const previous = { impressions: sum(before, 'impressions'), engagements: sum(before, 'engagements'), net_followers: sum(before, 'net_followers'), profile_visits: sum(before, 'profile_visits') };
      const rate = current.engagements / current.impressions, previousRate = previous.engagements / previous.impressions;
      out.push({ date: rows[i].date, current_start: now[0].date, previous_start: before[0].date, previous_end: before[before.length - 1].date, ...current, engagement_rate: rate, impressions_change: current.impressions / previous.impressions - 1, engagements_change: current.engagements / previous.engagements - 1, followers_change: current.net_followers / previous.net_followers - 1, visits_change: current.profile_visits / previous.profile_visits - 1, rate_change_points: (rate - previousRate) * 100 });
    }
    return out;
  },
});

const showCount = (value) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value) : '—';
const showCompact = (value) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { notation: Math.abs(value) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: Math.abs(value) >= 10000 ? 1 : 0 }).format(value) : '—';
const showRate = (value) => Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—';
const showChange = (value) => Number.isFinite(value) ? (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value * 100).toFixed(1) + '%' : '—';
const showPoints = (value) => Number.isFinite(value) ? (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toFixed(2) : '—';
const showDay = (value) => value ? Number(value.slice(5, 7)) + '月' + Number(value.slice(8, 10)) + '日' : '—';
const showFullDay = (value) => value ? value.slice(0, 4) + '年' + showDay(value) : '—';
const rowsOf = (id) => { const source = dash.data(id); return source.status === 'ok' && Array.isArray(source.data) ? source.data : []; };
const currentPeriod = () => { const rows = rowsOf('periods'); return rows.find((row) => row.date === dash.params().end) || rows[rows.length - 1] || null; };
const selectedRows = () => { const period = currentPeriod(); return period ? rowsOf('trend').filter((row) => row.date <= period.date) : []; };
const applyPeriod = (element, row) => { if (row) element.setAttribute('data-where', 'date=' + row.date); else element.removeAttribute('data-where'); };

dash.draw('end-control', (input) => {
  const rows = rowsOf('periods');
  input.disabled = rows.length === 0;
  if (!rows.length) return;
  input.min = rows[0].date; input.max = rows[rows.length - 1].date;
  if (document.activeElement !== input) input.value = currentPeriod().date;
  input.onchange = () => { if (input.value && input.validity.valid && rows.some((row) => row.date === input.value)) dash.setParams({ end: input.value }); };
  input.onblur = () => { input.value = currentPeriod().date; };
});

for (const control of document.querySelectorAll('.sc-metric')) {
  control.addEventListener('change', () => dash.setParams({ metric: control.value }));
  dash.onData(() => { control.value = dash.params().metric || 'impressions'; });
}
for (const button of document.querySelectorAll('.sc-reset')) button.addEventListener('click', () => {
  const periods = rowsOf('periods');
  if (periods.length) dash.setParams({ end: periods[periods.length - 1].date, metric: 'impressions', table_sort: 'date', table_dir: 'desc' });
});
for (const button of document.querySelectorAll('.sc-table button[data-sort]')) {
  button.addEventListener('click', () => {
    const field = button.getAttribute('data-sort');
    const params = dash.params();
    dash.setParams({ table_sort: field, table_dir: params.table_sort === field && params.table_dir === 'desc' ? 'asc' : 'desc' });
  });
  dash.onData(() => { button.parentElement.setAttribute('aria-sort', dash.params().table_sort === button.getAttribute('data-sort') ? (dash.params().table_dir === 'asc' ? 'ascending' : 'descending') : 'none'); });
}

dash.draw('period-label', (element) => {
  const row = currentPeriod(); applyPeriod(element, row);
  element.textContent = row ? showFullDay(row.current_start) + ' 至 ' + showDay(row.date) + '。每项变化均与前 28 天（' + showDay(row.previous_start) + ' 至 ' + showDay(row.previous_end) + '）比较。' : '正在读取示例数据…';
});
dash.draw('summary', (element) => {
  const row = currentPeriod(); applyPeriod(element, row);
  if (!row) { element.textContent = '正在读取日度记录…'; return; }
  const strong = (text) => { const node = document.createElement('strong'); node.textContent = text; return node; };
  element.replaceChildren(document.createTextNode('近 28 天曝光 '), strong(showCompact(row.impressions)), document.createTextNode('，互动 '), strong(showCompact(row.engagements)), document.createTextNode('，净增关注者 '), strong(showCount(row.net_followers)), document.createTextNode('。用日度记录，看清触达与增长的变化。'));
});

for (const [name, field, format] of [
  ['kpi-impressions', 'impressions', showCompact], ['kpi-engagements', 'engagements', showCompact], ['kpi-rate', 'engagement_rate', showRate], ['kpi-followers', 'net_followers', showCount], ['kpi-visits', 'profile_visits', showCount],
  ['delta-impressions', 'impressions_change', showChange], ['delta-engagements', 'engagements_change', showChange], ['delta-rate', 'rate_change_points', showPoints], ['delta-followers', 'followers_change', showChange], ['delta-visits', 'visits_change', showChange],
]) dash.draw(name, (element) => {
  const row = currentPeriod(); applyPeriod(element, row);
  element.textContent = row ? format(row[field]) : '—';
  if (name.startsWith('delta-')) { element.classList.toggle('sc-positive', !!row && row[field] > 0); element.classList.toggle('sc-negative', !!row && row[field] < 0); }
});

const svgNode = (name, attrs, text) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
};
const niceMaximum = (value) => { if (!(value > 0)) return 1; const power = Math.pow(10, Math.floor(Math.log10(value))); const fraction = value / power; return [1, 2, 4, 5, 8, 10].find((step) => fraction <= step) * power; };

function chart(element, rows, field, { small = false, bars = true, average = true, percent = false, label = '' } = {}) {
  element.replaceChildren();
  if (!rows.length) { const empty = document.createElement('div'); empty.className = 'sc-empty'; empty.textContent = dash.data('trend').status === 'loading' ? '正在读取示例数据…' : '暂无可显示的数据，请检查日期或在 Sources 查看来源。'; element.append(empty); return; }
  const width = Math.max(240, element.clientWidth || 800), height = small ? 210 : width < 600 ? 250 : 310;
  const margin = { top: 15, right: small ? 52 : 67, bottom: 31, left: percent ? 44 : 50 };
  const plotWidth = Math.max(80, width - margin.left - margin.right), plotHeight = height - margin.top - margin.bottom;
  const maximum = niceMaximum(Math.max(...rows.map((row) => Number(row[field]) || 0)) * 1.03);
  const x = (i) => margin.left + (i + .5) * plotWidth / rows.length;
  const y = (value) => margin.top + plotHeight - Math.max(0, value) / maximum * plotHeight;
  const format = percent ? showRate : showCompact;
  const wrap = document.createElement('div'); wrap.className = 'sc-chart-interactive'; wrap.tabIndex = 0; wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', label + '。左右方向键查看逐日值，Home 和 End 跳转首尾。');
  const svg = svgNode('svg', { width: '100%', height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': label });
  const description = svgNode('desc', {}, '数据来自示例日度 CSV。灰柱表示每日值，蓝线表示' + (average ? '7 日均值' : '当日互动率') + '；逐日数据表提供全部精确值。'); svg.append(description);
  for (let i = 0; i <= 4; i++) {
    const value = maximum * i / 4, yy = y(value);
    svg.append(svgNode('line', { x1: margin.left, x2: margin.left + plotWidth, y1: yy, y2: yy, stroke: '#e7e9e2', 'stroke-width': 1 }));
    svg.append(svgNode('text', { x: margin.left - 9, y: yy + 4, 'text-anchor': 'end' }, percent ? (value * 100).toFixed(value === 0 ? 0 : 1) + '%' : showCompact(value)));
  }
  const monthIndices = rows.map((row, i) => i === 0 || row.date.slice(0, 7) !== rows[i - 1].date.slice(0, 7) ? i : -1).filter((i) => i >= 0);
  const step = Math.max(1, Math.ceil(monthIndices.length / Math.max(2, Math.floor(plotWidth / 72))));
  const ticks = monthIndices.filter((_, i) => i % step === 0);
  if (x(rows.length - 1) - x(ticks[ticks.length - 1]) > 65) ticks.push(rows.length - 1);
  for (const i of ticks) {
    const date = rows[i].date;
    svg.append(svgNode('text', { x: x(i), y: height - 8, 'text-anchor': 'middle' }, i === 0 ? date.slice(0, 4) + '/' + Number(date.slice(5, 7)) : Number(date.slice(5, 7)) + '月'));
  }
  const paintedBars = [];
  if (bars) for (let i = 0; i < rows.length; i++) {
    const bw = Math.min(18, Math.max(.65, plotWidth / rows.length - 1.8));
    const rect = svgNode('rect', { x: x(i) - bw / 2, y: y(rows[i][field]), width: bw, height: Math.max(0, y(0) - y(rows[i][field])), rx: Math.min(2, bw / 2), fill: '#bfc3b7' });
    paintedBars.push(rect); svg.append(rect);
  }
  const lineField = average ? field + '_avg7' : field;
  const lineRows = rows.map((row, i) => ({ row, i })).filter(({ row }) => Number.isFinite(row[lineField]));
  const path = lineRows.map(({ row, i }, n) => (n ? 'L' : 'M') + x(i).toFixed(2) + ',' + y(row[lineField]).toFixed(2)).join(' ');
  svg.append(svgNode('path', { d: path, fill: 'none', stroke: '#2a78d6', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  const last = lineRows[lineRows.length - 1];
  if (last) {
    svg.append(svgNode('circle', { cx: x(last.i), cy: y(last.row[lineField]), r: 4, fill: '#2a78d6', stroke: '#ffffff', 'stroke-width': 2 }));
    svg.append(svgNode('text', { x: margin.left + plotWidth + 7, y: y(last.row[lineField]) + 4, style: 'fill:#50594a;font-weight:600' }, format(last.row[lineField])));
  }
  const guide = svgNode('line', { y1: margin.top, y2: y(0), stroke: '#87977c', 'stroke-width': 1, visibility: 'hidden' }); svg.append(guide);
  const tip = document.createElement('div'); tip.className = 'sc-tooltip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
  const dateText = document.createElement('div'); dateText.className = 'sc-tooltip-date';
  const makeTipRow = (name) => { const row = document.createElement('div'); row.className = 'sc-tooltip-row'; const title = document.createElement('span'); title.textContent = name; const value = document.createElement('strong'); row.append(title, value); tip.append(row); return value; };
  tip.append(dateText);
  const dailyValue = makeTipRow(average ? '每日值' : '互动率'); const averageValue = average ? makeTipRow('7 日均值') : null;
  let index = rows.length - 1, previousBar = -1;
  const show = (i) => {
    index = Math.max(0, Math.min(rows.length - 1, i)); const row = rows[index];
    dateText.textContent = showFullDay(row.date); dailyValue.textContent = format(row[field]); if (averageValue) averageValue.textContent = Number.isFinite(row[lineField]) ? format(row[lineField]) : '不足 7 天';
    tip.hidden = false; tip.style.top = '12px'; tip.style.left = Math.max(8, Math.min(width - Math.min(202, width - 16) - 8, x(index) + 12)) + 'px';
    guide.setAttribute('x1', x(index)); guide.setAttribute('x2', x(index)); guide.setAttribute('visibility', 'visible');
    if (paintedBars[previousBar]) paintedBars[previousBar].setAttribute('fill', '#bfc3b7');
    if (paintedBars[index]) paintedBars[index].setAttribute('fill', '#8b9a7e'); previousBar = index;
  };
  const hide = () => { tip.hidden = true; guide.setAttribute('visibility', 'hidden'); if (paintedBars[previousBar]) paintedBars[previousBar].setAttribute('fill', '#bfc3b7'); };
  wrap.addEventListener('pointermove', (event) => { const bounds = svg.getBoundingClientRect(); show(Math.round(((event.clientX - bounds.left) * width / bounds.width - margin.left) / plotWidth * rows.length - .5)); });
  wrap.addEventListener('pointerleave', () => { if (document.activeElement !== wrap) hide(); });
  wrap.addEventListener('focus', () => show(index)); wrap.addEventListener('blur', hide);
  wrap.addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); show(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowLeft' ? -1 : 1)); });
  wrap.append(svg, tip); element.append(wrap);
}

dash.draw('main-chart', (element) => {
  const field = ['impressions', 'engagements', 'net_followers', 'profile_visits'].includes(dash.params().metric) ? dash.params().metric : 'impressions';
  const names = { impressions: '曝光量', engagements: '互动数', net_followers: '净增关注者', profile_visits: '主页访问' };
  chart(element, selectedRows(), field, { label: '年度' + names[field] + '趋势' });
});
dash.draw('rate-chart', (element) => chart(element, selectedRows().slice(-90), 'engagement_rate', { small: true, bars: false, average: false, percent: true, label: '最近 90 天互动率' }));
dash.draw('followers-chart', (element) => chart(element, selectedRows().slice(-90), 'net_followers', { small: true, label: '最近 90 天净增关注者及 7 日均值' }));
dash.draw('chart-range', (element) => { const rows = selectedRows(); element.textContent = rows.length ? showFullDay(rows[0].date) + ' — ' + showFullDay(rows[rows.length - 1].date) + ' · ' + rows.length + ' 天示例记录' : ''; });
dash.draw('row-count', (element) => { const rows = selectedRows(); element.textContent = rows.length ? showCount(rows.length) + ' 条记录' : '—'; });
dash.draw('source-count', (element) => { const row = rowsOf('source_meta')[0]; element.textContent = row ? showCount(row.rows_count) : '—'; });
dash.draw('data-table', (body) => {
  const rows = selectedRows().slice();
  const field = ['date', 'impressions', 'engagements', 'engagement_rate', 'net_followers', 'profile_visits'].includes(dash.params().table_sort) ? dash.params().table_sort : 'date';
  const direction = dash.params().table_dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => direction * (field === 'date' ? a.date.localeCompare(b.date) : a[field] - b[field]));
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const tr = document.createElement('tr'); tr.setAttribute('data-key', row.date);
    for (const value of [showFullDay(row.date), showCount(row.impressions), showCount(row.engagements), showRate(row.engagement_rate), showCount(row.net_followers), showCount(row.profile_visits)]) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    fragment.append(tr);
  }
  body.replaceChildren(fragment);
});
