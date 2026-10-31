import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Extend discovery without creating or changing the user's global library. */
export function designSystemSearchEnvironment(env = process.env, { homeDirectory = os.homedir() } = {}) {
  let directory = path.resolve(homeDirectory);
  try {
    for (const name of ['.codex', 'CodexDesignLibrary', 'design-system']) {
      directory = path.join(directory, name);
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return env;
    }
    directory = fs.realpathSync(directory);
  } catch {
    return env;
  }
  const explicit = (env.CODEX_DESIGN_SYSTEMS ?? '').split(path.delimiter).map(value => value.trim()).filter(Boolean);
  const seen = new Set();
  const paths = [...explicit, directory].filter(value => {
    let identity;
    try { identity = fs.realpathSync(value); }
    catch { identity = path.resolve(value); }
    if (process.platform === 'win32') identity = identity.toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return { ...env, CODEX_DESIGN_SYSTEMS: paths.join(path.delimiter) };
}
