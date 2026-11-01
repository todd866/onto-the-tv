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
const token="command-fixture";
const server = createTvServer({ library, history, storage, uiRoot, token,
  ukeHandler: createConfiguredUkeHandler({ root: new URL('../../uke/', import.meta.url).pathname, controllerToken:token }) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('PAGEERROR', error.message));
  page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
  page.on('response', response => { if (response.status() >= 400) console.error('HTTP', response.status(), response.url()); });

  const auth={'Content-Type':'application/json','X-Onto-Token':token};
  async function request(path,body,headers=auth) {const r=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
  assert.equal((await request('/api/tv-command',{session:'s',action:'uke-open'},{'Content-Type':'application/json'})).status,403);
  await page.route('**/uke/songs/index.json',async route=>{await new Promise(r=>setTimeout(r,1000));await route.continue();});
  await page.route('**/config.js',route=>route.fulfill({contentType:'text/javascript',body:'window.ONTO_CONFIG='+JSON.stringify({token,build:'test-command'})+';'}));
  await page.goto(base+'/');await page.locator('.tile.focused').waitFor();await page.waitForTimeout(300);
  const sessions=(await request('/api/diagnostics')).body.sessions;const session=sessions.at(-1).session;
  async function command(action) {
    const result=await request('/api/tv-command',{session,action});assert.equal(result.status,202);const id=result.body.id;
    await page.evaluate(()=>window.ontoDiagnostics.emit('heartbeat'));
    for(let i=0;i<35;i++){const result=(await request('/api/tv-command?id='+id)).body;if(result.result){assert.equal(result.result.status,'done',JSON.stringify(result));return;}await page.waitForTimeout(500);}
    throw Error('Command timed out: '+action);
  }
  await command('uke-phone');
  const child=page.frames().find(f=>f.url().includes('/uke/'));assert.ok(child);
  const initial=await child.evaluate(()=>window.__uke.practice.status());assert.equal(initial.active,true);assert.match(initial.code,/^\d{6}$/);
  await command('uke-follow');assert.equal(await child.evaluate(()=>window.__uke.practice.following),true);
  const code=initial.code;
  await page.evaluate(()=>window.postMessage({type:'uke:practice-status',status:{active:true,code:'999999'}},'*'));
  await command('uke-state');
  const snapshot=(await request('/api/diagnostics')).body.sessions.find(x=>x.session===session);assert.equal(snapshot.uke.code,code);assert.equal(snapshot.uke.following,true);
  // Source and invalid division checks: a page cannot spoof the trusted parent.
  await child.evaluate(()=>window.postMessage({type:'uke:practice-stop'},'*'));assert.equal(await child.evaluate(()=>window.__uke.practice.status().active),true);
  await page.evaluate(()=>document.querySelector('#onto-uke').contentWindow.postMessage({type:'uke:practice-follow',enabled:true,division:999},location.origin));
  await page.waitForTimeout(100);assert.equal(await child.evaluate(()=>window.__uke.practice.status().division),1);
  await page.screenshot({path:'/private/tmp/onto-uke-command.png'});
  console.log(JSON.stringify({passed:true,authenticated:true,delayedCatalog:true,phoneOpened:true,following:true,spoofRejected:true}));

} finally {
  await browser.close();
  await rm(dir,{recursive:true,force:true});
  await new Promise(resolve => server.close(resolve));
}
