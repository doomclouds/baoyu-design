import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const marker = '/* codex-design:native-export-save-results */';
const native = 'globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__';
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Preserve a native Save As error instead of classifying it as browser fallback. */
export function throwNativeEditorExportFailure(error, code) {
  if (error?.nativeExportSaveFailure === true) throw error;
  const failureCode = typeof code === 'string' && code ? code : 'EXPORT_FAILED';
  const message = typeof error?.message === 'string' && error.message ? error.message
    : failureCode === 'EXPORT_UNCONFIRMED'
      ? 'The export save result could not be confirmed. The file may already exist. Check the selected folder before starting another export.'
      : `Save As did not complete (${failureCode}). The export was not retried automatically.`;
  throw Object.assign(new Error(message), { code: failureCode, nativeExportSaveFailure: true });
}

function definitionFor(source, property) {
  const matches = [...source.matchAll(new RegExp(`\\b[at]\\(e,"${escape(property)}",\\(\\)=>(${String.raw`[\w$]+`})\\)`, 'g'))];
  if (matches.length !== 1) throw new Error(`The canonical ${property} export changed; native export recovery was refused.`);
  const exported = matches[0];
  const start = source.lastIndexOf('function ' + exported[1] + '(', exported.index);
  const part = start < 0 ? null : readCommentComponent(source.slice(start), new RegExp(`^function ${escape(exported[1])}\\([^)]*\\)\\{`));
  if (!part) throw new Error(`The canonical ${property} function changed; native export recovery was refused.`);
  return { ...part, start, end: start + part.end };
}

