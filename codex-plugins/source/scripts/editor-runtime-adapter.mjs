/** Repair a dependency missing from the shipped dialog hook without changing upstream source files. */
export function repairEditorRuntime(source) {
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
