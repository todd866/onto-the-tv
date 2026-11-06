// Headless 1920×1080 tube layout: fixtures only, never a visible browser or the TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = fileURLToPath(new URL('../audit/tube/', import.meta.url));
await mkdir(out, { recursive: true });

const longTitle = 'Hermitcraft S01E01 The Start of a Very Long Title About the Base and the Mine and the Shop';
function card(src, title, creator, duration, resume) {
  return {
    src, title, show: creator, creator, duration,
    art: '/art?src=' + src.replace(/[^a-z0-9]/gi, ''),
    resume: resume || 0,
    watched: false,
  };
}
const cards = [
  card('grian/e1.mp4', longTitle, 'Grian', 724, 200),
  card('grian/e2.mp4', 'Hermitcraft S01E02 RC car jump', 'Grian', 451, 0),
  card('mumbo/m.mp4', 'Redstone shop', 'Mumbo Jumbo', 1330, 0),
  card('bluey/a.mp4', 'Bluey S01E01 Keepy Uppy', 'Bluey', 238, 0),
  card('lego/a.mp4', 'LEGO city chase', 'LEGO', 500, 0),
  card('octo/a.mp4', 'Octonauts and the kelp forest', 'Octonauts', 600, 0),
  card('rc/a.mp4', 'RC Odyssey hill climb', 'RC Odyssey', 640, 0),
  card('bluey/b.mp4', 'Bluey S01E02 Hospital', 'Bluey', 420, 0),
];
const chips = [
  { id: 'all', label: 'All' },
  { id: 'grian', label: 'Grian' },
  { id: 'bluey', label: 'Bluey' },
  { id: 'mumbo', label: 'Mumbo Jumbo' },
  { id: 'lego', label: 'LEGO' },
  { id: 'rc', label: 'RC Odyssey' },
  { id: 'octo', label: 'Octonauts' },
];
const home = {
  ceiling: 'PG', defaultCeiling: 'PG', rating: null,
  viewers: [
    { id: 'sam', name: 'Sam', on: false },
    { id: 'jake', name: 'Jake', on: true },
    { id: 'mum', name: 'Mum', on: true },
    { id: 'dad', name: 'Dad', on: true },
  ],
  channels: [{ id: 'forjake', number: 36, name: 'For Jake', now: { show: 'Bluey', title: 'Keepy Uppy', minutes: 7, art: '/art?src=show0' } }],
};

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const h = new Date().getHours();
    localStorage.setItem('onto.viewers.band', h >= 20 || h < 5 ? 'night' : 'day');
    localStorage.setItem('onto.profile', 'jake');
    localStorage.setItem('onto.viewers', 'jake,mum,dad');
    localStorage.setItem('onto.layouts', JSON.stringify({ jake: 'tube' }));
  });
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"tube-test"};' });
    if (url.pathname === '/api/diagnostics' || url.pathname === '/api/watch' || url.pathname === '/api/progress') return route.fulfill({ json: { ok: true, accepted: true } });
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [], thumbs: [], segments: [] } });
    if (url.pathname === '/api/home') return route.fulfill({ json: home });
    if (url.pathname === '/api/feed') {
      const chip = url.searchParams.get('chip') || 'all';
      const offset = Number(url.searchParams.get('offset') || 0);
      const list = chip === 'all' ? cards : cards.filter(item => item.creator.toLowerCase().includes(chip));
      return route.fulfill({ json: { cards: list.slice(offset, offset + 24), chips, total: list.length } });
    }
    if (url.pathname === '/api/related') {
      const src = url.searchParams.get('src');
      const rest = cards.filter(item => item.src !== src);
      return route.fulfill({ json: { cards: rest } });
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const found = cards.filter(item => (item.title + ' ' + item.creator).toLowerCase().includes(q));
      const suggestions = q && 'rc odyssey'.includes(q) ? ['RC Odyssey'] : [];
      return route.fulfill({ json: { cards: found, suggestions } });
    }
    if (url.pathname === '/api/creators') return route.fulfill({ json: { creators: [], cards: [] } });
    if (url.pathname === '/player.js') {
      const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
      const stub = 'window.ontoPlayer=function(){var h={},t=0,p=true;window.testMedia={finish:function(){(h.ended||function(){})();},tick:function(v){t=v;(h.time||function(){})();},fail:function(){(h.error||function(){})();}};return {engine:\'video\',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 1800},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true;(h.pause||function(){})();},stop:function(){p=true},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};';
      return route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + stub });
    }
    if (url.pathname === '/art') {
      const colors = ['#184e77', '#386641', '#6a4c93', '#9c6644', '#007f5f', '#1d3557', '#9b2226', '#005f73'];
      const n = (url.searchParams.get('src') || '').length;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="${colors[n % colors.length]}"/><circle cx="900" cy="180" r="120" fill="white" opacity=".18"/></svg>` });
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff') ? 'font/woff' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });

  async function pair(stem) {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(out, stem + '-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.screenshot({ path: path.join(out, stem + '-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
  }

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.tube-card').nth(7).waitFor();
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  await page.waitForFunction(() => [...document.querySelectorAll('.tube-card img')].every(img => img.complete && img.naturalWidth));
  assert.equal(/youtube/i.test(await page.locator('#home').innerText()), false);
  const homeMetrics = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#channels .tube-card')];
    const rects = cards.slice(0, 5).map(el => {
      const box = el.getBoundingClientRect();
      return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) };
    });
    const title = cards[0].querySelector('.tube-title');
    const style = getComputedStyle(title);
    return {
      rects,
      titleH: title.clientHeight,
      titleFull: title.scrollHeight,
      line: parseFloat(style.lineHeight),
      rows: document.getElementById('channels').clientHeight / cards[0].getBoundingClientRect().height,
      meta: cards[0].querySelector('.tube-meta').textContent,
      dur: cards[0].querySelector('.tube-dur').textContent,
    };
  });
  assert.ok(Math.abs(homeMetrics.rects[0].top - homeMetrics.rects[3].top) <= 2, JSON.stringify(homeMetrics.rects));
  assert.ok(homeMetrics.rects[4].top > homeMetrics.rects[0].top + 80, JSON.stringify(homeMetrics.rects));
  assert.ok(homeMetrics.rects[1].left > homeMetrics.rects[0].left, JSON.stringify(homeMetrics.rects));
  for (let i = 1; i < 4; i++) assert.ok(Math.abs(homeMetrics.rects[i].width - homeMetrics.rects[0].width) <= 2);
  assert.ok(homeMetrics.titleH <= homeMetrics.line * 2 + 2 && homeMetrics.titleFull > homeMetrics.titleH + 8, JSON.stringify(homeMetrics));
  assert.match(homeMetrics.meta, /Grian · \d+%/);
  assert.equal(homeMetrics.dur, '12:04');
  assert.ok(homeMetrics.rows >= 2 && homeMetrics.rows <= 2.8, 'visible rows ' + homeMetrics.rows);
  await pair('home');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.locator('.tube-card.focused').waitFor();
  const focusMetrics = await page.locator('.tube-card.focused').evaluate(el => {
    const title = el.querySelector('.tube-title');
    const thumb = el.querySelector('.tube-thumb');
    return {
      scale: el.getBoundingClientRect().width / el.offsetWidth,
      outline: getComputedStyle(thumb).outlineWidth,
      titleH: title.clientHeight,
      titleFull: title.scrollHeight,
      line: parseFloat(getComputedStyle(title).lineHeight),
      src: el._card && el._card.src,
    };
  });
  assert.ok(Math.abs(focusMetrics.scale - 1.08) < 0.04, JSON.stringify(focusMetrics));
  assert.equal(focusMetrics.outline, '4px');
  assert.ok(focusMetrics.titleH > focusMetrics.line * 2 && focusMetrics.titleH + 4 >= focusMetrics.titleFull, JSON.stringify(focusMetrics));
  assert.equal(focusMetrics.src, 'grian/e1.mp4');
  await pair('focused');

  await page.keyboard.press('ArrowLeft');
  await page.locator('body.tube-rail-open').waitFor();
  const railWidth = await page.locator('#tube-rail').evaluate(el => Math.round(el.getBoundingClientRect().width));
  assert.ok(railWidth >= 260, 'rail ' + railWidth);
  assert.equal(await page.locator('.tube-rail-label').first().textContent(), 'Search');
  await pair('rail');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !document.body.classList.contains('tube-rail-open'));

  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  await page.locator('#osd-episode', { hasText: 'Very Long Title' }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.locator('#tube-shelf .tube-card').first().waitFor();
  const shelf = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#tube-shelf .tube-card')];
    const tops = cards.map(el => el.offsetTop);
    const box = document.getElementById('tube-shelf').getBoundingClientRect();
    return { tops, height: Math.round(box.height), bottom: Math.round(box.bottom) };
  });
  assert.ok(shelf.tops.length >= 3);
  assert.ok(Math.abs(shelf.tops[0] - shelf.tops[shelf.tops.length - 1]) <= 2, JSON.stringify(shelf));
  assert.ok(shelf.bottom >= 1070 && shelf.height > 250 && shelf.height < 450, JSON.stringify(shelf));
  await pair('shelf');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.getElementById('tube-shelf').hidden);

  await page.evaluate(() => window.testMedia.tick(1792));
  await page.locator('#tube-next:visible').waitFor();
  await page.locator('#tube-count-num').waitFor();
  const count = await page.locator('#tube-count-num').textContent();
  assert.match(count, /^[1-5]$/, count);
  const nextBox = await page.locator('.tube-next-card').boundingBox();
  assert.ok(nextBox.x > 1200 && nextBox.y > 500, JSON.stringify(nextBox));
  await pair('upnext');
  await page.locator('#osd-episode', { hasText: 'RC car jump' }).waitFor({ timeout: 8000 });
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector('.tube-card.focused');
    return !!(el && el._card && el._card.src === 'grian/e2.mp4');
  });

  for (let i = 0; i < 4 && !(await page.locator('body.tube-rail-open').count()); i++) await page.keyboard.press('ArrowLeft');
  await page.locator('body.tube-rail-open').waitFor();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.locator('.tube-key.focused').waitFor();
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'Enter', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'Enter']) {
    await page.keyboard.press(key);
  }
  await page.locator('#tube-query', { hasText: 'rc' }).waitFor();
  await page.locator('#tube-results .tube-card').first().waitFor();
  assert.match(await page.locator('#tube-results .tube-card').first().locator('.tube-title').textContent(), /RC/);
  const keyTops = await page.evaluate(() => {
    const keys = [...document.querySelectorAll('.tube-key')].slice(0, 7);
    return keys.map(el => Math.round(el.getBoundingClientRect().top));
  });
  assert.ok(Math.abs(keyTops[0] - keyTops[6]) <= 2, JSON.stringify(keyTops));
  await pair('search');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.locator('#tube-results .tube-card.focused').waitFor();
  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  await page.locator('#osd-episode', { hasText: 'RC car jump' }).waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, out, homeMetrics, focusMetrics, railWidth, shelf, count, keyTops }));
} finally {
  await browser.close();
}
