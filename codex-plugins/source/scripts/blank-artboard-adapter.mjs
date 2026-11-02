const marker = '/* codex-design:native-blank-artboard-contract */';
const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const __codexBlankScriptBody = 'class Component extends DCLogic {\n  renderVals() { return {}; }\n}';
const __codexBlankPreviewOwners = new WeakMap();

/** Complete only a newly created empty board, using its resolved canvas size. */
export function completeNativeBlankArtboard(html, size) {
  if (typeof html !== 'string' || /\bdata-dc-script\b/.test(html)) return html;
  if (typeof size?.file !== 'string' || !size.file.endsWith('.dc.html') || ![size.w, size.h].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    throw new Error('The new artboard needs a finite positive width and height.');
  }
  const end = html.lastIndexOf('</body>');
  const close = html.lastIndexOf('</x-dc>');
  if (end < 0 || close < 0 || close >= end) throw new Error('The new blank artboard template changed.');
  const props = JSON.stringify({ $preview: { width: size.w, height: size.h } });
  const script = `<script type="text/x-dc" data-dc-script data-codex-design-blank="${encodeURIComponent(size.file)}" data-props='${props}'>\n${__codexBlankScriptBody}\n</script>\n`;
  return html.slice(0, end) + script + html.slice(end);
}

/** Keep our unchanged generated logic paired with its own canvas dimensions. */
export function syncNativeBlankArtboardPreviews(state, indexFile, owner) {
  const files = state?.content?.files;
  const indexText = files?.[indexFile];
  if (typeof indexText !== 'string') return state;
  // Each live files store has its own update-function identity. Remember the
  // immutable index text, rather than a potentially mutated state reference.
  const tracked = typeof owner === 'function' || owner !== null && typeof owner === 'object';
  const previous = tracked ? __codexBlankPreviewOwners.get(owner) : undefined;
  if (previous?.indexFile === indexFile && previous.indexText === indexText) return state;
  let index;
  try { index = JSON.parse(indexText); } catch { return state; }
  let boards;
  if (index?.boards && typeof index.boards === 'object' && !Array.isArray(index.boards)) boards = Object.entries(index.boards);
  else if (Array.isArray(index?.artboards)) {
    // The live document seam carries legacy artboards; its publisher converts
    // that layout to the canonical v3 boards map only after local edits settle.
    const seen = new Set();
    boards = [];
    for (const size of index.artboards) {
      if (!size || typeof size !== 'object' || Array.isArray(size) || typeof size.file !== 'string' || !size.file
        || seen.has(size.file) || ![size.w, size.h].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) return state;
      seen.add(size.file); boards.push([size.file, size]);
    }
  } else return state;
  let next;
  for (const [file, size] of boards) {
    const html = files[file];
    if (typeof html !== 'string' || ![size?.w, size?.h].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) continue;
    const scripts = [...html.matchAll(/<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)]
      .filter(match => /\bdata-dc-script\b/i.test(match[1]));
    if (scripts.length !== 1) continue;
    const script = scripts[0], attrs = script[1];
    if (!/\btype="text\/x-dc"/.test(attrs) || !attrs.includes(`data-codex-design-blank="${encodeURIComponent(file)}"`)
      || script[2].replace(/\r\n/g, '\n').trim() !== __codexBlankScriptBody) continue;
    const attribute = /\sdata-props=(['"])([\s\S]*?)\1/.exec(attrs);
    if (!attribute) continue;
    let props;
    try {
      const decoded = attribute[2].replace(/&(quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, (match, name) => {
        if (name[0] === '#') return String.fromCodePoint(parseInt(name.slice(name[1].toLowerCase() === 'x' ? 2 : 1), name[1].toLowerCase() === 'x' ? 16 : 10));
        return { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }[name.toLowerCase()];
      });
      props = JSON.parse(decoded);
    } catch { continue; }
    if (!props || typeof props !== 'object' || Array.isArray(props) || !props.$preview || typeof props.$preview !== 'object' || Array.isArray(props.$preview)) continue;
    if (![props.$preview.width, props.$preview.height].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) continue;
    if (props.$preview.width === size.w && props.$preview.height === size.h && attribute[1] === "'") continue;
    const json = JSON.stringify({ ...props, $preview: { ...props.$preview, width: size.w, height: size.h } })
      .replaceAll('&', '&amp;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const changedAttrs = attrs.slice(0, attribute.index) + ` data-props='${json}'` + attrs.slice(attribute.index + attribute[0].length);
    next ??= { ...files };
    next[file] = html.slice(0, script.index) + script[0].replace(attrs, changedAttrs) + html.slice(script.index + script[0].length);
  }
  const result = next ? { ...state, content: { ...state.content, files: next } } : state;
  // A failed scan must remain eligible for the next update's recovery attempt.
  if (tracked) __codexBlankPreviewOwners.set(owner, { indexFile, indexText });
  return result;
}

/** Adapt the two real creation owners; leave the shared factory and copies intact. */
export function adaptBlankArtboardCreation(source) {
  if (source.includes(marker) || !source.includes('"blankDcDocument"')) return source;
  const once = (expression, replacement, label) => {
    let count = 0;
    source = source.replace(expression, (...values) => { count++; return replacement(...values); });
    if (count !== 1) throw new Error(`The canonical ${label} changed; blank artboard adaptation was refused.`);
  };
  const ui = /let ([\w$]+)=([\w$]+)\?\(0,e\.insertBlankArtboardMarkup\)\(\(0,e\.blankDcDocument\)\(\),\2\):\(0,e\.blankDcDocument\)\(\);(await\(0,e\.getKvClient\)\(\)\.set\(\(0,e\.PlatformFileContentHandler_4\)\(([\w$]+)\),\1\));/g;
  let text, body, save, file;
  once(ui, (match, html, markup, write, name) => {
    [text, body, save, file] = [html, markup, write, name];
    return match.replace(write + ';', `if(!${native}||${body})${write};`);
  }, 'new empty artboard save');
  const uiCommit = new RegExp(`;([\\w$]+)\\.current\\(\\{kind:"add",entries:\\[\\{file:${escape(file)},src:${escape(text)},spec:([\\w$]+)\\}\\]\\}`, 'g');
  once(uiCommit, (match, history, spec) => `;if(${native}&&!${body}){${text}=__codexCompleteBlankArtboard(${text},${spec});${save};}${match.slice(1)}`, 'new empty artboard metadata');

  const batch = /([\w$]+)\[([\w$]+)\]=([\w$]+);let [\s\S]{0,1700}?([\w$]+)\.push\(([\w$]+)\),([\w$]+)\.push\(\{file:\2,src:\3,spec:\5\}\)/g;
  once(batch, (match, files, name, html, boards, spec, entries, offset) => {
    const bodyInput = /typeof ([\w$]+)\.x==/.exec(match)?.[1];
    // The final spec follows the source-selection expression, so its input is
    // the same entry used for the body, copy and optional page-rule branches.
    const selection = source.slice(Math.max(0, offset - 900), offset);
    if (!bodyInput || !selection.includes(`${bodyInput}.body.trim()===""`) || !selection.includes(`${bodyInput}.from!==void 0?`)) {
      throw new Error('The canonical blank batch input changed; adaptation was refused.');
    }
    const guard = `${native}&&${bodyInput}.from===void 0&&${bodyInput}.body.trim()===""&&(${bodyInput}.pageRule===void 0||${bodyInput}.pageRule==="")`;
    const before = `if(${guard}){${html}=__codexCompleteBlankArtboard(${html},${spec});${files}[${name}]=${html};}`;
    return match.replace(`${boards}.push(${spec}),${entries}.push`, before + `${boards}.push(${spec}),${entries}.push`);
  }, 'blank batch artboard metadata');
  once(/function ([\w$]+)\(([\w$]+)\)\{([\w$]+)=\2,([\w$]+)\(\2\.content\.files\),([\w$]+)\(!1\),([\w$]+)\(\)\}/g,
    (match, name, value, state) => match.replace(`{${state}=`, `{if(${native})${value}=__codexSyncBlankPreviews(${value},e.canvasMetadataFile,${name});${state}=`), 'local canvas content update');
  return marker + '\nconst __codexBlankScriptBody=' + JSON.stringify(__codexBlankScriptBody)
    + ';\nconst __codexBlankPreviewOwners=new WeakMap()'
    + ';\nconst __codexCompleteBlankArtboard=' + completeNativeBlankArtboard.toString()
    + ';\nconst __codexSyncBlankPreviews=' + syncNativeBlankArtboardPreviews.toString() + ';\n' + source;
}
