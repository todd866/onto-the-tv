// Headless render of the playback overlay. Never contacts the TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/tmp/onto-tv-control-overlay';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
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
    ];
    localStorage.setItem('onto.viewers.band', band);
    localStorage.setItem('onto.profile', 'all');
    localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
    localStorage.setItem('onto.back.v1', JSON.stringify({ recent: { all: row }, stacks: { all: [row[0]] } }));
  });
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"overlay"};' });
    if (url.pathname === '/api/diagnostics') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/now-playing' || url.pathname === '/api/play-next' || url.pathname === '/api/watch' || url.pathname === '/api/progress') return route.fulfill({ json: { ok: true, items: [] } });
    if (url.pathname === '/api/next') return route.fulfill({ json: { src: 'Kids/Bluey.mp4', show: 'Bluey', title: 'The Sign', resume: 0, duration: 420 } });
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [], thumbs: [], segments: [] } });
    if (url.pathname === '/api/home') {
      return route.fulfill({ json: {
        ceiling: 'G', defaultCeiling: 'G', rating: null,
        viewers: [
          { id: 'sam', name: 'Sam', on: true }, { id: 'jake', name: 'Jake', on: true },
          { id: 'mum', name: 'Mum', on: true }, { id: 'dad', name: 'Dad', on: true },
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
      const colors = ['#184e77', '#386641', '#6a4c93', '#9c6644'];
      const n = +(url.searchParams.get('src') || '').replace('show', '') || 0;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${colors[n % colors.length]}"/></svg>` });
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
  const playerStub = `window.ontoPlayer=function(){var h={},t=12,p=false;return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 420},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true},stop:function(){p=true},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};`;
  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + playerStub }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  async function shot(name, scheme) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: path.join(out, name) });
  }
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
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  await fire(49);
  await page.locator('#player:visible').waitFor();
  await page.locator('#osd-show').waitFor();
  const before = (await page.locator('#osd-show').textContent() || '').trim();
  await page.evaluate(() => document.getElementById('osd').classList.add('hidden'));
  await fire(38);
  const shown = await page.evaluate(() => {
    const osd = document.getElementById('osd');
    const play = document.getElementById('osd-play');
    return { hidden: osd.classList.contains('hidden'), focused: play.classList.contains('focused'), show: document.getElementById('osd-show').textContent.trim() };
  });
  await fire(38);
  const transport = await page.evaluate(() => {
    const play = document.getElementById('osd-play');
    const buttons = [...document.querySelectorAll('#osd-keys button')].filter(button => button.offsetParent && !button.hidden).map(button => {
      const icon = [...button.querySelectorAll('.icon')].find(node => getComputedStyle(node).display !== 'none') || button.querySelector('.icon');
      return {
        id: button.id, label: button.getAttribute('aria-label'), focused: button.classList.contains('focused'),
        w: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
      };
    });
    const track = document.getElementById('osd-track').getBoundingClientRect();
    const bar = document.getElementById('osd-bar').getBoundingClientRect();
    const keys = document.getElementById('osd-keys').getBoundingClientRect();
    return {
      buttons, trackH: Math.round(track.height), barH: Math.round(bar.height),
      keysBelow: keys.top >= track.bottom - 1,
      show: document.getElementById('osd-show').textContent.trim(),
    };
  });
  await page.waitForFunction(() => document.getElementById('tune-flash').hidden);
  await shot('transport-dark.png', 'dark');
  await shot('transport-light.png', 'light');
  await fire(40);
  await page.waitForFunction(() => {
    const row = document.getElementById('continue-strip');
    return row && !row.hidden && row.children.length > 0;
  });
  const row = await page.locator('#continue-strip').evaluate(strip => {
    const osd = document.getElementById('osd').getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    const tile = strip.children[0];
    return {
      label: strip.getAttribute('aria-label'),
      text: tile.getAttribute('aria-label'),
      overlap: box.bottom > osd.top + 2,
      top: Math.round(box.top), osdTop: Math.round(osd.top),
    };
  });
  await page.waitForFunction(() => document.getElementById('tune-flash').hidden);
  await shot('overlay-dark.png', 'dark');
  await shot('overlay-light.png', 'light');
  const preview = await page.evaluate(() => new Promise(resolve => {
    const show = document.getElementById('osd-show').textContent.trim();
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { get: () => 427 });
    Object.defineProperty(event, 'repeat', { get: () => false });
    document.dispatchEvent(event);
    const card = document.getElementById('channel-preview');
    resolve({ visible: card && !card.hidden, show, same: document.getElementById('osd-show').textContent.trim() === show });
  }));
  await page.waitForTimeout(400);
  await shot('preview-dark.png', 'dark');
  await shot('preview-light.png', 'light');
  console.log(JSON.stringify({ before, shown, transport, row, preview, errors }, null, 2));
  assert.equal(shown.show, before);
  assert.equal(shown.hidden, false);
  assert.equal(shown.focused, false, 'first up shows the overlay');
  assert.equal(transport.show, before, 'up does not change channel');
  assert.equal(transport.buttons.find(button => button.id === 'osd-play').focused, true);
  assert.deepEqual(transport.buttons.map(button => button.id), ['osd-prev-scene', 'osd-play', 'osd-next', 'osd-options']);
  assert.deepEqual(transport.buttons.map(button => button.label).filter((_, index) => index !== 1), ['Previous', 'Next', 'Options']);
  assert.ok(['Play', 'Pause', 'Play or pause'].includes(transport.buttons[1].label));
  assert.ok(transport.buttons.every(button => button.w >= 48), JSON.stringify(transport.buttons));
  assert.ok(transport.trackH >= 18, 'track ' + transport.trackH);
  assert.equal(transport.keysBelow, true);
  assert.equal(row.label, 'Continue');
  assert.match(row.text, /resume |next/);
  assert.equal(row.overlap, false, JSON.stringify(row));
  assert.equal(preview.visible, true);
  assert.equal(preview.same, true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
