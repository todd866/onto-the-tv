// Headless UI regression with synthetic library; never connects to the real TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertViewport } from '/Users/iantodd/Projects/.ux-authoring/viewport-fit.mjs';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/private/tmp/onto-tv-ui';
await mkdir(out, { recursive: true });
const shows = ['Blue Planet', 'The Great Adventure', 'A Very Long Show Name That Must Remain Readable When Selected', 'The Workshop', 'Wild Australia', 'Our Solar System'].map((name, n) => ({ name, src: 'show' + n, count: 12, channels: ['grown'] }));
const episodes = [{ src: 'episode', show: 'Blue Planet', title: 'The Deep', resume: 120, duration: 1800, channels: ['grown'] }];
const library = { channels: [{ id: '2', label: 'Little Kids', count: 20 }, { id: '6', label: 'Big Kids', count: 30 }, { id: 'grown', label: 'Grown Ups', count: 72 }, { id: 'music', label: 'Music', count: 15 }], continueWatching: episodes, shows };
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
let showRequests = 0, diagnostics = [], nextRequests = [];
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"ui-test"};' });
    if (url.pathname === '/api/diagnostics') { diagnostics.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/next') { nextRequests.push(route.request().postDataJSON()); return route.fulfill({ json: { ...episodes[0], src: 'next-episode', title: 'Next episode', resume: 0 } }); }
    if (url.pathname === '/api/progress') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/home') return route.fulfill({ json: library });
    if (url.pathname === '/api/show') { showRequests++; return route.fulfill({ json: episodes }); }
    if (url.pathname === '/art') {
      const colors = ['#184e77', '#386641', '#6a4c93', '#9c6644', '#007f5f', '#1d3557'];
      const n = +(url.searchParams.get('src') || '').replace('show', '') || 0;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${colors[n % colors.length]}"/><stop offset="1" stop-color="#080d18"/></linearGradient></defs><rect width="768" height="432" fill="url(#g)"/><circle cx="540" cy="130" r="90" fill="white" opacity=".12"/><path d="M0 390L200 160L400 390L570 230L768 420" fill="white" opacity=".12"/></svg>` });
    }
    try { return route.fulfill({ body: await readFile(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  for (const [label, width, height] of [['tv',1920,1080],['laptop',1366,768],['short',1280,640],['phone',390,844],['landscape',844,390]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://tv.test/');
    await page.locator('.tile.focused').waitFor();
    await page.screenshot({ path: path.join(out, label + '.png') });
    assert.equal(await page.getByText('Games', { exact: true }).count(), 1);
    await assertViewport(page, { primary: [{ selector: '#home' }], controls: [{ selector: '.tile.focused' }] });
    for (let n = 0; n < 2; n++) await page.keyboard.press('ArrowDown');
    for (let n = 0; n < 5; n++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(220);
    await assertViewport(page, { primary: ['#home'], controls: [{ selector: '.tile.focused' }] });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#shows .tile').count(), shows.length);
  }
  // Cached show navigation survives an unavailable server, and Back restores the selected show.
  const before = showRequests;
  await page.route('http://tv.test/api/show**', route => route.abort());
  await page.keyboard.press('Enter');
  await page.locator('#shows .episode').waitFor();
  assert.equal(showRequests, before);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.focused .name').textContent(), 'Our Solar System');
  await page.unroute('http://tv.test/api/show**');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('http://tv.test/');
  await page.locator('.focused').waitFor();
  await page.evaluate(() => {
    const elements = [...document.querySelectorAll('#home .name, #home h2, #home .count, #status')];
    const sizes = elements.map(el => parseFloat(getComputedStyle(el).fontSize));
    elements.forEach((el, i) => el.style.fontSize = (sizes[i] * 2) + 'px');
  });
  await page.keyboard.press('ArrowRight');
  await assertViewport(page, { primary: ['#home'], controls: [{ selector: '.tile.focused' }] });
  await page.screenshot({ path: path.join(out, 'large-text.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('http://tv.test/');
  await page.locator('.focused').waitFor();
  await page.screenshot({ path: path.join(out, 'light-preference.png') });

  // Real app integration against a deterministic, silent player adapter.
  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.ontoPlayer=function(){var h={},t=0,p=true; window.testMedia={finish:function(){(h.ended||function(){})();},tick:function(v){t=v;(h.time||function(){})();}};
    return {engine:'video',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 1800},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false},play:function(){p=false},pause:function(){p=true;(h.pause||function(){})();},stop:function(){p=true},seek:function(v){t=v}};};` }));
  await page.goto('http://tv.test/');
  await page.locator('#launch .focused').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.locator('#continue .focused').waitFor();
  diagnostics = [];
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'play_request' && event.state === 'loading'));
  await page.evaluate(() => window.testMedia.tick(120));
  await page.waitForTimeout(50);
  assert.ok(!diagnostics.some(event => event.event === 'playing'));
  await page.evaluate(() => window.testMedia.tick(121));
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'playing' && event.position === 121));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.ok(diagnostics.some(event => event.event === 'pause' && event.paused));
  await page.keyboard.press('Escape');
  await page.locator('#home:visible').waitFor();
  // Picking a shared kids' episode seeds Little Kids, then continues beyond that episode.
  episodes[0] = { src: 'Bluey/a.mp4', show: 'Bluey', title: 'Keepy Uppy', tier: 'shared', channels: ['2', '6', 'all'], duration: 420, resume: 0 };
  await page.goto('http://tv.test/');
  await page.locator('#launch .focused').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.locator('#continue .focused').waitFor();
  nextRequests = [];
  await page.keyboard.press('Enter');
  await page.locator('#player:visible').waitFor();
  assert.equal(await page.locator('#osd-episode').textContent(), 'Keepy Uppy');
  assert.equal(nextRequests.length, 0, 'plays the selected seed before asking for another');
  await page.evaluate(() => { window.testMedia.tick(420); window.testMedia.finish(); });
  await page.waitForTimeout(150);
  assert.equal(nextRequests[0].channel, '2');
  assert.equal(nextRequests[0].current, 'Bluey/a.mp4');
  assert.equal(nextRequests[0].reason, 'ended');
  assert.equal(await page.locator('#osd-episode').textContent(), 'Next episode');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  assert.equal(nextRequests[1].channel, '2');
  assert.equal(nextRequests[1].reason, 'skip');
  await page.keyboard.press('Escape');
  await page.goto('http://tv.test/');
  await page.locator('#launch .tile').filter({ hasText: 'Big Kids' }).click();
  await page.screenshot({ path: path.join(out, 'channel.png') });
  await page.locator('#player:visible').waitFor();
  assert.equal(nextRequests.at(-1).channel, '6', 'channel preset tunes immediately without an episode picker');
  await page.evaluate(() => { window.testMedia.tick(420); window.testMedia.finish(); });
  await page.waitForTimeout(100);
  assert.equal(nextRequests.at(-1).channel, '6', 'explicit Big Kids selection is preserved');
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await page.locator('#player:visible').waitFor();
  await page.waitForTimeout(100);
  assert.equal(nextRequests.at(-1).channel, '2', 'number key tunes the matching preset');
  // A slow earlier tune must not replace the latest channel selection.
  await page.keyboard.press('Escape');
  var releaseFirst;
  await page.route('http://tv.test/api/next', async route => {
    var body = route.request().postDataJSON();
    if (body.channel === '2') await new Promise(resolve => { releaseFirst = resolve; });
    await route.fulfill({json:{...episodes[0],src:body.channel+'.mp4',title:'Channel '+body.channel}});
  });
  await page.keyboard.press('1');
  await page.waitForTimeout(50);
  await page.keyboard.press('2');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#osd-episode').textContent(),'Channel 6');
  releaseFirst();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#osd-episode').textContent(),'Channel 6');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: 5, showRequests, screenshots: out }));
} finally { await browser.close(); }
