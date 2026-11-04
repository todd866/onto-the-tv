// The phone web app for invited guests: the real TV interface (tv/) in guest mode,
// served by a separate HTTP server that shares the library but none of the TV's
// controls. It answers only these routes:
//   GET  /w/<invite>   trade an invite link for a session cookie
//   GET  /config.js    guest mode for the TV interface (who you are)
//   GET  /api/me       who you are
//   GET  /api/home     channels at your rating ceiling, each with what's on
//   POST /api/next     the next video on a channel
//   POST /api/progress your place in a video (your own history, not the family's)
//   POST /api/watch    accepted and dropped (guests do not teach the family's taste)
//   GET  /api/scenes   empty; GET /api/subs, /subs sidecar subtitles
//   GET  /media, /art  only for videos this server has dealt to you
//   static files from tv/
// It is meant to listen on 127.0.0.1 behind Tailscale Funnel (https). The TV server's
// pairing token, TV commands, games, diagnostics and taste are not reachable from here.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createFileStorage, createTvLibrary, streamFile } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';
import { listSidecars, readSubtitle } from './subtitles.js';

// Phones play MP4 and QuickTime directly; MKV and AVI need the TV.
const PHONE_TYPES = new Set(['.mp4', '.m4v', '.mov']);
// A guest's ceiling maps onto the household viewer with that ceiling.
const VIEWERS_FOR = { G: 'sam', PG: 'jake', M: 'dad' };
const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff' };

const COOKIE = 'onto_guest';
const DEALT_LIMIT = 400;
// The M2 is fanless and on a home upload: cap simultaneous video streams.
const STREAMS_PER_GUEST = 3, STREAMS_TOTAL = 6;
const SECURITY = { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'" };

export const phonePlayable = item => PHONE_TYPES.has(extname(String(item?.file || item?.src || '')).toLowerCase());

function send(response, status, body, headers = {}) {
  const html = typeof body === 'string';
  response.writeHead(status, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...SECURITY, ...headers });
  response.end(html ? body : JSON.stringify(body));
}

