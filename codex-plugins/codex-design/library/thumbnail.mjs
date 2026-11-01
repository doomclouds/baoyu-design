import path from 'node:path';
import { createHash } from 'node:crypto';
import { LibraryError } from './safety.mjs';

const LIMITS = { maxSourceBytes: 512 * 1024, maxAssetBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxDocumentBytes: 6 * 1024 * 1024 };
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const decode = value => String(value).replace(/&(?:#(x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (match, number) => {
  if (number) { const point = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''; }
  return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[match.toLowerCase()] || '';
});
const textOf = html => decode(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim();
const dimension = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 40 && Number(value) <= 8000 ? Math.round(Number(value)) : fallback;
function attributes(source) {
  const result = new Map();
  for (const match of source.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1].toLowerCase(); if (!result.has(name)) result.set(name, decode(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return result;
}
async function replaceAsync(text, expression, fn) {
  let result = '', cursor = 0;
  for (const match of text.matchAll(expression)) { result += text.slice(cursor, match.index) + await fn(match); cursor = match.index + match[0].length; }
  return result + text.slice(cursor);
}
const ALLOWED = new Set('section article main header nav footer div p span h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr th td caption colgroup col hr br figure figcaption pre code b strong em i u s small sup sub blockquote a img button label input select option svg g defs path rect circle ellipse line polyline polygon text tspan lineargradient radialgradient stop clippath mask pattern use image title desc'.split(' '));
const VOID = new Set(['img', 'input', 'hr', 'br', 'col']);
const BLOCKED = new Set(['script', 'iframe', 'object', 'embed', 'foreignobject', 'math', 'noscript', 'canvas', 'video', 'audio', 'applet', 'template']);
const SVG_NAMES = { lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath' };
const ATTR_NAMES = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', patternunits: 'patternUnits', patterntransform: 'patternTransform', clippathunits: 'clipPathUnits', textlength: 'textLength', lengthadjust: 'lengthAdjust' };
const ATTRS = new Set('id class style title lang dir role aria-label aria-hidden width height viewbox preserveaspectratio x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity transform offset stop-color stop-opacity gradientunits gradienttransform patternunits patterntransform clippathunits clip-path mask filter text-anchor dominant-baseline font-family font-size font-weight letter-spacing textlength lengthadjust colspan rowspan alt type value placeholder checked selected'.split(' '));

function skipElement(html, from, name) {
  const expression = new RegExp('<\\/?' + name + '\\b(?:[^"\'<>]|"[^"]*"|\'[^\']*\')*>', 'gi'); expression.lastIndex = from;
  let depth = 1, match;
  while ((match = expression.exec(html))) { if (/^<\//.test(match[0])) depth--; else if (!/\/\s*>$/.test(match[0])) depth++; if (!depth) return expression.lastIndex; }
  return html.length;
}

async function sanitizedCss(css, base, context) {
  if (Buffer.byteLength(css) > context.limits.maxSourceBytes) { context.note('A large stylesheet was omitted.'); return ''; }
  css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import\b[^;]*;?/gi, '').replace(/<|>|\u0000/g, '');
  if (/\\[0-9a-f]{1,6}\s?/i.test(css)) { context.note('Escaped CSS was omitted from this static preview.'); return ''; }
  css = css.replace(/(?:expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding\s*:)[^;}]*[;}]?/gi, '');
  return replaceAsync(css, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, async match => {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (/^#[A-Za-z_][\w:.-]*$/.test(value)) return 'url("' + value + '")';
    const asset = await context.asset(value, base, 'style'); return asset ? 'url("' + asset + '")' : 'none';
  });
}

/** Rebuild inert HTML/SVG from an allowlist; do not execute the artwork's scripts. */
async function sanitize(html, base, context, defaults = {}) {
  html = html.replace(/<!doctype\b[^>]*>|<\?[\s\S]*?\?>/gi, '');
  html = html.replace(/{{\s*([A-Za-z_$][\w.$-]*|true|false)\s*}}/g, (_, key) => {
    if (key === 'true' || key === 'false') return key;
    const value = defaults[key]; if (['string', 'number', 'boolean'].includes(typeof value)) return escape(value);
    context.dynamic = true; return '';
  });
  let result = '', cursor = 0; const stack = [];
  const closeTo = name => { const index = stack.map(item => item.source).lastIndexOf(name); if (index < 0) return; while (stack.length > index) result += '</' + stack.pop().output + '>'; };
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) { result += escape(decode(html.slice(cursor))); break; }
    result += escape(decode(html.slice(cursor, start)));
    if (html.startsWith('<!--', start)) { const end = html.indexOf('-->', start + 4); cursor = end < 0 ? html.length : end + 3; continue; }
    const token = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/.exec(html.slice(start));
    if (!token) { result += '&lt;'; cursor = start + 1; continue; }
    cursor = start + token[0].length; const closing = !!token[1], name = token[2].toLowerCase();
    if (closing) { closeTo(name); continue; }
    const attrs = attributes(token[3]);
    if (BLOCKED.has(name) || name === 'aside' || name === 'title' && !stack.some(item => item.source === 'svg')) { context.dynamic ||= name === 'script' || name === 'canvas'; cursor = skipElement(html, cursor, name); continue; }
    if (name === 'style') { const end = /<\/style\s*>/gi; end.lastIndex = cursor; const match = end.exec(html); const css = await sanitizedCss(html.slice(cursor, match ? match.index : html.length), base, context); result += '<style>' + css + '</style>'; cursor = match ? end.lastIndex : html.length; continue; }
    if (name === 'link') {
      if ((attrs.get('rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) {
        const file = context.resolve(attrs.get('href') || '', base);
        if (file && context.files.has(file) && file.endsWith('.css')) result += '<style>' + await sanitizedCss(await context.text(file), file, context) + '</style>';
        else context.note('An external or missing stylesheet was omitted.');
      }
      continue;
    }
    if (name === 'sc-if') { const value = attrs.get('value'); const hint = attrs.get('hint-placeholder-val'); if (value === 'false' || value !== 'true' && hint === 'false') cursor = skipElement(html, cursor, name); continue; }
    if (['html', 'head', 'body', 'x-dc', 'helmet', 'sc-for'].includes(name)) { if (name === 'sc-for') context.dynamic = true; continue; }
    let output = SVG_NAMES[name] || name;
    if (name === 'x-shape') output = 'div'; else if (!ALLOWED.has(name)) { if (name.includes('-')) { context.dynamic = true; context.note('A custom component is not executed in the static cover.'); } continue; }
    const rendered = [];
    for (let [attribute, value] of attrs) {
      if (attribute.startsWith('sc-camel-')) attribute = attribute.slice(9);
      if (attribute.startsWith('on') || attribute.startsWith('data-') || ['nonce', 'srcset', 'formaction', 'action', 'autofocus', 'contenteditable'].includes(attribute)) continue;
      if (['src', 'href', 'xlink:href', 'poster', 'background'].includes(attribute)) {
        if (name === 'use' && /^#[A-Za-z_][\w:.-]*$/.test(value)) rendered.push('href="' + escape(value) + '"');
        else if (['img', 'image'].includes(name)) { const uri = await context.asset(value, base, 'image'); if (uri) rendered.push((name === 'image' ? 'href' : 'src') + '="' + escape(uri) + '"'); }
        continue;
      }
      if (!ATTRS.has(attribute) || value.length > 65536) continue;
      if (name === 'x-shape' && attribute === 'style') continue;
      if (attribute === 'style') value = await sanitizedCss(value, base, context);
      else if (/url\s*\(/i.test(value)) value = await sanitizedCss(value, base, context);
      if (attribute === 'type' && name === 'input' && !['text', 'email', 'number', 'date', 'range', 'checkbox', 'radio', 'button'].includes(value)) value = 'text';
      rendered.push((ATTR_NAMES[attribute] || attribute) + '="' + escape(value) + '"');
    }
    if (name === 'x-shape') {
      const kind = attrs.get('kind'); const shape = kind === 'arrow-right' ? 'clip-path:polygon(0 25%,65% 25%,65% 0,100% 50%,65% 100%,65% 75%,0 75%);' : kind === 'ellipse' ? 'border-radius:50%;' : kind === 'rounded' ? 'border-radius:8px;' : '';
      rendered.push('style="' + escape('display:block;' + await sanitizedCss(attrs.get('style') || '', base, context) + ';' + shape) + '"');
    }
    if (['button', 'input', 'select'].includes(name)) rendered.push('disabled=""');
    if (name === 'a') rendered.push('aria-disabled="true"');
    result += '<' + output + (rendered.length ? ' ' + rendered.join(' ') : '') + '>';
    if (!VOID.has(name) && !/\/\s*>$/.test(token[0])) stack.push({ source: name, output });
    else if (!VOID.has(name)) result += '</' + output + '>';
  }
  while (stack.length) result += '</' + stack.pop().output + '>';
  return result;
}

function defaultsOf(html) {
  const values = {};
  for (const match of html.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    const raw = attributes(match[1]).get('data-props'); if (!raw) continue;
    try { const parsed = JSON.parse(raw); for (const [key, spec] of Object.entries(parsed)) if (spec && ['string', 'number', 'boolean'].includes(typeof spec.default)) values[key] = spec.default; }
    catch { /* Unreadable interactive defaults are never executed. */ }
  }
  return values;
}
function hasRootBackground(html) {
  // An authored document background already supplies the artwork canvas.
  // Preserve it rather than covering it with the ordinary white fallback.
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const css = style[1]; let selectorStart = 0;
    for (let cursor = 0; cursor < css.length; cursor++) {
      if (css[cursor] === '}') { selectorStart = cursor + 1; continue; }
      if (css[cursor] !== '{') continue;
      const close = css.indexOf('}', cursor + 1), nested = css.indexOf('{', cursor + 1);
      if (close < 0) break;
      if (nested >= 0 && nested < close) { selectorStart = cursor + 1; continue; }
      const selectors = css.slice(selectorStart, cursor), declarations = css.slice(cursor + 1, close);
      cursor = close; selectorStart = close + 1;
      if (!/(?:^|;)\s*background(?:-color)?\s*:/i.test(declarations)) continue;
      if (selectors.split(',').some(selector => /(?:^|[\s>+~])(?:html|body|:root)(?:\.[\w-]+|#[\w-]+|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*$/i.test(selector.trim()))) return true;
    }
  }
  return false;
}
function tokenCss(tokens) {
  const declarations = [], values = new Map(), theme = tokens.color?.themes?.[0]?.id || 'light';
  for (const family of Object.values(tokens)) if (Array.isArray(family?.tokens)) for (const token of family.tokens) if (/^[A-Za-z_][\w-]*$/.test(token.name || '')) values.set(token.name, typeof token.value === 'object' && token.value ? token.value[theme] ?? Object.values(token.value)[0] : token.value);
  const resolve = (value, depth = 0) => depth > 8 ? '' : typeof value === 'string' && /^\{[^{}]+\}$/.test(value) ? resolve(values.get(value.slice(1, -1)), depth + 1) : value;
  const safeValue = value => ['string', 'number'].includes(typeof value) && !/[;{}<>]/.test(String(value)) ? String(value) : '';
  for (const [name, value] of values) { const resolved = safeValue(resolve(value)); if (resolved) declarations.push('--' + name + ':' + resolved); }
  for (const [name, value] of Object.entries(tokens.type?.families || {})) if (/^[A-Za-z_][\w-]*$/.test(name) && safeValue(value)) declarations.push('--font-' + name + ':' + value);
  let css = ':root{' + declarations.join(';') + '}';
  for (const group of tokens.type?.groups || []) for (const style of group.styles || []) if (/^[A-Za-z_][\w-]*$/.test(style.name || '')) {
    const properties = [];
    for (const [key, attribute] of Object.entries({ fontSize: 'font-size', lineHeight: 'line-height', fontWeight: 'font-weight', letterSpacing: 'letter-spacing', textTransform: 'text-transform' })) if (safeValue(style[key])) properties.push(attribute + ':' + style[key]);
    if (/^[A-Za-z_][\w-]*$/.test(group.family || '')) properties.push('font-family:var(--font-' + group.family + ')');
    css += '.' + style.name + '{' + properties.join(';') + '}';
  }
  return css;
}

export async function createArtifactThumbnail(store, id, options = {}) {
  const limits = { ...LIMITS, ...options };
  for (const key of Object.keys(LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new LibraryError('INVALID_THUMBNAIL_OPTION', 'Thumbnail limits must be positive integers.');
  const record = await store.get(id);
  if (record.contentStatus !== 'ok') throw new LibraryError(record.contentError?.code || 'ARTIFACT_CONTENT_UNAVAILABLE', 'Artwork content is unavailable for a real preview.');
  const listed = await store.listFiles(id), files = new Map(listed.map(file => [file.path, file]));
  const hash = createHash('sha256'); hash.update(JSON.stringify({ artifactId: record.id, kind: record.kind, title: record.title, files: listed.map(file => ({ path: file.path, bytes: file.bytes })).sort((a, b) => a.path < b.path ? -1 : 1) }));
  const read = new Map(), assets = new Map(), visiting = new Set(), notes = [];
  let total = 0;
  const context = {
    files, limits, dynamic: false,
    note(message) { if (!notes.includes(message) && notes.length < 20) notes.push(message); },
    async text(file) {
      if (!files.has(file)) throw new LibraryError('MISSING_CONTENT', 'A preview source file is missing.');
      if (!read.has(file)) {
        if (files.get(file).bytes > limits.maxSourceBytes || total + files.get(file).bytes > limits.maxTotalBytes) throw new LibraryError('THUMBNAIL_LIMIT', 'The static preview source exceeds its limit.');
        const result = await store.readFile(id, file, { encoding: 'utf8' }); total += result.bytes; read.set(file, result.text); hash.update(file + '\0' + result.text);
      }
      return read.get(file);
    },
    resolve(value, base) {
      value = decode(value).trim();
      if (files.has(value)) return value;
      const blob = /^\/_blob\/([a-f0-9]{32})$/.exec(value)?.[1];
      if (blob) { if (record.kind === 'dashboard') return files.has('_blobs/' + blob) ? '_blobs/' + blob : null; return [...files.keys()].find(file => file.startsWith((record.kind === 'design-system' ? 'project/_blobs/' : 'project/assets/') + blob + '.')) || null; }
      if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(value) || /[\\\u0000-\u001f]/.test(value)) return null;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(base), value.split(/[?#]/)[0]));
      return files.has(relative) ? relative : null;
    },
    async asset(value, base, purpose) {
      value = decode(value).trim();
      if (/^data:/i.test(value)) {
        const parsed = /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml)|font\/(?:woff2?|ttf|otf));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
        if (!parsed || value.length > Math.ceil(limits.maxAssetBytes / 3) * 4 + 100 || purpose === 'image' && !parsed[1].startsWith('image/')) { context.note('An unsupported embedded resource was omitted.'); return null; }
        if (parsed[1].toLowerCase() === 'image/svg+xml') return 'data:image/svg+xml;base64,' + Buffer.from(await sanitize(Buffer.from(parsed[2], 'base64').toString('utf8'), base, context)).toString('base64');
        return value;
      }
      const file = context.resolve(value, base);
      if (!file) { if (value) context.note('An external or missing resource was omitted.'); return null; }
      if (assets.has(file)) return assets.get(file);
      if (visiting.has(file)) { context.note('A recursive image reference was omitted.'); return null; }
      const info = files.get(file), mime = info.contentType || 'application/octet-stream';
      if (!(mime.startsWith('image/') || purpose === 'style' && mime.startsWith('font/')) || info.bytes > limits.maxAssetBytes || total + info.bytes > limits.maxTotalBytes) { context.note('An unsupported or large material was omitted.'); return null; }
      visiting.add(file);
      try {
        const resource = await store.readFile(id, file, { encoding: 'base64' }); total += resource.bytes; hash.update(file + '\0' + resource.data);
        let data = resource.data;
        if (mime === 'image/svg+xml') data = Buffer.from(await sanitize(Buffer.from(data, 'base64').toString('utf8'), file, context)).toString('base64');
        const uri = 'data:' + mime + ';base64,' + data; assets.set(file, uri); return uri;
      } finally { visiting.delete(file); }
    },
  };
  const json = async file => { try { return JSON.parse(await context.text(file)); } catch (cause) { if (cause instanceof LibraryError) throw cause; throw new LibraryError('INVALID_CONTENT', 'A thumbnail index is invalid.'); } };
  let sourceFile, width = 1200, height = 720, raw, extraCss = '', fidelity = 'native-static', normalizer = '';
  if (record.kind === 'slides') {
    const index = await json('project/deck.json'); const first = index.order?.[0];
    if (typeof first !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(first)) throw new LibraryError('NO_STATIC_COVER', 'This deck has no first slide to preview.');
    sourceFile = 'project/slides/' + first + '.html'; raw = await context.text(sourceFile); width = 1920; height = 1080;
    normalizer = `.codex-cover-surface>section{position:relative;width:${width}px;height:${height}px;box-sizing:border-box;overflow:hidden}.codex-cover-surface :is(h1,h2,h3,h4,p,ul,ol){margin:0}`;
  } else if (record.kind === 'design') {
    const index = await json('project/canvas.json'); const first = (index.order || []).find(name => index.boards?.[name]) || Object.keys(index.boards || {})[0];
    if (!first || !files.has('project/' + first)) throw new LibraryError('NO_STATIC_COVER', 'This canvas has no first artboard to preview.');
    sourceFile = 'project/' + first; raw = await context.text(sourceFile); width = dimension(index.boards[first].w, 1440); height = dimension(index.boards[first].h, 900);
  } else if (record.kind === 'design-system') {
    await json('project/design-system.json'); sourceFile = 'project/components/Cover/preview.html';
    if (!files.has(sourceFile)) sourceFile = files.has('project/README.md') ? 'project/README.md' : 'project/tokens.json';
    if (sourceFile.endsWith('.html')) { raw = await context.text(sourceFile); width = dimension(/width\s*:\s*(\d+)px/i.exec(raw)?.[1], 960); height = dimension(/@dsCard\b[^>]*\bheight\s*=\s*(\d+)/i.exec(raw)?.[1], 540); extraCss = await sanitizedCss(tokenCss(await json('project/tokens.json')), 'project/tokens.json', context); }
    else { const text = await context.text(sourceFile); raw = '<div style="padding:64px;font:28px/1.6 system-ui;color:#20211f;background:#fafaf8"><h1>' + escape(record.title) + '</h1><p>' + escape(text.slice(0, 700)) + '</p></div>'; fidelity = 'content-reference'; context.note('The design system has no static Cover HTML; this preview quotes actual content.'); }
  } else {
    const page = await json('db/files/index.html.json'); sourceFile = 'db/files/index.html.json';
    if (typeof page.text !== 'string') throw new LibraryError('INVALID_CONTENT', 'The dashboard page is missing.');
    const headings = [...page.text.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(match => textOf(match[2])).filter(Boolean);
    const firstImage = /<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(page.text)?.[0] || '';
    raw = '<div style="width:1200px;height:720px;box-sizing:border-box;padding:62px;color:#20211f;background:#fafaf8;font-family:system-ui"><p style="margin:0 0 18px;font-size:17px;color:#66705d">Static content reference · 动态页面内容参考</p><h1 style="margin:0 0 30px;font-size:46px;font-weight:500;line-height:1.3">' + escape(headings[0] || record.title) + '</h1>' + firstImage + '<div style="font-size:26px;line-height:1.8;color:#4d5944">' + headings.slice(1, 6).map(heading => '<p style="margin:10px 0">' + escape(heading) + '</p>').join('') + '</div></div>';
    fidelity = 'content-reference'; context.note('Dashboard scripts and chart calculations were not executed. This is actual page text/material, not a rendered chart screenshot.');
    // Read the real script/style documents into the revision without executing them.
    for (const file of [...files.keys()].filter(file => /^db\/files\/[^/]+\.(?:js|css)\.json$/.test(file)).sort()) await context.text(file);
  }
  const clean = await sanitize(raw, sourceFile, context, defaultsOf(raw));
  if (context.dynamic && record.kind !== 'dashboard') context.note('Interactive code was not executed; the cover uses static markup and literal preview defaults.');
  const revision = hash.digest('hex');
  const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  // Letterboxing belongs to the library surface, while an unspecified artwork
  // canvas keeps its ordinary white background inside the original viewBox.
  const canvasBackground = hasRootBackground(clean) ? 'transparent' : '#fff';
  const srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape(csp) + '"><meta name="referrer" content="no-referrer"><title>' + escape(record.title) + '</title><style>html,body{background:transparent}' + extraCss + normalizer + '</style></head><body><svg class="codex-cover-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet"><foreignObject width="' + width + '" height="' + height + '"><div xmlns="http://www.w3.org/1999/xhtml" class="codex-cover-surface" style="width:' + width + 'px;height:' + height + 'px;overflow:hidden;background:' + canvasBackground + '">' + clean + '</div></foreignObject></svg><style>html,body{margin:0!important;width:100%;height:100%;overflow:hidden!important}body>.codex-cover-svg{display:block;width:100vw;height:100vh}.codex-cover-surface *{animation:none!important;transition:none!important;pointer-events:none!important}</style></body></html>';
  if (Buffer.byteLength(srcdoc) > limits.maxDocumentBytes) throw new LibraryError('THUMBNAIL_LIMIT', 'The static cover exceeds its output limit.');
  return { artifactId: record.id, id: record.id, kind: record.kind, title: record.title, revision, cacheKey: record.id + ':' + revision, srcdoc, previewWidth: width, previewHeight: height, fidelity, sourceFile, notes };
}
