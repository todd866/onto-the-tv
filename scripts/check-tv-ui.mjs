// Headless UI regression with a synthetic library; never connects to the real TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { assertViewport } = await import(process.env.VIEWPORT_MODULE || new URL('./lib/viewport-fit.mjs', import.meta.url).href);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/private/tmp/onto-tv-ui';
await mkdir(out, { recursive: true });
const longShow = 'Bluey — The Sign';
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
  if (ceiling && ceiling !== 'G') channels.push({ id: 'rides', number: 19, name: 'Rides & Adventures', now: { show: 'Knight Rider (1982)', art: '/art?src=show5' } });
  if (ceiling === 'M') channels.push(...['Comedy', 'Sport & Docs', 'Sci-Fi', 'Classics', '1950s', '1960s', '1970s', '1980s', '1990s', 'Sports', 'Hop Hop'].map((name, i) => ({ id: 'extra' + i, number: i + 8, name, now: { show: ['The A-Team', 'Wild Australia', 'Airwolf'][i % 3], art: '/art?src=show' + i } })));
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
let homeQueries = [], diagnostics = [], nextRequests = [], artRequests = 0, artUnavailable = false;
let homeDelay = 0, failHome = false;
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const h = new Date().getHours();
    localStorage.setItem('onto.viewers.band', h >= 20 || h < 5 ? 'night' : 'day');
    if (!localStorage.getItem('onto.viewers')) localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
  });
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
    if (url.pathname === '/api/watch') return route.fulfill({ json: { accepted: true } });
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [0, 60, 180, 300], thumbs: [0,1,2,3].map(n => '/art?src=show' + n), segments: [] } });
    if (url.pathname === '/api/progress') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/home') {
      const viewers = url.searchParams.get('viewers');
      homeQueries.push(viewers);
      if (homeDelay) await new Promise(resolve => setTimeout(resolve, homeDelay));
      if (failHome) return route.fulfill({ status: 503, json: { error: 'fixture offline' } });
      return route.fulfill({ json: homeFor(url.searchParams.has('viewers') ? viewers : null) });
    }
    if (url.pathname === '/art') {
      artRequests++;
      if (artUnavailable) return route.abort();
      await new Promise(resolve => setTimeout(resolve, 60));
      const colors = ['#184e77', '#386641', '#6a4c93', '#9c6644', '#007f5f', '#1d3557'];
      const n = +(url.searchParams.get('src') || '').replace('show', '') || 0;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${colors[n % colors.length]}"/><stop offset="1" stop-color="#080d18"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="900" cy="180" r="120" fill="white" opacity=".12"/></svg>` });
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff') ? 'font/woff' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  assert.equal(await page.evaluate(() => document.fonts.check('700 44px Nunito') && document.fonts.check('800 44px Nunito')), true, 'Nunito woff did not load');
  await page.waitForFunction(() => [...document.querySelectorAll('.art')].every(img => img.complete && img.naturalWidth));
  await page.screenshot({ path: path.join(out, 'home-dark.png') });
  await page.screenshot({ path: path.join(out, 'home-everyone-dark.png') });
  assert.equal(await page.locator('h1, h2').count(), 0);
  assert.equal(await page.getByText('Continue Watching').count(), 0);
  assert.equal(await page.getByText('Browse shows').count(), 0);
  assert.equal(await page.getByText('Games', { exact: true }).count(), 1);
  assert.equal(await page.locator('#ceiling').textContent(), 'G');
  assert.equal(await page.locator('.viewer.on').count(), 4);
  assert.equal(await page.locator('.channel .now').first().getAttribute('title'), longShow);
  const tooSmall = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#home button, #home .num, #home .name, #home .now, #home .who, #ceiling, #clock')];
    return nodes.filter(el => el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 28).map(el => el.className + ' ' + getComputedStyle(el).fontSize);
  });
  assert.deepEqual(tooSmall, []);
  const card = await page.locator('.channel').first().boundingBox();
  assert.ok(Math.abs(card.width - 440) < 2 && Math.abs(card.height - 330) < 2, JSON.stringify(card));
  await assertViewport(page, { primary: [{ selector: '#home' }], controls: [{ selector: '.viewer.focused' }] });
  await page.keyboard.press('ArrowDown');
  await page.locator('.channel.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'home-focus-dark.png') });

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'home-light.png') });
  await page.screenshot({ path: path.join(out, 'home-everyone-light.png') });
  await page.keyboard.press('ArrowDown');
  await page.locator('.channel.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'home-light-focus.png') });
  await page.screenshot({ path: path.join(out, 'home-focus-light.png') });
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
  assert.equal(await page.getByRole('button', { name: /19 Rides/ }).count(), 1);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, 'home-rides-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'home-rides-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('#ceiling', { hasText: 'M' }).waitFor();
  assert.equal(await page.locator('.viewer.on').count(), 2);
  await page.screenshot({ path: path.join(out, 'home-adults-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'home-adults-light.png') });
  await page.waitForFunction(() => [...document.querySelectorAll('.art')].every(img => img.complete && img.naturalWidth));

  // Restrict an adult lineup while the old response is delayed. A second
  // change must build from the requested viewers, and stale replies cannot win.
  homeDelay = 350;
  await page.locator('.viewer').first().click(); // Sam on: G
  assert.equal(await page.locator('.channel:not([class*="app-"])').count(), 0);
  assert.equal(await page.locator('#ceiling').getAttribute('hidden'), '');
  homeDelay = 0;
  await page.locator('.viewer').nth(1).click(); // Jake on too
  await page.locator('#ceiling', { hasText: 'G' }).waitFor();
  assert.equal(homeQueries.at(-1), 'sam,jake,mum,dad');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.viewer.on').count(), 4);
  assert.equal(await page.locator('#ceiling').textContent(), 'G');
  failHome = true;
  await page.locator('.viewer').first().click();
  await page.locator('#status', { hasText: 'fixture offline' }).waitFor();
  assert.equal(await page.locator('.channel:not([class*="app-"])').count(), 0);
  failHome = false;
  await page.locator('.viewer').nth(1).click();
  await page.locator('#ceiling', { hasText: 'M' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.art')].every(img => img.complete && img.naturalWidth));

  const preparedRequests = artRequests;
  artUnavailable = true;
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  await assertViewport(page, { primary: ['#home'], controls: ['.channel.focused', '#viewers'] });
  await page.screenshot({ path: path.join(out, 'home-last-row-light.png') });
  assert.equal(artRequests, preparedRequests, 'prepared channel navigation makes no artwork requests');
  artUnavailable = false;
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.ontoPlayer=function(){var h={},t=0,p=true; window.testMedia={finish:function(){(h.ended||function(){})();},tick:function(v){t=v;(h.time||function(){})();}};
    return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 1800},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true;(h.pause||function(){})();},stop:function(){p=true},seek:function(v){t=v}};};` }));
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  await page.keyboard.press('1');
  await page.keyboard.press('9');
  await page.locator('#player:visible').waitFor();
  assert.equal(nextRequests.at(-1).channel, 'rides');
  await page.keyboard.press('Escape');
  diagnostics = [];
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'play_request' && event.state === 'loading'));
  assert.match(await page.locator('#osd-channel').textContent(), /^1 Cartoons/);
  assert.equal(await page.locator('#osd-show').textContent(), 'Bluey');
  assert.equal(await page.locator('#osd-episode').textContent(), '');
  const hint = await page.locator('#osd-keys').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(hint >= 28, 'key hints ' + hint);
  await page.waitForFunction(() => document.getElementById('tune-flash').hidden && !document.getElementById('tune-num').hidden);
  assert.equal(await page.locator('#tune-digits').textContent(), '1');
  await page.screenshot({ path: path.join(out, 'osd-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'osd-light.png') });
  await page.evaluate(() => {
    document.getElementById('ad-label').textContent = 'Ad 2/3';
    document.getElementById('ad-chip').hidden = false;
    document.getElementById('skip-intro').hidden = false;
  });
  await page.screenshot({ path: path.join(out, 'chips-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(out, 'chips-dark.png') });
  await page.evaluate(() => {
    document.getElementById('ad-chip').hidden = true;
    document.getElementById('skip-intro').hidden = true;
  });
  await page.locator('#osd-next-scene').click();
  await page.locator('#jump-strip:visible').waitFor();
  await page.screenshot({ path: path.join(out, 'scenes-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'scenes-light.png') });
  await page.waitForTimeout(1800);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.down('Enter');
  await page.waitForTimeout(750);
  await page.keyboard.up('Enter');
  await page.locator('#options:visible').waitFor();
  await page.screenshot({ path: path.join(out, 'options-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'options-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('options').hidden);
  await page.locator('#osd-play').click();
  assert.equal(await page.locator('#osd-play').getAttribute('aria-label'), 'Play');
  await page.locator('#osd-play').click();
  assert.equal(await page.locator('#osd-play').getAttribute('aria-label'), 'Pause');
  await page.waitForTimeout(1300); // the player ignores time updates for 1.2 s after a load or seek
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
  await page.waitForTimeout(1300);
  await page.keyboard.press('2');
  await page.waitForTimeout(1400);
  assert.equal(await page.locator('#osd-show').getAttribute('title'), 'Channel movies');
  assert.equal(await page.locator('#tune-digits').textContent(), '2');
  releaseFirst();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#osd-show').getAttribute('title'), 'Channel movies');
  await page.evaluate(() => {
    document.getElementById('player').hidden = true;
    document.getElementById('tune-num').hidden = true;
    document.getElementById('tune-flash').hidden = true;
    const setup = document.getElementById('setup');
    setup.hidden = false;
    document.getElementById('setup-address').value = '192.168.1.30:8686';
    document.getElementById('setup-message').textContent = 'No answer from http://192.168.1.30:8686';
  });
  await page.screenshot({ path: path.join(out, 'setup-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'setup-light.png') });
  await page.evaluate(() => { document.getElementById('setup').hidden = true; });
  await page.keyboard.press('Escape');
  await page.goto('http://tv.test/');
  await page.locator('.viewer.focused').waitFor();
  for (const [width, height] of [[1280,720], [960,540], [390,844], [844,390]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await assertViewport(page, { primary: ['#home'], controls: ['.channel.focused'] });
    await page.screenshot({ path: path.join(out, 'home-' + width + 'x' + height + '.png') });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: out, homeQueries: homeQueries.length, shots: ['home-everyone-dark.png', 'home-everyone-light.png', 'home-adults-dark.png', 'home-adults-light.png', 'home-focus-dark.png', 'home-focus-light.png', 'osd-dark.png', 'osd-light.png', 'options-dark.png', 'options-light.png', 'chips-dark.png', 'chips-light.png', 'setup-dark.png', 'setup-light.png'] }));
} finally { await browser.close(); }
