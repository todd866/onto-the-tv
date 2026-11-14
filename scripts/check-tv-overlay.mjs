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
  let nextCalls = 0;
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
    if (url.pathname === '/api/next') { let peek = false; try { peek = !!(route.request().postDataJSON() || {}).prefetch; } catch {} if (!peek) nextCalls++; return route.fulfill({ json: { src: 'Kids/Bluey.mp4', show: 'Bluey', title: 'The Sign', resume: 0, duration: 420 } }); }
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
  // Home: what was liked sits in the row after what is half-watched.
  const homeRow = await page.evaluate(() => [...document.querySelectorAll('#resume-row .resume')].map(tile => ({ liked: tile.classList.contains('liked'), label: tile.getAttribute('aria-label'), line: tile.querySelector('.resume-at').textContent, right: tile.getBoundingClientRect().right })));
  await fire(40); await fire(39);   // down to the row, right to the liked tile
  const likedHero = await page.evaluate(() => ({ focused: document.querySelector('#resume-row .resume.focused') ? document.querySelector('#resume-row .resume.focused').classList.contains('liked') : null, hero: document.getElementById('hero').textContent }));
  await shot('home-liked-dark.png', 'dark');
  await fire(37); await fire(38);
  // INFO on the home page: the remote, with the keys home uses.
  await fire(457);
  const homeGuide = await page.evaluate(() => ({ open: !document.getElementById('remote-guide').hidden, calls: [...document.querySelectorAll('#remote-guide .rg-word')].map(node => node.textContent) }));
  await shot('guide-home-dark.png', 'dark');
  await fire(457);
  await fire(49);
  await page.locator('#player:visible').waitFor();
  await page.locator('#osd-show').waitFor();
  const before = (await page.locator('#osd-show').textContent() || '').trim();
  await page.evaluate(() => document.getElementById('osd').classList.add('hidden'));
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
  // Watching: an arrow only shows the controls (focus on play/pause). Nothing changes, the picture keeps playing.
  let calls = nextCalls;
  await fire(39);
  await page.waitForTimeout(700);
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
  await fire(417);
  await fire(417);
  const seeking = { ...(await state()), calls: nextCalls - calls };
  await fire(39);   // an arrow in seek mode does nothing
  await fire(37);
  const seekArrow = await state();
  await shot('seek-dark.png', 'dark');
  await shot('seek-light.png', 'light');
  await fire(13);   // OK goes there
  const sought = await state();
  await fire(412);  // back 10 s, then RETURN: the picture is where it was
  const seekingBack = await state();
  await fire(10009);
  const cancelled = await state();
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
  await fire(10009); // drop any open controls so the picture is plain
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
    await fire(10009);  // closed without choosing
    await page.waitForTimeout(100);
    await fire(40);
    await page.waitForFunction(() => document.querySelectorAll('#continue-strip .direction').length === 5, null, { timeout: 5000 });
    await fire(39);
    await fire(13);     // OK on the second tile
    await page.waitForTimeout(600);
    afterChoice = await page.evaluate(() => ({ show: document.getElementById('osd-show').textContent.trim(), strip: !document.getElementById('continue-strip').hidden }));
  }
  console.log(JSON.stringify({ before, homeRow, likedHero, oneRight, directions, afterChoice, directionCalls, shown, skipped, homeGuide, onLike, likedNow, unliked, reliked, likeCalls, beforeSeek, seeking, seekArrow, sought, seekingBack, cancelled, guide, transport, row, preview, errors }, null, 2));
  assert.equal(oneRight.calls, 0, 'an arrow while watching never skips');
  assert.equal(oneRight.show, before, 'an arrow while watching leaves the show on');
  assert.equal(oneRight.paused, false, 'an arrow while watching does not pause');
  assert.equal(oneRight.hidden, false, 'an arrow while watching shows the controls');
  assert.equal(oneRight.play, true, 'an arrow while watching puts focus on play/pause');
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
  assert.match(seeking.seekTime, /^\+0:20$/, 'two presses are 20 s: ' + seeking.seekTime);
  assert.equal(seekArrow.seekTime, seeking.seekTime, 'arrows do nothing in seek mode');
  assert.equal(seekArrow.seeking, true);
  assert.equal(sought.seeking, false, 'OK leaves seek mode');
  assert.equal(sought.paused, beforeSeek.paused, 'OK resumes what was playing');
  assert.notEqual(sought.elapsed, beforeSeek.elapsed, 'OK goes to the marker');
  assert.equal(seekingBack.seeking, true);
  assert.equal(cancelled.seeking, false, 'RETURN leaves seek mode');
  assert.equal(cancelled.elapsed, sought.elapsed, 'RETURN puts the picture back where it was');
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
  assert.equal(homeRow[1].label, 'Liked: Bonobo Solo live at Cercle Odyssey, Paris, France');
  assert.equal(homeRow[1].line, '\u2665 Cercle');
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
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
