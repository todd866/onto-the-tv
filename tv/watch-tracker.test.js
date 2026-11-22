import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function tracker() { const window={}; vm.runInNewContext(readFileSync(new URL('./watch-tracker.js',import.meta.url),'utf8'),{window}); return window.ontoWatchTracker(); }
test('real tracker excludes seeks, pause, stall and wall-clock inflation',()=>{
 const t=tracker();
 assert.equal(t.sample(0,true,0),0);
 assert.equal(t.sample(4,true,4000),4);
 assert.equal(t.sample(4,false,19000),0);
 assert.equal(t.sample(8,true,19100),0); // short seek, not four watched seconds
 t.rebase(8,20000);
 assert.equal(t.sample(12,true,24000),4);
 assert.equal(t.sample(13,true,50000),0);
 assert.equal(t.sample(13,false,60000),0);
 assert.equal(t.sample(14,true,61000),1);
 const next=tracker();assert.equal(next.sample(200,true,62000),0);
});
