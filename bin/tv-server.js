#!/usr/bin/env node
// Serve the library to the TV app: node bin/tv-server.js [--port 8686] [--refresh]
// Uses the app's settings (library folder, show groups, sources) but builds its own
// catalogue, which also admits formats only the TV plays (MKV, Dolby Digital), and
// keeps its own taste and watch history in <app data>/tv-server/.
import { createRemoteLog } from '../src/tv-remote-log.js';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { readSettings } from '../src/settings.js';
import { rebuildCatalogue } from '../src/library.js';
import { buildPlayer } from '../src/shuffler.js';
import { loadPlaybackHistory } from '../src/playback-history.js';
import { createArtworkCache } from '../src/library-artwork.js';
import { TV_CHANNELS, channelScoresSignaturePart, createFileStorage, createTvLibrary, createTvServer, layeredHistory, loadCatalogue, mergeChannelScores, parseChannelScores } from '../src/tv-server.js';
import { createSceneStore } from '../src/scenes.js';
import { showsView } from '../src/tv-library-api.js';
import { createMediaCache } from '../src/media-cache.js';
import { createWatchEventStore } from '../src/watch-events.js';
import { createMusicEmbedLoader } from '../src/music-pick.js';
import { createDiskPriority, volumeRoots } from '../src/disk-priority.js';
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
function channelScoresPath(settings) {
  return settings.channelScoresPath || join(appData, 'channel-scores.json');
}

// channel-scores.json is rewritten whole by the tool that scores the stations. Other scorers each keep a
// file in channel-scores.d/ beside it (scripts/measure_dance.py writes dance.json), read in name order.
async function channelScoresFiles(settings) {
  const main = channelScoresPath(settings), extra = main.replace(/\.json$/, '') + '.d';
  const names = (await readdir(extra).catch(() => [])).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort();
  return [main, ...names.map(name => join(extra, name))];
}

async function loadChannelScores(settings) {
  const parsed = [];
  for (const path of await channelScoresFiles(settings)) parsed.push(parseChannelScores(await readFile(path, 'utf8').catch(() => '')));
  return mergeChannelScores(parsed);
}

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
  for (const scoresPath of await channelScoresFiles(settings)) {
    parts.push(channelScoresSignaturePart(scoresPath, await stat(scoresPath).catch(() => null)));
  }
  return parts.sort().join('\n');
}

// The kids library plus every extra source root. A pick is one file; a missing
// pick is a deletion, not an unmounted drive.
async function configuredRoots(settings) {
  const folders = [];
  if (typeof settings.library === 'string' && isAbsolute(settings.library)) folders.push(settings.library);
  try {
    const sources = JSON.parse(await readFile(settings.sourcesPath, 'utf8'));
    for (const entry of sources.roots || []) {
      if (typeof entry?.path !== 'string') continue;
      const path = entry.path.replace(/^~(?=\/)/, homedir());
      if (isAbsolute(path)) folders.push(path);
    }
  } catch { /* no sources file, or it is not ours to invent */ }
  return [...new Set(folders)];
}

async function rebuild(settings, force) {
  let signatureText = null;
  const outcome = await rebuildCatalogue({
    roots: await configuredRoots(settings),
    catalogueFile: catalogue,
    log,
    build: async () => {
      const now = await signature(settings);
      const before = await readFile(signatureFile, 'utf8').catch(() => '');
      const exists = await stat(catalogue).then(() => true, () => false);
      if (!force && exists && now === before) return false;
      log(`building catalogue from ${settings.library}`);
      log(await buildPlayer(root, { ...settings, playerPath: catalogue }, undefined, ['--tv']));
      signatureText = now;
      return true;
    },
  });
  // The signature is the last accepted scan. A rejected rebuild must not
  // remember a missing root, or the drive coming back would look unchanged.
  if (outcome.rescanned && signatureText != null) await writeFile(signatureFile, signatureText);
  return outcome;
}

