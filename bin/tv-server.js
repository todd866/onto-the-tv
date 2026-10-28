#!/usr/bin/env node
// Serve the library to the TV app: node bin/tv-server.js [--port 8686] [--refresh]
// Uses the app's settings (library folder, show groups, sources) but builds its own
// catalogue, which also admits formats only the TV plays (MKV, Dolby Digital), and
// keeps its own taste and watch history in <app data>/tv-server/.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { readSettings } from '../src/settings.js';
import { buildPlayer } from '../src/shuffler.js';
import { loadPlaybackHistory } from '../src/playback-history.js';
import { createArtworkCache } from '../src/library-artwork.js';
import { createFileStorage, createTvLibrary, createTvServer, loadCatalogue } from '../src/tv-server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const appData = option('--app-data', join(homedir(), 'Library/Application Support/Onto the TV'));
const port = Number(option('--port', process.env.ONTO_TV_PORT || 8686));
const host = option('--host', '0.0.0.0');
const RESCAN_MS = 10 * 60_000;
const log = message => console.log(`${new Date().toISOString()} ${message}`);

const data = join(appData, 'tv-server');
await mkdir(data, { recursive: true, mode: 0o700 });
const catalogue = join(data, 'catalogue.html');
const signatureFile = join(data, 'catalogue.signature');

// Folders whose contents feed the catalogue: the library, its show folders, and
// the extra roots in the sources file. Adding or removing a file changes the
// mtime of the folder that holds it, so this is cheap to check on a big drive.
async function signature(settings) {
  const folders = [settings.library];
  try {
    const sources = JSON.parse(await readFile(settings.sourcesPath, 'utf8'));
    for (const entry of [...(sources.roots || []), ...(sources.picks || [])]) {
      if (typeof entry?.path === 'string') folders.push(entry.path.replace(/^~(?=\/)/, homedir()));
    }
  } catch {}
  const parts = [];
  for (const folder of folders) {
    const info = await stat(folder).catch(() => null);
    parts.push(`${folder}:${info ? info.mtimeMs : 'missing'}`);
    if (!info?.isDirectory()) continue;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const child = await stat(join(folder, entry.name)).catch(() => null);
      if (child) parts.push(`${entry.name}:${child.mtimeMs}`);
    }
  }
  return parts.sort().join('\n');
}

async function rebuild(settings, force) {
  const now = await signature(settings);
  const before = await readFile(signatureFile, 'utf8').catch(() => '');
  const exists = await stat(catalogue).then(() => true, () => false);
  if (!force && exists && now === before) return false;
  log(`building catalogue from ${settings.library}`);
  log(await buildPlayer(root, { ...settings, playerPath: catalogue }, undefined, ['--tv']));
  await writeFile(signatureFile, now);
  return true;
}

const settings = await readSettings(join(appData, 'settings.json'));
await rebuild(settings, args.includes('--refresh'));
const history = await loadPlaybackHistory(join(data, 'playback-history.json'));
const storage = await createFileStorage(join(data, 'taste-storage.json'));
const artwork = createArtworkCache({ directory: join(appData, 'artwork'),
  ffmpeg: process.env.FFMPEG || 'ffmpeg', ffprobe: process.env.FFPROBE || 'ffprobe' });
// The installed TV app embeds this token (tizen/build.sh reads it).
const tokenFile = join(data, 'pairing-token');
let token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim();
if (!token) { token = randomBytes(24).toString('hex'); await writeFile(tokenFile, token + '\n', { mode: 0o600 }); }

let library = createTvLibrary({ videos: await loadCatalogue(catalogue), history, storage });
const current = { home: () => library.home(), show: name => library.show(name), next: (id, input) => library.next(id, input),
  progress: input => library.progress(input), file: src => library.file(src), video: src => library.video(src) };
const server = createTvServer({ library: current, history, storage, artwork, uiRoot: join(root, 'tv'), token, log });
server.listen(port, host, () => log(`serving ${library.home().channels.find(c => c.id === 'all')?.count || 0} videos on http://${host}:${port}/`));

// Pick up shows added to (or removed from) the drive without a restart.
let scanning = false;
setInterval(async () => {
  if (scanning) return;
  scanning = true;
  try {
    if (await rebuild(await readSettings(join(appData, 'settings.json')), false)) {
      library = createTvLibrary({ videos: await loadCatalogue(catalogue), history, storage });
      log(`catalogue reloaded: ${library.home().channels.find(c => c.id === 'all')?.count || 0} videos`);
    }
  } catch (error) { log(`rescan failed: ${error.message}`); } finally { scanning = false; }
}, RESCAN_MS).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { log(`${signal}: saving and stopping`); server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); });
}
