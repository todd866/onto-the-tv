import { resolve } from 'node:path';

export function filesFromArgv(argv, { appRoot } = {}) {
  const root = appRoot ? resolve(appRoot) : null;
  return argv.slice(1).filter((arg) => {
    if (!arg || arg.startsWith('-')) return false;
    if (arg === '.') return false;
    const resolved = resolve(arg);
    if (root && resolved === root) return false;
    if (/\/Electron\.app\//.test(arg) || /\/Electron$/.test(arg) || /\/electron$/.test(arg)) return false;
    if (arg.endsWith('.js') || arg.endsWith('.cjs') || arg.endsWith('.mjs')) return false;
    return true;
  });
}
