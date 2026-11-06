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
const longEpisode = 'Bluey — The Sign: A Very Long Holiday Special About the Creek and the Beach';
function libraryFixture() {
  const ep = (src, title, show, season, episode, resume, duration, art) => ({
    src, title, show, kind: 'episode', art, season, episode,
    positionSeconds: resume, durationSeconds: duration, completed: false, resume,
    updatedAt: '2026-11-05T12:00:00Z',
  });
  const film = (src, title, art, resume) => ({
    src, title, show: title, kind: 'film', art, season: null, episode: null,
    positionSeconds: resume, durationSeconds: 5400, completed: false, resume, updatedAt: '',
  });
  const bluey = [
    ep('bluey/s01e01.mp4', 'Bluey S01E01', 'Bluey', 1, 1, 0, 420, '/art?src=show0'),
    ep('bluey/s01e02.mp4', longEpisode, 'Bluey', 1, 2, 754, 1800, '/art?src=show0'),
    ep('bluey/s02e01.mp4', 'Bluey S02E01', 'Bluey', 2, 1, 0, 420, '/art?src=show1'),
  ];
  const hermit = [
    ep('hermit/s01e04.mp4', 'Hermitcraft S01E04 The Ocean Monument', 'Hermitcraft', 1, 4, 0, 2400, '/art?src=show2'),
  ];
  const cars = film('cars.mp4', 'Cars (2006)', '/art?src=show3', 240);
  const nemo = film('nemo.mp4', 'Finding Nemo', '/art?src=show4', 0);
  const show = (key, title, art, episodes, resume) => ({
    key, title, art, resume, positionSeconds: resume, durationSeconds: resume ? 1800 : 0, episodes,
  });
  return {
    ceiling: 'PG',
    upNext: [Object.assign({ upNext: true }, bluey[1]), hermit[0]],
    collections: [
      { key: 'family-films', title: 'Family films', items: [cars, nemo] },
      { key: 'grown-ups', title: 'Grown ups', items: [hermit[0]] },
    ],
    shows: [show('bluey', 'Bluey', '/art?src=show0', bluey, 754), show('hermit', 'Hermitcraft', '/art?src=show2', hermit, 0)],
    films: [cars, nemo],
    items: bluey.concat(hermit, [cars, nemo]),
  };
}
function homeFor(viewers, rating = null) {
  const ids = viewers == null ? ['sam', 'jake', 'mum', 'dad'] : String(viewers).split(',').filter(Boolean);
  const on = id => ids.includes(id);
  const defaultCeiling = on('sam') ? 'G' : on('jake') ? 'PG' : ids.length ? 'M' : null;
  const ceiling = defaultCeiling && rating ? rating : defaultCeiling;
  const pick = (show, i, extra = {}) => ({
    show, title: extra.title || show + ' episode', minutes: extra.minutes ?? 18,
    art: '/art?src=show' + i,
    next: extra.next || { show: 'Up next', title: 'Part two' },
  });
  const channels = [
    { id: 'cartoons', number: 1, name: 'Cartoons', now: pick(longShow, 0, { minutes: 12 }) },
    { id: 'movies', number: 2, name: 'Movies', now: pick('The Great Adventure', 1) },
    { id: 'music', number: 4, name: 'Music', now: pick('The Workshop', 3) },
    { id: 'christmas', number: 5, name: 'Christmas', now: pick('Wild Australia', 4) },
  ];
  if (ceiling === 'M') channels.splice(2, 0, { id: 'sitcoms', number: 3, name: 'Sitcoms', now: pick('Our Solar System', 2) });
  if (ceiling && ceiling !== 'G') channels.push({ id: 'rides', number: 19, name: 'Rides & Adventures', now: pick('Knight Rider (1982)', 5) });
  if (ceiling === 'M') channels.push(...['Comedy', 'Sport & Docs', 'Sci-Fi', 'Classics', '1950s', '1960s', '1970s', '1980s', '1990s', 'Sports', 'Hop Hop'].map((name, i) => ({ id: 'extra' + i, number: i + 8, name, now: pick(['The A-Team', 'Wild Australia', 'Airwolf'][i % 3], i) })));
  return {
    ceiling, defaultCeiling, rating: rating || null,
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
let homeQueries = [], homeRatings = [], diagnostics = [], nextRequests = [], artRequests = 0, artUnavailable = false;
let homeDelay = 0, failHome = false, serialFixture = false;
let sceneBody = { cuts: [0, 60, 180, 300], thumbs: [0, 1, 2, 3].map(n => '/art?src=show' + n), segments: [] };
function nextItem(body) {
  if (serialFixture) {
    const follow = body.peek || body.current;
    return follow
      ? { src: 'MobLand/MobLand S01E09.mp4', show: 'MobLand', title: 'MobLand S01E09 The Sign Is A Very Long Episode Title', resume: 0, duration: 1800 }
      : { src: 'MobLand/MobLand S01E08.mp4', show: 'MobLand', title: 'MobLand S01E08 Half', resume: 0, duration: 1800 };
  }
  return { src: body.channel + '.mp4', show: 'Bluey', title: 'Channel ' + body.channel, resume: body.resume === 0 ? 0 : 120, duration: 420, channels: [body.channel] };
}
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const h = new Date().getHours();
    localStorage.setItem('onto.viewers.band', h >= 20 || h < 5 ? 'night' : 'day');
    if (!localStorage.getItem('onto.viewers')) localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
    if (!localStorage.getItem('onto.profile')) localStorage.setItem('onto.profile', 'all');
  });
  async function pickProfile(page, id) {
    await page.locator('.profile-chip').click();
    await page.locator('#picker:visible').waitFor();
    await page.locator('#picker-people [data-profile="' + id + '"]').click();
    await page.waitForFunction(() => document.getElementById('picker').hidden);
  }
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"ui-test"};' });
    if (url.pathname === '/api/diagnostics') { diagnostics.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/next') {
      const body = route.request().postDataJSON();
      nextRequests.push(body);
      return route.fulfill({ json: nextItem(body) });
    }
    if (url.pathname === '/api/watch') return route.fulfill({ json: { accepted: true } });
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: sceneBody });
    if (url.pathname === '/api/progress') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/library') return route.fulfill({ json: libraryFixture() });
    if (url.pathname === '/api/home') {
      const viewers = url.searchParams.get('viewers');
      homeQueries.push(viewers);
      if (homeDelay) await new Promise(resolve => setTimeout(resolve, homeDelay));
      if (failHome) return route.fulfill({ status: 503, json: { error: 'fixture offline' } });
      homeRatings.push(url.searchParams.get('rating'));
      return route.fulfill({ json: homeFor(url.searchParams.has('viewers') ? viewers : null, url.searchParams.get('rating')) });
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
  const homeControls = () => page.evaluate(() => ({
    profile: document.querySelector('.profile-name')?.textContent,
    ratings: [...document.querySelectorAll('#viewers .seg-rating')].map(el =>
      el.getAttribute('data-rating') + (el.classList.contains('on') ? '*' : '') + (el.classList.contains('default') ? '^' : '')),
    layouts: [...document.querySelectorAll('#viewers .seg-layout')].map(el =>
      el.getAttribute('data-layout') + (el.classList.contains('on') ? '*' : '')),
    channelsClass: document.getElementById('channels').className,
  }));
  assert.deepEqual((await homeControls()).profile, 'Everyone');
  assert.deepEqual((await homeControls()).ratings, ['G*^', 'PG', 'M']);
  assert.deepEqual((await homeControls()).layouts, ['now*', 'guide', 'pictures']);
  assert.match((await homeControls()).channelsClass, /layout-now/);
  await page.locator('.seg[data-layout="guide"]').click();
  assert.match((await homeControls()).channelsClass, /layout-guide/);
  await page.locator('.seg[data-layout="now"]').click();
  assert.match((await homeControls()).channelsClass, /layout-now/);
  assert.equal(await page.locator('.channel .now').first().getAttribute('title'), longShow);
  const tooSmall = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#home button, #home .num, #home .name, #home .now, #home .profile-name, #home .hero-show, #home .hero-channel, #home .hero-length, #clock')];
    return nodes.filter(el => el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 28).map(el => el.className + ' ' + getComputedStyle(el).fontSize);
  });
  assert.deepEqual(tooSmall, []);
  const card = await page.locator('.channel').first().boundingBox();
  assert.ok(card.width > 280 && card.width < 300 && Math.abs(card.height - 212) < 2, 'six tiles a row at 1920: ' + JSON.stringify(card));
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.channel .name, .channel .now-title, .profile-name, .hero-show')]
    .filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent));
  assert.deepEqual(clipped, [], 'no clipped channel or control text');
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

  // Profile picker: Jake sets PG as the default rating.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.profile-chip.focused').waitFor();
  homeQueries = []; homeRatings = [];
  await pickProfile(page, 'jake');
  await page.locator('.seg.rate-pg.on').waitFor();
  assert.equal(homeQueries.at(-1), 'jake,mum,dad');
  assert.equal(homeRatings.at(-1), null);
  assert.deepEqual((await homeControls()).profile, 'Jake');
  assert.deepEqual((await homeControls()).ratings, ['G', 'PG*^', 'M']);
  assert.match((await homeControls()).channelsClass, /layout-pictures/);
  await page.screenshot({ path: path.join(out, 'home-dark-unticked.png') });
  assert.equal(await page.getByRole('button', { name: /19 Rides/ }).count(), 1);

  // The rating switch overrides the people's default, up or down, without a password.
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('.seg.rate-m.on').waitFor();
  assert.equal(homeQueries.at(-1), 'jake,mum,dad');
  assert.equal(homeRatings.at(-1), 'M');
  assert.deepEqual((await homeControls()).ratings, ['G', 'PG^', 'M*']);
  await page.screenshot({ path: path.join(out, 'home-override-dark.png') });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.locator('.seg.rate-pg.on').waitFor();
  assert.equal(homeRatings.at(-1), null, 'choosing the default clears the override');
  // A rating survives a reload until the audience changes.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('.seg.rate-m.on').waitFor();
  await page.goto('http://tv.test/');
  await page.locator('.seg.rate-m.on').waitFor();
  assert.equal(homeRatings.at(-1), 'M');

  // A rating pressed before the new audience's lineup arrives is still an override.
  homeDelay = 350;
  await pickProfile(page, 'sam');
  await page.locator('.seg[data-rating="M"]').click();
  homeDelay = 0;
  await page.locator('.seg.rate-m.on').waitFor();
  assert.equal(homeQueries.at(-1), 'sam,jake,mum,dad');
  assert.equal(homeRatings.at(-1), 'M');
  // Picking who's watching resets the rating to theirs.
  await pickProfile(page, 'ian');
  await page.locator('.seg.rate-m.on.default').waitFor();
  assert.equal(homeQueries.at(-1), 'dad');
  assert.equal(homeRatings.at(-1), null);
  await page.screenshot({ path: path.join(out, 'home-adults-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'home-adults-light.png') });
  await page.waitForFunction(() => [...document.querySelectorAll('.art')].every(img => img.complete && img.naturalWidth));

  // Restrict an adult lineup while the old response is delayed. A second
  // change must build from the requested viewers, and stale replies cannot win.
  homeDelay = 350;
  await pickProfile(page, 'sam');
  assert.equal(await page.locator('.channel:not([class*="app-"])').count(), 0);
  homeDelay = 0;
  await pickProfile(page, 'jake');
  await page.locator('.seg.rate-pg.on').waitFor();
  assert.equal(homeQueries.at(-1), 'jake,mum,dad');
  await page.waitForTimeout(400);
  assert.deepEqual((await homeControls()).profile, 'Jake');
  failHome = true;
  await pickProfile(page, 'sam');
  await page.locator('#status', { hasText: 'fixture offline' }).waitFor();
  assert.equal(await page.locator('.channel:not([class*="app-"])').count(), 0);
  failHome = false;
  await pickProfile(page, 'ian');
  await page.locator('.seg.rate-m.on').waitFor();
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

  const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
  const playerStub = `window.ontoPlayer=function(){var h={},t=0,p=true;window.testMedia={finish:function(){(h.ended||function(){})();},tick:function(v){t=v;(h.time||function(){})();},fail:function(){(h.error||function(){})();}};return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 1800},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true;(h.pause||function(){})();},stop:function(){p=true},seek:function(v){t=v},tracks:function(){return {audio:[{index:0,label:'Eng'},{index:1,label:'Commentary'}],text:[{index:0,label:'English'}]}},selectAudio:function(){},selectText:function(){}};};`;
  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + playerStub }));
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
  await page.locator('#resume-choice:visible').waitFor();
  await page.waitForFunction(() => document.getElementById('tune-flash').hidden);
  assert.equal(await page.locator('#resume-play').textContent(), 'Resume 2:00');
  assert.equal(await page.locator('#resume-start').textContent(), 'Start over');
  assert.match(await page.locator('#resume-play').getAttribute('class') || '', /focused/);
  await page.screenshot({ path: path.join(out, 'resume-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'resume-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('resume-choice').hidden);
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'play_request' && event.state === 'loading'));
  assert.match(await page.locator('#osd-channel').textContent(), /^1 Cartoons/);
  assert.equal(await page.locator('#osd-show').textContent(), 'Bluey');
  assert.equal(await page.locator('#osd-episode').textContent(), '');
  const hint = await page.locator('#osd-keys').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(hint >= 28, 'key hints ' + hint);
  assert.equal(await page.locator('#osd-cc').isHidden(), false);
  assert.equal(await page.locator('#osd-cc-value').textContent(), 'Off');
  assert.equal(await page.locator('#osd-audio-value').textContent(), 'Eng');
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
    if (serialFixture) {
      nextRequests.push(body);
      await route.fulfill({ json: nextItem(body) });
      return;
    }
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
  await page.evaluate(() => {
    localStorage.setItem('onto.profile', 'all');
    localStorage.setItem('onto.viewers', 'sam,jake,mum,dad');
    localStorage.removeItem('onto.rating');
    localStorage.setItem('onto.layouts', JSON.stringify({ all: 'now' }));
  });
  await page.goto('http://tv.test/');
  await page.locator('.profile-chip.focused').waitFor();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  serialFixture = true;
  sceneBody = {
    cuts: [0, 40, 800],
    thumbs: [0, 1, 2, 3].map(n => '/art?src=show' + n),
    segments: [{ start: 0, end: 40, kind: 'intro' }, { start: 1700, end: 1800, kind: 'credits' }],
  };
  await page.keyboard.press('2');
  await page.locator('#player:visible').waitFor();
  await page.waitForTimeout(1400);
  await page.evaluate(() => window.testMedia.tick(12));
  await page.locator('#skip-intro:visible').waitFor();
  assert.equal((await page.locator('#skip-intro').innerText()).replace(/\s+/g, ' ').trim(), 'Skip intro');
  await page.screenshot({ path: path.join(out, 'skip-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'skip-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.testMedia.tick(80));
  await page.waitForFunction(() => document.getElementById('skip-intro').hidden);
  await page.keyboard.press('ArrowRight');
  await page.locator('#osd-elapsed.is-preview').waitFor();
  await page.screenshot({ path: path.join(out, 'osd-seek-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('ArrowRight');
  await page.locator('#osd-elapsed.is-preview').waitFor();
  await page.screenshot({ path: path.join(out, 'osd-seek-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.testMedia.tick(1792));
  await page.locator('#up-next:visible').waitFor();
  assert.match(await page.locator('#up-next-label').innerText(), /^Next · S1E9 · The Sign Is A Very Long Episode Title$/);
  assert.equal(await page.locator('#up-next-count').textContent(), '10');
  const wrapped = await page.locator('#up-next-label').evaluate(el => ({
    ok: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 2,
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
  }));
  assert.equal(wrapped.ok, true, 'up-next title is clipped ' + JSON.stringify(wrapped));
  const smallPlayer = await page.evaluate(() => [...document.querySelectorAll('#up-next-play, #up-next-label, #up-next-count, #resume-play, #play-retry, #play-error-next, #osd-cc, #osd-audio, #skip-intro')]
    .filter(el => !el.hidden && el.getClientRects().length && parseFloat(getComputedStyle(el).fontSize) < 28)
    .map(el => el.id + ' ' + getComputedStyle(el).fontSize));
  assert.deepEqual(smallPlayer, []);
  await page.screenshot({ path: path.join(out, 'up-next-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'up-next-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.testMedia.fail());
  await page.locator('#play-error:visible').waitFor();
  assert.equal(await page.locator('#play-retry').textContent(), 'Retry');
  assert.equal(await page.locator('#play-error-next').textContent(), 'next in 5s');
  await page.screenshot({ path: path.join(out, 'error-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(out, 'error-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  serialFixture = false;
  sceneBody = { cuts: [0, 60, 180, 300], thumbs: [0, 1, 2, 3].map(n => '/art?src=show' + n), segments: [] };
  for (const [width, height] of [[1280,720], [960,540], [390,844], [844,390]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await assertViewport(page, { primary: ['#home'], controls: ['.channel.focused'] });
    await page.screenshot({ path: path.join(out, 'home-' + width + 'x' + height + '.png') });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.locator('.channel.app-library').waitFor();
  const polish = fileURLToPath(new URL('../audit/tv-polish/library/', import.meta.url));
  await mkdir(polish, { recursive: true });
  await page.locator('.channel.app-library').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(polish, 'library-card-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(polish, 'library-card-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.channel.app-library').click();
  await page.locator('#library:visible .lib-card').first().waitFor();
  await page.evaluate(async () => { if (document.fonts) await document.fonts.ready; });
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#library .lib-art')];
    return imgs.length > 0 && imgs.every(img => img.complete && img.naturalWidth);
  });
  const libraryArt = () => page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#library .lib-art')];
    return imgs.length === 0 || imgs.every(img => img.complete && img.naturalWidth);
  });
  const libraryFit = () => page.evaluate(() => {
    const text = [...document.querySelectorAll('#library .lib-title, #library .lib-ep-title, #library .lib-strip-name, #library .lib-q, #library .lib-mode')];
    const clipped = text.filter(el => el.textContent.trim() && (el.scrollWidth > el.clientWidth + 4 || el.scrollHeight > el.clientHeight + 4)).map(el => {
      const style = getComputedStyle(el);
      return el.textContent.slice(0, 48) + ' ' + el.scrollWidth + '/' + el.clientWidth + ' ' + el.scrollHeight + '/' + el.clientHeight + ' ' + style.whiteSpace + ' ' + style.display;
    });
    const small = [...document.querySelectorAll('#library button, #library .lib-title, #library .lib-time, #library .lib-strip-name, #library .lib-ep-title, #library .lib-q')]
      .filter(el => el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 28)
      .map(el => el.className + ' ' + getComputedStyle(el).fontSize);
    const focus = document.querySelector('#library .focused');
    const ring = focus ? getComputedStyle(focus).borderTopColor : '';
    return { clipped, small, ring, focus: focus ? focus.textContent : '' };
  });
  await page.screenshot({ path: path.join(polish, 'library-home-dark.png') });
  let fit = await libraryFit();
  assert.deepEqual(fit.clipped, [], 'library text is clipped');
  assert.deepEqual(fit.small, [], 'library text under 28px');
  assert.equal(fit.ring, 'rgb(255, 181, 71)');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(polish, 'library-home-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: path.join(polish, 'library-home-row3-dark.png') });
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('#library .lib-card', { hasText: 'Bluey' }).first().waitFor();
  await libraryArt();
  fit = await libraryFit();
  assert.deepEqual(fit.clipped, [], 'shows text is clipped');
  await page.screenshot({ path: path.join(polish, 'library-shows-dark.png') });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await page.locator('#library .lib-ep', { hasText: longEpisode }).waitFor();
  fit = await libraryFit();
  assert.deepEqual(fit.clipped, [], 'episode text is clipped');
  assert.deepEqual(fit.small, []);
  await page.screenshot({ path: path.join(polish, 'library-episodes-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(polish, 'library-episodes-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape');
  await page.locator('#library .lib-mode.on', { hasText: 'Shows' }).waitFor();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('#library .lib-key.focused', { hasText: 'A' }).waitFor();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.locator('#library .lib-q', { hasText: 'B' }).waitFor();
  await page.locator('#library .lib-results .lib-ep', { hasText: 'Bluey' }).first().waitFor();
  await libraryArt();
  fit = await libraryFit();
  assert.deepEqual(fit.clipped, [], 'search text is clipped');
  assert.deepEqual(fit.small, []);
  await page.screenshot({ path: path.join(polish, 'library-search-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(polish, 'library-search-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('library').hidden);
  await page.locator('.channel.app-library').click();
  await page.locator('#library:visible .lib-card').first().waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  assert.match(await page.locator('#osd-show').textContent(), /Bluey/);
  await page.keyboard.press('Escape');
  await page.locator('#library:visible').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  await page.keyboard.press('2');
  await page.locator('#player:visible').waitFor();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(750);
  await page.keyboard.up('Enter');
  await page.locator('#options:visible [data-opt="library"]').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.locator('#options .opt.focused[data-opt="library"]').waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(polish, 'library-options-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: path.join(polish, 'library-options-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Enter');
  await page.locator('#library:visible').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#player:visible').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: out, homeQueries: homeQueries.length, shots: ['home-everyone-dark.png', 'home-everyone-light.png', 'home-adults-dark.png', 'home-adults-light.png', 'home-focus-dark.png', 'home-focus-light.png', 'osd-dark.png', 'osd-light.png', 'osd-seek-dark.png', 'osd-seek-light.png', 'options-dark.png', 'options-light.png', 'chips-dark.png', 'chips-light.png', 'resume-dark.png', 'resume-light.png', 'up-next-dark.png', 'up-next-light.png', 'skip-dark.png', 'skip-light.png', 'error-dark.png', 'error-light.png', 'setup-dark.png', 'setup-light.png'] }));
} finally { await browser.close(); }
