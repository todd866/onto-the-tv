import { resolve } from 'node:path';

// Returns absolute paths: history and the TV session refuse relative ones, and
// a second launch's arguments are relative to that launch's own directory.
export function filesFromArgv(argv, { appRoot, cwd = process.cwd() } = {}) {
  const root = appRoot ? resolve(appRoot) : null;
  return argv.slice(1).filter((arg) => {
    if (!arg || arg.startsWith('-')) return false;
    if (arg === '.') return false;
    const resolved = resolve(cwd, arg);
    if (root && resolved === root) return false;
    if (/\/Electron\.app\//.test(arg) || /\/Electron$/.test(arg) || /\/electron$/.test(arg)) return false;
    if (arg.endsWith('.js') || arg.endsWith('.cjs') || arg.endsWith('.mjs')) return false;
    return true;
  }).map(arg => resolve(cwd, arg));
}
