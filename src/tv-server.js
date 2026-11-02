import { createTvCommands } from './tv-commands.js';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { readCatalogue } from './shuffler.js';
import { writeAtomically } from './atomic-write.js';
import { createDiagnosticsStore } from './tv-diagnostics.js';
import { createGameRelay } from './game-relay.js';
import { createConsoleLauncher } from './console-launcher.js';
import { createConfiguredUkeHandler } from './uke-handler.js';
import { adDecade, buildPlayQueue, isAdSrc } from './ads.js';
import { listSidecars, readSubtitle } from './subtitles.js';

// The TV pulls from this server: it lists the library, picks each channel's next
// episode with the same picker and learning rules as the app's player, and streams
// the files. It is meant for a home network; requests from public addresses are refused.

const require = createRequire(import.meta.url);
const player = require('../shuffler/player.js');

// One list, so a household can rename people without hunting through the UI.
// `ceiling` is the highest rating that person may watch; null means an adult.
export const TV_VIEWERS = [
  { id: 'sam', name: 'Sam', ceiling: 'G' },
  { id: 'jake', name: 'Jake', ceiling: 'PG' },
  { id: 'mum', name: 'Mum', ceiling: null },
  { id: 'dad', name: 'Dad', ceiling: null },
];

const RATING_ORDER = ['G', 'PG', 'PG-13', 'M'];
// Folder tiers from the shuffler. Decades are the 50s–90s source tiers.
export const TIER_RATINGS = {
  preschool: 'G', shared: 'G', music: 'G',
  big: 'PG',
  older: 'PG-13',
  grownup: 'M', couple: 'M', adultanim: 'M', sitcom: 'M', scifi: 'M',
  comedy: 'M', docs: 'PG', classic: 'M', sports: 'PG',
  '50s': 'M', '60s': 'M', '70s': 'M', '80s': 'M', '90s': 'M',
  sports: 'M',
};

// Genre channels. Numbers stay put when a channel is hidden, so key 1 is always
// Cartoons. Games (6) and Uke (7) are added by the TV page, not the library.
// Cartoons: kids' shows plus adult animation. Movies: family films plus the
// grown-up, couple, sci-fi and decade folders. Sitcoms, music and Christmas
// keep the folders and the seasonal filter they already had.
const CARTOON_TIERS = new Set(['preschool', 'shared', 'big', 'older', 'adultanim']);
const MOVIE_TIERS = new Set(['grownup', 'couple']);
const DECADES = { d50: '50s', d60: '60s', d70: '70s', d80: '80s', d90: '90s' };
// Numbers 6 and 7 are Games and Uke on the TV. Decade channels carry period ads.
// Sports is the taped-broadcast channel: its files are scanned for ad breaks.
export const TV_CHANNELS = [
  { id: 'cartoons', number: 1, name: 'Cartoons' },
  { id: 'movies', number: 2, name: 'Movies' },
  { id: 'sitcoms', number: 3, name: 'Sitcoms' },
  { id: 'music', number: 4, name: 'Music' },
  { id: 'christmas', number: 5, name: 'Christmas' },
  { id: 'comedy', number: 8, name: 'Comedy' },
  { id: 'docs', number: 9, name: 'Sport & Docs' },
  { id: 'scifi', number: 10, name: 'Sci-Fi' },
  { id: 'classic', number: 11, name: 'Classics' },
  { id: 'd50', number: 12, name: '1950s', ads: '50s' },
  { id: 'd60', number: 13, name: '1960s', ads: '60s' },
  { id: 'd70', number: 14, name: '1970s', ads: '70s' },
  { id: 'd80', number: 15, name: '1980s', ads: '80s' },
  { id: 'd90', number: 16, name: '1990s', ads: '90s' },
  { id: 'sports', number: 17, name: 'Sports', recordedAds: true },
  { id: 'hophop', number: 18, name: 'Hop Hop' },
];

export function inTvGenre(item, channelId) {
  if (!item || isAdSrc(item.src)) return false;
  if (channelId === 'christmas') return player.inStream(item, 'christmas');
  if (channelId === 'music') return item.tier === 'music';
  if (channelId === 'sitcoms') return item.tier === 'sitcom';
  if (channelId === 'movies') return player.inStream(item, 'movies') || MOVIE_TIERS.has(item.tier);
  if (channelId === 'cartoons') return CARTOON_TIERS.has(item.tier) && !player.inStream(item, 'movies');
  if (channelId === 'comedy') return item.tier === 'comedy';
  if (channelId === 'docs') return item.tier === 'docs';
  if (channelId === 'scifi') return item.tier === 'scifi';
  if (channelId === 'classic') return item.tier === 'classic';
  if (channelId === 'sports') return item.tier === 'sports';
  if (channelId === 'hophop') return ['preschool', 'shared'].includes(item.tier)
    && /hop[ ._-]?hop/i.test(String(item.channel || '') + ' ' + String(item.src || '').replace(/[._]/g, ' '));
  if (DECADES[channelId]) return item.tier === DECADES[channelId];
  return false;
}

