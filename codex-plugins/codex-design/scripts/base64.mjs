/** Linear validation for bounded binary transfers; repeated-group regexes overflow on multi-MiB inputs. */
export function isValidBase64(value) {
  if (typeof value !== 'string' || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf('=');
  return padding < 0 || value.length - padding <= 2 && /^={1,2}$/.test(value.slice(padding));
}