const settings = await readSettings(join(appData, 'settings.json'));
// Serve the last catalogue at once and rebuild it in the background: a restart (a deploy)
// should not take the TV off air while every video is probed. Build first only when there
// is no catalogue yet or --refresh asks for one.
const haveCatalogue = await stat(catalogue).then(() => true, () => false);
// An offline root must not publish an empty catalogue, including on --refresh.
// When a catalogue is already being served, just record whether the roots are
// up; the background rescan does the real rebuild.
if (!haveCatalogue || args.includes('--refresh')) await rebuild(settings, true);
else await rebuildCatalogue({ roots: await configuredRoots(settings), catalogueFile: catalogue, log, build: async () => false });
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
const watchEvents = await createWatchEventStore({ file: join(data, 'watch-events.jsonl'), knownSources, channels: TV_CHANNELS.map(channel => channel.id) });
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
let channelScores = await loadChannelScores(settings);
const musicEmbed = createMusicEmbedLoader({ dir: settings.musicVectorsDir, log });
await musicEmbed.refresh(true).catch(() => {});
setInterval(() => { void musicEmbed.refresh(); }, 60_000).unref();
// Each show's best-rated episodes (scripts/best-episodes.mjs writes them): a show new to the household opens on one.
const bestEpisodesFile = join(data, 'best-episodes.json');
let bestEpisodesCache = null, bestEpisodesStamp = '', bestEpisodesCheckedAt = 0;
function bestEpisodes() {
  if (Date.now() - bestEpisodesCheckedAt > 60_000) {
    bestEpisodesCheckedAt = Date.now();
    try {
      const info = statSync(bestEpisodesFile), stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp !== bestEpisodesStamp) { bestEpisodesCache = JSON.parse(readFileSync(bestEpisodesFile, 'utf8')).shows || null; bestEpisodesStamp = stamp; }
    } catch (error) { if (error.code !== 'ENOENT') log('best episodes unread: ' + error.message); }
  }
  return bestEpisodesCache;
}
let library = createTvLibrary({ videos: libraryVideos, history, storage, scenes: sceneLookup, showTiers, channelScores, musicEmbed, bestEpisodes });
// The library drive (a WD My Passport) spins itself down after a few idle minutes, whatever macOS's disk
// sleep says, and the first title after that took 19 s to start (16 Nov 2026). A tiny synced write keeps it
// spinning in the household's hours, and the TV opening its home or tuning wakes it before OK is pressed.
let diskTouching = false;
async function keepDiskAwake() {
  if (diskTouching || typeof settings.library !== 'string' || !isAbsolute(settings.library)) return;
  diskTouching = true;
  let handle = null;
  try { handle = await open(join(settings.library, '.onto-keep-awake'), 'w'); await handle.writeFile(String(Date.now())); await handle.sync(); }
  catch (error) { log('keep-awake write failed: ' + (error.code || error.message)); }
  finally { await handle?.close().catch(() => {}); diskTouching = false; }
}
setInterval(() => { const h = new Date().getHours(); if (h >= 6 && h < 23) void keepDiskAwake(); }, 3 * 60_000).unref();
// While the TV is in use, batch jobs on the library drives give way (src/disk-priority.js; fleet disk-slot).
const diskPriority = createDiskPriority({ file: join(homedir(), '.local/state/disk-slot/priority/onto-the-tv'),
  roots: () => volumeRoots(catalogueHolder.videos.map(video => video.file), fastRoot ? [fastRoot] : []), log });
const inUse = () => { void diskPriority.touch(); };
const current = { home: (viewers, rating) => { const lineup = library.home(viewers, rating); warmSoon(); keepDiskAwake(); inUse(); return lineup; }, billing: (viewers, rating, cards) => library.billing(viewers, rating, cards), show: name => library.show(name), next: (id, input) => { const item = library.next(id, input); warmSoon(); keepDiskAwake(); inUse(); return item; },
  progress: input => { inUse(); return library.progress(input); }, like: input => library.like(input), skipped: input => library.skipped(input), liked: src => library.liked(src), directions: (id, input) => library.directions(id, input), directionChosen: kind => library.directionChosen(kind), file: src => { inUse(); return library.file(src); }, video: src => library.video(src),
  // The TV's Library (/api/library) reads the whole catalogue; allowed() gates media by audience.
  catalogue: () => library.catalogue(), allowed: (...args) => library.allowed(...args) };
let mediaCache = null;
// Where the cache lives (Ian, 15 Nov 2026: "I just don't want the m2 internal drive getting full and I want
// snappy response"; "surely the SSD external is fast enough to serve this"). The M2's T9 SSD is the fast tier
// in the storage architecture (~/Projects/external-drives/docs/ARCHITECTURE.md: "fast media for the TV
// server", folder hot/). The volume is Research until it is reformatted as M2-Fast. With the T9 away the
// cache shrinks to a small fallback on the internal disk, which always keeps 50 GB free.
const GiB = 1024 ** 3;
const FAST_ROOTS = ['/Volumes/M2-Fast', '/Volumes/Research'];
const INTERNAL_CACHE = join(homedir(), 'Library/Caches/Onto the TV/media');
const fastRoot = FAST_ROOTS.find(root => existsSync(join(root, '.')));
const place = fastRoot
  ? { directory: join(fastRoot, 'hot/onto-the-tv-media'), maxBytes: 80 * GiB, reserveBytes: 40 * GiB, where: `the T9 SSD (${fastRoot})` }
  : { directory: INTERNAL_CACHE, maxBytes: 2 * GiB, reserveBytes: 50 * GiB, where: 'the internal disk (T9 not attached)' };
