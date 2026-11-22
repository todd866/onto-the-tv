// Headless 1920×1080 tube layout for Max. Synthetic fixtures only; never the real TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { assertViewport } = await import(process.env.VIEWPORT_MODULE || new URL('./lib/viewport-fit.mjs', import.meta.url).href);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/private/tmp/onto-tv-ui';
await mkdir(out, { recursive: true });

function card(src, title, creator, duration, resume) {
  return {
    src, title, show: creator, creator, duration,
    art: '/art?src=' + encodeURIComponent(src),
    resume: resume || 0,
    watched: !resume && /hospital/i.test(title),
  };
}
const cards = [
  card('grian/e1.mp4', 'Hermitcraft S01E01 The Start of a Very Long Title About the Base and the Mine', 'Grian', 724, 200),
  card('grian/e2.mp4', 'Hermitcraft S01E02 RC car jump', 'Grian', 451, 0),
  card('mumbo/m.mp4', 'Redstone shop', 'Mumbo Jumbo', 1330, 0),
  card('bluey/a.mp4', 'Bluey S01E01 Keepy Uppy', 'Bluey', 238, 0),
  card('lego/a.mp4', 'LEGO city chase', 'LEGO', 500, 0),
  card('octo/a.mp4', 'Octonauts and the kelp forest', 'Octonauts', 600, 0),
  card('rc/a.mp4', 'RC Odyssey hill climb', 'RC Odyssey', 640, 0),
  card('bluey/b.mp4', 'Bluey S01E02 Hospital', 'Bluey', 420, 0),
  card('mine/a.mp4', 'Minecraft village build', 'Minecraft', 800, 0),
];
const chips = [
  { id: 'all', label: 'All' },
  { id: 'grian', label: 'Grian' },
  { id: 'bluey', label: 'Bluey' },
  { id: 'mumbo', label: 'Mumbo Jumbo' },
  { id: 'lego', label: 'LEGO' },
  { id: 'rc', label: 'RC Odyssey' },
  { id: 'octo', label: 'Octonauts' },
  { id: 'mine', label: 'Minecraft' },
];
const creators = [
  { id: 'grian', label: 'Grian', name: 'Grian', art: '/art?src=grian', count: 2 },
  { id: 'bluey', label: 'Bluey', name: 'Bluey', art: '/art?src=bluey', count: 2 },
  { id: 'mumbo', label: 'Mumbo Jumbo', name: 'Mumbo Jumbo', art: '/art?src=mumbo', count: 1 },
  { id: 'rc', label: 'RC Odyssey', name: 'RC Odyssey', art: '/art?src=rc', count: 1 },
];
const home = {
  ceiling: 'PG', defaultCeiling: 'PG', rating: null,
  viewers: [
    { id: 'kid1', name: 'Robin', on: false },
    { id: 'kid2', name: 'Max', on: true },
    { id: 'adult2', name: 'Mum', on: true },
    { id: 'adult1', name: 'Dad', on: true },
  ],
  channels: [{ id: 'forkid2', number: 36, name: 'For Max', now: { show: 'Bluey', title: 'Keepy Uppy', minutes: 7, art: '/art?src=show0' } }],
};

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('onto.viewers.band', 'day');
    localStorage.setItem('onto.profile', 'kid2');
    localStorage.setItem('onto.viewers', 'kid2,adult2,adult1');
    localStorage.setItem('onto.layouts', JSON.stringify({ older: 'tube' }));
  });
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"tube-check"};' });
    if (url.pathname === '/api/diagnostics' || url.pathname === '/api/watch' || url.pathname === '/api/progress') return route.fulfill({ json: { ok: true, accepted: true } });
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [], thumbs: [], segments: [] } });
    if (url.pathname === '/api/home') return route.fulfill({ json: home });
    if (url.pathname === '/api/feed') {
      const chip = (url.searchParams.get('chip') || 'all').toLowerCase();
      const offset = Number(url.searchParams.get('offset') || 0);
      const list = chip === 'all' ? cards : cards.filter(item => item.creator.toLowerCase().includes(chip) || item.show.toLowerCase().includes(chip));
      return route.fulfill({ json: { cards: list.slice(offset, offset + 24), chips, total: list.length } });
    }
    if (url.pathname === '/api/related') {
      const src = url.searchParams.get('src');
      return route.fulfill({ json: { cards: cards.filter(item => item.src !== src) } });
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const found = q ? cards.filter(item => (item.title + ' ' + item.creator + ' ' + item.show).toLowerCase().includes(q)) : [];
      const suggestions = q && 'rc odyssey'.includes(q) ? ['RC Odyssey'] : [];
      return route.fulfill({ json: { cards: found, suggestions } });
    }
    if (url.pathname === '/api/creators') {
      const id = url.searchParams.get('id');
      const mine = id ? cards.filter(item => item.creator.toLowerCase().includes(id)) : cards.filter(item => item.creator === 'Grian');
      return route.fulfill({ json: { creators, cards: mine } });
    }
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

  async function shot(name) {
    await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
  }

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('#channels .tube-card').nth(7).waitFor();
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  await page.waitForFunction(() => [...document.querySelectorAll('#channels .tube-card img')].every(img => img.complete && img.naturalWidth));
  assert.equal(/youtube/i.test(await page.locator('#home').innerText()), false);

  const grid = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#channels .tube-card')];
    const rects = cards.slice(0, 8).map(el => {
      const box = el.getBoundingClientRect();
      return { top: Math.round(box.top), left: Math.round(box.left) };
    });
    const doc = document.documentElement;
    return {
      count: cards.length,
      rects,
      scroll: doc.scrollHeight <= window.innerHeight + 1 && doc.scrollWidth <= window.innerWidth + 1,
      pageY: window.scrollY,
    };
  });
  assert.ok(grid.count >= 8, 'cards ' + grid.count);
  assert.equal(grid.scroll, true, 'page scrolls');
  assert.equal(grid.pageY, 0);
  const row1 = grid.rects.slice(0, 4);
  const row2 = grid.rects.slice(4, 8);
  assert.ok(row1.every(box => Math.abs(box.top - row1[0].top) <= 2), JSON.stringify(row1));
  assert.ok(row2.every(box => Math.abs(box.top - row2[0].top) <= 2), JSON.stringify(row2));
  assert.ok(row2[0].top > row1[0].top + 40, JSON.stringify(grid.rects));
  for (let i = 1; i < 4; i++) assert.ok(row1[i].left > row1[i - 1].left, JSON.stringify(row1));
  await assertViewport(page, { primary: [{ selector: '#home', fit: 'visible' }], controls: [{ selector: '.viewer.focused', fit: 'visible' }] });
  await shot('tube-home-dark.png');

  await page.keyboard.press('ArrowDown');
  await page.locator('.tube-chip.focused').waitFor();
  await page.keyboard.press('ArrowDown');
  const first = await page.locator('#channels .tube-card.focused').evaluate(el => el._card && el._card.src);
  await page.keyboard.press('ArrowRight');
  const second = await page.locator('#channels .tube-card.focused').evaluate(el => el._card && el._card.src);
  assert.notEqual(second, first, 'D-pad did not move');
  await page.keyboard.press('ArrowUp');
  await page.locator('.tube-chip.focused').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  const playingSrc = await page.locator('#channels .tube-card.focused').evaluate(el => el._card && el._card.src);
  assert.equal(playingSrc, first);
  await page.keyboard.press('ArrowLeft');
  await page.locator('body.tube-rail-open').waitFor();
  assert.equal(await page.locator('.tube-rail-label').first().innerText(), 'Search');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !document.body.classList.contains('tube-rail-open'));

  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  await page.waitForFunction(src => {
    const el = document.querySelector('#channels .tube-card.focused');
    return !!(el && el._card && el._card.src === src);
  }, playingSrc);

  await page.keyboard.press('ArrowLeft');
  await page.locator('body.tube-rail-open').waitFor();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.locator('.tube-key.focused').waitFor();
  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'Enter', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'Enter']) {
    await page.keyboard.press(key);
  }
  await page.locator('#tube-query', { hasText: 'rc' }).waitFor();
  await page.locator('#tube-results .tube-card').first().waitFor();
  const titles = await page.locator('#tube-results .tube-title').allInnerTexts();
  assert.ok(titles.length >= 1 && titles.length < cards.length, JSON.stringify(titles));
  assert.ok(titles.every(title => /rc/i.test(title)), JSON.stringify(titles));
  await shot('tube-search-dark.png');

  await page.keyboard.press('Escape');
  await page.locator('#channels .tube-card').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await page.locator('body.tube-rail-open').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('.tube-avatar').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.tube-avatar')].every(img => img.complete && img.naturalWidth));
  assert.ok(await page.locator('.tube-avatar').count() >= 2);
  assert.ok(await page.locator('#channels .tube-card').count() >= 1);
  await shot('tube-creators-dark.png');

  await page.keyboard.press('Escape');
  await page.locator('#channels .tube-card').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  await page.evaluate(() => window.testMedia.tick(1792));
  await page.locator('#tube-next:visible').waitFor();
  const count = await page.locator('#tube-count-num').innerText();
  assert.match(count, /^[1-5]$/, count);
  await shot('tube-upnext-dark.png');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('tube-next').hidden);
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  await page.locator('#channels .tube-card').nth(7).waitFor();

  await page.emulateMedia({ colorScheme: 'light' });
  await shot('tube-home-light.png');
  await assertViewport(page, { primary: [{ selector: '#home', fit: 'visible' }] });

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, out, cards: grid.count, row1, row2, playingSrc, titles, count }));
} finally {
  await browser.close();
}
