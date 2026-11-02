// Two isolated browser pages exercise the real local relay. Silent, headless only.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTvServer } from '../src/tv-server.js';
const { assertViewport } = await import(pathToFileURL(process.env.VIEWPORT_MODULE || '/Users/iantodd/Projects/.ux-authoring/viewport-fit.mjs'));
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const out = '/private/tmp/onto-tv-games';
await mkdir(out, { recursive: true });
const server = createTvServer({ library: { home: () => ({ channels: [], shows: [], continueWatching: [] }) },
  history: { flush: async () => {} }, storage: { flush: async () => {} }, token: 'fixture',
  uiRoot: fileURLToPath(new URL('../tv/', import.meta.url)).replace(/\/$/, '') });
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  tv.on('pageerror', error => errors.push(error.message));
  await tv.addInitScript(() => { window.ONTO_CONFIG = { token: 'fixture', build: 'game-test' }; });
  await tv.goto(base);
  await tv.locator('.channel').filter({ hasText: 'Games' }).click();
  await tv.locator('#onto-games:visible').waitFor();
  assert.equal(tv.url(), base + '/', 'games stay in the installed page');
  await tv.keyboard.press('0');
  await tv.waitForFunction(() => /\b\d{6}\b/.test(document.getElementById('game-pairing').textContent));
  const code = (await tv.locator('#game-pairing').textContent()).match(/\b\d{6}\b/)[0];
  const laptop = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  laptop.on('pageerror', error => errors.push(error.message));
  await laptop.goto(base + '/controller/');
  await laptop.locator('#code').fill(code);
  await laptop.locator('#pair button').click();
  await laptop.locator('#pad:visible').waitFor();
  await tv.waitForFunction(() => /connected/i.test(document.getElementById('game-pairing').textContent));
  await assertViewport(laptop, { primary: ['main'], controls: ['#pad [data-action="ok"]'] });
  await laptop.screenshot({ path: out + '/controller.png' });
  await tv.keyboard.press('2');
  await tv.locator('.memory-card').first().waitFor();
  await tv.keyboard.press('1'); await tv.keyboard.press('2');
  await laptop.locator('[data-action="digit3"]').click();
  await tv.waitForFunction(() => document.querySelectorAll('.memory-card')[2].textContent !== '?');
  await tv.screenshot({path:out+'/memory.png'});
  await tv.keyboard.press('Escape');
  await tv.keyboard.press('1');
  await tv.locator('#onto-rover-overlay.onto-rover-open').waitFor();
  for (const [label, width, height] of [['tv',1920,1080],['laptop',1280,720],['phone',390,844],['landscape',844,390]]) {
    await tv.setViewportSize({ width, height });
    await tv.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertViewport(tv, { primary: ['.onto-rover-board'], controls: ['.onto-rover-hint'] });
    await tv.screenshot({ path: `${out}/rover-${label}.png` });
  }
  await tv.setViewportSize({width:1920,height:1080});
  const sequence=['ArrowRight','ArrowRight','ArrowDown','ArrowDown','Enter','ArrowDown','ArrowDown','ArrowRight','Enter','ArrowUp','ArrowUp','ArrowUp','ArrowUp','ArrowRight','ArrowRight','ArrowRight','ArrowRight'];
  for(const key of sequence)await tv.keyboard.press(key);
  assert.equal(await tv.locator('.onto-rover-level').textContent(),'L2');
  await tv.keyboard.press('Escape');
  await tv.keyboard.press('Escape');
  await tv.locator('#home:visible').waitFor();
  await laptop.waitForFunction(() => !document.getElementById('pair').hidden);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, pairedInput: true, screenshots: out }));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
