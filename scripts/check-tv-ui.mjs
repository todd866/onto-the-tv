// Headless UI regression with a synthetic library; never connects to the real TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertViewport } from '/Users/iantodd/Projects/.ux-authoring/viewport-fit.mjs';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/private/tmp/onto-tv-ui';
await mkdir(out, { recursive: true });
const longShow = 'A Very Long Show Name That Must Remain Readable When Selected On The Card';
function homeFor(viewers) {
  const ids = viewers == null ? ['sam', 'jake', 'mum', 'dad'] : String(viewers).split(',').filter(Boolean);
  const on = id => ids.includes(id);
  const ceiling = on('sam') ? 'G' : on('jake') ? 'PG' : ids.length ? 'M' : null;
  const channels = [
    { id: 'cartoons', number: 1, name: 'Cartoons', now: { show: longShow, art: '/art?src=show0' } },
    { id: 'movies', number: 2, name: 'Movies', now: { show: 'The Great Adventure', art: '/art?src=show1' } },
    { id: 'music', number: 4, name: 'Music', now: { show: 'The Workshop', art: '/art?src=show3' } },
    { id: 'christmas', number: 5, name: 'Christmas', now: { show: 'Wild Australia', art: '/art?src=show4' } },
  ];
  if (ceiling === 'M') channels.splice(2, 0, { id: 'sitcoms', number: 3, name: 'Sitcoms', now: { show: 'Our Solar System', art: '/art?src=show2' } });
  return {
    ceiling,
    viewers: [
      { id: 'sam', name: 'Sam', on: on('sam') },
      { id: 'jake', name: 'Jake', on: on('jake') },
      { id: 'mum', name: 'Mum', on: on('mum') },
      { id: 'dad', name: 'Dad', on: on('dad') },
    ],
    channels,
  };
}
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let homeQueries = [], diagnostics = [], nextRequests = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"ui-test"};' });
    if (url.pathname === '/api/diagnostics') { diagnostics.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/next') {
      const body = route.request().postDataJSON();
      nextRequests.push(body);
      return route.fulfill({ json: { src: body.channel + '.mp4', show: 'Bluey', title: 'Channel ' + body.channel, resume: 120, duration: 420, channels: [body.channel] } });
    }
    if (url.pathname === '/api/progress') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/home') {
      homeQueries.push(url.searchParams.get('viewers'));
      return route.fulfill({ json: homeFor(url.searchParams.has('viewers') ? url.searchParams.get('viewers') : null) });
    }
    if (url.pathname === '/art') {
      const colors = ['#184e77', '#386641', '#6a4c93', '#9c6644', '#007f5f', '#1d3557'];
      const n = +(url.searchParams.get('src') || '').replace('show', '') || 0;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${colors[n % colors.length]}"/><stop offset="1" stop-color="#080d18"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="900" cy="180" r="120" fill="white" opacity=".12"/></svg>` });
    }
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'home-dark.png') });
  assert.equal(await page.locator('h1, h2').count(), 0);
  assert.equal(await page.getByText('Continue Watching').count(), 0);
  assert.equal(await page.getByText('Browse shows').count(), 0);
  assert.equal(await page.getByText('Games', { exact: true }).count(), 1);
  assert.equal(await page.locator('#ceiling').textContent(), 'G');
  assert.equal(await page.locator('.viewer.on').count(), 4);
  assert.equal(await page.locator('.channel .now').first().getAttribute('title'), longShow);
  const tooSmall = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#home button, #home .num, #home .name, #home .now, #home .who, #ceiling, #clock')];
    return nodes.filter(el => el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 26).map(el => el.className + ' ' + getComputedStyle(el).fontSize);
  });
  assert.deepEqual(tooSmall, []);
  const card = await page.locator('.channel').first().boundingBox();
  assert.ok(Math.abs(card.width - 440) < 2 && Math.abs(card.height - 412) < 2, JSON.stringify(card));
  await assertViewport(page, { primary: [{ selector: '#home' }], controls: [{ selector: '.viewer.focused' }] });

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'home-light.png') });
  await page.keyboard.press('ArrowDown');
  await page.locator('.channel.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'home-light-focus.png') });
  await assertViewport(page, { primary: ['#home'], controls: [{ selector: '.channel.focused' }] });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  homeQueries = [];
  await page.keyboard.press('Enter');
  await page.locator('#ceiling', { hasText: 'PG' }).waitFor();
  assert.equal(homeQueries.at(-1), 'jake,mum,dad');
  assert.equal(await page.locator('#ceiling').textContent(), 'PG');
  assert.equal(await page.locator('.viewer').first().getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: path.join(out, 'home-dark-unticked.png') });

  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.ontoPlayer=function(){var h={},t=0,p=true; window.testMedia={finish:function(){(h.ended||function(){})();},tick:function(v){t=v;(h.time||function(){})();}};
    return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 1800},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true;(h.pause||function(){})();},stop:function(){p=true},seek:function(v){t=v}};};` }));
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  diagnostics = [];
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'play_request' && event.state === 'loading'));
  assert.match(await page.locator('#osd-channel').textContent(), /^1 Cartoons/);
  assert.equal(await page.locator('#osd-show').textContent(), 'Bluey');
  assert.equal(await page.locator('#osd-episode').textContent(), 'Channel cartoons');
  const hint = await page.locator('#osd-keys').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(hint >= 28, 'key hints ' + hint);
  await page.screenshot({ path: path.join(out, 'osd-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'osd-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.testMedia.tick(120));
  await page.waitForTimeout(50);
  assert.ok(!diagnostics.some(event => event.event === 'playing'));
  await page.evaluate(() => window.testMedia.tick(121));
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'playing' && event.position === 121));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'pause' && event.paused));
  nextRequests = [];
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(80);
  assert.equal(nextRequests.at(-1).channel, 'movies');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(80);
  assert.equal(nextRequests.at(-1).channel, 'cartoons');
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  await page.keyboard.press('2');
  await page.locator('#player:visible').waitFor();
  await page.waitForTimeout(80);
  assert.equal(nextRequests.at(-1).channel, 'movies', 'number key tunes that channel');
  await page.keyboard.press('Escape');
  var releaseFirst;
  await page.route('http://tv.test/api/next', async route => {
    var body = route.request().postDataJSON();
    if (body.channel === 'cartoons') await new Promise(resolve => { releaseFirst = resolve; });
    nextRequests.push(body);
    await route.fulfill({ json: { src: body.channel + '.mp4', show: 'Bluey', title: 'Channel ' + body.channel, resume: 0, duration: 420 } });
  });
  await page.keyboard.press('1');
  await page.waitForTimeout(50);
  await page.keyboard.press('2');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#osd-episode').textContent(), 'Channel movies');
  releaseFirst();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#osd-episode').textContent(), 'Channel movies');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: out, homeQueries: homeQueries.length }));
} finally { await browser.close(); }
