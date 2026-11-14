// Headless render of the back chip and the Continue row. Never contacts the TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/private/tmp/onto-tv-undo';
await mkdir(out, { recursive: true });

function entry(src, show, title, position, art, leftAt) {
  return {
    src, show, title, art, positionSeconds: position, duration: 600, leftAt,
    channel: { id: 'christmas', number: 5, name: 'Christmas' }, mode: 'channel',
  };
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const diagnostics = [];
let nextDelay = 0;
let nextAt = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const h = new Date().getHours();
    const band = h >= 20 || h < 5 ? 'night' : 'day';
    const now = Date.now();
    const row = [
      { src: 'Kids/Timmy Time Christmas Surprise.mp4', show: 'Timmy Time', title: 'Christmas Surprise', art: '/art?src=show0', positionSeconds: 84, duration: 600, channel: { id: 'christmas', number: 5, name: 'Christmas' }, mode: 'channel', leftAt: now },
      { src: 'Music/Common.mp4', show: 'Common', title: 'Common', art: '/art?src=show1', positionSeconds: 12, duration: 200, channel: { id: 'music', number: 4, name: 'Music' }, mode: 'channel', leftAt: now },
      { src: 'Kids/Sarah and Duck.mp4', show: 'Sarah and Duck', title: 'Sarah and Duck', art: '/art?src=show2', positionSeconds: 40, duration: 420, channel: { id: 'cartoons', number: 1, name: 'Cartoons' }, mode: 'channel', leftAt: now },
    ];
    localStorage.setItem('onto.viewers.band', band);
    localStorage.setItem('onto.profile', 'all');
    localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
    localStorage.setItem('onto.back.v1', JSON.stringify({ recent: { all: row, sam: row }, stacks: { all: [row[0]], sam: [row[0]] } }));
  });
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"undo-ui"};' });
    if (url.pathname === '/api/diagnostics') { diagnostics.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/next') {
      const body = route.request().postDataJSON();
      const started = Date.now();
      if (nextDelay) await new Promise(resolve => setTimeout(resolve, nextDelay));
      nextAt.push({ channel: body.channel, prefetch: body.prefetch === true, waited: Date.now() - started });
      return route.fulfill({ json: { src: (body.channel || 'show') + '.mp4', show: 'Bluey', title: 'Channel ' + body.channel, resume: 0, duration: 420 } });
    }
    if (url.pathname === '/api/watch' || url.pathname === '/api/progress') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [], thumbs: [], segments: [] } });
    if (url.pathname === '/api/home') {
      return route.fulfill({ json: {
        ceiling: 'G', defaultCeiling: 'G', rating: null,
        viewers: [
          { id: 'sam', name: 'Sam', on: true },
          { id: 'jake', name: 'Jake', on: true },
          { id: 'mum', name: 'Mum', on: true },
          { id: 'dad', name: 'Dad', on: true },
        ],
        channels: [
          { id: 'cartoons', number: 1, name: 'Cartoons', now: { show: 'Bluey', title: 'The Sign', minutes: 7, art: '/art?src=show3' } },
          { id: 'movies', number: 2, name: 'Movies', now: { show: 'Timmy Time', title: 'Christmas Surprise', minutes: 5, art: '/art?src=show0' } },
          { id: 'music', number: 4, name: 'Music', now: { show: 'Common', title: 'Common', minutes: 3, art: '/art?src=show1' } },
          { id: 'christmas', number: 5, name: 'Christmas', now: { show: 'Sarah and Duck', title: 'Sarah and Duck', minutes: 8, art: '/art?src=show2' } },
        ],
      } });
    }
    if (url.pathname === '/art') {
      const colors = ['#184e77', '#386641', '#6a4c93', '#9c6644', '#007f5f', '#1d3557'];
      const n = +(url.searchParams.get('src') || '').replace('show', '') || 0;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${colors[n % colors.length]}"/></svg>` });
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff') ? 'font/woff' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  async function shot(name, scheme) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(out, name) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('#resume-row .resume').first().waitFor();
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  await page.waitForFunction(() => [...document.querySelectorAll('#resume-row .thumb')].every(img => img.complete && img.naturalWidth));
  const home = await page.locator('#resume-row').evaluate(row => {
    const tiles = [...row.querySelectorAll('.resume')].map(button => {
      const rect = button.getBoundingClientRect();
      const title = button.querySelector('.resume-title');
      const at = button.querySelector('.resume-at');
      return {
        text: (title ? title.textContent : '') + ' | ' + (at ? at.textContent : ''),
        w: Math.round(rect.width), h: Math.round(rect.height),
        titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
        atSize: at ? parseFloat(getComputedStyle(at).fontSize) : 0,
      };
    });
    return { label: row.getAttribute('aria-label'), tiles, top: Math.round(row.getBoundingClientRect().top) };
  });
  assert.equal(home.label, 'Continue');
  assert.equal(home.tiles.length, 3);
  assert.equal(home.tiles[0].text, 'Timmy Time | resume 1:24');
  assert.ok(home.tiles[0].titleSize >= 28 && home.tiles[0].atSize >= 28, JSON.stringify(home.tiles[0]));
  await shot('continue-all-dark.png', 'dark');
  await shot('continue-all-light.png', 'light');

  await page.evaluate(() => {
    const h = new Date().getHours();
    localStorage.setItem('onto.viewers.band', h >= 20 || h < 5 ? 'night' : 'day');
    localStorage.setItem('onto.profile', 'sam');
    localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
  });
  await page.reload();
  await page.locator('body.profile-sam #resume-row .resume').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#resume-row .thumb')].every(img => img.complete && img.naturalWidth));
  await shot('continue-sam-dark.png', 'dark');
  await shot('continue-sam-light.png', 'light');

  await page.evaluate(() => {
    localStorage.setItem('onto.profile', 'all');
  });
  await page.reload();
  await page.locator('#resume-row .resume').first().waitFor();
  const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
  const playerStub = `window.ontoPlayer=function(){var h={},t=0,p=true;return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 1800},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true},stop:function(){p=true},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};`;
  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + playerStub }));
  await page.reload();
  await page.locator('.viewer.focused').waitFor();
  nextDelay = 800;
  const tuneStarted = Date.now();
  await page.keyboard.press('1');
  await page.locator('#player:visible').waitFor();
  await page.locator('#back-chip:visible').waitFor();
  const tuneMs = Date.now() - tuneStarted;
  await page.waitForFunction(() => {
    const img = document.getElementById('back-chip-art');
    return img && img.complete && img.naturalWidth;
  });
  const chip = await page.locator('#back-chip').evaluate(button => ({
    label: button.getAttribute('aria-label'),
    title: document.getElementById('back-chip-title').textContent,
    h: Math.round(button.getBoundingClientRect().height),
  }));
  assert.equal(chip.title, 'Timmy Time');
  assert.equal(chip.label, 'Back to Timmy Time');
  assert.ok(chip.h >= 80, 'chip height ' + chip.h);
  await shot('chip-all-dark.png', 'dark');
  await shot('chip-all-light.png', 'light');

  const beforeShow = (await page.locator('#osd-show').textContent() || '').trim();
  diagnostics.length = 0;
  nextAt = [];
  const previewMs = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now();
    function fire(type) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { get: () => 427 });
      Object.defineProperty(event, 'repeat', { get: () => false });
      document.dispatchEvent(event);
    }
    fire('keydown');
    fire('keyup');
    function check() {
      const card = document.getElementById('channel-preview');
      if (card && !card.hidden) return resolve(Math.round(performance.now() - start));
      if (performance.now() - start > 1000) return resolve(-1);
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  }));
  const heldShow = (await page.locator('#osd-show').textContent() || '').trim();
  const titleMs = await page.evaluate(before => new Promise(resolve => {
    const start = performance.now();
    function check() {
      const show = (document.getElementById('osd-show').textContent || '').trim();
      if (show && show !== before) return resolve(Math.round(performance.now() - start));
      if (performance.now() - start > 4000) return resolve(-1);
      requestAnimationFrame(check);
    }
    check();
  }), beforeShow);
  await page.waitForTimeout(100);
  const latency = diagnostics.filter(event => event.event === 'key_latency').map(event => event.latencyMs);
  await shot('preview-all-dark.png', 'dark');
  console.log(JSON.stringify({
    tuneMs,
    previewMs,
    heldShow,
    titleMs,
    keyLatency: latency,
    nextWaits: nextAt.map(item => item.waited),
    beforeWouldPaintMs: nextAt.length ? nextAt[0].waited : null,
  }));
  assert.ok(previewMs >= 0 && previewMs < 100, 'preview ' + previewMs);
  assert.equal(heldShow, beforeShow);
  assert.ok(titleMs >= 1200 && titleMs < 2200, 'title ' + titleMs);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
