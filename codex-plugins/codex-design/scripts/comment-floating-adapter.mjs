const identifier = '[\\w$]+';

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

/** Keep the canonical list/filter/reopen controls reachable from the one native floating dock. */
export function adaptFloatingCommentAccess(source) {
  const root = readCommentComponent(source, /function ([\w$]+)\(\{controller:([\w$]+),modeShortcut:([\w$]+)="C",launcher:([\w$]+)=\{bottom:16\},header:[\w$]+=!1,seats:[\w$]+,pinSide:[\w$]+\}\)\{/);
  if (!root || root.text.includes('__codexFloatingCommentList')) return source;
  const split = /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,modeShortcut:[\w$]+,panelOpen:[\w$]+,onPanel:[\w$]+\}\)/.exec(source)?.[1];
  const list = readCommentComponent(source, /function ([\w$]+)\(\{controller:[\w$]+,state:[\w$]+,dark:([\w$]+),top:([\w$]+),onClose:[\w$]+\}\)\{/);
  const state = /(?:const|let) ([\w$]+)=(?:\(0,)?[\w$]+\.useSyncExternalStore(?:\))?\(/.exec(root.text)?.[1];
  const dark = /\{dark:([\w$]+),remScale:/.exec(root.text)?.[1];
  const panel = /\[([\w$]+),([\w$]+)\]=(?:\(0,)?[\w$]+\.useState(?:\))?\(!1\)/.exec(root.text);
  if (!split || !list || !state || !dark || !panel) throw new Error('The packaged comment controls changed; native floating adaptation was refused.');
  const controller = root.match[2], shortcut = root.match[3], launcher = root.match[4];
  let replacements = 0;
  const floating = root.text.replace(/children:(?:\(0,)?([\w$]+)\.jsx(?:\))?\(([\w$]+),\{variant:"ghost",iconOnly:!0,icon:"Comment",[\s\S]*?onClick:\(\)=>[\w$]+\.setMode\(![\w$]+\.mode\)\}\)/,
    (match, jsx) => {
      replacements++;
      const original = match.slice('children:'.length);
      return `children:globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__?(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[(0,${jsx}.jsx)(${split},{controller:${controller},state:${state},modeShortcut:${shortcut}??void 0,panelOpen:${panel[1]},onPanel:${panel[2]}}),${panel[1]}&&(0,${jsx}.jsx)(${list.match[1]},{controller:${controller},state:${state},dark:${dark},top:0,onClose:()=>${panel[2]}(!1),__codexFloatingCommentList:!0,__codexFloatBottom:${launcher}.bottom??16})]}):${original}`;
    });
  if (replacements !== 1) throw new Error('The canonical floating comment launcher was not found.');
  const listDark = list.match[2], top = list.match[3];
  let panelStyles = 0;
  const escapedDark = listDark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedTop = top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const style = new RegExp(`style:\\{top:${escapedTop},right:(${identifier}),[\\s\\S]*?\\.\\.\\.${identifier}\\(${escapedDark}\\)\\}`);
  let listText = list.text.replace(/,onClose:([\w$]+)\}\)\{/, ',onClose:$1,__codexFloatingCommentList:__cfx=!1,__codexFloatBottom:__cfb=16}){');
  listText = listText.replace(style, (match, margin) => {
    panelStyles++;
    return match.slice(0, -1) + `,...(__cfx?{position:"absolute",top:"auto",right:0,bottom:"calc(100% + 8px)",maxHeight:\`calc(100dvh - 100% - \${__cfb+${margin}+8}px)\`}:{})}`;
  });
  if (panelStyles !== 1) throw new Error('The canonical comment list position was not found.');
  const changes = [{ ...root, replacement: floating }, { ...list, replacement: listText }].sort((a, b) => b.start - a.start);
  for (const change of changes) source = source.slice(0, change.start) + change.replacement + source.slice(change.end);
  return source;
}
