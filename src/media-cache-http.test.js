import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMediaCache} from './media-cache.js';
import {createFileStorage,createTvLibrary,createTvServer} from './tv-server.js';
import {loadPlaybackHistory} from './playback-history.js';

test('HTTP cache preserves full, suffix, cross-block and seek responses with authentication',async t=>{
 const root=await mkdtemp(join(tmpdir(),'onto-cache-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'episode.mp4');const content=Buffer.from(Array.from({length:1000},(_,i)=>i%251));await writeFile(file,content);
 const history=await loadPlaybackHistory(join(root,'history.json')),storage=await createFileStorage(join(root,'taste.json'));
 const mediaCache=await createMediaCache({directory:join(root,'cache'),eligible:()=>true,blockBytes:64,reserveBytes:0,maxBytes:4096});
 const library=createTvLibrary({videos:[{src:'episode.mp4',file,title:'Episode',channel:'Show',tier:'shared',duration:100}],history,storage});
 const server=createTvServer({library,history,storage,mediaCache,uiRoot:root,token:'test-token'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await mediaCache.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const [range,start,end] of [['bytes=0-99',0,99],['bytes=60-170',60,170],['bytes=800-899',800,899],['bytes=-25',975,999],[null,0,999]]){
  const r=await fetch(base+'/media?src=episode.mp4',{headers:{'x-onto-token':'test-token',...(range?{Range:range}:{})}});
  assert.equal(r.status,range?206:200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),content.subarray(start,end+1));
  assert.equal(r.headers.get('content-length'),String(end-start+1));
 }
 const head=await fetch(base+'/media?src=episode.mp4',{method:'HEAD',headers:{'x-onto-token':'test-token',Range:'bytes=0-99'}});assert.equal(head.status,206);assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await fetch(base+'/media?src=episode.mp4',{headers:{'x-onto-token':'test-token',Range:'bytes=1000-'}})).status,416);
 assert.equal((await fetch(base+'/api/media-cache')).status,403);
 const stats=await (await fetch(base+'/api/media-cache',{headers:{'x-onto-token':'test-token'}})).json();assert.ok(stats.hits>0);
});
