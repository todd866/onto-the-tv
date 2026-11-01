// Silent headless Uke-in-Onto smoke check. Uses the real Uke assets and the
// real Onto server route on an ephemeral loopback port; no TV or audio device.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createTvServer, createTvLibrary, createFileStorage } from '../src/tv-server.js';
import { loadPlaybackHistory } from '../src/playback-history.js';
import { createConfiguredUkeHandler } from '../src/uke-handler.js';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));

const dir = await mkdtemp(join(tmpdir(), 'onto-uke-check-'));
await writeFile(join(dir, 'index.html'), await (await import('node:fs/promises')).readFile(new URL('../tv/index.html', import.meta.url)));
const history = await loadPlaybackHistory(join(dir, 'history.json'));
const storage = await createFileStorage(join(dir, 'taste.json'));
const videos = [{ src: 'demo.mp4', file: join(dir, 'demo.mp4'), title: 'Demo', channel: 'Demo', tier: 'shared', duration: 12 }];
const library = createTvLibrary({ videos, history, storage, random: () => 0 });
const uiRoot = new URL('../tv/', import.meta.url).pathname.replace(/\/$/, '');
const server = createTvServer({ library, history, storage, uiRoot,
  ukeHandler: createConfiguredUkeHandler({ root: new URL('../../uke/', import.meta.url).pathname }) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('PAGEERROR', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error('HTTP', response.status(), response.url()); });
  await page.goto(`${base}/`);
  try { await page.locator('.channel', { hasText: 'Uke' }).waitFor({ timeout: 5000 }); }
  catch (error) { console.error('LAUNCH', await page.locator('#channels').innerText().catch(() => ''), await page.locator('#status').innerText().catch(() => '')); throw error; }
  await page.locator('.channel', { hasText: 'Uke' }).click();
  const frame = page.frameLocator('#onto-uke');
  await page.locator('#onto-uke').waitFor();
  console.error('FRAMES', page.frames().map(item => item.url()));
  await frame.locator('button.song').first().waitFor({timeout:10000});
  await page.evaluate(() => window.postMessage({type:'uke:exit'}, '*'));
  assert.equal(await page.locator('#onto-uke').count(),1,'spoofed exit ignored');
  await frame.locator('button.song',{hasText:'Riptide'}).click();
  const child=page.frames().find(f=>f.url().includes('/uke/'));
  await child.waitForFunction(()=>window.__uke.state.view==='play'&&window.__uke.audio.readyState>=1);
  await page.evaluate(()=>window.ontoUke.key(415));
  await child.waitForFunction(()=>window.__uke.state.playing);
  await page.evaluate(()=>window.ontoUke.key(19));
  await child.waitForFunction(()=>!window.__uke.state.playing);
  await page.evaluate(()=>window.ontoUke.key(39));
  await child.waitForFunction(()=>window.__uke.audio.currentTime>5);
  await page.screenshot({path:'/tmp/uke-chart/onto-player.png'});
  await page.evaluate(()=>window.ontoUke.key(10009));
  await child.waitForFunction(()=>window.__uke.state.view==='songs');
  await page.evaluate(()=>window.ontoUke.key(10009));
  await page.locator('#onto-uke').waitFor({state:'detached'});
  assert.equal(await page.locator('#onto-uke').count(),0);
  const local=await browser.newPage();await local.goto('http://localhost:8741/');
  await local.locator('button.song').first().waitFor();await local.close();
  console.log(JSON.stringify({ passed: true, base }));
} finally {
  await browser.close();
  await rm(dir,{recursive:true,force:true});
  await new Promise(resolve => server.close(resolve));
}