export function fileWantsRecordedAds(item) {
  return TV_CHANNELS.some(channel => channel.recordedAds && inTvGenre(item, channel.id));
}

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.wasm': 'application/wasm', '.woff': 'font/woff' };
const RECENT_LIMIT = 50;

/** True for loopback, private, link-local, CGNAT/Tailscale and unique-local addresses. */
export function isHomeAddress(address) {
  let value = String(address || '');
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(value) === 6) return value === '::1' || /^f[cd]/i.test(value) || /^fe[89ab]/i.test(value);
  return false;
}

function sameSecret(offered, token) {
  if (!token || typeof offered !== 'string') return false;
  const a = Buffer.from(offered), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True for a Host header naming this Mac by IP, localhost, a .local name or a Tailscale name. */
export function isHomeHost(host) {
  const name = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return isIP(name) > 0 || name === 'localhost' || /^[a-z0-9-]+\.local$/.test(name) || /\.ts\.net$/.test(name)
    || /^[a-z0-9-]+$/.test(name);
}

/** A localStorage stand-in persisted as one JSON file, so player.js learns unchanged. */
export async function createFileStorage(path) {
  let data = Object.create(null);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') data[key] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read TV taste: ${error.message}`); }
  let writes = Promise.resolve();
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem(key, value) { data[key] = String(value); },
    flush() {
      const content = JSON.stringify(data, null, 2) + '\n';
      writes = writes.catch(() => {}).then(() => writeAtomically(path, content));
      return writes;
    },
  };
}

/**
 * The TV's own history with other stores' places laid over it (the Mac app's,
 * read-only): for each file the most recently updated entry wins. Writes go to
 * the TV's own store. `others` returns the current list of stores.
 */
export function layeredHistory(own, others = () => []) {
  return {
    ...own,
    has: path => own.has(path) || others().some(store => store?.has(path)),
    get(path) {
      const entry = this.list().find(item => item.path === path);
      return entry && !entry.completed ? entry.positionSeconds : 0;
    },
    list() {
      const byPath = new Map();
      for (const store of [own, ...others()]) for (const entry of store?.list() || []) {
        const held = byPath.get(entry.path);
        if (!held || Date.parse(entry.updatedAt) > Date.parse(held.updatedAt)) byPath.set(entry.path, entry);
      }
      return [...byPath.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  };
}

/** Parse a single "bytes=a-b" range against a file size. Returns null for no or unusable range. */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!(start <= end) || start >= size) return { unsatisfiable: true };
  return { start, end };
}

/**
 * The TV-facing model. `videos` comes from readCatalogue; `history` is a
 * loadPlaybackHistory store; `storage` a createFileStorage store.
 */
