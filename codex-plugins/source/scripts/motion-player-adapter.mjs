import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-motion-player */';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refused = message => Object.assign(new Error(message), { code: 'MOTION_PLAYER_ADAPTER_UNSUPPORTED' });

/** Flush the canonical live-store queue, including edits still waiting for a frame. */
export function bindNativeMotionDocument(document, target = globalThis) {
  const flush = async () => {
    await document.save();
    document.flushNow();
    const deadline = Date.now() + 8_000;
    while (true) {
      const detail = document.syncDetail();
      if (document.saveState().status === 'error') throw new Error('The film still has unsaved changes.');
      if (!document.dirty() && detail.pending === 0 && detail.flights === 0) return true;
      if (Date.now() >= deadline) throw new Error('The film still has unsaved changes.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  target.__CODEX_DESIGN_EDITOR_FLUSH__ = flush;
  const dispose = document.dispose.bind(document);
  document.dispose = () => {
    if (target.__CODEX_DESIGN_EDITOR_FLUSH__ === flush) delete target.__CODEX_DESIGN_EDITOR_FLUSH__;
    return dispose();
  };
  return document;
}

/** Keep playback time separate from authored time after a user recuts a film. */
export function bindNativeMotionPlayer(host, authoredTime, target = globalThis) {
  target.__CODEX_DESIGN_MOTION_PLAYER__ = {
    state: () => host.state,
    authoredTime: () => authoredTime(host.state.meta?.parts, host.state.t),
    seek: seconds => host.seek(seconds),
  };
}

function definition(source, property) {
  const matches = [...source.matchAll(new RegExp(`\\ba\\(e,"${escape(property)}",\\(\\)=>(${String.raw`[\w$]+`})(?=[,)])`, 'g'))];
  if (matches.length !== 1) throw refused(`The canonical Motion ${property} export changed.`);
  const match = matches[0], start = source.lastIndexOf('function ' + match[1] + '(', match.index);
  if (start < 0) throw refused(`The canonical Motion ${property} declaration changed.`);
  const part = readCommentComponent(source.slice(start), new RegExp(`^function ${escape(match[1])}\\(([^)]*)\\)\\{`));
  if (!part) throw refused(`The canonical Motion ${property} signature changed.`);
  return { ...part, start, end: start + part.end, parameters: part.match[1].split(',') };
}

function replaceOnce(source, pattern, replacement, label) {
  let count = 0;
  const result = source.replace(pattern, (...values) => { count++; return typeof replacement === 'function' ? replacement(...values) : replacement; });
  if (count !== 1) throw refused(`The canonical Motion ${label} changed.`);
  return result;
}

/** Adapt host boundaries; keep the upstream player, timeline and scene renderer intact. */
export function adaptNativeMotionPlayer(source) {
  if (source.includes(marker)) return source;
  if (!source.includes('"MotionApp"')) {
    if (!source.includes('globalThis.claude=') || !source.includes('async customAnchors(')) return source;
    const local = replaceOnce(source, /([\w$]+)\(\{base:"\/",modeShortcut:null,header:!0,pinSide:([\w$]+)\}\)/g,
      (_, factory, side) => `${factory}({base:"/",modeShortcut:null,header:${native}?!1:!0,pinSide:${side}})`, 'local comment header');
    return marker + '\n' + local;
  }
  const updates = [];
  const document = definition(source, 'createLiveFilmDocument');
  const documentText = replaceOnce(document.text, /return\(0,e\.watchThumbnailDocumentLoad\)\(([\w$]+),/g,
    (_, doc) => `if(${native})__codexBindMotionDocument(${doc});return(0,e.watchThumbnailDocumentLoad)(${doc},`, 'live-store save barrier');
  updates.push({ ...document, replacement: documentText });

  const app = definition(source, 'MotionApp');
  const appText = replaceOnce(app.text, /([\w$]+)=e\.ReactReactRuntime\.useSyncExternalStore\(([\w$]+)\.subscribe,\(\)=>\2\.state\)/g,
    (_, state, host) => `${state}=(${native}&&__codexBindMotionPlayer(${host},e.playedTimeToAuthoredTime),e.ReactReactRuntime.useSyncExternalStore(${host}.subscribe,()=>${host}.state))`, 'player state binding');
  updates.push({ ...app, replacement: appText });

  const engine = definition(source, 'createVideoExportEngine');
  let engineText = replaceOnce(engine.text, /async format\(\)\{/g,
    `async format(){if(${native}&&globalThis.__CODEX_DESIGN_MOTION_EXPORT__)return{label:"MP4 · Local renderer"};`, 'native MP4 capability');
  engineText = replaceOnce(engineText, /async estimate\(([\w$]+),([\w$]+)\)\{(?=let [\w$]+=[\w$]+\.state\.meta,[\w$]+=await )/g,
    (match) => `${match}if(${native}&&globalThis.__CODEX_DESIGN_MOTION_EXPORT__)return null;`, 'native MP4 estimate');
  engineText = replaceOnce(engineText, /async run\(([\w$]+),([\w$]+),([\w$]+)\)\{(?=let [\w$]+=[\w$]+\.state\.meta;if\([\w$]+===null\)throw new e\.FilmGoneError\("No animation is loaded\."\);let [\w$]+=await )/g,
    (match, options, progress, signal) => `${match}if(${native}&&globalThis.__CODEX_DESIGN_MOTION_EXPORT__){const resource=await globalThis.__CODEX_DESIGN_MOTION_EXPORT__({format:"mp4",options:${options}},${progress},${signal});return{blob:{...resource,size:resource.bytes??resource.size??0},filename:resource.filename,mime:resource.mimeType}}`, 'native MP4 encoder');
  updates.push({ ...engine, replacement: engineText });

  const save = definition(source, 'saveHostDownload');
  const [data, filename] = save.parameters;
  let saveText = save.text.replace(save.match[0], save.match[0] + `if(${native}&&${data}&&typeof ${data}.exportToken==="string"){try{const saved=await globalThis.claude.downloads.save({filename:${filename},data:${data}});return{outcome:"saved",code:"",...saved?.path?{path:saved.path}:{}}}catch(error){return{outcome:error.code==="declined"?"declined":"failed",code:error.code||"EXPORT_FAILED"}}}`);
  saveText = replaceOnce(saveText, /catch\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\1\);return\{outcome:\2==="declined"\?"declined":"unsupported",code:\2\}\}/g,
    (_, error, code, classify) => `catch(${error}){let ${code}=${classify}(${error});return{outcome:${code}==="declined"?"declined":${native}?"failed":"unsupported",code:${code}}}`, 'Save As error handling');
  updates.push({ ...save, replacement: saveText });
  const outcome = definition(source, 'getSaveResultAction');
  const [status] = outcome.parameters;
  updates.push({ ...outcome, replacement: outcome.text.replace(outcome.match[0], outcome.match[0] + `if(${native})return ${status}==="saved"?"saved":${status}==="declined"?"keep":"failed";`) });
  const exports = definition(source, 'createHostExportEntries');
  updates.push({ ...exports, replacement: exports.text.replace(exports.match[0], exports.match[0] + `if(${native})return null;`) });
  for (const part of updates.sort((a, b) => b.start - a.start)) source = source.slice(0, part.start) + part.replacement + source.slice(part.end);
  return marker + '\nconst __codexBindMotionDocument=' + bindNativeMotionDocument.toString() + ';\nconst __codexBindMotionPlayer=' + bindNativeMotionPlayer.toString() + ';\n' + source;
}
