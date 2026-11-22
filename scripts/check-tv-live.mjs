// Headless check of the installed app's loader (tv/boot.js) against a packaged build. Never contacts the TV.
//   node scripts/check-tv-live.mjs            (uses tizen/build/app)
// Three starts: the server answers (the page is built from the server's copy); no server answers (the packaged
// copy is used); a live script is missing (one reload, then the packaged copy).
import './lib/example-household.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { liveManifest } from '../src/tv-live.js';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const pkg = path.resolve(process.env.TV_UI_ROOT || fileURLToPath(new URL('../tizen/build/app/', import.meta.url)));
const source = fileURLToPath(new URL('../tv/', import.meta.url));
const type = name => name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.woff') ? 'font/woff' : 'text/html';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Onto-Token' };

async function start(browser, mode) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const asked = [];
  await page.route('http://tv.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/config.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.ONTO_CONFIG={servers:["http://live.test"],token:"fixture",build:"packaged"};' });
    try { return route.fulfill({ body: await readFile(path.join(pkg, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))), contentType: type(url.pathname) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.route('http://live.test/**', async route => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (mode === 'down') return route.abort();
    if (url.pathname === '/api/tv-live') {
      assert.equal(route.request().headers()['x-onto-token'], 'fixture');
      return route.fulfill({ json: await liveManifest(source), headers: cors });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true, viewers: [], channels: [], items: [] }, headers: cors });
    if (mode === 'broken' && url.pathname === '/remote-map.js') return route.fulfill({ status: 404, body: '' });
    try { return route.fulfill({ body: await readFile(path.join(source, url.pathname.slice(1))), contentType: type(url.pathname), headers: cors }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://tv.test/');
  await page.waitForFunction(() => window.ontoRemoteGuide && window.ontoRemoteMap && window.ontoTVAction && document.getElementById('osd-like'), null, { timeout: 15000 });
  const state = await page.evaluate(() => ({
    build: window.ONTO_CONFIG.build, live: window.ONTO_CONFIG.live || '', packagedBuild: window.ONTO_CONFIG.packagedBuild || '',
    scripts: [...document.scripts].map(script => script.getAttribute('src')).filter(Boolean),
    styles: [...document.querySelectorAll('link[rel=stylesheet]')].map(link => link.getAttribute('href')),
    home: !!document.getElementById('home'), rover: !!document.getElementById('onto-rover-styles'),
  }));
  await page.close();
  return { ...state, asked, errors };
}

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const live = await start(browser, 'live');
  const down = await start(browser, 'down');
  const broken = await start(browser, 'broken');
  console.log(JSON.stringify({ live: { build: live.build, scripts: live.scripts.length, styles: live.styles.length }, down: { build: down.build }, broken: { build: broken.build } }));
  assert.match(live.build, /^live-[0-9a-f]{12}$/, 'the page reports the live build');
  assert.equal(live.packagedBuild, 'packaged');
  assert.ok(live.scripts.some(src => src.startsWith('http://live.test/app.js?v=live-')), 'app.js came from the server');
  assert.ok(live.styles.every(href => href.startsWith('http://live.test/')), 'styles came from the server');
  assert.ok(!live.asked.includes('/config.js'), 'the pairing config is never taken from the server');
  assert.equal(live.home && live.rover, true);
  assert.equal(down.build, 'packaged', 'with no server the packaged copy is used');
  assert.ok(down.scripts.includes('app.js'));
  assert.equal(broken.build, 'packaged', 'a missing live script falls back to the packaged copy');
  assert.ok(broken.scripts.includes('remote-map.js'));
  for (const run of [live, down, broken]) assert.deepEqual(run.errors, []);
} finally {
  await browser.close();
}