/** Keep verified Canvas Save As errors terminal without patching generic anchors. */
export function adaptEditorExportFallbacks(source) {
  if (source.includes(marker) || !source.includes('"saveThroughHost"')) return source;
  const part = definitionFor(source, 'saveThroughHost');
  const replaceOnce = (text, expression, transform) => {
    let count = 0;
    const replacement = text.replace(expression, (...values) => { count++; return transform(...values); });
    if (count !== 1) throw new Error('The canonical Canvas save error handler changed; native export recovery was refused.');
    return replacement;
  };
  let save = replaceOnce(part.text, /catch\(([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\1\);return\{outcome:\2==="declined"\?"declined":"unsupported",code:\2\}/g,
    (match, error, code) => match.replace(';return', `;if(${native}&&${code}!=="declined")__codexThrowNativeExportFailure(${error},${code});return`));
  save = replaceOnce(save, /if\(([\w$]+)===null\)return\{outcome:"unsupported",code:"no_shell_save"\}/g,
    (match, capability) => `if(${capability}===null){if(${native})__codexThrowNativeExportFailure(new Error("Save As is unavailable in this editor."),"no_shell_save");return{outcome:"unsupported",code:"no_shell_save"}}`);
  source = source.slice(0, part.start) + save + source.slice(part.end);

  // Registered exports own a protocol request as well as a save attempt. Their
  // delivery block must convert native errors to a final onResult outcome.
  const producer = definitionFor(source, 'runExportProducer');
  const delivery = /\}let ([\w$]+)=([\w$]+)\(([\w$]+),([\w$]+)\);if\(\1\.released===!0&&[\w$]+\.aborted\)return/.exec(producer.text);
  const finalResult = /return\{format:([\w$]+),\.\.\.([\w$]+),outcome:[\w$]+,code:[\w$]+\.code,filename:([\w$]+)\.filename,/.exec(producer.text);
  if (!delivery || !finalResult || delivery[3] !== finalResult[1] || !producer.text.endsWith('}')) {
    throw new Error('The canonical registered export delivery changed; native export recovery was refused.');
  }
  const request = delivery[1], resolve = delivery[2], format = delivery[3], execution = delivery[4];
  const variants = finalResult[2], file = finalResult[3];
  const declaration = `let ${request}=${resolve}(${format},${execution});`;
  const deliveryStart = delivery.index + 1 + declaration.length;
  const catchDelivery = `}catch(__codexNativeDeliveryError){if(${native}&&__codexNativeDeliveryError?.nativeExportSaveFailure===true){if(${request}.released!==!0)(0,e.declineFrameExport)(${request}.request);return{format:${format},...${variants},outcome:"failed",code:__codexNativeDeliveryError.code,filename:${file}.filename}}throw __codexNativeDeliveryError}`;
  const producerText = producer.text.slice(0, deliveryStart) + 'try{' + producer.text.slice(deliveryStart, -1) + catchDelivery + '}';
  source = source.slice(0, producer.start) + producerText + source.slice(producer.end);

  // Embedded-content warnings have a built file, but have not attempted Save
  // As. Keep the real warning card and require its explicit Download action.
  const image = definitionFor(source, 'exportArtboardImage');
  const imageText = replaceOnce(image.text, /&&\(\(0,e\.triggerBrowserDownload\)\(/g,
    () => `&&(!${native}&&(0,e.triggerBrowserDownload)(`);
  source = source.slice(0, image.start) + imageText + source.slice(image.end);
  const pdf = definitionFor(source, 'exportPdf');
  const pdfText = replaceOnce(pdf.text, /(if\([\w$]+==="unsupported"\)\{)try\{(?=let [\w$]+=document\.createElement\("a"\))/g,
    (match, condition) => `${condition}if(!${native})try{`);
  source = source.slice(0, pdf.start) + pdfText + source.slice(pdf.end);

  let cardCount = 0;
  source = source.replace(/id:"dUR5426EKh"\}\)\)\}finally\{([\w$]+)\(!1\)\}\}\)\(\)\};return ([\w$]+)\.jsxs\("div",\{className:"flex flex-col gap-1\.5",children:\[\2\.jsxs\("div",\{"data-testid":"export-delivery-card"/g,
    (match, busy, jsx, offset) => {
      const start = source.lastIndexOf('function ', offset);
      const prefix = source.slice(start, offset);
      const toast = /let\{showToast:([\w$]+)\}=\(0,e\.useToast\)\(\)/.exec(prefix)?.[1];
      if (!toast || prefix.length > 10_000) throw new Error('The canonical export warning card changed; native export recovery was refused.');
      cardCount++;
      const caught = `}catch(__codexNativeSaveError){if(${native}&&__codexNativeSaveError?.nativeExportSaveFailure===true){${toast}(__codexNativeSaveError.message,"error");return{outcome:"failed",code:__codexNativeSaveError.code}}throw __codexNativeSaveError}finally{`;
      return match.replace('}finally{', caught);
    });
  if (cardCount !== 1) throw new Error('The canonical export warning card changed; native export recovery was refused.');

  let catchCount = 0;
  // Upstream 2.7 localizes this exact warning instead of concatenating it.
  // Match only those two audited catch shapes; a generic catch patch would
  // risk treating a build/encoding failure as a native file-save outcome.
  const zipFailure = /\}catch\(([\w$]+)\)\{e\.healthReporter\.report\(\.\.\.\(0,e\.classifyExportFailure\)\("zip"\)\),([\w$]+)\((?:"Couldn't build the HTML zip: "\+String\(\1\)|\(0,e\.formatMessage\)\(\{defaultMessage:"Couldn’t build the HTML zip: \{error\}",id:"q0OIrbxby5"\},\{error:String\(\1\)\}\)),"error"\)\}finally\{([\w$]+)\(!1\)\}/g;
  source = source.replace(zipFailure,
    (match, error, toast) => {
      catchCount++;
      const guard = `if(${native}&&${error}?.nativeExportSaveFailure===true){e.healthReporter.report(...(0,e.classifyExportFailure)("zip"));${toast}(${error}.message,"error");return{outcome:"failed",code:${error}.code}}`;
      return match.replace(`}catch(${error}){`, `}catch(${error}){${guard}`);
    });
  if (catchCount !== 1) throw new Error('The canonical HTML zip error handler changed; native export recovery was refused.');
  return marker + '\nconst __codexThrowNativeExportFailure=' + throwNativeEditorExportFailure.toString() + ';\n' + source;
}
