// Key-to-screen latency of every remote key, on a CPU slowed to TV-chip speed with a slow server.
// Owner, 14 Nov 2026: "I press a button on the remote and the TV needs to respond *instantly*".
// Prints ms from keydown to the first visible change; fails when any key is over the budget. Never contacts the TV.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const root = fileURLToPath(new URL('../tv/', import.meta.url));
const out = process.env.TV_UI_OUTPUT || '/tmp/onto-tv-control-overlay';
await mkdir(out, { recursive: true });

const NET_MS = Number(process.env.TV_NET_MS || 400), CPU = Number(process.env.TV_CPU || 6), BUDGET = Number(process.env.TV_BUDGET_MS || 100);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  let nextCalls = 0;
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
    if (url.pathname.startsWith('/api/')) await new Promise(r => setTimeout(r, NET_MS));
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"overlay"};' });
    if (url.pathname === '/api/diagnostics') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/now-playing' || url.pathname === '/api/play-next' || url.pathname === '/api/watch' || url.pathname === '/api/progress') return route.fulfill({ json: { ok: true, items: [] } });
    if (url.pathname === '/api/next') { nextCalls++; return route.fulfill({ json: { src: 'Kids/Bluey.mp4', show: 'Bluey', title: 'The Sign', resume: 0, duration: 420 } }); }
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
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  // ms from keydown to the first frame in which anything on screen differs.
  function press(code, label) {
    return page.evaluate(([keyCode, label]) => new Promise(resolve => {
      function sig() {
        var out = '', nodes = document.querySelectorAll('body *'), i, n, r;
        for (i = 0; i < nodes.length; i++) { n = nodes[i]; out += n.className + '|' + (n.getAttribute('aria-label') || '') + '|' + (n.hidden ? 1 : 0) + '|' + (n.childElementCount ? '' : n.textContent) + '|' + (n.style ? n.style.cssText : '') + ';'; }
        return out;
      }
      function send(type) {
        var event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { get: function () { return keyCode; } });
        Object.defineProperty(event, 'repeat', { get: function () { return false; } });
        document.dispatchEvent(event);
      }
      var before = sig(), t0 = performance.now(), handler, changed = null;
      send('keydown');
      handler = performance.now() - t0;
      if (sig() !== before) changed = handler;
      setTimeout(function () { send('keyup'); }, 90);      // a real press lasts about 90 ms
      function frame() {
        var now = performance.now() - t0;
        if (changed === null && sig() !== before) changed = now;
        if (changed !== null || now > 3000) { var f = document.querySelector('#home .focused, #player .focused'); resolve({ key: label, handler: Math.round(handler), visible: changed === null ? null : Math.round(changed), where: f ? (f.parentNode.id || f.parentNode.className) + ' ' + (Array.prototype.indexOf.call(f.parentNode.children, f) + 1) + '/' + f.parentNode.children.length : '' }); }
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }), [code, label]);
  }
  const rows = [];
  async function step(code, label, settle = 700) { rows.push(await press(code, label)); await page.waitForTimeout(settle); }
  // Home
  await step(40, 'home ▼');
  await step(13, 'home OK (start playing)', 2500);
  await page.locator('#player:visible').waitFor({ timeout: 5000 });
  await step(10009, 'Back (to home)', 1500);
  await step(40, 'home ▼ (channel grid)'); await step(39, 'home ▶'); await step(39, 'home ▶'); await step(37, 'home ◀');
  await step(49, 'home digit 1 (tune)', 2500);
  await page.locator('#player:visible').waitFor({ timeout: 5000 });
  // Player
  await step(13, 'play OK (pause)'); await step(13, 'play OK (resume)');
  await step(39, 'play ▶ (seek)'); await step(39, 'play ▶ (seek)'); await step(37, 'play ◀ (seek)');
  await page.evaluate(() => document.getElementById('osd').classList.add('hidden'));
  await step(40, 'play ▼ (bar)'); await step(37, 'bar ◀'); await step(39, 'bar ▶');
  await step(13, 'bar OK (skip)', 2000); await step(13, 'bar OK (skip again)', 2000);
  await page.waitForTimeout(1500); await step(38, 'bar ▲ (continue)'); await step(10009, 'Back (close bar)');
  await step(427, 'CH+ (channel)', 2500); await step(50, 'digit 2', 2500);
  await step(10009, 'Back (to home)', 1500);
  let worst = 0;
  for (const r of rows) { worst = Math.max(worst, r.visible === null ? 9999 : r.visible); console.log(String(r.visible === null ? 'NONE' : r.visible).padStart(5) + ' ms  (handler ' + String(r.handler).padStart(4) + ')  ' + r.key + (r.visible === null ? '   [focus: ' + r.where + ']' : '')); }
  console.log('cpu x' + CPU + ', server ' + NET_MS + ' ms, budget ' + BUDGET + ' ms, worst ' + worst + ' ms; errors ' + JSON.stringify(errors));
  if (process.env.TV_ENFORCE !== '0') assert.ok(worst <= BUDGET, 'a key took ' + worst + ' ms to show anything');
} finally {
  await browser.close();
}
