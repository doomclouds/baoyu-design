const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-comment-toolbar */';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function readCommentComponent(source, pattern) {
  const match = pattern.exec(source);
  if (!match) return null;
  let depth = 1, quote = null, escaped = false;
  const begin = match.index + match[0].length;
  for (let index = begin; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || character === '`') quote = character;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return { match, start: match.index, end: index + 1, text: source.slice(match.index, index + 1) };
  }
  throw new Error('The packaged comment component could not be read.');
}

/** Reuse canonical toolbar seats and their full comment controller; never add a native bubble or header. */
export function adaptCommentToolbar(source) {
  if (source.includes(marker)) return source;
  let changed = false, factoryCalls = 0;
  const factory = /function ([\w$]+)\(\{base:[\w$]+,win:[\w$]+=window,modeShortcut:[\w$]+="C",launcher:[\w$]+,header:[\w$]+=!1,toolbar:[\w$]+=!1,pinSide:[\w$]+\}\)\{/.exec(source);
  if (factory) {
    // Slides/Canvas already pass toolbar:true. DS/Dashboard opt into those
    // same seats only in the native document. New DS enables the HTTP header;
    // preserve that there, while keeping the native menu's existing seats.
    const call = new RegExp(`${escape(factory[1])}\\(\\{base:([\\w$]+)(,header:!0)?\\}\\)`, 'g');
    source = source.replace(call, (_, base, header) => {
      changed = true; factoryCalls++;
      return `${factory[1]}({base:${base}${header ? `,header:${native}?!1:!0` : ''},toolbar:!!${native}})`;
    });
    // A DS sidebar tool row can sit near the bottom. Keep the original list
    // reachable within this editor's viewport instead of opening below it.
    const top = /function ([\w$]+)\(([\w$]+)\)\{for\((?:const|let) ([\w$]+) of \2\)\{(?:const|let) ([\w$]+)=\(\3\.el\.closest\([\w$]+\)\?\?\3\.el\.parentElement\)\?\.getBoundingClientRect\(\);if\(!\(!\4\|\|\4\.height===0\)\)return Math\.round\(\4\.bottom\+([\w$]+)\)\}return null\}/;
    let positioned = 0;
    source = source.replace(top, (match, name, seats, seat, rect, margin) => {
      positioned++; changed = true;
      return match.replace(`Math.round(${rect}.bottom+${margin})`, `Math.round(${native}?Math.min(${rect}.bottom+${margin},Math.max(${margin},globalThis.innerHeight/2)):${rect}.bottom+${margin})`);
    });
    if (positioned !== 1) throw new Error('The canonical toolbar comment-list anchor changed; adaptation was refused.');
  }
  const seat = jsx => `${native}?${jsx}.jsx("span",{"data-baoyu-comments-seat":"","data-codex-comment-toolbar":"",style:{display:"contents"}}):null`;
  const floating = readCommentComponent(source, /function ([\w$]+)\(\{sections:[\w$]+,tail:[\w$]+,current:[\w$]+,onJump:[\w$]+,footer:[\w$]+,status:([\w$]+),navRef:[\w$]+,edgeRef:[\w$]+,port:[\w$]+,marks:[\w$]+,search:[\w$]+,pending:[\w$]+\}\)\{/);
  const sidebar = readCommentComponent(source, /function ([\w$]+)\(\{sections:[\w$]+,tail:[\w$]+,current:[\w$]+,onJump:[\w$]+,dropProps:[\w$]+,footer:([\w$]+),navRef:[\w$]+,marks:[\w$]+,search:[\w$]+,pending:[\w$]+\}\)\{/);
  if (floating || sidebar) {
    if (!floating || !sidebar) throw new Error('The design-system navigation modes changed; adaptation was refused.');
    if (factoryCalls !== 1) throw new Error('The design-system comment mounting options changed; adaptation was refused.');
    const jsx = /return ([\w$]+)\.jsx\(/.exec(floating.text)?.[1];
    if (!jsx) throw new Error('The design-system navigation JSX runtime was not found.');
    const status = floating.match[2], footer = sidebar.match[2];
    const suffix = `}),${status}]})})}`;
    if (!floating.text.endsWith(suffix)) throw new Error('The design-system chapter tool row changed; adaptation was refused.');
    const floatingText = floating.text.slice(0, -suffix.length) + `}),${seat(jsx)},${status}]})})}`;
    const footerPattern = new RegExp(`${escape(footer)}!==void 0\\?${escape(jsx)}\\.jsx\\("div",\\{className:"ds-nav-foot[^\"]*","data-testid":"ds-nav-foot",children:${escape(footer)}\\}\\):null`);
    let footers = 0;
    const sidebarText = sidebar.text.replace(footerPattern, match => {
      footers++;
      return match.replace(`${footer}!==void 0?`, `(${footer}!==void 0||${native})?`)
        .replace(`children:${footer}`, `children:${jsx}.jsxs(${jsx}.Fragment,{children:[${seat(jsx)},${footer}]})`);
    });
    if (footers !== 1) throw new Error('The design-system sidebar tool row changed; adaptation was refused.');
    for (const part of [{ ...floating, replacement: floatingText }, { ...sidebar, replacement: sidebarText }].sort((a, b) => b.start - a.start)) source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
    changed = true;
  }
  if (source.includes('toolbarTrailing:') && source.includes('markToolbarUncommentable')) {
    const slot = /([\w$]+)\.jsx\("span",\{ref:([\w$]+)\.markToolbarUncommentable,hidden:!0\}\)/;
    if (!slot.test(source)) throw new Error('The dashboard toolbar slot changed; adaptation was refused.');
    source = source.replace(slot, (_, jsx, namespace) => `${jsx}.jsx("span",{ref:${namespace}.markToolbarUncommentable,hidden:!${native},"data-baoyu-comments-seat":${native}?"":void 0,"data-codex-comment-toolbar":${native}?"":void 0,style:${native}?{display:"contents"}:void 0})`);
    changed = true;
  }
  return changed ? marker + '\n' + source : source;
}
