#!/usr/bin/env node
// Serve the library to the TV app: node bin/tv-server.js [--port 8765] [--refresh]
// Uses the app's settings (library folder, show groups) and keeps its own taste
// and watch history in <app data>/tv-server/.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { readSettings } from '../src/settings.js';
import { buildPlayer, playerExists } from '../src/shuffler.js';
import { loadPlaybackHistory } from '../src/playback-history.js';
import { createArtworkCache } from '../src/library-artwork.js';
import { createFileStorage, createTvLibrary, createTvServer, loadCatalogue } from '../src/tv-server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const appData = option('--app-data', join(homedir(), 'Library/Application Support/Onto the TV'));
const port = Number(option('--port', process.env.ONTO_TV_PORT || 8765));
const host = option('--host', '0.0.0.0');
const log = message => console.log(`${new Date().toISOString()} ${message}`);

const settings = await readSettings(join(appData, 'settings.json'));
if (args.includes('--refresh') || !(await playerExists(settings))) {
  log(`building catalogue from ${settings.library}`);
  log(await buildPlayer(root, settings));
}
const videos = await loadCatalogue(settings.playerPath);
const data = join(appData, 'tv-server');
await mkdir(data, { recursive: true, mode: 0o700 });
const history = await loadPlaybackHistory(join(data, 'playback-history.json'));
const storage = await createFileStorage(join(data, 'taste-storage.json'));
const artwork = createArtworkCache({ directory: join(appData, 'artwork'),
  ffmpeg: process.env.FFMPEG || 'ffmpeg', ffprobe: process.env.FFPROBE || 'ffprobe' });
const library = createTvLibrary({ videos, history, storage });
const server = createTvServer({ library, history, storage, artwork, uiRoot: join(root, 'tv'), log });
server.listen(port, host, () => log(`serving ${videos.length} videos on http://${host}:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { log(`${signal}: saving and stopping`); server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); });
}
