// Shared headless fixture for the TV interface: serves tv/ from a folder, answers the API, and stubs the player.
// GET data comes from OTV_CACHE (recorded once from a real TV server given OTV_SOURCE + ONTO_TV_TOKEN, then
// replayed) or, with neither, from the synthetic household below, so the checks run anywhere. Nothing is ever
// POSTed to a real server: plays, progress, likes, telemetry and diagnostics are answered here.
import './lib/example-household.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { publicHousehold } from '../src/household.js';

export const KEYS = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 10009 };

export async function launch() {
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
  return chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: 'chrome' }) });
}

function cacheKey(url) {
  const u = new URL(url);
  u.searchParams.delete('t');
  return createHash('sha1').update(u.pathname + '?' + u.searchParams.toString()).digest('hex');
}

// ---------- synthetic household: enough channels, shows, episodes and videos to fill every screen ----------
const COLORS = ['#184e77', '#386641', '#6a4c93', '#9c6644', '#bc4749', '#1d3557', '#2a9d8f', '#e9c46a'];
function art(id) { return '/art?src=' + encodeURIComponent(id); }
function synthetic(url) {
  const p = url.pathname;
  const channelNames = ['Cartoons', 'Movies', 'Sitcoms', 'Music', 'Christmas', 'Docos', 'Live sets', 'Stand-Up', 'Sci-Fi', 'Classic Movies', 'Sport & Docs', 'Fireplace', 'BBC'];
  if (p === '/api/home') {
    return { ceiling: 'G', defaultCeiling: 'G', rating: null,
      viewers: [{ id: 'kid1', name: 'Robin', on: true }, { id: 'kid2', name: 'Max', on: true }, { id: 'adult2', name: 'Mum', on: true }, { id: 'adult1', name: 'Dad', on: true }],
      channels: channelNames.map((name, i) => ({ id: name.toLowerCase().replace(/[^a-z]+/g, ''), number: i + 1, name, count: 40 + i,
        now: { show: 'Show ' + (i + 1), title: 'Episode title number ' + (i + 1), minutes: 5 + i, art: art('ch' + i), next: { show: 'Next show', title: 'Next title' } } })),
      liked: Array.from({ length: 6 }, (_, i) => ({ src: 'liked/' + i + '.mp4', show: 'Liked show ' + i, title: 'Liked episode ' + i, art: art('liked' + i), duration: 600, channel: { id: 'cartoons', number: 1, name: 'Cartoons' } })) };
  }
  if (p === '/api/channel-art') return { pools: {} };
  if (p === '/api/household') return publicHousehold();
  const video = (i, tag) => ({ src: tag + '/' + i + '.mp4', title: tag + ' video ' + i + ' with a fairly long title that wraps', show: 'Creator ' + (i % 7), creator: 'Creator ' + (i % 7), art: art(tag + i), duration: 120 + i * 17, position: i % 5 === 0 ? 40 : 0 });
  if (p === '/api/feed') {
    const offset = Number(url.searchParams.get('offset') || 0), chip = url.searchParams.get('chip') || 'all', total = 60;
    return { cards: Array.from({ length: Math.max(0, Math.min(24, total - offset)) }, (_, i) => video(offset + i, chip)), total,
      chips: [{ id: 'all', label: 'All' }].concat(Array.from({ length: 8 }, (_, i) => ({ id: 'creator' + i, label: 'Creator ' + i }))) };
  }
  if (p === '/api/creators') {
    const creators = Array.from({ length: 16 }, (_, i) => ({ id: 'creator' + i, name: 'Creator ' + i, art: art('cr' + i) }));
    const id = url.searchParams.get('id');
    return id ? { creators, cards: Array.from({ length: 14 }, (_, j) => video(j, id)) } : { creators };
  }
  if (p === '/api/related') return { cards: Array.from({ length: 12 }, (_, i) => video(i, 'rel')) };
  if (p === '/api/search') return { cards: Array.from({ length: 9 }, (_, i) => video(i, 'hit')), suggestions: ['Creator 1', 'Creator 2'] };
  if (p === '/api/library') {
    const episode = (s, e) => ({ src: 'shows/' + s + '/' + e + '.mp4', title: 'Show ' + s + ' episode ' + e, show: 'Show ' + s, season: 1 + Math.floor(e / 6), episode: e + 1, art: art('ep' + s + '-' + e), duration: 1300, resume: s === 2 && e === 4 ? 300 : 0 });
    const shows = Array.from({ length: 23 }, (_, s) => ({ name: 'Show ' + s, title: 'Show ' + s, art: art('show' + s), count: 4 + (s % 9), episodes: Array.from({ length: 4 + (s % 9) }, (_, e) => episode(s, e)) }));
    const films = Array.from({ length: 10 }, (_, f) => ({ src: 'films/' + f + '.mp4', title: 'Film ' + f, art: art('film' + f), duration: 5400 }));
    return { shows, films, upNext: Array.from({ length: 14 }, (_, i) => episode(i, 1)),
      collections: [{ title: 'Recently added', items: films.slice(0, 9) }, { title: 'Short', items: Array.from({ length: 3 }, (_, i) => episode(i, 0)) }, { title: 'Long row', items: Array.from({ length: 25 }, (_, i) => episode(i % 23, 2)) }] };
  }
  if (p === '/api/scenes') return { cuts: [], thumbs: [], segments: [] };
  if (p === '/api/subs') return { tracks: [] };
  if (p === '/api/health') return { ok: true };
  if (p === '/art') return { svg: COLORS[Math.abs([...(url.searchParams.get('src') || '')].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)) % COLORS.length] };
  return null;
}

