// Real TV model + synthetic catalogue, with a mocked Electron bridge. No real TV commands.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createTvLibrary } from '../src/tv-server.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || pathToFileURL(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const { assertViewport } = await import(process.env.VIEWPORT_MODULE || new URL('./lib/viewport-fit.mjs', import.meta.url).href);
const out = resolve('audit/native-channels');
await mkdir(out, { recursive: true });
const videos = [
  ['Bluey', 'shared'], ['Bing', 'preschool'], ['Gravity Falls', 'big'], ['Family film', 'shared'],
  ['The Good Place', 'sitcom'], ['A concert', 'music'], ['Knight Rider (1982)', 'classic'],
  ['A grown-up film', 'grownup'], ['Airwolf', 'older'], ['Space', 'scifi'], ['Wild Australia', 'docs'],
  ['Comedy', 'comedy'], ['1950s', '50s'], ['1960s', '60s'], ['1970s', '70s'], ['1980s', '80s'], ['1990s', '90s'],
  ['Sports', 'sports'], ['Hop Hop', 'preschool'],
].map(([channel, tier], i) => ({ channel, tier, src: `show${i}.mp4`, file: `/fixture/show${i}.mp4`, title: `${channel} episode`, duration: 1200 }));
const saved = new Map();
const library = createTvLibrary({ videos, history: {get:()=>0, list:()=>[]}, storage:{getItem:k=>saved.get(k), setItem:(k,v)=>saved.set(k,v)}, random:()=>0 });
const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE, channel:process.env.CHROMIUM_EXECUTABLE ? undefined : 'chrome', args:['--mute-audio']});
let offline = false, delay = 0, calls = [], next = [], artRequests = 0;
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fixtureHome', async viewers => {
    calls.push(viewers); const result = library.home(viewers); const wait = delay;
    if (wait) await new Promise(r=>setTimeout(r,wait));
    if (offline) throw new Error('offline');
    return result;
  });
  await page.addInitScript(() => {
    window.tv = {
      getTvHome: viewers => window.fixtureHome(viewers),
      get:async()=>({hasPlayer:false,library:'Fixture library',tvHost:'',avTransportUrl:'',bindHost:'',tv:{status:'idle',current:null,upcoming:[],history:[]}}),
      onState:()=>{},onMode:()=>{},onError:()=>{},onCast:()=>{},
    };
  });
  await page.route('http://localhost:8686/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/home') return route.fulfill({json:library.home(url.searchParams.get('viewers'))});
    if (url.pathname === '/api/next') {
      const body=route.request().postDataJSON();next.push(body);
      return route.fulfill({json:library.next(body.channel,body)});
    }
    if (url.pathname === '/api/scenes') return route.fulfill({json:{cuts:[],thumbs:[],segments:[]}});
    if (url.pathname === '/api/subs') return route.fulfill({json:{tracks:[]}});
    if (url.pathname.startsWith('/api/')) return route.fulfill({json:{ok:true}});
    if (url.pathname === '/config.js') return route.fulfill({contentType:'text/javascript',body:'window.ONTO_CONFIG={token:"fixture"};'});
    if (url.pathname === '/player.js') return route.fulfill({contentType:'text/javascript',body:`window.ontoPlayer=function(){return {engine:'video',on:function(){},load:function(){},stop:function(){},play:function(){},pause:function(){},seek:function(){},time:function(){return 0},duration:function(){return 1200},paused:function(){return true},ended:function(){return false},audioTracks:function(){return []},subtitleTracks:function(){return []},tracks:function(){return []},selectAudio:function(){},selectText:function(){}}};`});
    if (url.pathname === '/art') {
      artRequests++;
      if (offline) return route.abort();
      return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#244c70"/><circle cx="480" cy="90" r="65" fill="#ffb547"/><path d="M0 360 180 100 400 360" fill="#14213d"/></svg>'});
    }
    const file=resolve('tv',url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const type={'.js':'text/javascript','.css':'text/css','.woff':'font/woff','.svg':'image/svg+xml','.html':'text/html'}[extname(file)] || 'application/octet-stream';
    try { return route.fulfill({body:await readFile(file),contentType:type}); } catch { return route.fulfill({status:404,body:''}); }
  });
  await page.goto(pathToFileURL(resolve('ui/index.html')).href);
  await page.locator('#channel-ceiling[data-rating="G"]').waitFor();
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.fonts.check('700 14px Nunito')),true);
  await page.waitForFunction(()=>[...document.querySelectorAll('.channel-card')].every(el=>el.querySelector('img')?.naturalWidth));
  assert.deepEqual(await page.locator('.channel-number').allTextContents(),library.home().channels.map(c=>String(c.number)));
  assert.equal(await page.locator('.channel-name').getByText('Rides & Adventures',{exact:true}).count(),0);
  const screenshots=[];
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [name,size] of Object.entries({app:{width:980,height:720},laptop:{width:1280,height:720},small:{width:520,height:560},phone:{width:390,height:844},landscape:{width:844,height:390}})) {
      await page.setViewportSize(size);
      const shot=resolve(out,`${name}-${theme}.png`);
      await assertViewport(page,{primary:['#channel-home'],controls:['#channel-viewers','#channel-refresh','#mode-local'],screenshotPath:shot});
      screenshots.push(shot);
    }
  }
  await page.setViewportSize({width:980,height:720});
  // Revisit prepared cards with networking unavailable: no extra request or blank art.
  const before=[calls.length,artRequests];offline=true;
  await page.locator('#mode-tv').click();await page.locator('#mode-local').click();
  assert.deepEqual([calls.length,artRequests],before);
  assert.equal(await page.locator('.channel-picture img').count(),library.home().channels.length);
  offline=false;
  await page.getByRole('checkbox',{name:'Sam',exact:true}).uncheck();
  await page.locator('#channel-ceiling[data-rating="PG"]').waitFor();
  assert.equal(await page.locator('.channel-name').getByText('Rides & Adventures',{exact:true}).count(),1);
  await page.getByRole('checkbox',{name:'Jake',exact:true}).uncheck();
  await page.locator('#channel-ceiling[data-rating="M"]').waitFor();
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:resolve(out,`adults-${theme}.png`)});
  }
  // Rapid ceiling changes: the slow adult response cannot restore forbidden picks.
  delay=250;await page.locator('#channel-refresh').click();delay=0;
  await page.getByRole('checkbox',{name:'Sam',exact:true}).check();
  await page.locator('#channel-ceiling[data-rating="G"]').waitFor();await page.waitForTimeout(300);
  assert.equal(await page.locator('#channel-ceiling').textContent(),'G');
  assert.equal(await page.locator('.channel-name').getByText('Rides & Adventures',{exact:true}).count(),0);
  // Real TV app receives the audience, and its /api/next request retains it.
  await page.locator('.channel-card').first().click();
  await page.waitForFunction(()=>!document.querySelector('#channel-player').hidden);
  for (let i=0;i<50 && !next.length;i++) await page.waitForTimeout(100);
  assert.ok(next.length,'embedded TV player must request an episode');
  assert.equal(next.at(-1).viewers,'sam,mum,dad');
  const frame = page.frames().find(f=>f.url().startsWith('http://localhost:8686/'));
  await frame.locator('#player:visible').waitFor();
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await assertViewport(page,{primary:['#channel-player'],controls:['#channel-back','#channel-viewers']});
    await assertViewport(frame,{primary:['#osd'],controls:['#osd-play','#osd-options','#osd-next']});
    await page.screenshot({path:resolve(out,`player-${theme}.png`)});
  }
  await frame.locator('#osd-options').click();
  assert.deepEqual(errors, []);
  await frame.locator('#options').waitFor({state:'visible',timeout:3000});
  await assertViewport(frame,{primary:['#options'],controls:['#options .opt']});
  await page.screenshot({path:resolve(out,'player-options.png')});
  for(const size of [{width:520,height:560},{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(size);
    await assertViewport(page,{primary:['#channel-player'],controls:['#channel-back']});
    await assertViewport(frame,{primary:['#osd','#options'],controls:['#osd-play','#osd-options','#options .opt']});
  }
  await page.setViewportSize({width:980,height:720});
  await page.locator('#channel-back').click();
  assert.equal(await page.locator('#channel-player').getAttribute('src'),'about:blank');
  // Empty audience fails closed, and an offline viewer change clears earlier cards.
  for(const name of ['Sam','Mum','Dad']) await page.getByRole('checkbox',{name,exact:true}).uncheck();
  await page.waitForFunction(()=>document.querySelector('#channel-state').textContent==='∅');
  assert.equal(await page.locator('.channel-card').count(),0);
  offline=true;await page.getByRole('checkbox',{name:'Jake',exact:true}).check();
  await page.waitForFunction(()=>document.querySelector('#channel-state').textContent==='⚠');
  assert.equal(await page.locator('.channel-card').count(),0);
  offline=false;await page.locator('#channel-refresh').click();await page.locator('#channel-ceiling[data-rating="PG"]').waitFor();
  await page.locator('#library-toggle').click();
  await assertViewport(page,{primary:['#library-settings'],controls:['#library-close']});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    const els=[...document.querySelectorAll('body *')],sizes=els.map(el=>parseFloat(getComputedStyle(el).fontSize));
    els.forEach((el,i)=>el.style.fontSize=`${sizes[i]*2}px`);
  });
  await assertViewport(page,{primary:['#channel-home'],controls:['#channel-viewers','#channel-refresh','#mode-local'],screenshotPath:resolve(out,'large-text.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,screenshots,out}));
} finally {await browser.close();}
