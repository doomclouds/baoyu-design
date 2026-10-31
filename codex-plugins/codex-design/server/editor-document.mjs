import { createHash } from 'node:crypto';
import { repairEditorRuntime } from '../scripts/editor-runtime-adapter.mjs';
import { adaptFloatingCommentAccess } from '../scripts/comment-floating-adapter.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });
const scriptText = value => value.replace(/<\/script/gi, '<\\/script');
const attribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const mime = value => ({ woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', wasm: 'application/wasm' })[value.split('.').pop().toLowerCase()] || 'application/octet-stream';

async function replaceAsync(source, expression, transform) {
  const matches = [...source.matchAll(expression)];
  const replacements = await Promise.all(matches.map(match => transform(match)));
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    source = source.slice(0, match.index) + replacements[i] + source.slice(match.index + match[0].length);
  }
  return source;
}

/** Adapt only the editor's local-host selection, never authored artwork files. */
export function adaptInlineEditorScript(source, scriptUrl) {
  source = repairEditorRuntime(source);
  source = adaptFloatingCommentAccess(source);
  source = source.replace(/\bwindow\.parent===window\b/g, '(!!globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__||window.parent===window)');
  source = source.replace(/function ([\w$]+)\(([\w$]+)\)\{return \2\.parent===\2\?null:\{post:/g,
    (match, name, win) => `function ${name}(${win}){return (globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&${win}===globalThis.window)||${win}.parent===${win}?null:{post:`);
  source = source.replace(/localComments:([\w$]+)=>([\w$]+)\(\{base:\1,toolbar:!0\}\)/g,
    (match, base, create) => `localComments:${base}=>${create}({base:${base},toolbar:!globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__})`);
  // An intrinsic opaque data: origin is not a secure context. getRandomValues
  // remains available there; this quote-free fallback also survives canonical
  // runtime code serialized into nested preview and worker string literals.
  source = source.replace(/(?<![\w$.])(?:[\w$]+\.)?crypto\.randomUUID\(\)/g, call => {
    const crypto = call.slice(0, -'.randomUUID()'.length);
    return `((c)=>{if(c.randomUUID)return c.randomUUID();let b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;return Array.from(b,(v,i)=>([4,6,8,10].includes(i)?String.fromCharCode(45):String())+(v+256).toString(16).slice(1)).join(String())})(${crypto})`;
  });
  source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(scriptUrl));
  source = source.replace(/new URL\((["'])\.\/\1,([\w$]+)\.location\.href\)\.href/g,
    match => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`);
  source = source.replace(/new URL\((["'])\.\/\1,location\.href\)\.href/g,
    match => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`);
  source = source.replace(/([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\1\?null:([\w$]+)\.localComments\?\.\(([\w$]+)\)/g,
    (match, link, getParent, win, local, options, base) => `${link}=globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?null:${getParent}(${win}),${local}=${link}?null:${options}.localComments?.(${base})`);
  // Capture the original editor flush closure before its optional parent-link
  // branch. It dispatches the editor's dirty guard and awaits its publish queue.
  source = source.replace(/return ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\),\5&&\(\5\.onMessage\(async ([\w$]+)=>\{if\(\6\.type!==["']editor:flush["']\)return;const ([\w$]+)=await ([\w$]+)\(\2,\4\);/g,
    (match, listen, win, base, client, parent, request, saved, flush) => `return globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&(globalThis.__CODEX_DESIGN_EDITOR_FLUSH__=()=>${flush}(${win},${client})),${match.slice(7)}`);
  source = source.replace(/new URL\(target\.location\.href\)\.searchParams\.get\(["']codexDesignLanguage["']\)/g,
    match => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.language??${match})`);
  return source;
}

/**
 * Build an editor document entirely from its verified local session. The host
 * receives inline bytes and a virtual base; no localhost iframe is requested.
 * fetchLocal has the standard fetch Response contract and must refuse redirects.
 */
export async function buildEditorDocument({ baseUrl, fetchLocal, config = {}, maxBytes = 24 * 1024 * 1024 } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw error('EDITOR_INVALID_URL', 'An authenticated loopback editor session is required.');
  }
  if (typeof fetchLocal !== 'function') throw new TypeError('A scoped editor fetch function is required.');
  const virtual = new URL(config.virtualBase || config.baseUrl || 'https://codex-design.invalid/');
  if (virtual.protocol !== 'https:' || virtual.hostname !== 'codex-design.invalid' || virtual.username || virtual.password) {
    throw error('EDITOR_INVALID_URL', 'The native editor virtual base is invalid.');
  }
  let total = 0;
  const requests = new Map();
  const scripts = new Map();
  const resolveLocal = (value, relative = base) => {
    const url = new URL(value, relative);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash) {
      throw error('EDITOR_ASSET_REFUSED', 'An editor asset points outside its verified session.');
    }
    return url;
  };
  const bytes = (value, relative) => {
    const url = resolveLocal(value, relative);
    if (!requests.has(url.href)) requests.set(url.href, (async () => {
      const response = await fetchLocal(url.href);
      if (!response.ok) throw error('EDITOR_ASSET_FAILED', `An editor asset failed to load (HTTP ${response.status}).`);
      const length = Number(response.headers?.get?.('content-length'));
      if (length > maxBytes) throw error('EDITOR_DOCUMENT_TOO_LARGE', 'An editor asset exceeds the native document limit.');
      const buffer = Buffer.from(await response.arrayBuffer());
      total += buffer.length;
      if (total > maxBytes) throw error('EDITOR_DOCUMENT_TOO_LARGE', 'The native editor document exceeds its content limit.');
      return buffer;
    })());
    return requests.get(url.href);
  };
  const dataUrl = async (value, relative) => {
    const url = resolveLocal(value, relative);
    const data = await bytes(url.href);
    return `data:${mime(url.pathname)};base64,${data.toString('base64')}`;
  };
  const script = (value, relative, chain = []) => {
    const url = resolveLocal(value, relative);
    if (chain.includes(url.href)) throw error('EDITOR_MODULE_CYCLE', 'The editor module graph needs a prebuilt native bundle.');
    if (!scripts.has(url.href)) scripts.set(url.href, (async () => {
      let code = (await bytes(url.href)).toString('utf8');
      const virtualScript = new URL(url.pathname.slice(base.pathname.length), virtual).href;
      code = adaptInlineEditorScript(code, virtualScript);
      code = await replaceAsync(code, /\bimport\(\s*(["'])(\.[^"']+)\1\s*\)/g, async match => {
        const dependency = await script(match[2], url, [...chain, url.href]);
        return `import(${JSON.stringify('data:text/javascript;base64,' + Buffer.from(dependency).toString('base64'))})`;
      });
      return code;
    })());
    return scripts.get(url.href);
  };
  const css = async (value, relative) => {
    const url = resolveLocal(value, relative);
    let code = (await bytes(url.href)).toString('utf8');
    code = await replaceAsync(code, /url\(\s*(["']?)([^"')]+)\1\s*\)/g, async match => {
      if (/^(?:data:|blob:|#)/i.test(match[2])) return match[0];
      return `url("${await dataUrl(match[2], url)}")`;
    });
    return code;
  };
  let html = (await bytes(base.href)).toString('utf8');
  if (!/<head\b[^>]*>/i.test(html)) throw error('EDITOR_INVALID_DOCUMENT', 'The editor did not return an HTML document.');
  html = html.replace('appifact_extra_export_formats:window.parent===window', 'appifact_extra_export_formats:true');
  html = html.replace(/<base\b[^>]*>/gi, '');
  // Resolve document tags before inserting JavaScript, whose string literals
  // can themselves contain example HTML such as stylesheet links.
  html = await replaceAsync(html, /<link\b([^>]*\bhref\s*=\s*(["'])([^"']+)\2[^>]*)>/gi, async match => {
    if (/\brel\s*=\s*(["'])stylesheet\1/i.test(match[1])) return `<style>\n${(await css(match[3], base)).replace(/<\/style/gi, '<\\/style')}\n</style>`;
    if (/\brel\s*=\s*(["'])(?:modulepreload|preload)\1/i.test(match[1])) return '';
    return match[0];
  });
  html = await replaceAsync(html, /<script\b([^>]*\bsrc\s*=\s*(["'])([^"']+)\2[^>]*)>\s*<\/script>/gi, async match => {
    const code = await script(match[3], base);
    const module = /\btype\s*=\s*(["'])module\1/i.test(match[1]);
    const deferred = !module && /\bdefer\b/i.test(match[1]);
    const body = deferred ? `if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',()=>{${code}\n},{once:true});}else{${code}\n}` : code;
    return `<script${module ? ' type="module"' : ''}>\n${scriptText(body)}\n</script>`;
  });
  const bootstrap = typeof config.bootstrap === 'string' ? config.bootstrap : '';
  html = html.replace(/<head\b[^>]*>/i, match => `${match}\n<meta http-equiv="Content-Security-Policy" content="form-action 'none'">\n<base href="${attribute(virtual.href)}">\n<script>${scriptText(bootstrap)}</script>`);
  const outputBytes = Buffer.byteLength(html);
  if (outputBytes > maxBytes) throw error('EDITOR_DOCUMENT_TOO_LARGE', 'The assembled native editor exceeds its content limit.');
  return { html, bytes: outputBytes, assetCount: requests.size, sha256: createHash('sha256').update(html).digest('hex'), virtualBase: virtual.href };
}
