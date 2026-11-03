import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const marker = '/* codex-design:native-motion-player */';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refused = message => Object.assign(new Error(message), { code: 'MOTION_PLAYER_ADAPTER_UNSUPPORTED' });

function motionLifecycleFor(target) {
  if (target.__CODEX_DESIGN_MOTION_LIFECYCLE__) return target.__CODEX_DESIGN_MOTION_LIFECYCLE__;
  let document, host, root, commit, closing = false, previewsHeld = false, disposed = target.__CODEX_DESIGN_EDITOR_TRANSPORT__?.disposed === true;
  const editStates = new Map();
  const roots = new WeakSet();
  const audioRenders = new Map();
  let audioGeneration = 0;
  const pauseAudio = (record, starting = false) => {
    if (record.pending) return record.pending;
    const context = record.context;
    if (context.state !== 'running' && !(context.state === 'suspended' && !record.paused && (starting || record.rendering))) return Promise.resolve();
    const at = context.currentTime + 0.02;
    const pause = at < context.length / context.sampleRate ? context.suspend(at) : record.rendering;
    record.pending = Promise.resolve(pause).then(async () => {
      record.paused = context.state === 'suspended';
      if (record.paused && !closing && !disposed) { record.paused = false; await context.resume(); }
    }).finally(() => { record.pending = undefined; });
    return record.pending;
  };
  const release = [];
  const quiesce = () => { host?.pause?.(); host?.holdPreview?.(true); };
  const once = value => {
    if (typeof value?.dispose !== 'function') return;
    const dispose = value.dispose.bind(value); let released = false;
    value.dispose = () => { if (released) return; released = true; return dispose(); };
  };
  const lifecycle = {
    get disposed() { return disposed; },
    get closing() { return closing; },
    bindDocument(value) { if (disposed) { value.dispose(); return false; } document = value; return true; },
    bindPlayer(value) {
      if (host === value) return;
      once(value);
      for (const name of ['play', 'prime']) if (typeof value[name] === 'function') {
        const original = value[name].bind(value);
        value[name] = (...args) => { if (!closing && !disposed) return original(...args); };
      }
      if (typeof value.load === 'function') {
        const load = value.load.bind(value);
        value.load = (...args) => disposed ? Promise.resolve(null) : load(...args);
      }
      if (typeof value.holdPreview === 'function') {
        const hold = value.holdPreview.bind(value);
        value.holdPreview = held => hold(previewsHeld || disposed || held);
      }
      if (disposed) { value.dispose?.(); return; }
      host = value;
      if (closing) host.pause?.();
    },
    bindRoot(value) {
      if (!roots.has(value)) {
        roots.add(value);
        const unmount = value.unmount.bind(value); let released = false;
        value.unmount = () => { if (released) return; released = true; return unmount(); };
        if (typeof value.render === 'function') {
          const render = value.render.bind(value);
          value.render = (...args) => { if (!disposed && !released) return render(...args); };
        }
      }
      if (disposed) { value.unmount(); return false; } root = value; return true;
    },
    bindEdits(name, state) { if (!disposed) editStates.set(name, state); },
    bindCommit(value) { if (!disposed) commit = value; },
    bindAudioRender(context) {
      if (disposed) { context.startRendering = () => Promise.reject(new Error('The film editor has closed.')); return context; }
      if (audioRenders.has(context)) return context;
      const record = { context, pending: undefined, rendering: undefined, paused: false, queued: undefined };
      audioRenders.set(context, record); audioGeneration++;
      const start = context.startRendering.bind(context);
      const run = () => {
        if (disposed) return Promise.reject(new Error('The film editor has closed.'));
        if (closing) pauseAudio(record, true).catch(error => { record.error = error; });
        record.rendering = start();
        record.rendering.then(() => audioRenders.delete(context), () => audioRenders.delete(context));
        return record.rendering;
      };
      context.startRendering = () => {
        if (disposed) return Promise.reject(new Error('The film editor has closed.'));
        if (previewsHeld) return new Promise((resolve, reject) => { record.queued = { start: () => run().then(resolve, reject), reject }; });
        return run();
      };
      return context;
    },
    editsReady() {
      const states = [...editStates.values()].map(read => read());
      const failed = states.find(state => state.error);
      if (failed) throw new Error('The film edit could not be saved. ' + failed.error);
      return !states.some(state => state.pending);
    },
    async settle() {
      await commit?.();
      const deadline = Date.now() + 8_000;
      for (;;) {
        if (disposed) throw new Error('The film editor has closed.');
        if (lifecycle.editsReady()) return true;
        if (Date.now() >= deadline) throw new Error('The film still has pending edits. Keep this tab open until they can be saved.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    prepareClose() {
      if (disposed) return;
      if (!closing) { closing = true; host?.pause?.(); }
      for (const record of audioRenders.values()) pauseAudio(record).catch(error => { record.error = error; });
      document?.flushNow?.();
    },
    async saved() {
      if (disposed) throw new Error('The film editor has closed.');
      if (!closing) return true;
      let generation;
      do {
        generation = audioGeneration;
        await Promise.all([...audioRenders.values()].map(record => pauseAudio(record)));
        if (disposed) throw new Error('The film editor has closed.');
        if (!closing) return true;
      } while (generation !== audioGeneration);
      const detail = document?.syncDetail?.();
      if (!lifecycle.editsReady() || document?.dirty?.() || detail?.pending || detail?.flights) return false;
      previewsHeld = true; host?.holdPreview?.(true);
      return true;
    },
    cancelClose() {
      if (disposed || !closing) return;
      closing = false; previewsHeld = false; host?.holdPreview?.(false);
      for (const record of audioRenders.values()) {
        record.error = undefined;
        if (record.queued) { const queued = record.queued; record.queued = undefined; queued.start(); }
        else if (record.paused && !record.pending) { record.paused = false; record.context.resume().catch(() => {}); }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; closing = true;
      for (const record of audioRenders.values()) pauseAudio(record).catch(() => {});
      for (const dispose of [quiesce, () => root?.unmount(), () => host?.dispose?.(), () => document?.dispose?.()]) {
        try { dispose(); } catch (error) { release.push(error); }
      }
      root = host = document = commit = undefined;
      editStates.clear();
      for (const record of audioRenders.values()) record.queued?.reject(new Error('The film editor has closed.'));
      audioRenders.clear();
      delete target.__CODEX_DESIGN_MOTION_PLAYER__;
      if (release.length) throw new AggregateError(release, 'The Motion player could not release every resource.');
    },
  };
  target.__CODEX_DESIGN_MOTION_LIFECYCLE__ = lifecycle;
  target.__CODEX_DESIGN_EDITOR_PREPARE_CLOSE__ = lifecycle.prepareClose;
  target.__CODEX_DESIGN_EDITOR_CANCEL_CLOSE__ = lifecycle.cancelClose;
  target.__CODEX_DESIGN_EDITOR_DISPOSE__ = lifecycle.dispose;
  target.__CODEX_DESIGN_EDITOR_SETTLE__ = lifecycle.settle;
  return lifecycle;
}

/** Flush the canonical live-store queue, including edits still waiting for a frame. */
export function bindNativeMotionDocument(document, target = globalThis) {
  const lifecycle = motionLifecycleFor(target);
  let pending;
  const save = async () => {
    if (lifecycle.disposed) throw new Error('The film editor has closed.');
    await lifecycle.settle();
    await document.save();
    if (lifecycle.disposed) throw new Error('The film editor has closed.');
    document.flushNow();
    const deadline = Date.now() + 8_000;
    while (true) {
      if (lifecycle.disposed) throw new Error('The film editor has closed.');
      const detail = document.syncDetail();
      if (document.saveState().status === 'error') throw new Error('The film still has unsaved changes.');
      if (!document.dirty() && detail.pending === 0 && detail.flights === 0) {
        await lifecycle.settle();
        const latest = document.syncDetail();
        if (!lifecycle.disposed && lifecycle.editsReady() && !document.dirty() && latest.pending === 0 && latest.flights === 0) {
          if (await lifecycle.saved()) return true;
        }
      }
      if (Date.now() >= deadline) throw new Error('The film still has unsaved changes.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const flush = () => {
    if (pending) return pending;
    const saved = save();
    const current = saved.finally(() => { if (pending === current) pending = undefined; });
    pending = current; return current;
  };
  const dispose = document.dispose.bind(document);
  let released = false;
  document.dispose = () => {
    if (released) return; released = true;
    if (target.__CODEX_DESIGN_EDITOR_FLUSH__ === flush) delete target.__CODEX_DESIGN_EDITOR_FLUSH__;
    return dispose();
  };
  if (lifecycle.bindDocument(document)) target.__CODEX_DESIGN_EDITOR_FLUSH__ = flush;
  return document;
}

/** Keep playback time separate from authored time after a user recuts a film. */
export function bindNativeMotionPlayer(host, authoredTime, target = globalThis) {
  const lifecycle = motionLifecycleFor(target);
  lifecycle.bindPlayer(host);
  if (lifecycle.disposed) return;
  target.__CODEX_DESIGN_MOTION_PLAYER__ = {
    state: () => host.state,
    authoredTime: () => authoredTime(host.state.meta?.parts, host.state.t),
    seek: seconds => host.seek(seconds),
  };
}

export function bindNativeMotionRoot(root, target = globalThis) {
  return motionLifecycleFor(target).bindRoot(root);
}

export function bindNativeMotionEditState(name, state, target = globalThis) {
  motionLifecycleFor(target).bindEdits(name, state);
}

export function bindNativeMotionCommit(commit, target = globalThis) {
  motionLifecycleFor(target).bindCommit(commit);
}

export function bindNativeMotionAudioRender(context, target = globalThis) {
  return motionLifecycleFor(target).bindAudioRender(context);
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
  source = replaceOnce(source, /"This folder is one animation, as code\. Made with Claude Motion on "\+([\w$]+)\.day\+"\. An AI model wrote this code\."/g,
    (_, value) => `"Editable Motion film. Saved on "+${value}.day+". This folder contains editable code."`, 'source-folder introduction');
  source = replaceOnce(source, /The animation's code was written by Claude, an AI model, for the person who made it\. Treat it as you would any code from outside\./g,
    'The animation is stored as editable code. Treat it as you would any code from outside.', 'source-file safety introduction');
  const updates = [];
  source = replaceOnce(source, /async function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{(?=let [\w$]+=Math.round\(\5\*[\w$]+\),[\w$]+=Math.ceil\(\5\*\4\),[\w$]+=new OfflineAudioContext)/g,
    match => match.replace('){', ',__codexTrackAudio){'), 'offline score-render callback');
  source = replaceOnce(source, /([\w$]+)=new OfflineAudioContext\(2,([\w$]+)\+([\w$]+),([\w$]+)\),([\w$]+)=\1\.createBuffer\(2,\3,\4\)/g,
    (_, context, lead, length, rate, buffer) => `${context}=new OfflineAudioContext(2,${lead}+${length},${rate}),${buffer}=(__codexTrackAudio?.(${context}),${context}.createBuffer(2,${length},${rate}))`, 'offline score-render lifecycle');
  source = replaceOnce(source, /await ([\w$]+)\(([\w$]+),([\w$]+),Math.max\(\.1,\3\),([\w$]+),1,!1\)/g,
    match => match.slice(0, -1) + `,${native}?__codexBindMotionAudioRender:undefined)`, 'preview normalization lifecycle');
  const document = definition(source, 'createLiveFilmDocument');
  const documentText = replaceOnce(document.text, /return\(0,e\.watchThumbnailDocumentLoad\)\(([\w$]+),/g,
    (_, doc) => `if(${native})__codexBindMotionDocument(${doc});return(0,e.watchThumbnailDocumentLoad)(${doc},`, 'live-store save barrier');
  updates.push({ ...document, replacement: documentText });

  const wording = definition(source, 'useWordingEdits');
  const docName = /^function [\w$]+\(\{doc:([\w$]+),/.exec(wording.text)?.[1];
  if (!docName) throw refused('The canonical Motion wording document changed.');
  let wordingText = replaceOnce(wording.text, /let ([\w$]+)=t\.useRef\(null\),([\w$]+)=t\.useRef\(!1\),([\w$]+)=t\.useRef\(null\);/g,
    (match, _before, writing) => `${match}const __codexWordingClose=t.useRef({expected:undefined,error:null});if(${native})__codexBindMotionEditState("wording",()=>({pending:(${writing}.current||(__codexWordingClose.current.expected!==undefined&&__codexWordingClose.current.expected!==(0,e.readFilmModule)(${docName}.content(),e.RETYPED_MODULE))),error:__codexWordingClose.current.error}));`, 'wording settlement state');
  wordingText = replaceOnce(wordingText, /([\w$]+)=t\.useCallback\(\(([\w$]+),([\w$]+)\)=>\{if\(!([\w$]+)\.current\.active\|\|([\w$]+)\.readOnly\(\)\)return;/g,
    (match, _setter, id, value, state) => `${match}if(${native}&&${value}===""){__codexWordingClose.current.error=null;__codexWordingClose.current.expected=(0,e.serializeRetypedLines)((0,e.setRetypedLine)(${state}.current.lines,${id},""));}`, 'explicit wording reset');
  wordingText = replaceOnce(wordingText, /([\w$]+)\.current\.lines=\(0,e\.setRetypedLine\)\(\1\.current\.lines,([\w$]+),([\w$]+)\),([\w$]+)\(([\w$]+)=>\[\.\.\.\5,\{was:\2,v:\3\}\]\)/g,
    (match, state) => match.replace('),', `),${native}&&(__codexWordingClose.current.expected=(0,e.serializeRetypedLines)(${state}.current.lines),__codexWordingClose.current.error=null),`), 'accepted wording edit');
  wordingText = replaceOnce(wordingText, /let ([\w$]+)=([\w$]+)=>\{([\w$]+)\(\[\]\),([\w$]+)\.clear\(\),\(0,e\.showEditorToast\)\(\2\)\}/g,
    (match, _reset, reason) => match.replace('=>{', `=>{if(${native})__codexWordingClose.current.error=String(${reason});`), 'rejected wording edit');
  updates.push({ ...wording, replacement: wordingText });

  const app = definition(source, 'MotionApp');
  let appText = replaceOnce(app.text, /([\w$]+)=e\.ReactReactRuntime\.useSyncExternalStore\(([\w$]+)\.subscribe,\(\)=>\2\.state\)/g,
    (_, state, host) => `${state}=(${native}&&__codexBindMotionPlayer(${host},e.playedTimeToAuthoredTime),e.ReactReactRuntime.useSyncExternalStore(${host}.subscribe,()=>${host}.state))`, 'player state binding');
  appText = replaceOnce(appText, /(\(0,e\.useExportPress\)\(\{film:[\s\S]*?,live:[\w$]+,save:)([\w$]+)(,dialogOpen:)/g,
    (_, prefix, commit, suffix) => `${prefix}(${native}&&__codexBindMotionCommit(${commit}),${commit})${suffix}`, 'canonical UI commit barrier');
  updates.push({ ...app, replacement: appText });

  source = replaceOnce(source, /([\w$]+)=e\.ReactDOMClientReactRuntime\.createRoot\(([\w$]+)\),\1\.render\(/g,
    (_, root, node) => `${root}=e.ReactDOMClientReactRuntime.createRoot(${node}),(!${native}||__codexBindMotionRoot(${root}))&&${root}.render(`, 'React root lifecycle');

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
  return marker + '\nconst motionLifecycleFor=' + motionLifecycleFor.toString() + ';\nconst __codexBindMotionDocument=' + bindNativeMotionDocument.toString() + ';\nconst __codexBindMotionPlayer=' + bindNativeMotionPlayer.toString() + ';\nconst __codexBindMotionRoot=' + bindNativeMotionRoot.toString() + ';\nconst __codexBindMotionEditState=' + bindNativeMotionEditState.toString() + ';\nconst __codexBindMotionCommit=' + bindNativeMotionCommit.toString() + ';\nconst __codexBindMotionAudioRender=' + bindNativeMotionAudioRender.toString() + ';\n' + source;
}
