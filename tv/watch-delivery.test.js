import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function setup(send,storage,scope='paired',timers=[]){const window={};vm.runInNewContext(readFileSync(new URL('./watch-delivery.js',import.meta.url),'utf8'),{window,Promise,setTimeout});return window.ontoWatchDelivery(send,storage,scope,fn=>{timers.push(fn);return 1;});}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('real outbox survives failure/reload and preserves ordered same-id delivery',async()=>{
 const data={};const storage={getItem:k=>data[k]||null,setItem:(k,v)=>{data[k]=v;}};const timers=[];
 const first=setup(()=>Promise.reject(Error('offline')),storage,'paired',timers);
 first.enqueue({sessionId:'s',sequence:0,reason:'start',watchedSeconds:0});first.enqueue({sessionId:'s',sequence:1,reason:'progress',watchedSeconds:15});first.enqueue({sessionId:'s',sequence:2,reason:'stop',watchedSeconds:20});await tick();assert.equal(first.pending(),3);
 const sent=[];const resumed=setup(e=>{sent.push(e.sequence);return Promise.resolve();},storage);resumed.drain();await tick();assert.deepEqual(sent,[0,1,2]);assert.equal(resumed.pending(),0);
});
test('pairing change clears previous private outbox and progress coalescing preserves start/end',async()=>{
 const data={};const storage={getItem:k=>data[k]||null,setItem:(k,v)=>{data[k]=v;}};
 const first=setup(()=>new Promise(()=>{}),storage);
 for(const e of [{sequence:0,reason:'start'},{sequence:1,reason:'progress'},{sequence:2,reason:'progress'},{sequence:3,reason:'stop'}])first.enqueue({sessionId:'s',...e});
 assert.equal(first.pending(),3);
 const other=setup(()=>Promise.resolve(),storage,'new-pair');assert.equal(other.pending(),0);
});
