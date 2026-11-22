// Jank profile of the TV interface on a CPU slowed to TV-chip speed, against real home data.
// Owner, 22 Nov 2026: the app is "still kinda janky". Prints per key press: ms to the next painted frame (the
// same measure the TV logs to remote-events.jsonl), main-thread long tasks, frames over 50 ms in the second after
// the press, and layout shift; then style/layout/script totals and the composited layer area of the idle home.
//
// Data: GET responses (home, channel art, pictures, feed) are recorded once from a TV server into OTV_CACHE and
// replayed after that, so before/after runs see identical data. Nothing is ever POSTed to the server: plays,
// progress, likes, telemetry and diagnostics are answered locally. Headless only; never contacts the TV.
//
//   ONTO_TV_TOKEN=… OTV_SOURCE=http://tv-mac.local:8686 node scripts/measure-tv-jank.mjs
//   TV_ROOT=/path/to/other/tv  (compare another revision's tv/ folder)   TV_CPU=6   TV_STOP_MS=250
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));

const root = process.env.TV_ROOT || fileURLToPath(new URL('../tv/', import.meta.url));
const cacheDir = process.env.OTV_CACHE || path.join(process.env.TMPDIR || '/tmp', 'otv-jank-cache');
const source = process.env.OTV_SOURCE || '';
const token = process.env.ONTO_TV_TOKEN || '';
const CPU = Number(process.env.TV_CPU || 6);
// The TV's AVPlay stop/close is synchronous; key telemetry puts Back from the player at ~200 ms against ~14 ms for a
// home move (remote-events.jsonl, 14-21 Nov 2026). The stub blocks for this long in stop() to model it.
const STOP_MS = Number(process.env.TV_STOP_MS || 250);
const PROFILE = process.env.TV_PROFILE || 'all';
await mkdir(cacheDir, { recursive: true });