const CACHE_BYTES = place.maxBytes;
try {
  // A file already on the fast SSD gains nothing from a copy beside it.
  mediaCache = await createMediaCache({ directory: place.directory, maxBytes: place.maxBytes, reserveBytes: place.reserveBytes,
    eligible: file => file.startsWith('/Volumes/') && !(fastRoot && file.startsWith(fastRoot + '/')),
    log: entry => log('media cache: ' + JSON.stringify(entry)) });
  log(`media cache on ${place.where}: up to ${place.maxBytes / GiB} GB, keeping ${place.reserveBytes / GiB} GB free there`);
  // The internal cache from before the move is emptied by the cache's own eviction (ceiling 0).
  if (fastRoot && existsSync(INTERNAL_CACHE)) {
    const old = await createMediaCache({ directory: INTERNAL_CACHE, maxBytes: 0, reserveBytes: 0, eligible: () => false });
    const before = old.stats().bytesCached;
    await old.trim(); await old.close();
    if (before) log(`media cache: ${Math.round(before / GiB)} GB released from the internal disk`);
  }
} catch (error) { log('media cache unavailable; direct streaming retained: ' + (error.code || error.message)); }
// What is about to play is on the M2's SSD before anyone presses it (Ian, 15 Nov 2026: "I don't ever wanna
// see a 9s delay"). The cache keeps every card's pick and the one after, for every profile, and warms
// those first. It used to warm the opening of every title in the library in turn: 4,000 openings through a
// 40 GB cache, which pushed out the episodes the cards were about to play.
const IMMINENT_AUDIENCES = ['sam,jake,mum,dad', 'sam,mum,dad', 'jake,mum,dad', 'dad', 'mum', 'mum,dad'];
let warming = false, warmAgain = false, warmTimer = null;
const sizes = new Map();
// Then the episode each show opens on in Find a show (left part-way, else the first not finished): the
// kids' first (Ms Rachel, 15 Nov 2026), then the grown-ups', music folders aside, as far as the budget goes.
const OPENING_AUDIENCES = ['sam,mum,dad', 'jake,mum,dad', 'mum,dad', 'dad', 'mum'];
function imminent() {
  const seen = new Map();
  for (const audience of IMMINENT_AUDIENCES) {
    for (const item of library.billing(audience)) if (item?.file && !seen.has(item.file)) seen.set(item.file, item);
  }
  const bySrc = new Map(library.catalogue().map(item => [item.src, item]));
  for (const audience of OPENING_AUDIENCES) {
    for (const show of showsView({ videos: library.catalogue(), history: history.list(), viewers: audience }).shows) {
      const left = show.episodes.filter(item => item.at > 5 && !item.done).sort((a, b) => String(b.when).localeCompare(String(a.when)))[0];
      const first = bySrc.get((left || show.episodes.find(item => !item.done) || show.episodes[0]).src);
      if (first?.file && first.tier !== 'music' && !seen.has(first.file)) seen.set(first.file, first);
    }
  }
  return [...seen.values()];
}
// What a title's warm takes: about two minutes of its opening (32 to 128 MB) and its last 4 MB.
const MiB = 1024 ** 2;
const warmBytes = (size, seconds) => (size <= 32 * MiB ? size : Math.min(128 * MiB, Math.max(32 * MiB, size * 180 / Math.max(1, seconds || 120)))) + 4 * MiB;
async function warmImminent() {
  if (!mediaCache) return;
  if (warming) { warmAgain = true; return; }
  warming = true;
  try {
    do {
      warmAgain = false;
      // In order of need, as many as fit in 80% of the ceiling; the rest of it is room for whatever is
      // pressed that was not foreseen.
      const list = [];
      let budget = CACHE_BYTES * 0.8;
      for (const item of imminent()) {
        // Sizes are remembered for ten minutes: a pass restarts whenever a lineup is asked for, and
        // re-reading 235 files' details from a busy drive each time held the warm-up back.
        const known = sizes.get(item.file);
        const info = known && Date.now() - known.at < 600_000 ? known.info : await stat(item.file).catch(() => null);
        if (!info) continue;
        if (!known || known.info !== info) sizes.set(item.file, { info, at: Date.now() });
        const cost = warmBytes(info.size, item.duration);
        if (cost > budget) break;
        budget -= cost;
        list.push({ ...item, info });
      }
      const kept = await mediaCache.keep(list.map(item => ({ file: item.file, info: item.info })));
      await mediaCache.trim();
      let done = 0;
      for (const item of list) {
        if (warmAgain) break;
        try { await mediaCache.warm(item.file, item.info, { durationSeconds: item.duration }); done++; }
        catch (error) { log('cache warm skipped: ' + (error.code || error.message)); }
      }
      if (!warmAgain) log(`cache: ${done} of ${list.length} titles about to play are ready (${kept} kept, ${Math.round(mediaCache.stats().bytesCached / 1024 ** 3 * 10) / 10} GB)`);
    } while (warmAgain);
  } finally { warming = false; }
}
// A lineup asked for, or a channel moving on, changes what is next: look again a few seconds later.
function warmSoon() { clearTimeout(warmTimer); warmTimer = setTimeout(() => { void warmImminent(); }, 3000); warmTimer.unref?.(); }
// Something else filling the disk makes the cache give way within ten minutes.
setInterval(() => { mediaCache?.trim().catch(() => {}); }, 10 * 60_000).unref();
const server = createTvServer({ library: current, mediaCache, history, storage, watchEvents, artwork, uiRoot: join(root, 'tv'), token, sceneStore,
  libraryRoots: async () => configuredRoots(await readSettings(join(appData, 'settings.json'))), catalogueFile: catalogue,
  playNextFile: join(homedir(), '.local/state/onto-the-tv/play-next.json'),
  remoteLog: createRemoteLog({ file: join(data, 'remote-events.jsonl') }), directionsFile: join(data, 'directions.jsonl'), log });
