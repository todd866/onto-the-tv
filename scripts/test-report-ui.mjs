import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || pathToFileURL(resolve(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const { assertViewport } = await import(process.env.VIEWPORT_CHECK_MODULE || '/Users/iantodd/Projects/.ux-authoring/viewport-fit.mjs');
await mkdir('audit', { recursive: true });
const [template, player] = await Promise.all([readFile('shuffler/player.html', 'utf8'), readFile('shuffler/player.js', 'utf8')]);
const videos = [
  {src:'Example/A.mp4', channel:'Example', title:'Example A', tier:'shared', duration:120},
  {src:'Example/B.mp4', channel:'Example', title:'Example B', tier:'shared', duration:180},
];
// Deterministic media with no decoder/network dependency. All actual controls and CSS are unchanged.
const media = `
  Object.defineProperties(HTMLMediaElement.prototype, {
    src:{get(){return this.fixtureSrc || '';},set(value){this.fixtureSrc=value;}},
    paused:{get(){return this.fixturePaused !== false;}}, duration:{get(){return 120;}}, readyState:{get(){return 4;}}
  });
  HTMLMediaElement.prototype.play=function(){this.fixturePaused=false;this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('playing'));return Promise.resolve();};
  HTMLMediaElement.prototype.pause=function(){this.fixturePaused=true;this.dispatchEvent(new Event('pause'));};
  HTMLMediaElement.prototype.load=function(){};
`;
const source = template.replace('__VIDEOS__', JSON.stringify(videos)).replace('__PLAYER_JS__', media + player);
// The player clips its page (overflow:hidden); its inline <video> leaves a 3 px baseline gap that cannot scroll.
const sizes = { laptop:{width:1280,height:720}, phone:{width:390,height:844}, landscape:{width:844,height:390} };
await writeFile('audit/report-player.html', source);
await writeFile('audit/report-host.html', '<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0;display:block}</style><iframe src="report-player.html"></iframe>');
const browser = await chromium.launch({ headless:true, channel:'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(resolve('audit/report-host.html')).href);
  const frame = page.frames().find(item => item !== page.mainFrame());
  await frame.locator('#s2').waitFor({state:'attached'});
  if (await frame.locator('#p2').isVisible()) await frame.locator('#p2').click();
  if (await frame.locator('#s2').isVisible()) await frame.locator('#s2').click();
  await page.evaluate(() => {
    window.notes=[];
    window.addEventListener('message', event => {
      if (event.data?.type === 'onto:report') document.querySelector('iframe').contentWindow.postMessage({type:'onto:report-saved', folder:'/fixture/reports/saved', at:event.data.at}, '*');
      if (event.data?.type === 'onto:report-note') window.notes.push(event.data.note);
    });
  });
  await page.context().setOffline(true);
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [name,size] of Object.entries(sizes)) {
      await page.setViewportSize(size);
      await frame.locator('#report').focus();
      await assertViewport(frame, {documentY:'allow', primary:['#controls'], controls:['#report','#fullscreen','#pause']});
      await page.screenshot({path:resolve(`audit/report-${theme}-${name}-utility.png`)});
      await frame.locator('#report').click();
      await frame.locator('#reportSaved').waitFor({state:'visible'});
      await assertViewport(frame, {documentY:'allow', primary:['#controls','#reportSaved'], controls:['#reportNote','#reportDone','#report']});
      const boxes = await frame.evaluate(() => ['reportSaved','controls'].map(id => {
        const {top,bottom}=document.getElementById(id).getBoundingClientRect(); return {top,bottom};
      }));
      assert.ok(boxes[1].bottom <= boxes[0].top, 'report row does not cover transport');
      await page.screenshot({path:resolve(`audit/report-${theme}-${name}-saved.png`)});
      const before = await frame.locator('#vid').evaluate(video => ({time:video.currentTime, paused:video.paused, src:video.src}));
      await frame.locator('#reportNote').fill('stutter');
      await frame.locator('#reportNote').press('Space');
      await frame.locator('#reportNote').press('ArrowLeft');
      assert.deepEqual(await frame.locator('#vid').evaluate(video => ({time:video.currentTime, paused:video.paused, src:video.src})), before);
      await frame.locator('#reportNote').press('Enter');
      assert.equal(await frame.locator('#reportSaved').isHidden(),true);
      assert.equal(await page.evaluate(()=>window.notes.at(-1)), 'stutter ');
    }
  }
  await page.context().setOffline(false);
  await page.addInitScript(() => {
    window.reportNotes=[];
    window.tv={
      get:async()=>({hasPlayer:false,tv:{status:'idle',current:null,history:[],upcoming:[]}}),
      onState(){},onMode(fn){window.setMode=fn;},onError(){},onCast(){},report(){},reportMode:async()=>{},
      onReportState(fn){window.reportRequest=fn;}, onReportSaved(fn){window.reportSaved=fn;},
      reportNote:async(folder,note)=>{window.reportNotes.push({folder,note});},reportError:async()=>{},
    };
  });
  await page.goto(pathToFileURL(resolve('ui/index.html')).href);
  await page.context().setOffline(true);
  await page.getByRole('button',{name:'TV',exact:true}).click();
  for (const theme of ['light','dark']) {
    await page.emulateMedia({colorScheme:theme});
    for (const [name,size] of Object.entries(sizes)) {
      await page.setViewportSize(size);
      await page.evaluate(()=>window.reportSaved({folder:'/fixture/reports/saved',at:'2026-10-15T11:54:00Z'}));
      await assertViewport(page,{primary:['#report-saved'],controls:['#report-note','#report-saved button'],screenshotPath:resolve(`audit/report-toast-${theme}-${name}.png`)});
      await page.locator('#report-note').fill('TV stopped');
      await page.locator('#report-note').press('Enter');
      await page.locator('#report-saved').waitFor({state:'hidden'});
    }
  }
  // Enlarge actual text (including fixed-pixel labels), then check the working row.
  await page.setViewportSize(sizes.laptop);
  await page.evaluate(()=>{
    window.reportSaved({folder:'/fixture/reports/saved',at:new Date().toISOString()});
    for(const el of document.querySelectorAll('#report-saved span,#report-saved input,#report-saved button')) el.style.fontSize=`${parseFloat(getComputedStyle(el).fontSize)*2}px`;
  });
  await assertViewport(page,{primary:['#report-saved'],controls:['#report-note','#report-saved button'],screenshotPath:resolve('audit/report-toast-large-text.png')});
  assert.deepEqual(errors,[]);
  console.log('Report rows: light/dark, laptop/phone/landscape, note keys, offline operation and enlarged text passed.');
} finally { await browser.close(); }
