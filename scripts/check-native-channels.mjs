// Real TV model + synthetic catalogue, with a mocked Electron bridge. No real TV commands.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createTvLibrary } from '../src/tv-server.js';
import { libraryView, showsView } from '../src/tv-library-api.js';
import { fetchTvShows } from '../src/tv-home-client.js';
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
let offline = false, delay = 0, calls = [], next = [], artRequests = 0, nextDelay = 0, nextStatus = 200, holdPicture = false;
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('fixtureHome', async (viewers, rating) => {
    calls.push([viewers, rating]); const result = library.home(viewers, rating); const wait = delay;
    if (wait) await new Promise(r=>setTimeout(r,wait));
    if (offline) throw new Error('offline');
    return { ...result, origin: 'http://localhost:8686' };
  });
  // The real show-list client over the real library model, with the fixture catalogue.
  let showCalls = 0, showsOffline = false;
  await page.exposeFunction('fixtureShows', (viewers, rating) => {
    showCalls++;
    return fetchTvShows(viewers, async url => {
      if (showsOffline) throw new Error('offline');
      const view = url.pathname === '/api/shows' ? showsView : libraryView;
      return { ok: true, status: 200, json: async () => view({ videos: library.catalogue(), history: [], viewers: url.searchParams.get('viewers'), rating: url.searchParams.get('rating') }) };
    }, rating, ['http://localhost:8686']);
  });
  // The lounge TV, as the Mac app sees it: it takes a command, or is not on.
  const sentToTv = []; let tvOn = true;
  await page.exposeFunction('fixtureTv', async (...args) => {
    sentToTv.push(args);
    await new Promise(r=>setTimeout(r,120));
    if (!tvOn) throw new Error("Error invoking remote method 'tv-remote:send': Error: The TV is not on Onto the TV.");
    return true;
  });
  await page.addInitScript(() => {
    window.tv = {
      getTvHome: (viewers, rating) => window.fixtureHome(viewers, rating),
      getTvShows: (viewers, rating) => window.fixtureShows(viewers, rating),
      sendToTv: (...args) => window.fixtureTv(...args),
      setPlayOn: async () => {},
      get:async()=>({hasPlayer:false,library:'Fixture library',tvHost:'',avTransportUrl:'',bindHost:'',playOn:'mac',tv:{status:'idle',current:null,upcoming:[],history:[]}}),
      onState:()=>{},onMode:()=>{},onError:()=>{},onCast:()=>{},
    };
  });
  await page.route('http://localhost:8686/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/home') return route.fulfill({json:library.home(url.searchParams.get('viewers'),url.searchParams.get('rating'))});
    if (url.pathname === '/api/next') {
      const body=route.request().postDataJSON();next.push(body);
      if (nextDelay) await new Promise(r=>setTimeout(r,nextDelay));
      if (nextStatus !== 200) return route.fulfill({status:nextStatus,json:{error:'Pair this TV first.'}});
      return route.fulfill({json:library.next(body.channel,body)});
    }
    if (url.pathname === '/api/scenes') return route.fulfill({json:{cuts:[],thumbs:[],segments:[]}});
    if (url.pathname === '/api/subs') return route.fulfill({json:{tracks:[]}});
    if (url.pathname.startsWith('/api/')) return route.fulfill({json:{ok:true}});
    if (url.pathname === '/config.js') return route.fulfill({contentType:'text/javascript',body:'window.ONTO_CONFIG={token:"fixture"};window.__holdPicture='+holdPicture+';'});
    if (url.pathname === '/player.js') return route.fulfill({contentType:'text/javascript',body:`window.ontoPlayer=function(){var on={},t=0,timer=0;function tick(){var list=on.time||[];for(var i=0;i<list.length;i++)list[i]();}return {engine:'video',on:function(name,fn){(on[name]=on[name]||[]).push(fn);},load:function(){clearInterval(timer);t=0;var n=0;timer=setInterval(function(){if(window.__holdPicture)return;t+=0.25;tick();if(++n>=4)clearInterval(timer);},60);},stop:function(){clearInterval(timer);},play:function(){},pause:function(){},seek:function(){},time:function(){return t},duration:function(){return 1200},paused:function(){return true},ended:function(){return false},audioTracks:function(){return []},subtitleTracks:function(){return []},tracks:function(){return []},selectAudio:function(){},selectText:function(){}}};`});
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
  const rated = value => page.locator(`#channel-rating [data-rating="${value}"][aria-pressed="true"]`).waitFor();
  const pick = async name => { await page.locator('#channel-profile').click(); await page.locator(`.picker-person[data-profile="${name.toLowerCase()}"]`).click(); };
  const ratingButton = value => page.getByRole('button',{name:new RegExp('^Rated '+value+'( |$)')});
  // This Mac opens on Ian's profile: rating M is his default.
  await rated('M');
  assert.deepEqual(calls.at(-1),[['dad'],null]);
  assert.equal(await page.locator('#channel-who').textContent(),'Ian');
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.fonts.check('700 14px Nunito')),true);
  await page.waitForFunction(()=>[...document.querySelectorAll('.channel-card')].every(el=>el.querySelector('img')?.naturalWidth));
  assert.deepEqual(await page.locator('#channel-list .channel-number').allTextContents(),library.home('dad').channels.map(c=>String(c.number)));
  assert.equal(await page.locator('#channel-rating .default').textContent(),'M');
  const screenshots=[];
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [name,size] of Object.entries({app:{width:980,height:720},laptop:{width:1280,height:720},small:{width:520,height:560},phone:{width:390,height:844},landscape:{width:844,height:390}})) {
      await page.setViewportSize(size);
      const shot=resolve(out,`${name}-${theme}.png`);
      await assertViewport(page,{primary:['#channel-home'],controls:['#channel-profile','#channel-refresh','#mode-local'],screenshotPath:shot});
      screenshots.push(shot);
    }
  }
  await page.setViewportSize({width:980,height:720});
  // Revisit prepared cards with networking unavailable: no extra request or blank art.
  const before=[calls.length,artRequests];offline=true;
  await page.locator('#mode-tv').click();await page.locator('#mode-local').click();
  assert.deepEqual([calls.length,artRequests],before);
  assert.equal(await page.locator('.channel-picture img').count(),library.home('dad').channels.length);
  offline=false;
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:resolve(out,`adults-${theme}.png`)});
  }
  // One click picks Jake: PG by default.
  await pick('Jake');
  await rated('PG');
  assert.deepEqual(calls.at(-1),[['jake','mum','dad'],null]);
  assert.equal(await page.locator('.channel-card[data-channel="rides"]').count(),1);
  // The rating switch overrides it either way; picking the default clears the override.
  await ratingButton('G').click();
  await rated('G');
  assert.deepEqual(calls.at(-1),[['jake','mum','dad'],'G']);
  assert.equal(await page.locator('.channel-card[data-channel="rides"]').count(),0);
  await ratingButton('PG').click();
  await rated('PG');
  assert.deepEqual(calls.at(-1),[['jake','mum','dad'],null]);
  await ratingButton('M').click();
  await rated('M');
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:resolve(out,`override-${theme}.png`)});
  }
  // The choice survives a reload of the app.
  await page.reload();
  await rated('M');
  assert.deepEqual(calls.at(-1),[['jake','mum','dad'],'M']);
  // Rapid audience changes: the slow adult response cannot restore forbidden picks.
  delay=250;await page.locator('#channel-refresh').click();delay=0;
  await pick('Sam');
  await rated('G');await page.waitForTimeout(300);
  assert.equal(await page.locator('#channel-rating [aria-pressed="true"]').textContent(),'G');
  assert.equal(await page.locator('.channel-card[data-channel="rides"]').count(),0);
  // Card arrows follow the actual grid, and Back returns to the tuned card.
  await page.locator('.channel-card').first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.channel-card').nth(1).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('End');
  assert.equal(await page.locator('.channel-card').last().evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Home');
  assert.equal(await page.locator('.channel-card').first().evaluate(el=>el===document.activeElement),true);
  // Real TV app receives the audience, and its /api/next request retains it.
  // The pressed channel's own card answers the click at once and holds until the player has a picture.
  nextDelay=600; holdPicture=true;
  const pressed = await page.locator('.channel-card').nth(1).getAttribute('data-channel');
  await page.locator('.channel-card').nth(1).click();
  await page.waitForFunction(()=>!document.querySelector('#channel-player').hidden);
  assert.equal(await page.locator('#channel-tuning').isVisible(),true);
  assert.equal(await page.locator('#tuning-name').textContent(),library.home('sam,mum,dad').channels.find(c=>c.id===pressed).name);
  await page.waitForFunction(()=>document.querySelector('#tuning-picture img')?.naturalWidth);
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await assertViewport(page,{primary:['#channel-tuning'],controls:['#channel-back','#tuning-readout']});
    await page.screenshot({path:resolve(out,`tuning-${theme}.png`)});
  }
  // A message still in flight from the tune before does not lift this card or close this tune.
  await page.waitForFunction(()=>window.frames.length>0);
  const early = page.frames().find(f=>f.url().startsWith('http://localhost:8686/'));
  await early.evaluate(()=>{ parent.postMessage({type:'onto:desktop-playing',n:'0'},'*'); parent.postMessage({type:'onto:desktop-home',n:'0'},'*'); });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#channel-tuning').isVisible(),true,'a stale message must not lift the card');
  assert.equal(await page.locator('#channel-player').isHidden(),false,'a stale message must not close the tune');
  for (let i=0;i<50 && !next.length;i++) await page.waitForTimeout(100);
  assert.ok(next.length,'embedded TV player must request an episode');
  assert.equal(next.at(-1).viewers,'sam,mum,dad');
  const frame = page.frames().find(f=>f.url().startsWith('http://localhost:8686/'));
  await frame.locator('#player:visible').waitFor();
  // The server has answered and the episode is loading, with no picture yet: the card stays up, and
  // that is not a fault. It lifts when the picture runs.
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#channel-tuning').isVisible(),true);
  assert.equal(await page.locator('#tuning-retry').isVisible(),false);
  holdPicture=false; await frame.evaluate(()=>{ window.__holdPicture=false; });
  await page.locator('#channel-tuning').waitFor({state:'hidden'});
  nextDelay=0;
  // The TV-scale home is never part of the Mac window.
  assert.equal(await frame.locator('#home').evaluate(el=>getComputedStyle(el).display),'none');
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await assertViewport(page,{primary:['#channel-player'],controls:['#channel-back','#channel-profile']});
    await assertViewport(frame,{primary:['#osd'],controls:['#osd-play','#osd-options','#osd-next']});
    await page.screenshot({path:resolve(out,`player-${theme}.png`)});
  }
  await frame.locator('#osd-options').click();
  assert.deepEqual(errors, []);
  await frame.locator('#options').waitFor({state:'visible',timeout:3000});
  // The TV's ten-foot Library is not offered in the Mac window.
  assert.deepEqual(await frame.locator('#options .opt').evaluateAll(list=>list.map(el=>el.getAttribute('data-opt'))),['subs','audio','ads']);
  await assertViewport(frame,{primary:['#options'],controls:['#options .opt']});
  await page.screenshot({path:resolve(out,'player-options.png')});
  for(const size of [{width:520,height:560},{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(size);
    // Measure the player once it has taken the new size: this step used to pass on the old geometry.
    await frame.waitForFunction(width=>innerWidth===width,size.width);
    await assertViewport(page,{primary:['#channel-player'],controls:['#channel-back']});
    await assertViewport(frame,{primary:['#osd','#options'],controls:['#osd-play','#osd-options','#options .opt']});
    if (size.height===390) { await page.waitForTimeout(500); await page.screenshot({path:resolve(out,'player-options-short.png')}); }
  }
  await page.setViewportSize({width:980,height:720});
  await page.locator('#channel-back').click();
  assert.equal(await page.locator('#channel-player').getAttribute('src'),'about:blank');
  assert.equal(await page.locator('.channel-card').nth(1).evaluate(el=>el===document.activeElement),true);
  // A refused tune (the M2 answered 403 behind its https address until 15 Nov 2026) stays on the
  // channel's card with Retry: never the TV home with a hidden error.
  nextStatus=403;
  await page.locator('.channel-card').nth(1).click();
  await page.locator('#tuning-retry').waitFor();
  assert.match(await page.locator('#tuning-retry').getAttribute('title'),/403/);
  const refused = page.frames().find(f=>f.url().startsWith('http://localhost:8686/'));
  assert.equal(await refused.locator('#home').evaluate(el=>getComputedStyle(el).display),'none');
  // The player page shows its own retry line now (as the TV does); here the app's card covers it.
  assert.equal(await page.locator('#channel-tuning').isVisible(),true);
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await assertViewport(page,{primary:['#channel-tuning'],controls:['#channel-back','#tuning-retry']});
    await page.screenshot({path:resolve(out,`fault-${theme}.png`)});
  }
  nextStatus=200;
  await page.locator('#tuning-retry').click();
  await page.locator('#channel-tuning').waitFor({state:'hidden'});
  await page.frames().find(f=>f.url().startsWith('http://localhost:8686/')).locator('#player:visible').waitFor();
  await page.locator('#channel-back').click();
  assert.equal(await page.locator('#channel-tuning').isVisible(),false);
  // Find a show: a show named in the row plays itself, not whatever a channel has on.
  // The shows are fetched behind the lineup. When that fetch fails nothing is said until a name is typed.
  showsOffline=true;
  await page.locator('#channel-refresh').click();
  await page.waitForFunction(()=>document.querySelectorAll('.channel-card').length>1 && document.querySelector('#channel-state').textContent==='');
  await page.locator('#channel-search').fill('bing');
  await page.waitForFunction(()=>document.querySelector('#channel-state').textContent==='⚠');
  assert.equal(await page.locator('.channel-card').count(),0);
  showsOffline=false;await page.locator('#channel-feedback').click();
  await page.locator('.channel-card').first().waitFor();
  assert.deepEqual(await page.locator('.channel-card .picture-label').allTextContents(),['Bing']);
  await page.waitForFunction(()=>document.querySelector('.channel-card .channel-picture img')?.naturalWidth);
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await assertViewport(page,{primary:['#channel-home'],controls:['#channel-search','#channel-profile','#channel-refresh']});
    await page.screenshot({path:resolve(out,`find-${theme}.png`)});
  }
  const asked=next.length;
  await page.locator('#channel-search').press('Enter');
  assert.equal(await page.locator('#tuning-name').textContent(),'Bing');
  await page.locator('#channel-tuning').waitFor({state:'hidden'});
  const named = page.frames().find(f=>f.url().startsWith('http://localhost:8686/'));
  assert.equal(new URL(named.url()).searchParams.get('play'),videos.find(v=>v.channel==='Bing').src);
  await named.locator('#player:visible').waitFor();
  assert.equal(next.length,asked,'a named show is not a channel pick');
  await page.locator('#channel-back').click();
  // A grown-up show is not offered to Sam, and clearing the field brings the channels back.
  await page.locator('#channel-search').fill('good place');
  await page.waitForFunction(()=>document.querySelector('#channel-state').textContent==='∅');
  assert.equal(await page.locator('.channel-card').count(),0);
  await page.locator('#channel-search').fill('');
  await page.waitForFunction(()=>document.querySelectorAll('.channel-card').length>1 && document.querySelector('#channel-state').textContent==='');
  // Ian's lineup, by contrast, finds it; switching back to Sam must not leave it on screen.
  await pick('Ian');await rated('M');
  await page.locator('#channel-search').fill('good place');
  await page.locator('.channel-card').first().waitFor();
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:resolve(out,`find-now-${theme}.png`)});
  }
  await pick('Sam');await rated('G');
  await page.waitForFunction(()=>document.querySelector('#channel-state').textContent==='∅');
  assert.equal(await page.locator('.channel-card').count(),0);
  await page.locator('#channel-search').fill('');
  await page.waitForFunction(()=>document.querySelectorAll('.channel-card').length>1);
  // Play on TV: the card goes to the lounge TV instead of this window, and wears the TV mark.
  await page.locator('[data-play-on="tv"]').click();
  const sendCard = page.locator('.channel-card').nth(1), sendId = await sendCard.getAttribute('data-channel');
  await sendCard.click();
  assert.equal(await sendCard.getAttribute('data-tv'),'sending');
  await page.waitForFunction(id=>document.querySelector(`.channel-card[data-channel="${id}"]`).dataset.tv==='on',sendId);
  assert.deepEqual(sentToTv.at(-1),['http://localhost:8686','tune',sendId]);
  assert.equal(await page.locator('#channel-player').isHidden(),true);
  for (const theme of ['dark','light']) {
    await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:resolve(out,`on-tv-${theme}.png`)});
  }
  // A found show sends the episode it opens on.
  await page.locator('#channel-search').fill('bing');
  await page.locator('.channel-card .picture-label').first().waitFor();
  await page.locator('#channel-search').press('Enter');
  await page.waitForFunction(()=>document.querySelector('.channel-card')?.dataset.tv==='on');
  assert.deepEqual(sentToTv.at(-1),['http://localhost:8686','play',videos.find(v=>v.channel==='Bing').src,null]);
  await page.locator('#channel-search').fill('');
  await page.waitForFunction(()=>document.querySelectorAll('.channel-card').length>1);
  // A TV that is not on says so, and the card is left as it was.
  tvOn=false;
  await page.locator('.channel-card').first().click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='The TV is not on Onto the TV.');
  assert.equal(await page.locator('.channel-card').first().getAttribute('data-tv'),null);
  assert.equal(await page.locator('#status').evaluate(el=>el.classList.contains('is-fault')),true);
  tvOn=true;
  // Back on Mac, a card plays here again.
  await page.locator('[data-play-on="mac"]').click();
  await page.locator('.channel-card').nth(1).click();
  await page.locator('#channel-tuning').waitFor({state:'hidden'});
  await page.frames().find(f=>f.url().startsWith('http://localhost:8686/')).locator('#player:visible').waitFor();
  await page.locator('#channel-back').click();
  // An offline audience change clears earlier cards.
  offline=true;await pick('Jake');
  await page.waitForFunction(()=>document.querySelector('#channel-state').textContent==='⚠');
  assert.equal(await page.locator('.channel-card').count(),0);
  assert.equal(await page.locator('#channel-feedback').isVisible(),true);
  offline=false;await page.locator('#channel-feedback').click();await rated('PG');
  // Full long titles wrap instead of being lost in an ellipsis.
  await page.locator('.channel-name').first().evaluate(el=>el.textContent='Rides & Adventures around the world');
  await page.locator('.channel-now').first().evaluate(el=>el.textContent='▶ The extraordinary adventures of a family travelling across Australia');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:resolve(out,'long-titles-phone.png')});
  for(const selector of ['.channel-name','.channel-now']) {
    const bounds = await page.locator(selector).first().evaluate(el=>({width:el.clientWidth,height:el.clientHeight,scrollWidth:el.scrollWidth,scrollHeight:el.scrollHeight}));
    assert.ok(bounds.scrollWidth<=bounds.width+1 && bounds.scrollHeight<=bounds.height+1, JSON.stringify({selector,...bounds}));
  }
  await page.setViewportSize({width:980,height:720});
  await page.locator('#library-toggle').click();
  await assertViewport(page,{primary:['#library-settings'],controls:['#library-close']});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{
    const els=[...document.querySelectorAll('body *')],sizes=els.map(el=>parseFloat(getComputedStyle(el).fontSize));
    els.forEach((el,i)=>el.style.fontSize=`${sizes[i]*2}px`);
  });
  await assertViewport(page,{primary:['#channel-home'],controls:['#channel-profile','#channel-refresh','#mode-local'],screenshotPath:resolve(out,'large-text.png')});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,screenshots,out}));
} finally {await browser.close();}
