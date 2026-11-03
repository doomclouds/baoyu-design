import { adaptEditorExportFallbacks } from './editor-export-adapter.mjs';
import { adaptBlankArtboardCreation } from './blank-artboard-adapter.mjs';
import { readCommentComponent } from './comment-toolbar-adapter.mjs';

const missingDashboardFont = 'url(/_runtime/AnthropicSerif-Roman-Variable-26-179-2.ac9c19c70558c515.woff2)';
const fontMarker = '/* codex-design:native-dashboard-font-fallback */';

/** This hosted face is absent from the local package; keep its existing CSS fallback. */
function adaptDashboardFontRequest(source) {
  if (source.includes(fontMarker) || !source.includes('"loadAnthropicSerifFont"')) return source;
  const exports = [...source.matchAll(/\b[at]\(e,"loadAnthropicSerifFont",\(\)=>([\w$]+)\)/g)];
  if (exports.length !== 1) throw new Error('The canonical Dashboard font loader export changed; native font adaptation was refused.');
  const name = exports[0][1], start = source.lastIndexOf('function ' + name + '(', exports[0].index);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const part = start < 0 ? null : readCommentComponent(source.slice(start), new RegExp(`^function ${escaped}\\([^)]*\\)\\{`));
  if (!part) throw new Error('The canonical Dashboard font loader changed; native font adaptation was refused.');
  if (!part.text.includes(missingDashboardFont)) return source;
  const guarded = part.text.replace(part.match[0], part.match[0] + 'if(globalThis.__CODEX_DESIGN_EDITOR_TRANSPORT__)return;');
  return fontMarker + '\n' + source.slice(0, start) + guarded + source.slice(start + part.end);
}

/** Repair a dependency missing from the shipped dialog hook without changing upstream source files. */
export function repairEditorRuntime(source) {
  source = adaptDashboardFontRequest(source);
  source = adaptEditorExportFallbacks(source);
  source = adaptBlankArtboardCreation(source);
  const hookName = /\([\w$]+,"useSheetTreeDialogAnnouncement",\(\)=>([\w$]+)/.exec(source)?.[1];
  const initialize = /\([\w$]+,"initializeSheetMeasurement",\(\)=>([\w$]+)/.exec(source)?.[1];
  if (hookName && initialize) {
    const escaped = hookName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hook = new RegExp(`function ${escaped}\\([^)]*\\)\\{(?=let [\\w$]+=[\\w$]+\\.useContext\\([\\w$]+\\.sheetParentContext\\))`);
    source = source.replace(hook, match => `${match}${initialize}();`);
  }
  // Preserve the Fieldset provider and disabled/ref handling, but make the CDS
  // Form wrapper a real form so submit buttons and requestSubmit can work.
  return source.replace(/([\w$]+)\.jsx\(([\w$]+)\.baseFieldsetRoot,\{(?=ref:[\w$]+,"data-cds":"Form",)/g,
    (match, jsx, registry) => `${jsx}.jsx(${registry}.baseFieldsetRoot,{render:${jsx}.jsx("form",{}),`);
}
