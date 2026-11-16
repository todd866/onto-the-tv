// Headless: Back while a channel is moving on from a title that failed goes home; it does not retune the failure
// (16 Nov 2026: two TNG episodes failing in turn on the TV, Back retuned the broken one). Never contacts the TV.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const loads = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('onto.profile', 'all');
    localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
    localStorage.removeItem('onto.back.v1');
  });
  const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
  // The media stub records each load and lets the test fail it, as AVPlay's error does.
  const playerStub = `window.ontoPlayer=function(){var h={},t=0,p=true;window.__fail=function(){h.error&&h.error()};return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 0},paused:function(){return p},ended:function(){return false},load:function(u,start){window.__loads=(window.__loads||[]).concat([u]);t=start||0;p=false},play:function(){p=false},pause:function(){p=true},stop:function(){p=true},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};`;
  let n = 0;
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/player.js') return route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + playerStub });
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"error-back"};' });
    if (url.pathname === '/api/next') {
      const body = route.request().postDataJSON();
      if (body.prefetch) return route.fulfill({ json: { src: 'prefetch.mkv', show: 'TNG', title: 'Prefetch', resume: 0, duration: 2700 } });
      n++;
      loads.push(n);
      return route.fulfill({ json: { src: `scifi/TNG ${n}.mkv`, show: 'TNG', title: 'Episode ' + n, resume: 0, duration: 2700 } });
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/home') return route.fulfill({ json: {
        ceiling: 'G', defaultCeiling: 'G', rating: null,
        viewers: [{ id: 'sam', name: 'Sam', on: true }, { id: 'jake', name: 'Jake', on: true }, { id: 'mum', name: 'Mum', on: true }, { id: 'dad', name: 'Dad', on: true }],
        channels: [{ id: 'scifi', number: 1, name: 'Sci-Fi', now: { show: 'TNG', title: 'Encounter at Farpoint', minutes: 90, art: '/art?src=a' } }],
      } });
      if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
      if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [], thumbs: [], segments: [] } });
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === '/art') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36"><rect width="64" height="36" fill="#335"/></svg>' });
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff') ? 'font/woff' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('http://tv.test/');
  await page.locator('#channels .channel').first().waitFor();
  await page.keyboard.press('1');                       // tune Sci-Fi by number
  await page.waitForFunction(() => (window.__loads || []).length === 1);
  await page.evaluate(() => window.__fail());           // episode 1 fails
  await page.waitForFunction(() => (window.__loads || []).length === 2, null, { timeout: 15000 }); // the channel moves on
  await page.evaluate(() => window.__fail());           // episode 2 fails too
  await page.waitForFunction(() => (window.__loads || []).length === 3, null, { timeout: 15000 });
  await page.keyboard.press('Escape');                  // Back while episode 3 is loading
  await page.waitForTimeout(800);
  const state = await page.evaluate(() => ({ playerHidden: document.getElementById('player').hidden, loads: (window.__loads || []).length }));
  assert.equal(state.loads, 3, 'Back retuned a title: ' + JSON.stringify(state));
  assert.equal(state.playerHidden, true, 'Back did not reach home: ' + JSON.stringify(state));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...state }));
} finally {
  await browser.close();
}