server.listen(port, host, () => log(`serving ${library.home().channels.length} channels on http://${host}:${port}/`));

// Invited guests: a separate server with no route to the TV's controls (src/guest-server.js).
const invites = await createGuestInvites(join(data, 'guests.json'));
const guestServer = guestPort ? createGuestServer({ videos: () => catalogueHolder.videos, invites, dataDir: join(data, 'guests'),
  uiRoot: join(root, 'tv'), artwork, mediaCache, log }) : null;
guestServer?.on('error', error => log(`guest app not started: ${error.code || error.message}`));
guestServer?.listen(guestPort, '127.0.0.1', () => log(`guest app on http://127.0.0.1:${guestPort}/`));

void warmImminent();
// The profiles' lineups have their pictures made before anyone opens them: each audience's cards, then
// what each card shows next. Again after a reload, when every channel stages fresh picks.
const PROFILE_AUDIENCES = ['sam,jake,mum,dad', 'sam,mum,dad', 'jake,mum,dad', 'dad', 'mum', 'mum,dad'];
let artGeneration = 0;
async function warmProfileArt() {
  const generation = ++artGeneration;
  for (const audience of PROFILE_AUDIENCES) {
    if (generation !== artGeneration) return;
    await server.warmArt(audience);
  }
  if (generation === artGeneration) log(`pictures ready for ${PROFILE_AUDIENCES.length} lineups`);
}
void warmProfileArt();

setInterval(() => { reloadAppHistory().catch(() => {}); }, APP_HISTORY_MS).unref();

// Pick up shows added to (or removed from) the drive without a restart.
let scanning = false;
async function rescan() {
  if (scanning) return;
  scanning = true;
  try {
    const outcome = await rebuild(await readSettings(join(appData, 'settings.json')), false);
    if (outcome.rescanned) {
      const refreshedVideos = await loadCatalogue(catalogue);
      warmSoon();
      catalogueHolder.videos = refreshedVideos;
      const freshSettings = await readSettings(join(appData, 'settings.json'));
      channelScores = await loadChannelScores(freshSettings);
      library = createTvLibrary({ videos: refreshedVideos, history, storage, scenes: sceneLookup, showTiers, channelScores, musicEmbed, bestEpisodes });
      knownSources.clear();
      for (const video of refreshedVideos) knownSources.add(video.src);
      log(`catalogue reloaded: ${library.home().channels.length} channels`);
      void warmProfileArt();
    }
  } catch (error) { log(`rescan failed: ${error.message}`); } finally { scanning = false; }
}
setInterval(rescan, RESCAN_MS).unref();
if (haveCatalogue) setTimeout(rescan, 5_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { log(`${signal}: saving and stopping`); warmAgain = true; clearTimeout(warmTimer); guestServer?.close(); server.close(async () => { await mediaCache?.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref(); });
}
