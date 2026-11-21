// Headless render of the playback overlay. Never contacts the TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
// TV_UI_ROOT points the same check at a packaged build (tizen/build/app) instead of the source folder.
const root = process.env.TV_UI_ROOT ? path.resolve(process.env.TV_UI_ROOT) + path.sep : fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/tmp/onto-tv-control-overlay';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  let nextCalls = 0, prefetchCalls = 0;
  const likeCalls = [];
  const directionCalls = [];
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
    if (url.pathname === '/api/next') {
      let peek = false;
      try { peek = !!(route.request().postDataJSON() || {}).prefetch; } catch {}
      if (!peek) nextCalls++;
      if (peek) { prefetchCalls++; return route.fulfill({ json: { src: 'Kids/PrefetchNext.mp4', show: 'PrefetchFld', display: { show: 'Up Next Show', episode: 'Warm part' }, title: 'Prefetch title', resume: 0, duration: 420 } }); }
      return route.fulfill({ json: { src: 'Kids/Bluey.mp4', show: 'Bluey', title: 'The Sign', resume: 0, duration: 420 } });
    }
    if (url.pathname === '/api/directions') {
      const tile = (kind, label, src, title, n, channel) => ({ kind, label, src, title, show: label, duration: 600, resume: 0, art: '/art?src=show' + n, channel: channel || { id: 'cartoons', number: 1, name: 'Cartoons' } });
      return route.fulfill({ json: { channel: 'cartoons', from: 'Kids/Bluey.mp4', tiles: [
        tile('more', 'Bluey', 'Kids/Bluey 2.mp4', 'Sleepytime', 3),
        tile('new', 'New to you', 'Kids/Hey Duggee.mp4', 'The Stick Badge', 1),
        tile('favourite', 'Favourite', 'Kids/Timmy Time Christmas Surprise.mp4', 'Timmy Time: Christmas Surprise', 0),
        tile('long', 'Long set', 'music/Cercle/Bonobo.mp4', 'Bonobo Solo live at Cercle Odyssey, Paris, France, recorded under the dome at night', 2),
        tile('elsewhere', 'Music', 'music/Common.mp4', 'Common, Pete Rock - All Kind Of Ideas', 1, { id: 'music', number: 4, name: 'Music' }),
      ] } });
    }
    if (url.pathname === '/api/direction-choice') { directionCalls.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/like') { let want = false; try { want = !!(route.request().postDataJSON() || {}).liked; } catch {} likeCalls.push(route.request().method() + ':' + want); return route.fulfill({ json: { src: 'Kids/Bluey.mp4', liked: want } }); }
    if (url.pathname === '/api/subs') return route.fulfill({ json: { tracks: [] } });
    if (url.pathname === '/api/scenes') return route.fulfill({ json: { cuts: [], thumbs: [], segments: [] } });
    if (url.pathname === '/api/home') {
      return route.fulfill({ json: {
        ceiling: 'G', defaultCeiling: 'G', rating: null,
        liked: [{ src: 'music/Cercle/Bonobo.mp4', title: 'Bonobo Solo live at Cercle Odyssey, Paris, France', show: 'Cercle', resume: 1470, duration: 5009, channel: { id: 'music', number: 9, name: 'Music' } }],
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
  // Test-only access to lifecycle state; the shipped app has no test API.
  const appSource = await readFile(path.join(root, 'app.js'), 'utf8');
  await page.route('http://tv.test/app.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: appSource.replace('  // ---------- keys ----------', `
      window.overlayTest = {
        load: function () { var item = JSON.parse(JSON.stringify(play.item)); item.resume = 0; load(item, true); },
        arm: function () { upNextCard.reset(); showUpNext('Next episode'); },
        time: function (t) { if (t != null) media.seek(t); return media.time(); },
        tick: upNextTick,
        close: closeOverlay,
        state: function () { return { focus: overlayFocus, timer: osdTimer, upNext: upNextCard.active(),
          hold: arrowHoldRepeats, delta: seekCtrl.delta(), seeking: !!scrub }; }
      };
      // ---------- keys ----------
    `)
  }));
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
  await page.locator('#channels .channel').first().waitFor({ timeout: 10000 });
  const homeResumeTile = page.locator('#resume-row .resume, #channels .channel[aria-label^="Continue"], #channels .channel[aria-label^="Liked"]');
  await homeResumeTile.first().waitFor({ timeout: 10000 });
  await page.locator('#channels .channel[aria-label^="Liked"], #resume-row .resume.liked').first().waitFor({ timeout: 10000 });
  // Home: what was liked sits in the row after what is half-watched (resume row, or the now-layout page).
  const homeRow = await page.evaluate(() => {
    const read = tile => {
      const label = tile.getAttribute('aria-label') || '';
      const liked = tile.classList.contains('liked') || /^Liked:/.test(label);
      const at = tile.querySelector('.resume-at');
      const line1 = tile.querySelector('.now-card-line1');
      return { liked, label, line: at ? at.textContent : (line1 ? line1.textContent.trim() : ''), right: tile.getBoundingClientRect().right };
    };
    const home = document.getElementById('home');
    const now = home && home.classList.contains('home-now');
    const tiles = now
      ? [...document.querySelectorAll('#channels .channel')].filter(b => /^(Continue|Liked):/.test(b.getAttribute('aria-label') || ''))
      : [...document.querySelectorAll('#resume-row .resume')];
    return tiles.map(read);
  });
  await fire(40); await fire(39);   // down to the row, right to the liked tile
  const likedHero = await page.evaluate(() => {
    const focused = document.querySelector('#resume-row .resume.focused') || document.querySelector('#channels .channel.focused');
    const label = focused ? (focused.getAttribute('aria-label') || '') : '';
    const liked = focused ? (focused.classList.contains('liked') || /^Liked:/.test(label)) : null;
    return { focused: liked, hero: document.getElementById('hero').textContent };
  });
  await shot('home-liked-dark.png', 'dark');
  await fire(37); await fire(38);
  // INFO on the home page: the remote, with the keys home uses.
  await fire(457);
  const homeGuide = await page.evaluate(() => ({ open: !document.getElementById('remote-guide').hidden, calls: [...document.querySelectorAll('#remote-guide .rg-word')].map(node => node.textContent) }));
  await shot('guide-home-dark.png', 'dark');
  await fire(457);
  const prefetchDone = page.waitForResponse(async r => {
    if (!r.url().includes('/api/next')) return false;
    try {
      return !!(r.request().postDataJSON() || {}).prefetch;
    } catch { return false; }
  });
  await fire(49);
  await page.locator('#player:visible').waitFor();
  await page.locator('#osd-show').waitFor();
  const before = (await page.locator('#osd-show').textContent() || '').trim();
  // Prefetch: after a moment the next title is known; a skip must show it within 100 ms.
  await prefetchDone;
  await page.waitForTimeout(80);
  const prefetchSkipTiming = await page.evaluate(() => {
    const stamp = Date.now();
    function dispatch(code) {
      const down = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(down, 'keyCode', { get: () => code });
      Object.defineProperty(down, 'repeat', { get: () => false });
      document.dispatchEvent(down);
      const up = new Event('keyup', { bubbles: true, cancelable: true });
      Object.defineProperty(up, 'keyCode', { get: () => code });
      document.dispatchEvent(up);
    }
    dispatch(406);
    return { ms: Date.now() - stamp, show: document.getElementById('osd-show').textContent.trim() };
  });
  // Back chip: only while the OSD is up.
  await fire(39);
  const backWithOsd = await page.evaluate(() => ({
    osd: !document.getElementById('osd').classList.contains('hidden'),
    chip: !document.getElementById('back-chip').hidden,
  }));
  await page.waitForTimeout(4500);
  const backAfterOsd = await page.evaluate(() => ({
    osd: !document.getElementById('osd').classList.contains('hidden'),
    chip: !document.getElementById('back-chip').hidden,
  }));
  const state = () => page.evaluate(() => ({
    hidden: document.getElementById('osd').classList.contains('hidden'),
    play: document.getElementById('osd-play').classList.contains('focused'),
    next: document.getElementById('osd-next').classList.contains('focused'),
    seeking: document.getElementById('player').classList.contains('is-seeking'),
    seekTime: document.getElementById('osd-seek-time').textContent,
    guide: !document.getElementById('remote-guide').hidden,
    strip: !document.getElementById('continue-strip').hidden,
    elapsed: document.getElementById('osd-elapsed').textContent.trim(),
    show: document.getElementById('osd-show').textContent.trim(),
    like: document.getElementById('osd-like').classList.contains('focused'),
    liked: document.getElementById('osd-like').classList.contains('is-liked'),
    paused: document.getElementById('osd-play').classList.contains('is-paused'),
  }));
  // Watching: Right tap-seeks with Netflix burst steps; the picture keeps playing.
  await page.evaluate(() => document.getElementById('osd').classList.add('hidden'));
  let calls = nextCalls;
  const arrowBurst = await page.evaluate(() => new Promise(resolve => {
    function pulse(code) {
      const down = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(down, 'keyCode', { get: () => code });
      Object.defineProperty(down, 'repeat', { get: () => false });
      document.dispatchEvent(down);
      const up = new Event('keyup', { bubbles: true, cancelable: true });
      Object.defineProperty(up, 'keyCode', { get: () => code });
      document.dispatchEvent(up);
    }
    let t0 = performance.now();
    pulse(39);
    const one = {
      ms: performance.now() - t0,
      bubble: document.getElementById('osd-seek-time').textContent,
      paused: document.getElementById('osd-play').classList.contains('is-paused'),
      elapsed: document.getElementById('osd-elapsed').textContent.trim(),
    };
    const t1 = performance.now();
    pulse(39);
    const two = {
      ms: performance.now() - t1,
      bubble: document.getElementById('osd-seek-time').textContent,
      elapsed: document.getElementById('osd-elapsed').textContent.trim(),
    };
    pulse(39);
    const three = {
      bubble: document.getElementById('osd-seek-time').textContent,
      elapsed: document.getElementById('osd-elapsed').textContent.trim(),
    };
    setTimeout(function () {
      pulse(39);
      const afterGap = {
        bubble: document.getElementById('osd-seek-time').textContent,
        elapsed: document.getElementById('osd-elapsed').textContent.trim(),
      };
      pulse(37);
      resolve({
        one, two, three, afterGap,
        left: {
          bubble: document.getElementById('osd-seek-time').textContent,
          elapsed: document.getElementById('osd-elapsed').textContent.trim(),
        },
      });
    }, 2000);
  }));
  const oneRight = { ...(await state()), calls: nextCalls - calls };
  // OK pauses and opens the controls on play/pause.
  await fire(13);
  const shown = await state();
  // Inside the controls the arrows navigate: Right to Next, OK skips, OK again skips again.
  await fire(39);
  calls = nextCalls;
  await fire(13);
  await page.waitForTimeout(700);
  await fire(13);
  await page.waitForTimeout(700);
  const skipped = { ...(await state()), calls: nextCalls - calls };
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
  // Like: one step right of Next. OK fills the heart in the same frame; the green key takes it back from anywhere.
  await fire(39);
  const onLike = await state();
  await fire(13);
  const likedNow = await state();
  await shot('like-dark.png', 'dark');
  await shot('like-light.png', 'light');
  await fire(404);
  const unliked = await state();
  await fire(404);
  const reliked = await state();
  await page.waitForTimeout(100);
  await fire(37);
  // Seek mode: the forward key holds the picture and moves a marker; nothing is skipped and no arrow seeks.
  const beforeSeek = await state();
  calls = nextCalls;
  // Same sync stopwatch as arrowBurst above: the handler must leave the bubble painted before it returns.
  const seekPressTiming = await page.evaluate(() => {
    function down() {
      const e = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => 417 });
      Object.defineProperty(e, 'repeat', { get: () => false });
      document.dispatchEvent(e);
    }
    function up() {
      const e = new Event('keyup', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => 417 });
      document.dispatchEvent(e);
    }
    const t0 = performance.now();
    down();
    const firstMs = performance.now() - t0;
    const firstDelta = document.getElementById('osd-seek-time').textContent;
    up();
    const t1 = performance.now();
    down();
    const secondMs = performance.now() - t1;
    const secondDelta = document.getElementById('osd-seek-time').textContent;
    up();
    return { ms: firstMs, delta: firstDelta, secondMs, secondDelta };
  });
  const seeking = { ...(await state()), calls: nextCalls - calls };
  await fire(39);   // an arrow in seek mode does nothing
  await fire(37);
  const seekArrow = await state();
  await shot('seek-dark.png', 'dark');
  await shot('seek-light.png', 'light');
  await fire(13);   // OK goes there
  const sought = await state();
  await fire(412);  // back 10 s, then OK commits it (Back now always goes to the main menu)
  const seekingBack = await state();
  await fire(13);
  const cancelled = await state();
  const holdGrowth = await page.evaluate(() => new Promise(resolve => {
    let repeats = 0;
    function down(repeat) {
      const e = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => 417 });
      // Tizen may omit repeat even throughout a hold.
      document.dispatchEvent(e);
    }
    function up() {
      const e = new Event('keyup', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { get: () => 417 });
      document.dispatchEvent(e);
    }
    down(false);
    const start = document.getElementById('osd-elapsed').textContent.trim();
    const tick = setInterval(function () {
      repeats += 1;
      down(true);
      if (repeats >= 5) {
        clearInterval(tick);
        up();
        resolve({
          start,
          end: document.getElementById('osd-elapsed').textContent.trim(),
          bubble: document.getElementById('osd-seek-time').textContent,
          seeking: document.getElementById('player').classList.contains('is-seeking'),
        });
      }
    }, 35);
  }));
  await fire(13);   // commit the held seek (Back would leave for the main menu)
  // INFO: the drawing of the remote; the keys still work under it and INFO puts it away.
  await fire(457);
  const guideOpen = await state();
  const guide = await page.evaluate(() => {
    const box = document.getElementById('remote-guide').getBoundingClientRect();
    const texts = [...document.querySelectorAll('#remote-guide .rg-word')].map(node => { const r = node.getBoundingClientRect(); return { text: node.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const overlaps = [];
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(a.text + ' / ' + b.text);
    }
    return {
      lit: [...document.querySelectorAll('#remote-guide .rg-key.on')].map(node => node.getAttribute('data-key')),
      calls: texts.map(item => item.text),
      clipped: texts.filter(item => item.left < box.left + 4 || item.right > box.right - 4).map(item => item.text),
      overlaps, fits: box.top >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
    };
  });
  await shot('guide-dark.png', 'dark');
  await shot('guide-light.png', 'light');
  await fire(457);
  const guideShut = await state();
  await fire(38);   // an arrow shows the controls
  await fire(38);   // Up from the transport row: the Continue strip, drawn above the bar
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
  // Down while watching: tiles of where the channel could go. Nothing changes until OK; closing it is recorded too.
  await page.waitForTimeout(900);
  // A plain picture without Back (which now leaves for the main menu): let go of CH+, then Down past the strip and bar.
  await page.evaluate(() => { const e = new Event('keyup', { bubbles: true, cancelable: true }); Object.defineProperty(e, 'keyCode', { get: () => 427 }); document.dispatchEvent(e); });
  await page.waitForTimeout(900);
  for (let i = 0; i < 4 && await page.evaluate(() => !document.getElementById('continue-strip').hidden || !document.getElementById('osd').classList.contains('hidden')); i++) {
    await fire(40); await page.waitForTimeout(150);
  }
  await page.waitForTimeout(4500); // the controls time out on their own
  if (await page.evaluate(() => !document.getElementById('continue-strip').hidden)) { await fire(40); await page.waitForTimeout(150); }
  await page.waitForTimeout(100);
  const playingBefore = await page.evaluate(() => document.getElementById('player').hidden ? '' : document.getElementById('osd-show').textContent.trim());
  let directions = null, afterChoice = null;
  if (playingBefore) {
    calls = nextCalls;
    await page.evaluate(() => document.getElementById('osd').classList.add('hidden'));
    await fire(40);
    await page.waitForFunction(() => document.querySelectorAll('#continue-strip .direction').length === 5, null, { timeout: 5000 });
    await fire(39); await fire(39); await fire(39);
    directions = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('#continue-strip .direction')];
      const strip = document.getElementById('continue-strip').getBoundingClientRect(), osd = document.getElementById('osd').getBoundingClientRect();
      const caption = document.getElementById('direction-caption');
      return {
        labels: tiles.map(tile => tile.querySelector('.resume-at').textContent), focused: tiles.findIndex(tile => tile.classList.contains('focused')),
        caption: caption.hidden ? '' : caption.textContent, captionCut: caption.scrollWidth > caption.clientWidth + 1,
        fits: tiles.every(tile => { const r = tile.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }),
        clearOfBar: strip.bottom <= osd.top + 2 && caption.getBoundingClientRect().bottom <= osd.top + 2,
        show: document.getElementById('osd-show').textContent.trim(),
      };
    });
    directions.calls = nextCalls - calls;
    await page.waitForFunction(() => document.getElementById('tune-flash').hidden);
    await shot('directions-dark.png', 'dark');
    await shot('directions-light.png', 'light');
    await fire(40); await fire(40); // Down to the bar, Down again: closed without choosing
    await page.waitForTimeout(100);
    await fire(40);
    await page.waitForFunction(() => document.querySelectorAll('#continue-strip .direction').length === 5, null, { timeout: 5000 });
    await fire(39);
    await fire(13);     // OK on the second tile
    await page.waitForTimeout(600);
    afterChoice = await page.evaluate(() => ({ show: document.getElementById('osd-show').textContent.trim(), strip: !document.getElementById('continue-strip').hidden }));
  }
  console.log(JSON.stringify({ before, homeRow, likedHero, prefetchSkipTiming, backWithOsd, backAfterOsd, arrowBurst, oneRight, directions, afterChoice, directionCalls, shown, skipped, homeGuide, onLike, likedNow, unliked, reliked, likeCalls, beforeSeek, seekPressTiming, seeking, seekArrow, sought, holdGrowth, seekingBack, cancelled, guide, transport, row, preview, errors }, null, 2));
  assert.equal(oneRight.calls, 0, 'Right while watching does not skip to the next show');
  assert.ok(arrowBurst.one.ms < 100, 'first Right step paints within 100 ms: ' + arrowBurst.one.ms);
  assert.equal(arrowBurst.one.bubble, '+0:10', 'first Right tap is 10 s');
  assert.equal(arrowBurst.one.paused, false, 'Right tap does not pause');
  assert.ok(arrowBurst.two.ms < 100, 'second Right step paints within 100 ms: ' + arrowBurst.two.ms);
  assert.equal(arrowBurst.two.bubble, '+0:40', 'two Right taps are 10 s + 30 s');
  assert.equal(arrowBurst.three.bubble, '+1:40', 'three Right taps are 10 s + 30 s + 60 s');
  assert.equal(arrowBurst.afterGap.bubble, '+0:10', 'Right after 2 s restarts the burst');
  assert.equal(arrowBurst.left.bubble, '\u22120:10', 'Left tap mirrors forward steps');
  assert.equal(onLike.like, true, 'Like is one step right of Next');
  assert.equal(onLike.liked, false);
  assert.equal(likedNow.liked, true, 'OK on Like fills the heart');
  assert.equal(unliked.liked, false, 'the green key takes the like back');
  assert.equal(reliked.liked, true, 'the green key likes');
  assert.deepEqual(likeCalls.filter(call => call.startsWith('POST')), ['POST:true', 'POST:false', 'POST:true']);
  assert.equal(shown.hidden, false);
  assert.equal(shown.play, true, 'OK opens the controls on play/pause');
  assert.equal(skipped.calls, 2, 'OK, OK on Next skips twice');
  assert.equal(skipped.hidden, false);
  assert.equal(skipped.next, true, 'Next keeps the focus after a skip');
  assert.equal(homeGuide.open, true, 'INFO opens the guide on the home page');
  assert.ok(homeGuide.calls.includes('Move') && homeGuide.calls.includes('Open'), JSON.stringify(homeGuide.calls));
  assert.equal(seeking.seeking, true, 'the forward key enters seek mode');
  assert.equal(seeking.paused, true, 'the picture holds while seeking');
  assert.equal(seeking.calls, 0, 'seeking never skips');
  assert.ok(seekPressTiming.ms < 100, 'first forward step paints within 100 ms: ' + seekPressTiming.ms);
  assert.equal(seekPressTiming.delta, '+0:10', 'first step is 10 s');
  assert.ok(seekPressTiming.secondMs < 100, 'second forward step paints within 100 ms: ' + seekPressTiming.secondMs);
  assert.equal(seekPressTiming.secondDelta, '+0:40', 'two taps are 10 s + 30 s');
  assert.match(seeking.seekTime, /^\+0:40$/, 'two presses are 40 s: ' + seeking.seekTime);
  assert.equal(holdGrowth.seeking, false, 'FF hold without event.repeat commits on release');
  assert.notEqual(holdGrowth.start, holdGrowth.end, 'holding grows the preview: ' + holdGrowth.start + ' -> ' + holdGrowth.end);
  assert.equal(seekArrow.seekTime, seeking.seekTime, 'arrows do nothing in seek mode');
  assert.equal(seekArrow.seeking, true);
  assert.equal(sought.seeking, false, 'OK leaves seek mode');
  assert.equal(sought.paused, beforeSeek.paused, 'OK resumes what was playing');
  assert.notEqual(sought.elapsed, beforeSeek.elapsed, 'OK goes to the marker');
  assert.equal(seekingBack.seeking, true);
  assert.equal(cancelled.seeking, false, 'OK leaves seek mode');
  assert.equal(guideOpen.guide, true, 'INFO opens the guide');
  assert.equal(guideShut.guide, false, 'INFO closes the guide');
  assert.equal(guide.fits, true);
  assert.deepEqual(guide.clipped, [], 'no callout is cut off');
  assert.deepEqual(guide.overlaps, [], 'no two callouts overlap');
  for (const key of ['up', 'down', 'left', 'right', 'ok', 'return', 'rw', 'ff', 'pause', 'play', 'stop', 'a', 'b', 'd', 'ch', 'prech', 'tools', 'subt', 'info', 'guide', 'chlist', '0', '5'])
    assert.ok(guide.lit.includes(key), key + ' is lit');
  for (const key of ['power', 'vol', 'mute', 'menu', 'exit', 'c', 'rec']) assert.ok(!guide.lit.includes(key), key + ' is not lit');
  assert.equal(transport.buttons.find(button => button.id === 'osd-next').focused, true);
  assert.deepEqual(transport.buttons.map(button => button.id), ['osd-prev-scene', 'osd-play', 'osd-next', 'osd-like', 'osd-options']);
  assert.deepEqual(transport.buttons.map(button => button.label).filter((_, index) => index !== 1), ['Previous', 'Next', 'Like', 'Options']);
  assert.ok(['Play', 'Pause', 'Play or pause'].includes(transport.buttons[1].label));
  assert.ok(transport.buttons.every(button => button.w >= 48), JSON.stringify(transport.buttons));
  assert.ok(transport.trackH >= 18, 'track ' + transport.trackH);
  assert.equal(transport.keysBelow, true);
  assert.equal(row.label, 'Continue');
  assert.match(row.text, /resume |next/);
  assert.equal(row.overlap, false, JSON.stringify(row));
  assert.equal(preview.visible, true);
  assert.equal(preview.same, true);
  assert.equal(homeRow.length, 2, JSON.stringify(homeRow));
  assert.equal(homeRow[0].liked, false);
  assert.equal(homeRow[1].liked, true);
  assert.ok(homeRow[1].label.startsWith('Liked:'), homeRow[1].label);
  assert.ok(homeRow[1].label.includes('Cercle') || homeRow[1].label.includes('Bonobo'), homeRow[1].label);
  assert.ok(homeRow[1].line.includes('Cercle') || homeRow[1].line.includes('\u2665'), homeRow[1].line);
  assert.ok(prefetchSkipTiming.ms <= 100, 'prefetched skip title: ' + JSON.stringify(prefetchSkipTiming));
  assert.equal(prefetchSkipTiming.show, 'Up Next Show');
  assert.equal(backWithOsd.osd, true);
  assert.equal(backAfterOsd.osd, false);
  assert.equal(backAfterOsd.chip, false, 'back chip stays off the picture');
  assert.equal(likedHero.focused, true, 'the liked tile takes focus');
  assert.ok(likedHero.hero.includes('Bonobo Solo live at Cercle Odyssey, Paris, France'), 'the focused tile is shown in full: ' + likedHero.hero);
  assert.ok(directions, 'something was playing for the directions check');
  assert.deepEqual(directions.labels, ['Bluey', 'New to you', 'Favourite', 'Long set', 'Music']);
  assert.equal(directions.focused, 3, 'arrows move along the tiles');
  assert.equal(directions.caption, 'Bonobo Solo live at Cercle Odyssey, Paris, France, recorded under the dome at night', 'the focused tile\'s whole title is shown');
  assert.equal(directions.captionCut, false, 'the whole title fits');
  assert.equal(directions.fits && directions.clearOfBar, true, JSON.stringify(directions));
  assert.equal(directions.show, playingBefore, 'opening and moving along the tray changes nothing');
  assert.equal(directions.calls, 0);
  assert.equal(directionCalls.length, 2, JSON.stringify(directionCalls));
  assert.equal(directionCalls[0].chosen, null, 'closing the tray is recorded');
  assert.equal(directionCalls[0].shown.length, 5);
  assert.deepEqual(directionCalls[1].chosen, { kind: 'new', src: 'Kids/Hey Duggee.mp4' });
  assert.equal(afterChoice.strip, false);
  // Exercise lifecycle regressions after the visual checks.
  await page.evaluate(() => window.overlayTest.close());
  await page.evaluate(() => window.overlayTest.time(100));
  await fire(39);
  await page.evaluate(() => window.overlayTest.load());
  assert.equal(await page.evaluate(() => window.overlayTest.state().delta), 0, 'load clears burst anchor');
  assert.equal(await page.evaluate(() => document.getElementById('player').classList.contains('is-tap-seeking')), false);
  await fire(39);
  assert.equal(await page.evaluate(() => window.overlayTest.time()), 10, 'new item starts with a fresh 10 second tap');
  for (const key of [37, 39, 412, 417]) {
    await page.evaluate(() => window.overlayTest.arm());
    await fire(key);
    const state = await page.evaluate(() => {
      for (let i = 0; i < 11; i++) window.overlayTest.tick();
      return window.overlayTest.state();
    });
    assert.equal(state.upNext, false, 'seek cancels up-next: ' + key);
    if (state.seeking) await fire(13);
  }
  await fire(38);
  // Back peels one layer (Ian, 21 Nov 2026): with the controls up it closes them and the picture plays on;
  // with only the picture, the next Back goes to the main menu.
  await fire(10009);
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => ({ player: !document.getElementById('player').hidden, osd: !document.getElementById('osd').classList.contains('hidden') })),
    { player: true, osd: false }, 'first Back closes the controls and keeps the picture');
  await fire(10009);
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => ({ player: !document.getElementById('player').hidden, home: !document.getElementById('home').hidden })),
    { player: false, home: true }, 'second Back lands on the main menu');
  await page.evaluate(() => window.ontoHome());
  assert.deepEqual(await page.evaluate(() => window.overlayTest.state()),
    { focus: '', timer: 0, upNext: false, hold: 0, delta: 0, seeking: false },
    'direct Home clears timer, all focus and seek state');
  await page.waitForTimeout(4200);
  assert.equal(await page.evaluate(() => window.overlayTest.state().timer), 0, 'OSD timer stays stopped on home');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
