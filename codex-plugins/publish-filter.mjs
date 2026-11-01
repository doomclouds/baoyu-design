/** Source-only locale history and development probes are not runtime assets. */
export function includePublishedSource(relative) {
  const name = relative.split('\\').join('/');
  return !['server/spike.mjs', 'server/spike.html', 'ui/locales/zh.js'].includes(name)
    && !/^scripts\/locales(?:\/|$)/.test(name);
}