export async function installFixture(page, opts = {}) {
  const root = opts.root || process.env.TV_ROOT || fileURLToPath(new URL('../tv/', import.meta.url));
  const cacheDir = process.env.OTV_CACHE || '';
  const source = process.env.OTV_SOURCE || '', token = process.env.ONTO_TV_TOKEN || '';
  const stopMs = Number(opts.stopMs || 0);
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  const state = { home: null, posts: [] };
  async function recorded(raw) {
    if (!cacheDir) {
      const u = new URL(raw), body = synthetic(u);
      if (!body) return null;
      if (body.svg) return { status: 200, type: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="' + body.svg + '"/></svg>').toString('base64') };
      return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify(body)).toString('base64') };
    }
    const file = path.join(cacheDir, cacheKey(raw) + '.json');
    try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
    if (!source) return null;
    const u = new URL(raw), from = new URL(u.pathname + u.search, source);
    if (from.searchParams.has('t')) from.searchParams.set('t', token);
    const response = await fetch(from, { headers: { 'X-Onto-Token': token } });
    const body = Buffer.from(await response.arrayBuffer());
    const entry = { status: response.status, type: response.headers.get('content-type') || 'application/octet-stream', body: body.toString('base64') };
    await writeFile(file, JSON.stringify(entry));
    return entry;
  }
  await page.route('http://tv.test/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"fixture"};' });
    if (url.pathname === '/player.js') {
      const source = await readFile(path.join(root, 'player.js'), 'utf8');
      const stub = `window.ontoPlayer=function(){var h={},t=12,p=false;function block(ms){var e=performance.now()+ms;while(performance.now()<e){}}return {engine:'avplay',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 600},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false;setTimeout(function(){h.playing&&h.playing();h.canplay&&h.canplay();},50)},play:function(){p=false},pause:function(){p=true},stop:function(){p=true;block(${stopMs})},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};`;
      return route.fulfill({ contentType: 'text/javascript', body: source + '\n' + stub });
    }
    if (request.method() !== 'GET') {
      state.posts.push(url.pathname);
      if (url.pathname === '/api/next' || url.pathname === '/api/play-next') {
        const channels = (state.home && state.home.channels) || [];
        let wanted = '';
        try { wanted = JSON.parse(request.postData() || '{}').channel; } catch {}
        const ch = channels.find(c => c.id === wanted) || channels[0] || {};
        const now = ch.now || {};
        return route.fulfill({ json: { src: 'fixture/' + (now.title || 'x') + '.mp4', show: now.show || 'Show', title: now.title || 'Title', art: now.art || '', resume: 0, duration: 600 } });
      }
      if (url.pathname === '/api/directions') {
        // Twelve tiles a page, two pages: more than fit across, so the tray has to scroll and fetch more.
        let offset = 0;
        try { offset = Number(JSON.parse(request.postData() || '{}').offset) || 0; } catch {}
        const channels = (state.home && state.home.channels) || [];
        const kinds = ['more', 'new', 'favourite', 'long', 'channel'];
        const tiles = offset >= 24 ? [] : Array.from({ length: 12 }, (_, i) => {
          const c = channels[(offset + i) % Math.max(1, channels.length)] || { id: 'x', number: 1, name: 'X' };
          return { kind: kinds[(offset + i) % kinds.length], label: kinds[(offset + i) % kinds.length], src: 'dir/' + (offset + i) + '.mp4', show: 'Direction show ' + (offset + i), title: 'Direction title ' + (offset + i), duration: 600, channel: { id: c.id, number: c.number, name: c.name } };
        });
        return route.fulfill({ json: { tiles, next: offset + 12 < 24 ? offset + 12 : null } });
      }
      return route.fulfill({ json: { ok: true, items: [] } });
    }
    if (url.pathname === '/api/diagnostics' || url.pathname === '/api/tv-live') return route.fulfill({ json: { ok: true } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/art' || url.pathname.startsWith('/still') || url.pathname.startsWith('/pictures')) {
      const entry = await recorded(request.url());
      if (!entry) return route.fulfill({ status: 404, json: { error: 'not recorded' } });
      const body = Buffer.from(entry.body, 'base64');
      if (url.pathname === '/api/home') { try { state.home = JSON.parse(body.toString('utf8')); } catch {} }
      return route.fulfill({ status: entry.status, contentType: entry.type, body });
    }
    const p = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : p.endsWith('.woff') ? 'font/woff' : p.endsWith('.png') ? 'image/png' : p.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, p)), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  return state;
}

export function profileInit(profile) {
  return ({ profile }) => {
    const viewers = { all: 'kid1,kid2,adult2,adult1', adult1: 'adult1', kid2: 'kid2,adult2,adult1', kid1: 'kid1,kid2,adult2,adult1', adult2: 'adult2' }[profile];
    const h = new Date().getHours();
    localStorage.setItem('onto.viewers.band', h >= 20 || h < 5 ? 'night' : 'day');
    localStorage.setItem('onto.profile', profile);
    localStorage.setItem('onto.viewers', viewers);
  };
}

// A remote press as the TV delivers it: keydown with a keyCode, keyup about 90 ms later.
export function pressKey(page, code) {
  return page.evaluate(keyCode => new Promise(resolve => {
    function send(type) {
      var event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { get: function () { return keyCode; } });
      Object.defineProperty(event, 'repeat', { get: function () { return false; } });
      document.dispatchEvent(event);
    }
    send('keydown');
    setTimeout(function () { send('keyup'); resolve(); }, 30);
  }), code);
}
