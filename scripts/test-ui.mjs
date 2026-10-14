import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || pathToFileURL(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const { assertViewport } = await import(process.env.VIEWPORT_CHECK_MODULE || pathToFileURL(resolve('../.ux-authoring/viewport-fit.mjs')).href);
await mkdir('audit', { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    let listener;
    const state = {status:'playing', tvHost:'192.168.1.50', current:{title:'Example film.mp4', path:'/example.mp4', positionSeconds:120, durationSeconds:7200, seekable:true, chapters:[{title:'Opening',startSeconds:0},{title:'The discovery',startSeconds:900}],points:[]}, upcoming:[], history:[
      {path:'/example.mp4',title:'Example film.mp4',positionSeconds:120,durationSeconds:7200,completed:false,updatedAt:'2026-09-19T09:10:00Z'},
      ...Array.from({length:24}, (_,i) => ({path:`/film-${i}.mp4`,title:`Film ${i+1} — A long title for checking history layout.mp4`,positionSeconds:300,durationSeconds:1000,completed:i%2===0,updatedAt:'2026-09-18T10:15:00Z'}))]};
    window.calls = [];
    window.fixtureState = state;
    window.updateTv = value => { Object.assign(state, value); listener(structuredClone(state)); };
    window.tv = {
      get:async()=>({tvHost:'192.168.1.50',avTransportUrl:'',bindHost:'',hasPlayer:false,library:'/Example library',tv:structuredClone(state)}),
      onState:fn=>{listener=fn;}, onMode:fn=>{window.setAppMode=fn;},onError:()=>{},onCast:()=>{},
      seek:async value=>{window.calls.push(['seek',value]);state.current.positionSeconds=value;listener(structuredClone(state));},
      pause:async()=>{window.calls.push(['pause']);state.status='paused';listener(structuredClone(state));},
      resume:async()=>{state.status='playing';listener(structuredClone(state));},
      stop:async()=>{state.current=null;state.status='idle';listener(structuredClone(state));},
      choose:async enqueue=>{window.calls.push(['choose',enqueue]);return state;},
      openFiles:async paths=>{window.calls.push(['open',paths]);window.setAppMode('tv');},
      addPoint:async (title,path)=>{state.current.points.push({id:'point-1',title,positionSeconds:state.current.positionSeconds});window.calls.push(['point',title,path]);listener(structuredClone(state));},
      removePoint:async id=>{state.current.points=state.current.points.filter(point=>point.id!==id);listener(structuredClone(state));},
      next:async()=>{},saveTv:async()=>{},pathFor:()=>'/another.mp4',recordHistory:async()=>{},
    };
  });
  await page.goto(pathToFileURL(resolve('ui/index.html')).href);
  await page.getByRole('button',{name:'TV', exact:true}).click();
  await page.context().setOffline(true);
  const sizes = { app:{width:980,height:720}, minimum:{width:520,height:560}, laptop:{width:1280,height:720}, phone:{width:390,height:844}, small:{width:360,height:640}, landscape:{width:844,height:390} };
  for (const [name,size] of Object.entries(sizes)) {
    await page.setViewportSize(size);
    await assertViewport(page, {primary:[{selector:'#deck',minWidth:280,minHeight:90}], controls:['#mode-tv','#mode-history','#rewind','#forward','#progress','#stop','#gate'], screenshotPath:resolve(`audit/tv-${name}.png`)});
    await page.locator('#scene-points summary').click();
    await assertViewport(page,{primary:['#deck'],controls:['#point-title','#point-form button','#rewind','#forward'],screenshotPath:resolve(`audit/scenes-${name}.png`)});
    await page.locator('#scene-points summary').click();
    await page.getByRole('button',{name:'History',exact:true}).click();
    await assertViewport(page, {primary:[{selector:'#history-list',minWidth:280,minHeight:100}], controls:['#mode-tv','#mode-history'], screenshotPath:resolve(`audit/history-${name}.png`)});
    await page.getByRole('button',{name:'TV',exact:true}).click();
  }
  await page.setViewportSize(sizes.app);
  await page.getByRole('button',{name:'Forward 30 seconds',exact:true}).click({clickCount:3,delay:20});
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(x=>x[0]==='seek')), [['seek',210]]);
  await page.locator('#progress').focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.calls.at(-1)[1]),7199);
  await page.locator('#scene-points summary').click();
  await page.getByRole('button',{name:'15:00 · The discovery',exact:true}).click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.calls.at(-1)[1]),900);
  await page.getByRole('textbox',{name:'Scene name',exact:true}).fill('The reveal');
  await page.getByRole('button',{name:'Save point',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'15:00 · The reveal',exact:true}).isVisible(),true);
  await page.getByRole('button',{name:'Remove scene point The reveal',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'15:00 · The reveal',exact:true}).count(),0);
  await assertViewport(page,{primary:['#deck'],controls:['#point-title','#point-form button'],screenshotPath:resolve('audit/scene-points.png')});
  await page.locator('#scene-points summary').click();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.getByRole('button',{name:'Back 10 seconds',exact:true}).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#resume').isVisible(),true);
  await page.getByRole('button',{name:'History',exact:true}).click();
  const resume=page.getByRole('button',{name:'Resume on TV Example film.mp4',exact:true});
  await resume.focus();
  await page.evaluate(()=>window.updateTv({}));
  assert.equal(await resume.evaluate(el=>document.activeElement===el),true);
  await resume.click();
  assert.deepEqual(await page.evaluate(()=>window.calls.at(-1)),['open',['/example.mp4']]);
  // A pending seek must be discarded when a different file opens.
  await page.getByRole('button',{name:'Forward 30 seconds',exact:true}).click();
  const before=await page.evaluate(()=>window.calls.length);
  await page.evaluate(()=>window.updateTv({current:{...window.fixtureState.current,path:'/different.mp4'}}));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>window.calls.length),before);
  await page.locator('#tv-settings summary').first().click();
  await page.locator('#tv-host').fill('192.168.1.60');
  await page.locator('#tv-settings summary').first().click();
  await page.getByRole('button',{name:'Library settings',exact:true}).click();
  await assertViewport(page,{primary:['#library-settings'],controls:['#library-close'],screenshotPath:resolve('audit/library-panel.png')});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#library-toggle').evaluate(el=>document.activeElement===el),true);
  // Enlarge all rendered text, including fixed-pixel labels, without hiding overflow.
  await page.evaluate(()=>{
    for(const el of document.querySelectorAll('button,p,h1,h2,span,summary,label,input')) el.style.fontSize=`${parseFloat(getComputedStyle(el).fontSize)*2}px`;
  });
  await assertViewport(page,{primary:['#deck'],controls:['#rewind','#forward','#stop','#gate'],screenshotPath:resolve('audit/tv-large-text.png')});
  assert.deepEqual(errors,[]);
  console.log('TV controls, history, file switching, six viewports, settings and enlarged text passed.');
} finally { await browser.close(); }