function cookie(request, name) {
  for (const part of String(request.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

async function readJson(request, limit = 8 * 1024) {
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('JSON only.'), { status: 415 });
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

const page = (title, text) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><link rel="stylesheet" href="/styles.css"><main class="note"><h1>${title}</h1><p>${text}</p></main>`;

/**
 * `videos()` returns the current catalogue (it changes on rescan). `invites` is
 * createGuestInvites. `dataDir` holds each guest's own history and taste.
 */
export function createGuestServer({ videos, invites, dataDir, uiRoot, artwork = null, mediaCache = null,
  secureCookie = true, log = () => {} }) {
  const guests = new Map();
  const streams = new Map();
  let total = 0;

  async function stateFor(guest) {
    const all = videos();
    let state = guests.get(guest.id);
    if (state && state.rating !== guest.rating) state = { history: state.history, storage: state.storage };  // drop old grants
    if (state?.library && state.source === all) return state;
    const dir = join(dataDir, guest.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const history = state?.history || await loadPlaybackHistory(join(dir, 'playback-history.json'));
    const storage = state?.storage || await createFileStorage(join(dir, 'taste-storage.json'));
    const library = createTvLibrary({ videos: all.filter(phonePlayable), history, storage });
    state = { source: all, rating: guest.rating, library, history, storage, dealt: state?.dealt || new Set() };
    guests.set(guest.id, state);
    return state;
  }

  function deal(state, src) {
    state.dealt.delete(src);
    state.dealt.add(src);
    while (state.dealt.size > DEALT_LIMIT) state.dealt.delete(state.dealt.values().next().value);
  }

  const server = createServer(async (request, response) => {
    let url, path = '';
    try { url = new URL(request.url, 'http://guest'); path = url.pathname; }
    catch { return send(response, 400, { error: 'Bad request.' }); }
    try {
      if (request.method === 'GET' && path.startsWith('/w/')) {
        const redeemed = await invites.redeem(path.slice(3));
        if (!redeemed) { log('guest: invite refused'); return send(response, 403, page('Invite expired', 'Ask for a new link.')); }
        const maxAge = Math.max(60, Math.floor((redeemed.guest.expires - Date.now()) / 1000));
        log(`guest: ${redeemed.guest.id} signed in`);
        return send(response, 302, '', { Location: '/', 'Set-Cookie':
          `${COOKIE}=${redeemed.session}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}` });
      }

      if (path === '/config.js' && request.method === 'GET') {
        const guest = await invites.session(cookie(request, COOKIE));
        const config = { guest: guest ? { name: guest.name, rating: guest.rating } : { signedOut: true } };
        response.writeHead(200, { 'Content-Type': STATIC['.js'], 'Cache-Control': 'no-store', ...SECURITY });
        return response.end(`window.ONTO_CONFIG = ${JSON.stringify(config).replace(/</g, '\\u003c')};\n`);
      }

      if (path.startsWith('/api/') || path === '/media' || path === '/art' || path === '/subs') {
        const guest = await invites.session(cookie(request, COOKIE));
        if (!guest) return send(response, 401, { error: 'Open your invite link again.' });
        if (request.method === 'POST') {
          const origin = request.headers.origin;
          let sameHost = false;
          try { sameHost = new URL(origin).host === request.headers.host; } catch {}
          if (origin && !sameHost) return send(response, 403, { error: 'Wrong origin.' });
        }
        const state = await stateFor(guest);
        const viewers = VIEWERS_FOR[guest.rating] || 'sam';

        if (path === '/api/me' && request.method === 'GET') return send(response, 200, { name: guest.name, rating: guest.rating, expires: guest.expires });
        if (path === '/api/health' && request.method === 'GET') return send(response, 200, { ok: true });
        if (path === '/api/watch' && request.method === 'POST') { await readJson(request); return send(response, 200, { ok: true }); }
        if (path === '/api/scenes' && request.method === 'GET') return send(response, 200, { cuts: [], thumbs: [], segments: [] });
        if (path === '/api/home' && request.method === 'GET') {
          const home = state.library.home(viewers);
          for (const channel of home.channels) {
            const src = new URLSearchParams(channel.now.art.split('?')[1]).get('src');
            if (src) deal(state, src);
          }
          return send(response, 200, { ceiling: home.ceiling, viewers: [], channels: home.channels });
        }
        if (path === '/api/next' && request.method === 'POST') {
          const body = await readJson(request);
          const item = state.library.next(String(body.channel || ''), { viewers, current: body.current ? String(body.current) : undefined });
          deal(state, item.src);
          // Decade channels interleave ads: deal those too, so the player may fetch them.
          for (const entry of item.queue || []) if (entry && entry.src) deal(state, entry.src);
          return send(response, 200, item);
        }
        if (path === '/api/progress' && request.method === 'POST') {
          const body = await readJson(request);
          if (!state.dealt.has(String(body.src || ''))) return send(response, 404, { error: 'Not yours.' });
          const saved = state.library.progress({ src: String(body.src), positionSeconds: Number(body.positionSeconds),
            durationSeconds: Number(body.durationSeconds), completed: body.completed === true });
          if (saved) state.history.flush().catch(error => log(`guest history: ${error.message}`));
          return send(response, 200, { ok: true, saved });
        }
        if ((path === '/api/subs' || path === '/subs') && request.method === 'GET') {
          const src = url.searchParams.get('src') || '';
          if (!state.dealt.has(src) || !state.library.allowed(src, viewers)) return send(response, 404, { error: 'Not found.' });
          const file = state.library.file(src);
          if (path === '/api/subs') return send(response, 200, { tracks: await listSidecars(file) });
          const vtt = await readSubtitle(file, url.searchParams.get('name') || '');
          response.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, max-age=3600', ...SECURITY });
          return response.end(vtt);
        }
        if ((path === '/media' || path === '/art') && (request.method === 'GET' || request.method === 'HEAD')) {
          const src = url.searchParams.get('src') || '';
          // Dealt to this guest, and still within their ceiling under the current catalogue.
          if (!state.dealt.has(src) || !state.library.allowed(src, viewers)) return send(response, 404, { error: 'Not found.' });
          const item = state.library.video(src);
          if (path === '/media') {
            if (request.destroyed || response.destroyed || response.socket?.destroyed) return;
            const mine = streams.get(guest.id) || 0;
            if (mine >= STREAMS_PER_GUEST || total >= STREAMS_TOTAL) return send(response, 429, { error: 'Too many videos at once.' }, { 'Retry-After': '5' });
            streams.set(guest.id, mine + 1); total++;
            let released = false;
            const release = () => { if (released) return; released = true; total--; streams.set(guest.id, (streams.get(guest.id) || 1) - 1); };
            response.on('close', release);
            try { return await streamFile(request, response, item.file, mediaCache); }
            catch (error) { release(); throw error; }
          }
          const file = artwork ? await artwork.get(item.file, { durationSeconds: item.duration }) : null;
          if (!file) return send(response, 404, { error: 'No artwork.' });
          if (response.destroyed || request.destroyed) return;
          const image = createReadStream(file);
          image.on('error', () => response.destroy());
          response.on('close', () => image.destroy());
          response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ...SECURITY });
          return image.pipe(response);
        }
        return send(response, 404, { error: 'Not found.' });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'Not allowed.' });
      let name = path === '/' ? '/index.html' : path;
      if (name.endsWith('/')) name += 'index.html';
      const file = normalize(join(uiRoot, name));
      if (!file.startsWith(uiRoot + '/') || !STATIC[extname(file)]) return send(response, 404, { error: 'Not found.' });
      const content = await readFile(file).catch(() => null);
      if (!content) return send(response, 404, { error: 'Not found.' });
      response.writeHead(200, { 'Content-Type': STATIC[extname(file)], 'Cache-Control': 'no-cache', ...SECURITY });
      return response.end(content);
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : 'Something went wrong.' });
      else response.destroy();
      // Never log the path of /w/ links: it is the invite secret.
      if (!error.status) log(`guest error ${request.method} ${path.startsWith('/w/') ? '/w/…' : path}: ${error.stack || error.message}`);
    }
  });
  const close = server.close.bind(server);
  server.close = callback => {
    Promise.all([...guests.values()].flatMap(state => [state.history.flush(), state.storage.flush()])).catch(() => {})
      .finally(() => close(callback));
    return server;
  };
  return server;
}
