import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { readCatalogue } from './shuffler.js';
import { writeAtomically } from './atomic-write.js';

// The TV pulls from this server: it lists the library, picks each channel's next
// episode with the same picker and learning rules as the app's player, and streams
// the files. It is meant for a home network; requests from public addresses are refused.

const require = createRequire(import.meta.url);
const player = require('../shuffler/player.js');

// Channels the TV offers. The ids are the player's stream ids, so taste learned
// here and in the app use the same keys.
export const TV_CHANNELS = [
  { id: '2', label: 'Little Kids' },
  { id: '6', label: 'Big Kids' },
  { id: 'grown', label: 'Grown-ups' },
  { id: 'music', label: 'Music' },
  { id: 'all', label: 'Everything' },
];

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
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
export function createTvLibrary({ videos, history, storage, random = Math.random }) {
  const bySrc = new Map(videos.map((video, index) => [video.src, index]));
  // Per-channel memory of recently played indices, as the player keeps per tab.
  const recent = new Map();

  function video(src) {
    const index = bySrc.get(src);
    if (index === undefined) throw Object.assign(new Error('That video is not in this library.'), { status: 404 });
    return { index, video: videos[index] };
  }

  function describe(item) {
    const resume = history.get(item.file);
    return { src: item.src, title: item.title || item.src, show: item.channel || '', tier: item.tier,
      duration: item.duration || 0, resume: resume > 5 ? resume : 0 };
  }

  function channelPool(id) {
    return videos.map((item, index) => (player.inStream(item, id) ? index : -1)).filter(index => index >= 0);
  }

  function home() {
    const channels = TV_CHANNELS.map(channel => ({ ...channel, count: channelPool(channel.id).length }))
      .filter(channel => channel.count > 0);
    const shows = new Map();
    for (const item of videos) {
      const name = item.channel || 'Other';
      const entry = shows.get(name) || { name, count: 0, tier: item.tier, src: item.src };
      entry.count += 1;
      shows.set(name, entry);
    }
    const paths = new Map(videos.map(item => [item.file, item]));
    const continueWatching = history.list()
      .filter(entry => !entry.completed && entry.positionSeconds > 5 && paths.has(entry.path))
      .slice(0, 12).map(entry => describe(paths.get(entry.path)));
    return { channels, continueWatching,
      shows: [...shows.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  function show(name) {
    return videos.filter(item => (item.channel || 'Other') === name).map(describe)
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }

  // Grade the episode being left (as the player does), then pick the next one.
  function next(channelId, { current, reason, time, watched, duration } = {}) {
    if (!TV_CHANNELS.some(channel => channel.id === channelId)) {
      throw Object.assign(new Error('Unknown channel.'), { status: 404 });
    }
    const played = recent.get(channelId) || [];
    let currentIndex = -1;
    if (typeof current === 'string' && current) {
      const { index, video: item } = video(current);
      currentIndex = index;
      if (reason === 'skip' || reason === 'ended') {
        const stored = player.readStored(storage, channelId);
        const was = player.weightFor(stored, item.src);
        const now = player.learnedWeight(was, reason, Number(time), Number(duration) || item.duration, Number(watched));
        if (now !== was) { stored[item.src] = now; player.saveWeights(storage, channelId, stored); }
        player.appendLog(storage, { t: Date.now(), age: channelId, src: item.src, reason, at: Math.round(Number(time) || 0),
          watched: Math.round(Number(watched) || 0), dur: Math.round(Number(duration) || item.duration || 0), via: 'tv' });
      }
    }
    const pool = channelPool(channelId);
    const weights = player.readWeights(storage, channelId, videos);
    const index = player.pickVideo(videos, pool, weights, currentIndex, new Set(), played, random);
    if (index < 0) throw Object.assign(new Error('This channel is empty.'), { status: 404 });
    played.push(index);
    recent.set(channelId, played.slice(-RECENT_LIMIT));
    return describe(videos[index]);
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

async function streamFile(request, response, file) {
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
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/**
 * HTTP front end. `artwork` is optional (createArtworkCache); `uiRoot` holds the TV web UI;
 * `token` is the pairing secret the installed TV app sends.
 */
export function createTvServer({ library, history, storage, artwork, uiRoot, token = '', log = () => {} }) {
  let dirty = false;
  const save = () => {
    if (!dirty) return;
    dirty = false;
    Promise.all([history.flush(), storage.flush()]).catch(error => { dirty = true; log(`save failed: ${error.message}`); });
  };
  const timer = setInterval(save, 15_000);
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
          response.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'Content-Type, X-Onto-Token', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
          return response.end();
        }
        // <video> and <img> cannot send headers, so only /media and /art take the token in the URL.
        const offered = request.headers['x-onto-token'] || (path === '/media' || path === '/art' ? url.searchParams.get('t') : '');
        if (!sameSecret(offered, token)) {
          return send(response, 403, { error: 'Pair this TV first.' });
        }
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'POST' && !/^application\/json\b/.test(request.headers['content-type'] || '')) {
        return send(response, 415, { error: 'JSON only.' });
      }
      if (path === '/api/home') return send(response, 200, library.home());
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
      if (path === '/media') return await streamFile(request, response, library.file(url.searchParams.get('src') || ''));
      if (path === '/art') {
        const item = library.video(url.searchParams.get('src') || '');
        const file = artwork ? await artwork.get(item.file, { durationSeconds: item.duration }) : null;
        if (!file) return send(response, 404, { error: 'No artwork.' });
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        return createReadStream(file).pipe(response);
      }
      if (path === '/api/health') return send(response, 200, { ok: true });
      // Static TV UI.
      const name = path === '/' ? '/index.html' : path;
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
  server.close = callback => { clearInterval(timer); dirty = true; save(); return close(callback); };
  return server;
}

/** Load the generated catalogue (the shuffler HTML) as player.js videos with absolute files. */
export async function loadCatalogue(playerPath, outputPath = playerPath) {
  return readCatalogue(await readFile(playerPath, 'utf8'), playerPath, outputPath);
}