function cacheKey(url) {
  const u = new URL(url);
  u.searchParams.delete('t');
  return createHash('sha1').update(u.pathname + '?' + u.searchParams.toString()).digest('hex');
}
async function recorded(url) {
  const file = path.join(cacheDir, cacheKey(url));
  try { return JSON.parse(await readFile(file + '.json', 'utf8')); } catch {}
  if (!source) return null;
  const u = new URL(url), from = new URL(u.pathname + u.search, source);
  if (from.searchParams.has('t')) from.searchParams.set('t', token);
  const response = await fetch(from, { headers: { 'X-Onto-Token': token } });
  const body = Buffer.from(await response.arrayBuffer());
  const entry = { status: response.status, type: response.headers.get('content-type') || 'application/octet-stream', body: body.toString('base64') };
  await writeFile(file + '.json', JSON.stringify(entry));
  return entry;
}

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : { channel: 'chrome' }) });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ profile }) => {
    const viewers = { all: 'kid1,kid2,adult2,adult1', adult1: 'adult1', kid2: 'kid2,adult2,adult1', kid1: 'kid1,kid2,adult2,adult1', adult2: 'adult2' }[profile];
    const h = new Date().getHours();
    localStorage.setItem('onto.viewers.band', h >= 20 || h < 5 ? 'night' : 'day');
    localStorage.setItem('onto.profile', profile);
    localStorage.setItem('onto.viewers', viewers);
    window.__jank = { longTasks: [], shifts: [] };
    try {
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__jank.longTasks.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] });
      new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__jank.shifts.push([e.startTime, e.value]); }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
  }, { profile: PROFILE });
  let home = null;
  await page.route('http://tv.test/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={token:"fixture",build:"jank"};' });
    if (request.method() !== 'GET') {
      if (url.pathname === '/api/next' || url.pathname === '/api/play-next') {
        const channels = (home && home.channels) || [];
        let wanted = '';
        try { wanted = JSON.parse(request.postData() || '{}').channel; } catch {}
        const ch = channels.find(c => c.id === wanted) || channels[0] || {};
        const now = ch.now || {};
        return route.fulfill({ json: { src: 'fixture/' + (now.title || 'x') + '.mp4', show: now.show || 'Show', title: now.title || 'Title', art: now.art || '', resume: 0, duration: 600 } });
      }
      if (url.pathname === '/api/directions') return route.fulfill({ json: { options: [] } });
      return route.fulfill({ json: { ok: true, items: [] } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/art' || url.pathname.startsWith('/still') || url.pathname.startsWith('/pictures')) {
      if (url.pathname === '/api/diagnostics' || url.pathname === '/api/tv-live') return route.fulfill({ json: { ok: true } });
      if (url.pathname === '/media' || url.pathname.startsWith('/media/')) return route.fulfill({ status: 404, body: '' });
      const entry = await recorded(request.url());
      if (!entry) return route.fulfill({ status: 404, json: { error: 'not recorded' } });
      const body = Buffer.from(entry.body, 'base64');
      if (url.pathname === '/api/home') { try { home = JSON.parse(body.toString('utf8')); } catch {} }
      return route.fulfill({ status: entry.status, contentType: entry.type, body });
    }
    const p = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const type = p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : p.endsWith('.woff') ? 'font/woff' : p.endsWith('.png') ? 'image/png' : 'text/html';
    try { return route.fulfill({ body: await readFile(path.join(root, p)), contentType: type }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  const playerSource = await readFile(path.join(root, 'player.js'), 'utf8');
  const playerStub = `window.ontoPlayer=function(){var h={},t=12,p=false;function block(ms){var e=performance.now()+ms;while(performance.now()<e){}}return {engine:'avplay',on:function(n,f){h[n]=f},time:function(){return t},duration:function(){return 600},paused:function(){return p},ended:function(){return false},load:function(u,start){t=start||0;p=false;setTimeout(function(){h.playing&&h.playing();h.canplay&&h.canplay();},50)},play:function(){p=false},pause:function(){p=true},stop:function(){p=true;block(${STOP_MS})},seek:function(v){t=v},tracks:function(){return {audio:[],text:[]}},selectAudio:function(){},selectText:function(){}};};`;
  await page.route('http://tv.test/player.js', route => route.fulfill({ contentType: 'text/javascript', body: playerSource + '\n' + playerStub }));

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://tv.test/');
  await page.waitForTimeout(2500);
  if (process.env.TV_EXTRA_CSS) await page.addStyleTag({ content: process.env.TV_EXTRA_CSS }); // isolate a suspect
  if (await page.locator('#picker:visible').count()) { await press(13); await page.waitForTimeout(800); }
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send('Performance.enable', { timeDomain: 'threadTicks' }); } catch { await cdp.send('Performance.enable'); } // CPU time, not wall time
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  await page.waitForTimeout(3000);

  function press(code) {
    return page.evaluate(keyCode => new Promise(resolve => {
      function send(type) {
        var event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { get: function () { return keyCode; } });
        Object.defineProperty(event, 'repeat', { get: function () { return false; } });
        document.dispatchEvent(event);
      }
      var t0 = performance.now();
      send('keydown');
      var handler = performance.now() - t0;
      setTimeout(function () { send('keyup'); }, 90);
      requestAnimationFrame(function () { setTimeout(function () { resolve({ t0: t0, handler: handler, frame: performance.now() - t0 }); }, 0); });
    }), code);
  }
  // Frames over 50 ms in the window after a press, sampled with requestAnimationFrame.
  function frames(ms) {
    return page.evaluate(ms => new Promise(resolve => {
      var last = performance.now(), end = last + ms, slow = 0, worst = 0;
      function tick(now) { var d = now - last; last = now; if (d > 50) slow++; if (d > worst) worst = d; if (now < end) requestAnimationFrame(tick); else resolve({ slow: slow, worst: worst }); }
      requestAnimationFrame(tick);
    }), ms);
  }
  const rows = [];
  async function step(code, label, settle = 900) {
    const m0 = await metrics();
    const r = await press(code);
    const f = await frames(settle);
    const j = await page.evaluate(t0 => {
      var lt = window.__jank.longTasks.filter(e => e[0] >= t0 - 5), cls = window.__jank.shifts.filter(e => e[0] >= t0 - 5);
      return { lt: lt.length, ltMs: lt.reduce((a, e) => a + e[1], 0), cls: cls.reduce((a, e) => a + e[1], 0) };
    }, r.t0);
    const m1 = await metrics();
    const where = await page.evaluate(() => {
      var f = document.querySelector('.focused'), p = document.getElementById('player');
      var at = f ? (f.id || (f.parentNode && f.parentNode.id) || f.className.split(' ')[0]) + ' ' + (Array.prototype.indexOf.call(f.parentNode.children, f) + 1) : '-';
      return (p && !p.hidden ? 'PLAYER ' : 'home ') + at;
    });
    const cpu = ['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration'].reduce((a, k) => a + ((m1[k] || 0) - (m0[k] || 0)) * 1000, 0);
    rows.push({ label, handler: r.handler, frame: r.frame, slow: f.slow, worst: f.worst, lt: j.lt, ltMs: j.ltMs, cls: j.cls, cpu, styles: m1.RecalcStyleCount - m0.RecalcStyleCount, where });
  }
  async function metrics() {
    const m = {}; for (const x of (await cdp.send('Performance.getMetrics')).metrics) m[x.name] = x.value; return m;
  }
  async function layers() {
    await cdp.send('LayerTree.enable');
    const tree = await new Promise(resolve => {
      cdp.once('LayerTree.layerTreeDidChange', e => resolve(e.layers || []));
      setTimeout(() => resolve(null), 3000);
    });
    await cdp.send('LayerTree.disable');
    if (!tree) return null;
    let area = 0, n = 0;
    for (const l of tree) if (l.drawsContent) { n++; area += l.width * l.height; }
    return { layers: n, mpx: area / 1e6 };
  }
  // Idle cost, independent of how busy the measuring Mac is: main-thread task time and style passes per 2 s with
  // no key pressed, and the animations that are running.
  async function idle() {
    const a = await metrics(), f = await frames(2000), b = await metrics();
    const anims = await page.evaluate(() => (document.getAnimations ? document.getAnimations() : []).filter(x => x.playState === 'running').map(x => (x.animationName || x.transitionProperty || 'anim') + '@' + ((x.effect && x.effect.target && (x.effect.target.id || x.effect.target.className || x.effect.target.tagName)) || '?') + (x.effect && x.effect.pseudoElement ? x.effect.pseudoElement : '')));
    return { slow: f.slow, worst: f.worst, task: (b.TaskDuration - a.TaskDuration) * 1000, styles: b.RecalcStyleCount - a.RecalcStyleCount, layouts: b.LayoutCount - a.LayoutCount, anims };
  }
  const idleBefore = await idle();
  const layerIdle = await layers();
  const before = await metrics();
  const right = PROFILE === 'kid2' ? 39 : 39;
  // Home: across the channel cards and back, down and up.
  await step(40, 'home ▼ (to the cards)');
  for (let i = 0; i < 5; i++) await step(right, 'home ▶ ' + (i + 1), 600);
  for (let i = 0; i < 3; i++) await step(37, 'home ◀ ' + (i + 1), 600);
  // Into the player and back out.
  await step(13, 'home OK (play)', 2500);
  await step(40, 'player ▼ (tray/controls)', 1200);
  await step(39, 'player ▶ (controls)'); await step(37, 'player ◀ (controls)');
  await step(10009, 'player Back (close)', 1200);
  await step(10009, 'player Back (to home)', 2500);
  await step(right, 'home ▶ after Back', 600); await step(37, 'home ◀ after Back', 600);
  const after = await metrics();
  const idleAfter = await idle();

  const pad = (v, n = 6) => String(v).padStart(n);
  console.log('profile ' + PROFILE + ', cpu x' + CPU + ', modelled AVPlay stop ' + STOP_MS + ' ms, tv/ from ' + root);
  console.log(' frame handler   cpu styles  >50ms worst  longtasks   CLS  key → where');
  for (const r of rows) console.log(pad(Math.round(r.frame)) + pad(Math.round(r.handler), 8) + pad(Math.round(r.cpu), 6) + pad(r.styles, 7) + pad(r.slow, 6) + pad(Math.round(r.worst), 6) + pad(r.lt, 4) + '/' + pad(Math.round(r.ltMs), 5) + pad(r.cls.toFixed(3), 7) + '  ' + r.label + ' → ' + r.where);
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const homeRows = rows.filter(r => r.label.startsWith('home ▶') || r.label.startsWith('home ◀'));
  console.log('home arrows: mean frame ' + Math.round(homeRows.reduce((a, r) => a + r.frame, 0) / homeRows.length) + ' ms, max ' + Math.round(Math.max(...homeRows.map(r => r.frame))) + ' ms, slow frames ' + homeRows.reduce((a, r) => a + r.slow, 0));
  console.log('all keys: slow frames ' + sum('slow') + ', long tasks ' + sum('lt') + ' (' + Math.round(sum('ltMs')) + ' ms), CLS ' + sum('cls').toFixed(3));
  const d = k => ((after[k] || 0) - (before[k] || 0));
  console.log('totals over the run: style ' + Math.round(d('RecalcStyleDuration') * 1000) + ' ms (' + d('RecalcStyleCount') + 'x), layout ' + Math.round(d('LayoutDuration') * 1000) + ' ms (' + d('LayoutCount') + 'x), script ' + Math.round(d('ScriptDuration') * 1000) + ' ms, task ' + Math.round(d('TaskDuration') * 1000) + ' ms');
  for (const [name, x] of [['idle home', idleBefore], ['idle after Back', idleAfter]]) console.log(name + ' (2 s): main-thread task ' + Math.round(x.task) + ' ms, style passes ' + x.styles + ', layouts ' + x.layouts + ', frames >50 ms ' + x.slow + '; running: ' + (x.anims.join(' ') || 'none'));
  console.log('composited layers at idle ' + (layerIdle ? layerIdle.layers + ', ' + layerIdle.mpx.toFixed(1) + ' Mpx' : 'n/a'));
  console.log('errors ' + JSON.stringify(errors));
  // TV_PROBE=1: what the idle home is drawing, then each suspect switched off in turn, interleaved with the
  // untouched page, so a busy measuring Mac affects both sides alike.
  if (process.env.TV_PROBE) {
    console.log('backdrop: ' + JSON.stringify(await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#backdrop img'), i => i.className + ' ' + i.naturalWidth + 'x' + i.naturalHeight))) + ' body: ' + await page.evaluate(() => document.body.className));
    const suspects = {
      snow: '#backdrop::before,#backdrop::after{display:none!important}',
      blur: '#backdrop img{-webkit-filter:none!important;filter:none!important}',
      drift: '#backdrop img{-webkit-animation:none!important;animation:none!important}',
      scrim: '#backdrop .scrim{display:none!important}',
      backdrop: '#backdrop{display:none!important}',
    };
    const tally = {};
    for (let round = 0; round < 3; round++) {
      for (const [name, css] of Object.entries(suspects)) {
        const base = await frames(1500);
        await page.evaluate(css => { var s = document.createElement('style'); s.id = 'probe'; s.textContent = css; document.head.appendChild(s); }, css);
        await page.waitForTimeout(300);
        const off = await frames(1500);
        await page.evaluate(() => document.getElementById('probe').remove());
        await page.waitForTimeout(300);
        (tally[name] = tally[name] || []).push([base.slow, off.slow]);
      }
    }
    for (const [name, v] of Object.entries(tally)) console.log('probe ' + name.padEnd(9) + ' frames >50 ms per 1.5 s, on → off: ' + v.map(x => x[0] + '→' + x[1]).join('  '));
  }
} finally {
  await browser.close();
}
