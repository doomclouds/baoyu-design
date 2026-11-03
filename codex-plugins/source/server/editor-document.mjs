import { createHash } from 'node:crypto';
import { repairEditorRuntime } from '../scripts/editor-runtime-adapter.mjs';
import { adaptCommentToolbar } from '../scripts/comment-toolbar-adapter.mjs';
import { adaptCommentDrafts } from '../scripts/comment-draft-adapter.mjs';
import { adaptCommentViewport } from '../scripts/comment-viewport-adapter.mjs';
import { adaptAgentDrafts } from '../scripts/agent-draft-adapter.mjs';
import { adaptNativeHistoryUi } from '../scripts/native-history-adapter.mjs';
import { adaptNativeEditorLanguage } from '../scripts/native-editor-language-adapter.mjs';
import { adaptNativeMotionPlayer } from '../scripts/motion-player-adapter.mjs';

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
  // The upstream HTTP boot response prefixes a path/WebSocket transport shim.
  // Its owner/history metadata is still needed, but native sessions already
  // carry scoped fetch and SSE through MCP and must retain those transports.
  if (source.startsWith('(function(BASE){\nvar P=location.protocol') && source.includes('window.EventSource=S;') && source.includes("'baoyu-sse'")) {
    source = source.replace('(function(BASE){', '(function(BASE){if(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__)return;');
  }
  if (new URL(scriptUrl).pathname.endsWith('/__codex/history-ui.js')) return adaptNativeHistoryUi(source);
  source = adaptNativeEditorLanguage(source);
  source = repairEditorRuntime(source);
  source = adaptCommentToolbar(source);
  source = adaptCommentDrafts(source);
  source = adaptCommentViewport(source);
  source = adaptAgentDrafts(source);
  source = adaptNativeMotionPlayer(source);
  source = source.replace(/\bwindow\.parent===window\b/g, '(!!globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__||window.parent===window)');
  source = source.replace(/function ([\w$]+)\(([\w$]+)\)\{return \2\.parent===\2\?null:\{post:/g,
    (match, name, win) => `function ${name}(${win}){return (globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&${win}===globalThis.window)||${win}.parent===${win}?null:{post:`);
  // An intrinsic opaque data: origin is not a secure context. getRandomValues
  // remains available there; this quote-free fallback also survives canonical
  // runtime code serialized into nested preview and worker string literals.
  source = source.replace(/(?<![\w$.])(?:[\w$]+\.)?crypto\.randomUUID\(\)/g, call => {
    const crypto = call.slice(0, -'.randomUUID()'.length);
    return `((c)=>{if(c.randomUUID)return c.randomUUID();let b=new Uint8Array(16);c.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;return Array.from(b,(v,i)=>([4,6,8,10].includes(i)?String.fromCharCode(45):String())+(v+256).toString(16).slice(1)).join(String())})(${crypto})`;
  });
  source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(scriptUrl));
  // local-host.js is shipped unminified too: formatting must not leave its
  // relative-base lookup running against the native editor's opaque URL.
  source = source.replace(/\bnew\s+URL\s*\(\s*(["'])\.\/\1\s*,\s*([\w$]+)\s*\.\s*location\s*\.\s*href\s*\)\s*\.\s*href\b/g,
    match => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`);
  source = source.replace(/\bnew\s+URL\s*\(\s*(["'])\.\/\1\s*,\s*location\s*\.\s*href\s*\)\s*\.\s*href\b/g,
    match => `(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?.baseUrl??${match})`);
  source = source.replace(/([\w$]+)=([\w$]+)\(([\w$]+)\),([\w$]+)=\1\?null:([\w$]+)\.localComments\?\.\(([\w$]+)\)/g,
    (match, link, getParent, win, local, options, base) => `${link}=globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?null:${getParent}(${win}),${local}=${link}?null:${options}.localComments?.(${base})`);
  // Canvas sessions keep edits in their nested preview/model before publishing
  // them. Reuse the canonical settler and its null-on-unmount lifecycle instead
  // of treating a quiet file publisher as proof that those edits were saved.
  const settlers = [...source.matchAll(/\b[\w$]+\([\w$]+,["']setEmbedSettler["'],\(\)=>([\w$]+)\)/g)];
  if (settlers.length > 1 || /["']setEmbedSettler["']/.test(source) && settlers.length !== 1) throw error('EDITOR_SETTLE_ADAPTER_UNSUPPORTED', 'The editor session settler changed; review its native adapter before loading it.');
  if (settlers.length === 1) {
    const name = settlers[0][1].replaceAll('$', '\\$');
    const setter = new RegExp(`function ${name}\\(([\\w$]+)\\)\\{([\\w$]+)=\\1\\}`, 'g');
    let captures = 0;
    source = source.replace(setter, (match, callback, slot) => {
      captures++;
      return `function ${settlers[0][1]}(${callback}){${slot}=${callback};globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&(globalThis.__CODEX_DESIGN_EDITOR_SETTLE__=${callback})}`;
    });
    if (captures !== 1) throw error('EDITOR_SETTLE_ADAPTER_UNSUPPORTED', 'The editor session settler changed; review its native adapter before loading it.');
  }
  // Capture the original editor flush closure before its optional parent-link
  // branch. It dispatches the editor's dirty guard and awaits its publish queue.
  let flushCaptures = 0;
  source = source.replace(/([\w$]+)&&\(\1\.onMessage\(async ([\w$]+)=>\{if\(\2\.type!==["']editor:flush["']\)return;const ([\w$]+)=await ([\w$]+)\(([\w$]+),([\w$]+)\);/g,
    (match, parent, request, saved, flush, win, client) => {
      flushCaptures++;
      return `globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__&&(globalThis.__CODEX_DESIGN_EDITOR_FLUSH__=async()=>{await globalThis.__CODEX_DESIGN_EDITOR_SETTLE__?.();return ${flush}(${win},${client})}),${match}`;
    });
  if (flushCaptures > 1 || /type:["']editor:flushed["']/.test(source) && flushCaptures !== 1) throw error('EDITOR_FLUSH_ADAPTER_UNSUPPORTED', 'The editor save barrier changed; review its native adapter before loading it.');
  source = source.replace(/\bnew\s+URL\s*\(\s*target\s*\.\s*location\s*\.\s*href\s*\)\s*\.\s*searchParams\s*\.\s*get\s*\(\s*(["'])codexDesignLanguage\1\s*\)/g,
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
  if (config.nativeHistory === true) {
    // Native chrome uses only authenticated, artwork-scoped boot metadata and
    // the canonical History controller. Never load the network Share module.
    html = html.replace(/<script\b[^>]*\bsrc\s*=\s*(["'])\/__share\/(?:boot|ui)\.js(?:\?[^"']*)?\1[^>]*>\s*<\/script>/gi, '');
    html = html.replace(/<head\b[^>]*>/i, match => `${match}<script src="./__codex/boot.js"></script><script type="module" src="./__codex/history-ui.js"></script>`);
  }
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
