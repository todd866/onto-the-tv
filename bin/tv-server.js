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
import { createFileStorage, createTvLibrary, createTvServer, layeredHistory, loadCatalogue } from '../src/tv-server.js';
import { createSceneStore } from '../src/scenes.js';
import { createMediaCache } from '../src/media-cache.js';
import { createWatchEventStore } from '../src/watch-events.js';
import { createGuestInvites } from '../src/guest-invites.js';
import { createGuestServer } from '../src/guest-server.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const appData = option('--app-data', join(homedir(), 'Library/Application Support/Onto the TV'));
const port = Number(option('--port', process.env.ONTO_TV_PORT || 8686));
const host = option('--host', '0.0.0.0');
// The guest (phone) app listens on loopback only; Tailscale Funnel publishes it over https.
const guestPort = Number(option('--guest-port', process.env.ONTO_GUEST_PORT || 8687));
const RESCAN_MS = 10 * 60_000, APP_HISTORY_MS = 15_000;
const log = message => console.log(`${new Date().toISOString()} ${message}`);

const data = join(appData, 'tv-server');
await mkdir(data, { recursive: true, mode: 0o700 });
await writeFile(join(data, 'watch-events.jsonl'), '', { flag: 'a', mode: 0o600 });
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
// Serve the last catalogue at once and rebuild it in the background: a restart (a deploy)
// should not take the TV off air while every video is probed. Build first only when there
// is no catalogue yet or --refresh asks for one.
const haveCatalogue = await stat(catalogue).then(() => true, () => false);
if (!haveCatalogue || args.includes('--refresh')) await rebuild(settings, args.includes('--refresh'));
// Places saved by the Mac app are laid over the TV's own, so either picks up where the other stopped.
const appHistoryFile = join(appData, 'playback-history.json');
let appHistory = null, appHistoryStamp = '';
async function reloadAppHistory() {
  const info = await stat(appHistoryFile).catch(() => null);
  const stamp = info ? `${info.mtimeMs}:${info.size}` : '';
  if (stamp === appHistoryStamp) return;
  appHistoryStamp = stamp;
  try { appHistory = info ? await loadPlaybackHistory(appHistoryFile) : null; }
  catch (error) { log(`cannot read the app's places: ${error.message}`); }
}
await reloadAppHistory();
const history = layeredHistory(await loadPlaybackHistory(join(data, 'playback-history.json')), () => (appHistory ? [appHistory] : []));
const storage = await createFileStorage(join(data, 'taste-storage.json'));
const knownSources = new Set((await loadCatalogue(catalogue)).map(video => video.src));
const watchEvents = await createWatchEventStore({ file: join(data, 'watch-events.jsonl'), knownSources });
const artwork = createArtworkCache({ directory: join(appData, 'artwork'),
  ffmpeg: process.env.FFMPEG || 'ffmpeg', ffprobe: process.env.FFPROBE || 'ffprobe' });
// The installed TV app embeds this token (tizen/build.sh reads it).
const tokenFile = join(data, 'pairing-token');
let token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim();
if (!token) { token = randomBytes(24).toString('hex'); await writeFile(tokenFile, token + '\n', { mode: 0o600 }); }

let showTiers = null;
try {
  if (settings.tiersPath) showTiers = JSON.parse(await readFile(settings.tiersPath, 'utf8'));
} catch (error) { log(`tiers unread: ${error.message}`); }
const sceneStore = createSceneStore(join(appData, 'scenes'));
let libraryVideos = await loadCatalogue(catalogue);
const catalogueHolder = { videos: libraryVideos };
const sceneLookup = src => {
  const video = catalogueHolder.videos.find(item => item.src === src);
  return video ? sceneStore.load(video.file) : null;
};
let library = createTvLibrary({ videos: libraryVideos, history, storage, scenes: sceneLookup, showTiers });
const current = { home: viewers => library.home(viewers), show: name => library.show(name), next: (id, input) => library.next(id, input),
  progress: input => library.progress(input), file: src => library.file(src), video: src => library.video(src) };
let mediaCache = null;
try { mediaCache = await createMediaCache({ directory: join(homedir(), 'Library/Caches/Onto the TV/media'), maxBytes: 40 * 1024 ** 3,
  log: entry => log('media cache: ' + JSON.stringify(entry)) }); }
catch (error) { log('media cache unavailable; direct streaming retained: ' + (error.code || error.message)); }
// Warm external titles sequentially; serving always takes priority over this queue.
let warmGeneration = 0, warming = false, warmPending = libraryVideos;
async function warmLibrary(videos) {
  if (!mediaCache) return;
  warmPending = videos; warmGeneration++;
  if (warming) return;
  warming = true;
  try {
    while (warmPending) {
      const batch = warmPending, generation = warmGeneration; warmPending = null;
      for (const video of batch) {
        if (generation !== warmGeneration) break;
        if (!video.file?.startsWith('/Volumes/')) continue;
        try { await mediaCache.warm(video.file, await stat(video.file), { durationSeconds: video.duration }); }
        catch (error) { log('cache warm skipped: ' + (error.code || error.message)); }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } finally { warming = false; }
}
const server = createTvServer({ library: current, mediaCache, history, storage, watchEvents, artwork, uiRoot: join(root, 'tv'), token, sceneStore, log });
server.listen(port, host, () => log(`serving ${library.home().channels.length} channels on http://${host}:${port}/`));

// Invited guests: a separate server with no route to the TV's controls (src/guest-server.js).
const invites = await createGuestInvites(join(data, 'guests.json'));
const guestServer = guestPort ? createGuestServer({ videos: () => catalogueHolder.videos, invites, dataDir: join(data, 'guests'),
  uiRoot: join(root, 'tv'), artwork, mediaCache, log }) : null;
guestServer?.on('error', error => log(`guest app not started: ${error.code || error.message}`));
guestServer?.listen(guestPort, '127.0.0.1', () => log(`guest app on http://127.0.0.1:${guestPort}/`));

void warmLibrary(libraryVideos);

setInterval(() => { reloadAppHistory().catch(() => {}); }, APP_HISTORY_MS).unref();

// Pick up shows added to (or removed from) the drive without a restart.
let scanning = false;
async function rescan() {
  if (scanning) return;
  scanning = true;
  try {
    if (await rebuild(await readSettings(join(appData, 'settings.json')), false)) {
      const refreshedVideos = await loadCatalogue(catalogue);
      void warmLibrary(refreshedVideos);
      catalogueHolder.videos = refreshedVideos;
      library = createTvLibrary({ videos: refreshedVideos, history, storage, scenes: sceneLookup, showTiers });
      knownSources.clear();
      for (const video of refreshedVideos) knownSources.add(video.src);
      log(`catalogue reloaded: ${library.home().channels.length} channels`);
    }
  } catch (error) { log(`rescan failed: ${error.message}`); } finally { scanning = false; }
}
setInterval(rescan, RESCAN_MS).unref();
if (haveCatalogue) setTimeout(rescan, 5_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { log(`${signal}: saving and stopping`); warmPending = null; warmGeneration++; guestServer?.close(); server.close(async () => { await mediaCache?.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref(); });
}
