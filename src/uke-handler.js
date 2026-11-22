import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uke');

export function createConfiguredUkeHandler({ root = process.env.UKE_ROOT || DEFAULT_ROOT, audioRoot = path.join(os.homedir(), 'Music', 'YouTube Liked'), cacheDir, prefix = '/uke/', controllerToken = '' } = {}) {
  let loaded = null;
  let failed = null;
  return async function handle(req, res) {
    const pathname = String(req.url || '').split('?')[0];
    const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (pathname.replace(/\/$/, '') !== base.replace(/\/$/, '') && !pathname.startsWith(base)) return false;
    if (!loaded && !failed) {
      try {
        const mod = await import(pathToFileURL(path.join(root, 'tools', 'onto-handler.mjs')).href);
        loaded = mod.createUkeHandler({ root, audioRoot, cacheDir, prefix, controllerToken });
      } catch (error) { failed = error; }
    }
    if (loaded) return loaded(req, res);
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Uke is unavailable on this host.' }));
    return true;
  };
}
