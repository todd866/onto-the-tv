// Headless: the directions tray loads further tiles as focus moves along the row (Nov 2026).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));

function tile(n) {
  return {
    kind: n % 6 === 0 ? 'more' : 'on',
    label: 'Dir ' + n,
    src: 'scifi/ep-' + n + '.mkv',
    title: 'Focused episode title number ' + n,
    show: 'TNG',
    resume: 0,
    duration: 2700,
    channel: { id: 'scifi', number: 10, name: 'Sci-Fi' },
  };
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const directionCalls = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('onto.profile', 'all');
    localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
  });
  const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
  const playerStub = "window.ontoPlayer=function(){var h={},t=0,p=false;return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 2700},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true},stop:function(){p=true},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};";
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/player.js') return route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + playerStub });
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"directions"};' });
    if (url.pathname === '/api/directions') {
      const body = route.request().postDataJSON() || {};
      const offset = Number(body.offset) || 0;
      directionCalls.push(offset);
      const batch = [];
      for (let i = 0; i < 12; i++) batch.push(tile(offset + i + 1));
      const next = offset + 12 < 36 ? offset + 12 : null;
      return route.fulfill({ json: { from: 'scifi/now.mkv', tiles: batch, next } });
    }
    if (url.pathname === '/api/next') {
      return route.fulfill({ json: { src: 'scifi/now.mkv', show: 'TNG', title: 'Now playing', resume: 0, duration: 2700 } });
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/home') return route.fulfill({ json: {
        ceiling: 'G', defaultCeiling: 'G', rating: null,
        viewers: [{ id: 'sam', name: 'Sam', on: true }, { id: 'jake', name: 'Jake', on: true }, { id: 'mum', name: 'Mum', on: true }, { id: 'dad', name: 'Dad', on: true }],
        channels: [{ id: 'scifi', number: 1, name: 'Sci-Fi', now: { show: 'TNG', title: 'Now playing', minutes: 45, art: '/art?src=a' } }],
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
  function fire(code) {
    return page.evaluate(keyCode => {
      function dispatch(type) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { get: () => keyCode });
        Object.defineProperty(event, 'repeat', { get: () => false });
        document.dispatchEvent(event);
      }
      dispatch('keydown');
      dispatch('keyup');
    }, code);
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('http://tv.test/');
  await page.locator('#channels .channel').first().waitFor();
  await fire(49);
  await page.waitForFunction(() => !document.getElementById('player').hidden);
  await page.waitForTimeout(3200);
  await page.evaluate(() => { const osd = document.getElementById('osd'); if (osd) osd.classList.add('hidden'); });
  await fire(40);
  await page.waitForFunction(() => document.querySelectorAll('#continue-strip .direction').length >= 5, null, { timeout: 12000 });
  for (let i = 0; i < 20; i++) await fire(39);
  await page.waitForTimeout(800);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '/tmp/onto-tv-directions-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: '/tmp/onto-tv-directions-light.png' });
  const state = await page.evaluate(() => {
    const strip = document.getElementById('continue-strip');
    const focused = strip && strip.querySelector('.direction.focused');
    const caption = document.getElementById('direction-caption');
    const entry = focused && focused._entry;
    if (!strip || !focused) return { ok: false };
    const tile = focused.getBoundingClientRect();
    const view = strip.getBoundingClientRect();
    return {
      ok: true,
      caption: caption && !caption.hidden ? caption.textContent : '',
      title: entry ? entry.title || '' : '',
      inView: tile.left >= view.left - 2 && tile.right <= view.right + 2,
      tiles: strip.querySelectorAll('.direction').length,
    };
  });
  assert.ok(directionCalls.length >= 3, 'further batches were requested: ' + JSON.stringify(directionCalls));
  assert.equal(state.ok, true, JSON.stringify(state));
  assert.equal(state.caption, state.title, 'caption shows the focused tile title');
  assert.ok(state.inView, 'focused tile stays inside the strip viewport');
  assert.ok(state.tiles > 12, 'tiles were appended along the row');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, directionCalls, ...state }));
} finally {
  await browser.close();
}