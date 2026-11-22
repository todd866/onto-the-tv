// Headless check that the TV interface still works with the server refusing unpaired devices (enforce mode).
//   node scripts/check-tv-auth.mjs
// Starts a real TV server (src/tv-server.js) on a free port with a tiny synthetic library and auth enforced,
// and reaches it as another device would: the name tvbox.local is mapped to 127.0.0.1 inside the headless
// Chrome, so the server sees a non-local Host and applies the gate. Never contacts a real server or the TV;
// the browser is muted.
//   1. The installed TV app (file: page, packaged config with the token): boot, lineup, household, pictures
//      (?t=), a channel's video (?t=) and its progress.
//   2. A browser on another device: refused (401), sent to /pair.html, pairs with the code, then loads with
//      the cookie alone.
// Every request to the server is recorded; the check fails on any 401 or 403 a paired client caused.
import './lib/example-household.mjs';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileStorage, createTvLibrary, createTvServer } from '../src/tv-server.js';
import { loadPlaybackHistory } from '../src/playback-history.js';

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const TOKEN = 'fixture-token-' + Math.random().toString(16).slice(2);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

const dir = await mkdtemp(path.join(tmpdir(), 'onto-auth-check-'));
const media = path.join(dir, 'media');
const shows = ['Bluey', 'Hey Duggee', 'Peppa Pig'];
const videos = [];
for (const show of shows) {
  await mkdir(path.join(media, show), { recursive: true });
  for (let e = 1; e <= 3; e++) {
    const src = `${show}/${show} S01E0${e}.mp4`;
    await writeFile(path.join(media, src), Buffer.alloc(64 * 1024, e));
    videos.push({ src, file: path.join(media, src), title: `${show} S01E0${e}`, channel: show, tier: 'shared', duration: 420 });
  }
}
const still = path.join(dir, 'art.jpg');
await writeFile(still, JPEG);
const history = await loadPlaybackHistory(path.join(dir, 'history.json'));
const storage = await createFileStorage(path.join(dir, 'taste.json'));
const library = createTvLibrary({ videos, history, storage, random: () => 0 });
const uiRoot = fileURLToPath(new URL('../tv', import.meta.url));
const logs = [];
const server = createTvServer({ library, history, storage, uiRoot, token: TOKEN, authMode: 'enforce', artwork: { get: async () => still },
  // Stand-ins for the stores the real server has, so their routes answer as they do there.
  remoteLog: { record: async () => ({ ok: true }) }, watchEvents: { record: () => ({ accepted: false }), flush: async () => {} },
  playNextFile: path.join(dir, 'play-next.json'), log: line => logs.push(line) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://tvbox.local:${port}`;

// The packaged app: tv/ with a config.js like tizen/build.sh writes, opened from file:.
const app = path.join(dir, 'app');
await cp(uiRoot, app, { recursive: true, filter: source => !source.endsWith('.test.js') });
await writeFile(path.join(app, 'config.js'), `window.ONTO_CONFIG = ${JSON.stringify({ servers: [base], token: TOKEN, port, build: 'packaged' })};\n`);
// The packaged index.html loads config.js and boot.js and is built from the server's live copy (as tizen/build.sh does).
const { liveManifest } = await import('../src/tv-live.js');
const page0 = await liveManifest(uiRoot);
await writeFile(path.join(app, 'packaged.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>window.ONTO_LOCAL = ${JSON.stringify(page0).replace(/</g, '\\u003c')};</script>
<script src="config.js"></script><script src="boot.js"></script></body></html>`);

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: 'chrome' }),
  args: [`--host-resolver-rules=MAP tvbox.local 127.0.0.1`, '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const results = {};
try {
  // ---------- 1. the installed TV app ----------
  {
    const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const seen = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { const url = new URL(response.url()); if (url.host === `tvbox.local:${port}`) seen.push({ path: url.pathname, status: response.status(), t: url.searchParams.has('t') }); });
    await page.goto(pathToFileURL(path.join(app, 'packaged.html')).href);
    await page.waitForFunction(() => window.ONTO_CONFIG && window.ONTO_CONFIG.live, null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#channels .channel').length > 0, null, { timeout: 15000 });
    await page.waitForFunction(() => document.body.className.includes('theme-'), null, { timeout: 5000 });
    // Pictures load (?t=) and a channel plays (?t= on /media).
    await page.waitForFunction(() => [...document.images].some(img => img.complete && img.naturalWidth > 0 && /\/art\?/.test(img.src)), null, { timeout: 15000 }).catch(() => {});
    // Play a title the way a remote command does (the same player path a channel takes).
    await page.evaluate(src => window.ontoTVAction('play', { src, positionSeconds: 0 }), videos[0].src);
    await page.waitForFunction(() => !document.getElementById('player').hidden, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(dir, 'packaged.png') });
    const refused = seen.filter(row => row.status === 401 || row.status === 403);
    results.packaged = { requests: seen.length, refused, paths: [...new Set(seen.map(row => `${row.path}:${row.status}${row.t ? ':t' : ''}`))], errors };
    await context.close();
  }
  // ---------- 2. a browser on another device ----------
  {
    const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const seen = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { const url = new URL(response.url()); if (url.host === `tvbox.local:${port}`) seen.push({ path: url.pathname, status: response.status() }); });
    await page.goto(`${base}/`);
    await page.waitForURL(/\/pair\.html\?next=/, { timeout: 15000 });
    const unpaired = seen.filter(row => row.status === 401).map(row => row.path);
    await page.screenshot({ path: path.join(dir, 'pair.png') });
    await page.fill('#pair-code', 'wrong');
    await page.click('#pair-form button');
    await page.waitForFunction(() => /not this server/.test(document.getElementById('pair-status').textContent), null, { timeout: 5000 });
    await page.fill('#pair-code', TOKEN);
    seen.length = 0;
    await page.click('#pair-form button');
    await page.waitForURL(url => !/pair\.html/.test(String(url)), { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('#channels .channel').length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const cookies = await context.cookies(base);
    await page.screenshot({ path: path.join(dir, 'paired.png') });
    results.browser = { unpaired: [...new Set(unpaired)], afterPairing: { refused: seen.filter(row => row.status === 401 || row.status === 403), paths: [...new Set(seen.map(row => `${row.path}:${row.status}`))] },
      cookie: cookies.map(cookie => ({ name: cookie.name, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, isToken: cookie.value === TOKEN })), errors };
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(JSON.stringify(results, null, 1));
console.log(`screenshots: ${dir}`);
const p = results.packaged;
assert.deepEqual(p.refused, [], 'the installed app is never refused');
for (const want of ['/api/tv-live:200', '/api/health:200', '/api/home:200', '/api/household:200']) assert.ok(p.paths.includes(want), `packaged app asked ${want}`);
assert.ok(p.paths.some(row => /^\/art:200:t$/.test(row)), 'pictures load with ?t=');
assert.ok(p.paths.some(row => /^\/media:20[06]:t$/.test(row)), 'the video loads with ?t=');
assert.deepEqual(p.errors, []);
const b = results.browser;
assert.ok(b.unpaired.includes('/api/home'), 'an unpaired browser is refused the lineup');
assert.deepEqual(b.afterPairing.refused, [], 'a paired browser is never refused');
assert.ok(b.afterPairing.paths.includes('/api/home:200') && b.afterPairing.paths.some(row => row.startsWith('/art:200')), 'lineup and pictures after pairing');
assert.deepEqual(b.cookie, [{ name: 'onto_pair', httpOnly: true, sameSite: 'Strict', isToken: false }]);
assert.ok(logs.some(line => line.startsWith('auth enforce: rejected GET /api/home')), 'the refusal was logged');
assert.ok(!logs.join('\n').includes(TOKEN), 'the token never reaches the log');
console.log('check-tv-auth: ok');