export function createTvLibrary({ videos, history, storage, random = Math.random, scenes = () => null, showTiers = null, now = () => Date.now() }) {
  const bySrc = new Map(videos.map((video, index) => [video.src, index]));
  // Per-channel memory of recently played indices, as the player keeps per tab.
  const recent = new Map();
  // Home's "now" pick, so OK plays the episode on the card.
  const staged = new Map();

  function video(src) {
    const index = bySrc.get(src);
    if (index === undefined) throw Object.assign(new Error('That video is not in this library.'), { status: 404 });
    return { index, video: videos[index] };
  }

  function describe(item) {
    const resume = history.get(item.file);
    return { src: item.src, title: item.title || item.src, show: item.channel || '', tier: item.tier,
      channels: channelsOf(item), duration: item.duration || 0, resume: resume > 5 ? resume : 0 };
  }

  function viewerIds(value) {
    if (value == null) return TV_VIEWERS.map(person => person.id);
    const parts = Array.isArray(value) ? value : String(value).split(',');
    const known = new Set(TV_VIEWERS.map(person => person.id));
    const ids = [];
    for (const part of parts) {
      const id = String(part).trim().toLowerCase();
      if (known.has(id) && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  function audience(ids) {
    if (!ids.length) return { ceiling: null, blocked: true };
    const caps = TV_VIEWERS.filter(person => ids.includes(person.id) && person.ceiling).map(person => person.ceiling);
    if (!caps.length) return { ceiling: 'M', blocked: false };
    const ceiling = caps.reduce((lowest, cap) => (RATING_ORDER.indexOf(cap) < RATING_ORDER.indexOf(lowest) ? cap : lowest));
    return { ceiling, blocked: false };
  }

  function ratingAllowed(item, ceiling, blocked) {
    if (blocked) return false;
    const rating = TIER_RATINGS[item.tier] || 'M';
    return RATING_ORDER.indexOf(rating) <= RATING_ORDER.indexOf(ceiling);
  }

  function inGenre(item, channelId) {
    return inTvGenre(item, channelId);
  }

  // Which genre channels a video belongs to, before the audience ceiling.
  function channelsOf(item) {
    return TV_CHANNELS.filter(channel => inGenre(item, channel.id)).map(channel => channel.id);
  }

  function poolFor(channelId, ids) {
    const { ceiling, blocked } = audience(ids);
    return videos.map((item, index) => (inGenre(item, channelId) && ratingAllowed(item, ceiling, blocked) ? index : -1))
      .filter(index => index >= 0);
  }

  // Adults share the Mac player's taste keys. A child in the room does not.
  function tasteKey(ids) {
    const selected = new Set(ids);
    if (!ids.length || TV_VIEWERS.some(person => person.ceiling && selected.has(person.id))) return null;
    const mum = selected.has('mum'), dad = selected.has('dad');
    if (mum && dad) return 'both';
    if (dad) return 'grown';
    if (mum) return Object.prototype.hasOwnProperty.call(player.STREAMS, 'mum') ? 'mum' : 'grown';
    return null;
  }

  function weightsFor(key) {
    if (key !== 'both') return player.readWeights(storage, key, videos);
    const mum = player.readStored(storage, 'mum'), dad = player.readStored(storage, 'dad'), both = player.readStored(storage, 'both');
    const weights = Object.create(null);
    for (const item of videos) {
      weights[item.src] = player.togetherWeight(player.weightFor(mum, item.src), player.weightFor(dad, item.src), player.weightFor(both, item.src));
    }
    return weights;
  }

  function stageKey(channelId, ids) {
    return channelId + '\n' + ids.slice().sort().join(',');
  }

  function nowPlaying(item) {
    return { show: item.channel || item.title || item.src, art: '/art?src=' + encodeURIComponent(item.src) };
  }

  function home(viewers) {
    const ids = viewerIds(viewers);
    const selected = new Set(ids);
    const { ceiling, blocked } = audience(ids);
    const channels = [];
    for (const channel of TV_CHANNELS) {
      if (!poolFor(channel.id, ids).length) continue;
      const key = stageKey(channel.id, ids);
      if (!staged.has(key)) staged.set(key, chooseIndex(channel.id, ids, {}));
      channels.push({ id: channel.id, number: channel.number, name: channel.name, now: nowPlaying(videos[staged.get(key)]) });
    }
    return {
      ceiling: blocked ? null : ceiling,
      viewers: TV_VIEWERS.map(person => ({ id: person.id, name: person.name, on: selected.has(person.id) })),
      channels,
    };
  }

  function show(name) {
    return videos.filter(item => (item.channel || 'Other') === name).map(describe)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }

  // Where each serial's story is, from the places and finishes the TV has reported.
  function story(show, available, currentIndex, currentFinished) {
    const byPath = new Map(videos.map(item => [item.file, item]));
    const places = Object.create(null), finished = new Map();
    for (const entry of history.list()) {
      const item = byPath.get(entry.path);
      if (!item) continue;
      const at = Date.parse(entry.updatedAt) || 0;
      if (entry.completed || player.nearlyFinished(entry.positionSeconds, entry.durationSeconds || item.duration)) finished.set(item.src, at);
      else places[item.src] = { time: entry.positionSeconds, updated: at };
    }
    if (currentFinished && currentIndex >= 0) finished.set(videos[currentIndex].src, Date.now());
    return player.seriesNext(videos, available, show, places, finished, currentIndex);
  }

  // Grade the episode being left (as the player does), then pick the next one.
  function chooseIndex(channelId, ids, options) {
    if (!TV_CHANNELS.some(channel => channel.id === channelId)) {
      throw Object.assign(new Error('Unknown channel.'), { status: 404 });
    }
    const pool = poolFor(channelId, ids);
    if (!pool.length) throw Object.assign(new Error('This channel is empty.'), { status: 404 });
    const key = tasteKey(ids) || channelId;
    const played = recent.get(channelId) || [];
    let currentIndex = -1;
    if (typeof options.current === 'string' && options.current) {
      const { index, video: item } = video(options.current);
      currentIndex = index;
      if (options.reason === 'skip' || options.reason === 'ended') {
        const stored = player.readStored(storage, key);
        const was = player.weightFor(stored, item.src);
        const now = player.learnedWeight(was, options.reason, Number(options.time), Number(options.duration) || item.duration, Number(options.watched));
        if (now !== was) { stored[item.src] = now; player.saveWeights(storage, key, stored); }
        player.appendLog(storage, { t: Date.now(), age: key, src: item.src, reason: options.reason, at: Math.round(Number(options.time) || 0),
          watched: Math.round(Number(options.watched) || 0), dur: Math.round(Number(options.duration) || item.duration || 0), via: 'tv' });
      }
    }
    const weights = weightsFor(key);
    // Episodic films and sitcoms play in order; cartoons stay shuffled.
    const serial = channelId === 'movies' || channelId === 'sitcoms';
    const ending = options.reason === 'ended';
    const showOf = index => videos[index].channel || 'Other';
    let index = -1;
    if (serial && ending && currentIndex >= 0 && player.episodeNumber(videos[currentIndex]) !== null) {
      index = story(showOf(currentIndex), pool, currentIndex, true);
    }
    if (index < 0) {
      index = player.pickVideo(videos, pool, weights, currentIndex, new Set(), played, random);
      if (serial && index >= 0 && player.episodeNumber(videos[index]) !== null) {
        const following = story(showOf(index), pool, currentIndex, ending);
        if (following >= 0) index = following;
      }
    }
    if (index < 0) throw Object.assign(new Error('This channel is empty.'), { status: 404 });
    return index;
  }

  function remember(channelId, index) {
    const played = recent.get(channelId) || [];
    played.push(index);
    recent.set(channelId, played.slice(-RECENT_LIMIT));
  }

  function queueFor(channel, show, ids) {
    if (!channel?.ads) return [{ kind: 'show', src: show.src, breaks: [] }];
    const { ceiling, blocked } = audience(ids);
    const pool = [];
    for (const item of videos) {
      if (adDecade(item.src) !== channel.ads) continue;
      pool.push({ src: item.src, title: item.title || item.src, duration: item.duration || 0 });
    }
    let blacks = [];
    try {
      const scene = scenes(show.src);
      if (scene && Array.isArray(scene.blacks)) blacks = scene.blacks;
    } catch { blacks = []; }
    let stored = null;
    try { stored = JSON.parse(storage.getItem('onto.ads.played.v1') || ''); }
    catch { stored = null; }
    const built = buildPlayQueue({
      show: { src: show.src, duration: show.duration || 0 },
      ads: pool, blacks, played: stored, now: now(), ceiling, blocked, tiers: showTiers,
    });
    storage.setItem('onto.ads.played.v1', JSON.stringify(built.played));
    return built.queue;
  }

  function finish(index, channelId, ids) {
    const described = describe(videos[index]);
    const channel = TV_CHANNELS.find(entry => entry.id === channelId);
    return { ...described, queue: queueFor(channel, described, ids) };
  }

  function next(channelId, options = {}) {
    const ids = viewerIds(options.viewers);
    const key = stageKey(channelId, ids);
    if (!options.current && staged.has(key)) {
      const index = staged.get(key);
      staged.delete(key);
      remember(channelId, index);
      return finish(index, channelId, ids);
    }
    const index = chooseIndex(channelId, ids, options);
    staged.delete(key);
    remember(channelId, index);
    return finish(index, channelId, ids);
  }

  function progress({ src, positionSeconds, durationSeconds, completed }) {
    const { video: item } = video(src);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0 || typeof completed !== 'boolean') {
      throw Object.assign(new Error('Invalid progress.'), { status: 400 });
    }
    const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : item.duration || 0;
    // Surfing is not watching: start an entry only after half a minute.
    if (!completed && positionSeconds < 30 && !history.has(item.file)) return false;
    history.set(item.file, { title: item.title || item.src, positionSeconds, durationSeconds: duration, completed });
    return true;
  }

  return { home, show, next, progress, file: src => video(src).video.file, video: src => video(src).video };
}

async function readBody(request, limit = 16 * 1024) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function send(response, status, body, headers = {}) {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(content);
}

async function streamFile(request, response, file, mediaCache) {
  const info = await stat(file);
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const range = parseRange(request.headers.range, info.size);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (range?.unsatisfiable) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
    return response.end();
  }
  const { start, end } = range || { start: 0, end: info.size - 1 };
  response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
  if (request.method === 'HEAD') return response.end();
  const stream = mediaCache ? await mediaCache.stream(file, info, { start, end }) : createReadStream(file, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/**
 * HTTP front end. `artwork` is optional (createArtworkCache); `uiRoot` holds the TV web UI;
 * `token` is the pairing secret the installed TV app sends.
 */
export function createTvServer({ library, history, storage, artwork, uiRoot, token = '', watchEvents = null, mediaCache = null, diagnostics = createDiagnosticsStore(), gameRelay = createGameRelay(), ukeHandler = createConfiguredUkeHandler({controllerToken:token}), sceneStore = null,
  consoleLauncher = createConsoleLauncher(), log = () => {} }) {
  const tvCommands = createTvCommands();
  let dirty = false;
  const save = () => {
    if (!dirty) return Promise.resolve();
    dirty = false;
    return Promise.all([history.flush(), storage.flush(), watchEvents?.flush?.()]).catch(error => { dirty = true; log(`save failed: ${error.message}`); throw error; });
  };
  const timer = setInterval(() => { save().catch(() => {}); }, 15_000);
  timer.unref();

  const server = createServer(async (request, response) => {
    try {
      if (!isHomeAddress(request.socket.remoteAddress)) return send(response, 403, { error: 'Home network only.' });
      const url = new URL(request.url, 'http://tv.local');
      const path = url.pathname;
      // A Host check blocks DNS rebinding. The page served here is same-origin; the
      // installed TV app is cross-origin and must carry the pairing token. JSON-only
      // POSTs force a preflight, so other pages cannot change taste or history.
      if (!isHomeHost(request.headers.host)) return send(response, 403, { error: 'Use this Mac’s address.' });
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) {
        if (request.method === 'OPTIONS') {
          response.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, X-Onto-Token', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
          return response.end();
        }
        // <video> and <img> cannot send headers, so only /media and /art take the token in the URL.
        const fileToken = path === '/media' || path === '/art' || path === '/subs' || path === '/scene-thumb' || path.startsWith('/uke/audio/');
        const offered = request.headers['x-onto-token'] || (fileToken ? url.searchParams.get('t') : '');
        if (!sameSecret(offered, token)) {
          return send(response, 403, { error: 'Pair this TV first.' });
        }
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'POST' && !/^application\/json\b/.test(request.headers['content-type'] || '')) {
        return send(response, 415, { error: 'JSON only.' });
      }
      if (ukeHandler && await ukeHandler(request, response)) return;
      // Diagnostics are deliberately stricter than ordinary same-origin APIs:
      // telemetry can contain playback state and must never be spoofable by a
      // page merely able to reach the home-network address.
      if (path.startsWith('/api/game/')) {
        const result = gameRelay.handle({ method: request.method, path: request.url,
          headers: request.headers, ip: request.socket.remoteAddress,
          body: request.method === 'POST' ? await readBody(request) : undefined,
          tvAuthorized: !!token && sameSecret(request.headers['x-onto-token'], token) });
        response.setHeader('Cache-Control', 'no-store');
        return send(response, result.status, result.body);
      }
      if (path === '/api/console/games' || path === '/api/console/launch') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (path === '/api/console/games') {
          if (request.method !== 'GET') return send(response, 405, { error: 'Method not allowed.' });
          response.setHeader('Cache-Control', 'no-store');
          return send(response, 200, { games: await consoleLauncher.games() });
        }
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const result = await consoleLauncher.launch(await readBody(request));
        return send(response, result.status, result.body);
      }
      if (path === '/api/watch') {
        if (!watchEvents || !token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed.' });
        const result = watchEvents.record(await readBody(request));
        dirty = true;
        await watchEvents.flush();
        return send(response, 200, result);
      }
      if (path === '/api/tv-command') {
        if (!token || !sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        response.setHeader('Cache-Control', 'no-store');
        if (request.method === 'POST') {
          const result = tvCommands.enqueue(await readBody(request));
          return send(response,result.status,result.body);
        }
        if (request.method === 'GET') {
          const item=tvCommands.get(url.searchParams.get('id'));
          return send(response,item?200:404,item||{error:'Command not found.'});
        }
        return send(response,405,{error:'Method not allowed.'});
      }
      if (path === '/api/diagnostics') {
        const offered = request.headers['x-onto-token'];
        if (!token || !sameSecret(offered, token)) return send(response, 403, { error: 'Pair this TV first.' });
        if (request.method === 'GET') return send(response, 200, diagnostics.snapshot());
        if (request.method === 'POST') {
          const body=await readBody(request), diagnostic=diagnostics.record(body);
          tvCommands.ack(diagnostic.session,body.commandAck);
          return send(response,200,{ok:true,diagnostic,command:tvCommands.next(diagnostic.session)});
        }
        return send(response, 405, { error: 'Method not allowed.' });
      }
      if (path === '/api/scenes') {
        const src = url.searchParams.get('src') || '';
        const file = library.file(src);
        if (!sceneStore) return send(response, 200, { cuts: [], thumbs: [], chapters: false, segments: [], blacks: [] });
        return send(response, 200, sceneStore.api(file, src));
      }
      if (path === '/scene-thumb') {
        const src = url.searchParams.get('src') || '';
        const index = Number(url.searchParams.get('i'));
        const file = library.file(src);
        const thumb = sceneStore ? sceneStore.thumbFile(file, index) : '';
        if (!thumb) return send(response, 404, { error: 'No thumbnail.' });
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return createReadStream(thumb).pipe(response);
      }
      if (path === '/api/subs') {
        const tracks = await listSidecars(library.file(url.searchParams.get('src') || ''));
        return send(response, 200, { tracks });
      }
      if (path === '/subs') {
        const vtt = await readSubtitle(library.file(url.searchParams.get('src') || ''), url.searchParams.get('name') || '');
        response.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
        return response.end(vtt);
      }
      if (path === '/api/home') return send(response, 200, library.home(url.searchParams.has('viewers') ? url.searchParams.get('viewers') : undefined));
      if (path === '/api/show') return send(response, 200, library.show(url.searchParams.get('name') || ''));
      if (path === '/api/next' && request.method === 'POST') {
        const params = await readBody(request);
        const item = library.next(String(params.channel || ''), params);
        dirty = true;
        return send(response, 200, item);
      }
      if (path === '/api/progress' && request.method === 'POST') {
        const changed = library.progress(await readBody(request));
        if (changed) dirty = true;
        return send(response, 200, { ok: true });
      }
      if (path === '/media') return await streamFile(request, response, library.file(url.searchParams.get('src') || ''), mediaCache);
      if (path === '/art') {
        const item = library.video(url.searchParams.get('src') || '');
        const file = artwork ? await artwork.get(item.file, { durationSeconds: item.duration }) : null;
        if (!file) return send(response, 404, { error: 'No artwork.' });
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return createReadStream(file).pipe(response);
      }
      if (path === '/api/media-cache') {
        if (!sameSecret(request.headers['x-onto-token'], token)) return send(response, 403, { error: 'Pair this TV first.' });
        return send(response, 200, mediaCache?.stats() || { enabled: false });
      }
      if (path === '/api/health') return send(response, 200, { ok: true });
      // Static TV UI. A trailing slash is that folder's index, so /games/ is the games page.
      let name = path === '/' ? '/index.html' : path;
      if (name.endsWith('/')) name += 'index.html';
      const file = normalize(join(uiRoot, name));
      if (!file.startsWith(uiRoot + '/') || !STATIC[extname(file)]) return send(response, 404, { error: 'Not found.' });
      const content = await readFile(file).catch(() => null);
      if (!content) return send(response, 404, { error: 'Not found.' });
      response.writeHead(200, { 'Content-Type': STATIC[extname(file)], 'Cache-Control': 'no-cache' });
      return response.end(content);
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: error.message });
      else response.destroy();
      // Path only: the query can carry the pairing token.
      if (!error.status) log(`error ${request.method} ${String(request.url).split('?')[0]}: ${error.stack || error.message}`);
    }
  });
  const close = server.close.bind(server);
  server.close = callback => { clearInterval(timer); dirty = true; save().catch(() => {}).finally(() => close(callback)); return server; };
  return server;
}

/** Load the generated catalogue (the shuffler HTML) as player.js videos with absolute files. */
export async function loadCatalogue(playerPath, outputPath = playerPath) {
  return readCatalogue(await readFile(playerPath, 'utf8'), playerPath, outputPath);
}
