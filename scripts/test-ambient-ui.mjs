import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createAmbientSources, DEFAULT_AMBIENT_OPTIONS } from '../src/ambient-sources.js';
import { readIsobarProgramme } from '../src/weather-channel.js';
const { chromium } = await import(pathToFileURL(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const { assertViewport } = await import(pathToFileURL(resolve('../.ux-authoring/viewport-fit.mjs')).href);
const source = await createAmbientSources().snapshot();
const programme = await readIsobarProgramme();
if (programme) source.slides.unshift(programme.slide);
const fixture = { ...source, options:DEFAULT_AMBIENT_OPTIONS, photo:pathToFileURL(resolve('brand/onto-the-tv-icon.png')).href };
await mkdir('audit', { recursive:true });
const browser = await chromium.launch({headless:true,channel:'chrome',args:['--mute-audio']});
try {
  const page = await browser.newPage(); const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.addInitScript(fixture=>{
    let options={...fixture.options}; window.calls=[];
    const state={status:'playing',current:null,upcoming:[],history:[],tvHost:'192.0.2.10'};
    async function snapshot(input) {
      await new Promise(r=>setTimeout(r,100));
      const opt={...options,...input};
      return {options:opt,locations:fixture.locations,issues:[],slides:[
        ...(opt.weather ? fixture.slides : []),
        ...(opt.news ? [{kind:'news',eyebrow:'BBC News · Test fixture',title:'A long headline checks the weather channel preview across smaller screens and larger text sizes',detail:'World news',footer:'Preview fixture'}] : []),
        ...(opt.photos ? [{kind:'photo',title:'Photo 1',image:fixture.photo,footer:'1 of 1'}] : []),
      ]};
    }
    window.tv={
      get:async()=>({hasPlayer:false,tv:state,library:'Example',playerPath:'',tvHost:state.tvHost,avTransportUrl:'',bindHost:''}),
      onState:()=>{},onMode:()=>{},onError:()=>{},onCast:()=>{},onAmbient:()=>{},
      getAmbient:async input=>{window.calls.push(['get']);return snapshot(input);},
      saveAmbient:async input=>{window.calls.push(['save',input]);options=input;return snapshot(input);},
      chooseAmbientPhotos:async()=>{options={...options,photos:true,photoFolder:'/fixture/photos'};window.calls.push(['photos']);return snapshot();},
      startAmbient:async input=>{window.calls.push(['start',input]);return state;},
    };
  },fixture);
  await page.goto(pathToFileURL(resolve('ui/index.html')).href);
  await page.locator('#mode-ambient').click();
  await page.locator('#ambient-stage .ambient-slide').waitFor();
  await page.waitForTimeout(900);
  assert.equal((await page.evaluate(()=>window.calls)).filter(x=>x[0]==='start').length,0);
  await page.locator('[data-ambient-kind="news"]').click();
  await page.waitForFunction(()=>window.calls.some(x=>x[0]==='save' && x[1].news));
  await page.waitForTimeout(150);
  for (let i=0;i<fixture.slides.length;i++) { await page.locator('#ambient-next').click(); await page.waitForTimeout(50); }
  await page.waitForTimeout(850);
  assert.match(await page.locator('#ambient-stage').innerText(),/long headline/);
  await page.evaluate(()=>window.ambientView.showSlide(0)); await page.waitForTimeout(850);
  if (programme) assert.equal(await page.locator('#ambient-stage video').evaluate(video=>video.muted && !video.paused),true);
  await page.context().setOffline(true);
  const count=await page.evaluate(()=>window.calls.filter(x=>x[0]==='get').length);
  await page.locator('#mode-tv').click(); await page.locator('#mode-ambient').click();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x[0]==='get').length),count);
  const sizes={app:{width:980,height:720},laptop:{width:1280,height:720},short:{width:1024,height:600},phone:{width:390,height:844},small:{width:360,height:640},landscape:{width:844,height:390}};
  for(const [name,size] of Object.entries(sizes)) {
    await page.setViewportSize(size);
    await assertViewport(page,{primary:[{selector:'#ambient-stage',minWidth:240,minHeight:130}],controls:['#mode-ambient','#ambient-next','#ambient-start','[data-ambient-kind="news"]'],screenshotPath:resolve(`audit/ambient-${name}.png`)});
  }
  await page.setViewportSize(sizes.app);
  await page.locator('#ambient-start').click();
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x[0]==='start').length),1);
  await page.locator('[data-ambient-kind="weather"]').click();
  await page.locator('[data-ambient-kind="news"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#ambient-start').isDisabled(),true);
  assert.equal(await page.locator('#ambient-stage').innerText(),'');
  await page.locator('[data-ambient-kind="weather"]').click(); await page.waitForTimeout(150);
  await page.locator('[data-ambient-kind="photos"]').click();
  await page.waitForFunction(()=>window.calls.some(x=>x[0]==='photos'));
  await page.waitForTimeout(150);
  await page.evaluate(()=>window.ambientView.showSlide(-1));
  assert.equal(await page.locator('#ambient-stage img').evaluate(image=>image.complete && image.naturalWidth>0),true);
  await page.locator('[data-ambient-kind="photos"]').click(); await page.waitForTimeout(150);
  await page.locator('.ambient-more summary').click();
  await assertViewport(page,{primary:['#ambient-stage'],controls:['#ambient-location','#ambient-pace','#ambient-photos'],screenshotPath:resolve('audit/ambient-options.png')});
  await page.evaluate(()=>{const nodes=[...document.querySelectorAll('body *')];const sizes=nodes.map(el=>parseFloat(getComputedStyle(el).fontSize));nodes.forEach((el,i)=>el.style.fontSize=`${sizes[i]*2}px`);});
  await assertViewport(page,{documentY:'allow',primary:[{selector:'#ambient-view',fit:'visible',minHeight:100}],controls:['#mode-ambient'],screenshotPath:resolve('audit/ambient-text-200.png')});
  assert.deepEqual(errors,[]);
  console.log('Screensaver options, explicit start, offline reuse, empty state, navigation and six viewport sizes passed.');
} finally { await browser.close(); }
