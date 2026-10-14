import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || pathToFileURL(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const { assertViewport } = await import(pathToFileURL(resolve('../.ux-authoring/viewport-fit.mjs')).href);
const fixture = process.env.LIBRARY_FIXTURE ? JSON.parse(await readFile(process.env.LIBRARY_FIXTURE, 'utf8')) : {
  items: Array.from({length:20}, (_, i) => ({path:`/film-${i}.mp4`,title:`Film ${i + 1}`,kind:'film',positionSeconds:i === 0 ? 240 : 0,durationSeconds:1800,completed:false})), artwork:{}
};
await mkdir('audit', {recursive:true});
const browser = await chromium.launch({headless:true,channel:'chrome',args:['--mute-audio']});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fixture => {
    let listener;
    const state = {status:'playing',current:null,upcoming:[],history:fixture.items.filter(x => x.positionSeconds > 5),tvHost:'192.0.2.10'};
    window.calls=[];
    window.updateTv = () => listener(structuredClone(state));
    window.tv = {
      get:async()=>({hasPlayer:false,tv:state,library:'Example',playerPath:'',tvHost:state.tvHost,avTransportUrl:'',bindHost:''}),
      onState:fn=>listener=fn,onMode:fn=>window.setAppMode=fn,onError:()=>{},onCast:()=>{},
      getLibrary:async()=>{window.calls.push(['library']);await new Promise(r=>setTimeout(r,80));return fixture;},
      libraryArtwork:async path=>{window.calls.push(['artwork',path]);await new Promise(r=>setTimeout(r,60));return fixture.artwork[path] || null;},
      openFiles:async paths=>{window.calls.push(['open',paths]);return state;},
      addLibraryFolder:async()=>fixture,pathFor:()=>'',recordHistory:async()=>{},
    };
  },fixture);
  await page.goto(pathToFileURL(resolve('ui/index.html')).href);
  await page.getByRole('button',{name:'Library',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.library-card').length > 0);
  await page.context().setOffline(true);
  await page.waitForTimeout(250);
  const sizes = {laptop:{width:1280,height:720},app:{width:980,height:720},phone:{width:390,height:844},small:{width:360,height:640},landscape:{width:844,height:390}};
  for (const [name,size] of Object.entries(sizes)) {
    await page.setViewportSize(size);
    await page.evaluate(()=>{document.querySelector('#library-view').scrollTop=0;});
    await assertViewport(page,{primary:[{selector:'#library-view',minWidth:280,minHeight:130}],controls:['#mode-library','#library-search','[data-library-filter="film"]'],screenshotPath:resolve(`audit/library-${name}.png`)});
  }
  await page.setViewportSize(sizes.app);
  const item=fixture.items.find(x=>x.positionSeconds>5 && !x.completed);
  assert.ok(item);
  await page.locator('#library-search').fill(item.title);
  await page.waitForTimeout(100);
  const tile=page.locator('#library-list').getByRole('button',{name:`Resume on TV ${item.title}`,exact:true});
  await tile.focus(); await page.evaluate(()=>window.updateTv());
  assert.equal(await tile.evaluate(el=>el===document.activeElement),true);
  await tile.click();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(x=>x[0]==='open')), [['open',[item.path]]]);
  await page.getByRole('button',{name:'Library',exact:true}).click();
  await page.locator('#library-search').fill('No title matches this string');
  assert.equal(await page.locator('#library-list .library-card').count(),0);
  assert.equal(await page.locator('#library-empty').isVisible(),true);
  await page.locator('#library-search').fill('');
  await page.locator('[data-library-filter="film"]').click();
  assert.equal(await page.locator('#library-list .library-card').count(),fixture.items.filter(x=>x.kind==='film').length);
  await page.getByRole('button',{name:'Library settings',exact:true}).click();
  await assertViewport(page,{primary:['#library-settings'],controls:['#choose-media-folder','#library-close'],screenshotPath:resolve('audit/library-settings.png')});
  await page.locator('#library-close').click();
  // Enlarge every text size, including px declarations; the gallery can scroll.
  await page.evaluate(()=>{
    const elements=[...document.querySelectorAll('body *')];
    const sizes=elements.map(el=>parseFloat(getComputedStyle(el).fontSize));
    elements.forEach((el,i)=>el.style.fontSize=`${sizes[i]*2}px`);
  });
  await assertViewport(page,{documentY:'allow',primary:[{selector:'#library-view',fit:'visible',minHeight:100}],controls:['#mode-library','#library-search'],screenshotPath:resolve('audit/library-text-200.png')});
  assert.deepEqual(errors,[]);
  console.log('Library tiles, search, resume, filters, offline reuse and viewport checks passed.');
} finally { await browser.close(); }
