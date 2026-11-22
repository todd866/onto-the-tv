import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import('/Users/iantodd/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {assertViewport}=await import('/Users/iantodd/Projects/.ux-authoring/viewport-fit.mjs');
const template=await readFile('shuffler/player.html','utf8'),player=await readFile('shuffler/player.js','utf8');
const videos=Array.from({length:10},(_,i)=>({src:`Example/S01E${String(i+1).padStart(2,'0')}.mp4`,title:`Example S01E${String(i+1).padStart(2,'0')}`,channel:'Example',tier:'grownup',duration:120}));
const media=`Object.defineProperties(HTMLMediaElement.prototype,{src:{get(){return this.fixtureSrc||''},set(v){this.fixtureSrc=v}},paused:{get(){return this.fixturePaused!==false}},duration:{get(){return 120}},readyState:{get(){return 4}}});HTMLMediaElement.prototype.play=function(){this.fixturePaused=false;this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('playing'));return Promise.resolve()};HTMLMediaElement.prototype.pause=function(){this.fixturePaused=true;this.dispatchEvent(new Event('pause'))};HTMLMediaElement.prototype.load=function(){};`;
await mkdir('audit',{recursive:true});await writeFile('audit/qol.html',template.replace('__VIDEOS__',JSON.stringify(videos)).replace('__PLAYER_JS__',media+player));
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(resolve('audit/qol.html')).href);
 await page.locator('#sgrown').click();
 await page.locator('#episodes').click();
 await page.getByRole('button',{name:'Example S01E03 · Play',exact:true}).click();
 assert.match(await page.locator('#vid').evaluate(v=>v.src),/S01E03/);
 await page.locator('#episodes').click();await page.getByRole('button',{name:'Next episode · Example S01E04',exact:true}).click();
 assert.match(await page.locator('#vid').evaluate(v=>v.src),/S01E04/);
 await page.locator('#vid').click({position:{x:400,y:150}});await page.waitForTimeout(400);
 assert.equal(await page.locator('#vid').evaluate(v=>v.paused),true,'a click pauses');
 await page.locator('#vid').click({position:{x:400,y:150}});await page.waitForTimeout(400);
 assert.equal(await page.locator('#vid').evaluate(v=>v.paused),false,'a second click plays');
 await page.locator('#vid').dblclick({position:{x:400,y:150}});await page.waitForTimeout(400);
 assert.equal(await page.locator('#vid').evaluate(v=>v.paused),false,'a double-click does not pause');
 assert.equal(await page.evaluate(()=>!!document.fullscreenElement),true);
 await page.waitForTimeout(3300);assert.equal(await page.locator('#vid').evaluate(v=>getComputedStyle(v).cursor),'none');
 await page.mouse.move(300,100);assert.notEqual(await page.locator('#vid').evaluate(v=>getComputedStyle(v).cursor),'none');
 await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>!!document.fullscreenElement),false);
 for(const [name,size] of Object.entries({laptop:{width:1280,height:720},phone:{width:390,height:844},landscape:{width:844,height:390}})){
  await page.setViewportSize(size);await page.mouse.move(100,100);await page.locator('#episodes').click();
  await assertViewport(page,{primary:['#savedPanel'],controls:['#closeSaved'],screenshotPath:resolve(`audit/qol-${name}.png`)});
  await page.locator('#closeSaved').click();
 }
 assert.deepEqual(errors,[]);console.log('Episode selection, next episode, fullscreen, cursor and viewport checks passed.');
}finally{await browser.close()}
