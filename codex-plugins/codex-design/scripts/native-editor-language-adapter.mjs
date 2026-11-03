import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-conflict-language */';
const layer = '"data-baoyu-clash-layer"';
const actions = ['theirs:"Use theirs"', 'mine:"Keep mine"', 'copy:"Keep both"'];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unsupported = () => Object.assign(new Error('The canonical conflict language selector changed; native adaptation was refused.'), { code: 'EDITOR_LANGUAGE_ADAPTER_UNSUPPORTED' });
const hostErrorMarker = '/* codex-design:native-host-operation-errors-v1 */';

/** Change only audited capability-error branches, never arbitrary string values. */
export function adaptNativeHostErrors(source) {
  if (source.includes(hostErrorMarker)) return source;
  let adapted = source;
  const unavailable = 'Saving is unavailable in this view. Reopen the artwork in Codex Design to reconnect local editing.';
  for (const host of ['claude', 'slidesHost', 'designHost', 'designSystemHost']) {
    const original = `window.${host}.self is missing — this view’s runtime predates the self capability (or this page is running outside a Frame shell and the emulator). Content cannot be saved from here.`;
    const statement = `throw Error(${JSON.stringify(original)})`;
    if (!adapted.includes(statement)) continue;
    if (adapted.split(statement).length !== 2) throw new Error('The reviewed self-capability error branch changed.');
    adapted = adapted.replace(statement, `throw Error(${native}?${JSON.stringify(unavailable)}:${JSON.stringify(original)})`);
  }
  const denied = 'throw{code:"not_granted",message:"The self capability is not available to this view."}';
  if (adapted.includes(denied)) {
    if (adapted.split(denied).length !== 2) throw new Error('The reviewed self-capability denial branch changed.');
    adapted = adapted.replace(denied, `throw{code:"not_granted",message:${native}?"Permission to save is unavailable in this view. Reopen the artwork in Codex Design to retry.":"The self capability is not available to this view."}`);
  }
  return adapted === source ? source : hostErrorMarker + '\n' + adapted;
}

/** Keep the canonical conflict/presence chrome English only inside the native app. */
export function adaptNativeEditorLanguage(source) {
  if (source.includes(marker)) return source;
  const layers = source.split(layer).length - 1;
  if (!layers && !actions.every(action => source.includes(action))) return source;
  const selectors = [...source.matchAll(/const ([\w$]+)=\/\^zh\\b\/i\.test\(navigator\.language\);/g)];
  if (layers !== 1 || selectors.length !== 1) throw unsupported();
  const selector = selectors[0];
  const branch = new RegExp(`\\b([\\w$]+)=${escape(selector[1])}\\?\\{changed:`, 'g');
  if ([...source.matchAll(branch)].length !== 1) throw unsupported();
  const chinese = readCommentComponent(source, branch);
  const english = chinese && readCommentComponent(source.slice(chinese.end), /^:\{changed:/);
  if (!english || !actions.every(action => english.text.includes(action))
    || !english.text.includes('sub:e=>"Your edits on it are not saved yet. Pick one:"')
    || !/^,[\w$]+=`/.test(source.slice(chinese.end + english.end))) throw unsupported();
  // Preserve the original selector and both dictionaries for standalone users;
  // never override navigator/Intl or translate names, board labels or content.
  const replacement = selector[0].replace('=/^zh', `=${native}?!1:/^zh`);
  return marker + '\n' + source.slice(0, selector.index) + replacement + source.slice(selector.index + selector[0].length);
}
