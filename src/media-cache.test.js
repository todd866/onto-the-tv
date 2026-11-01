import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaCache } from './media-cache.js';

const temp = async () => fs.mkdtemp(join(tmpdir(), 'onto-media-cache-'));
const bytes = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); };
const info = (size, mtimeMs = 1) => ({ size, mtimeMs });
const fakeFs = (free = 1e12) => async () => ({ bavail: free, bsize: 1 });

test('exact inclusive ranges and cross-block reads', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = Buffer.from('abcdefghijklmnop');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, data);
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs() });
  assert.deepEqual(await bytes(await cache.stream(file, info(data.length), { start: 3, end: 11 })), data.subarray(3, 12));
  await cache.close();
});

test('persistent restart produces cache hits without opening source', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = Buffer.from('abcdefgh');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, data);
  const options = { directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs() };
  const first = await createMediaCache(options); await bytes(await first.stream(file, info(data.length))); await first.close();
  const second = await createMediaCache(options); const original = fs.open; fs.open = async () => { throw new Error('source opened'); };
  try { assert.deepEqual(await bytes(await second.stream(file, info(data.length))), data); assert.ok(second.stats().hits > 0); }
  finally { fs.open = original; await second.close(); }
});

test('source identity change and corrupt blocks recover from source', async t => {
  const root = await temp(), file = join(root, 'source.bin'); await fs.writeFile(file, 'abcdefgh');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs() };
  const cache = await createMediaCache(options); await bytes(await cache.stream(file, info(8, 1)));
  await fs.writeFile(file, 'ijklmnop');
  assert.equal((await bytes(await cache.stream(file, info(8, 2)))).toString(), 'ijklmnop');
  await fs.writeFile(join(root, 'cache', (await fs.readdir(join(root, 'cache')))[0]), 'bad');
  assert.equal((await bytes(await cache.stream(file, info(8, 2)))).toString(), 'ijklmnop'); await cache.close();
});

test('low disk fails open and warm remains bounded', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = Buffer.alloc(64, 7); await fs.writeFile(file, data);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 8, eligible: () => true, statfs: fakeFs(0) });
  assert.deepEqual(await bytes(await cache.stream(file, info(data.length))), data);
  await cache.warm(file, info(data.length), { durationSeconds: 120 }); assert.deepEqual(await fs.readdir(join(root, 'cache')), []); assert.equal(cache.stats().closed, false); await cache.close();
});

test('warm persists small media and remains usable after source removal', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = Buffer.from('warm-me-completely');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, data);
  const options = { directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs() };
  const cache = await createMediaCache(options); await cache.warm(file, info(data.length), { durationSeconds: 120 });
  await fs.unlink(file); assert.deepEqual(await bytes(await cache.stream(file, info(data.length))), data); await cache.close();
});

test('same-size corrupted disk block is rejected after restart', async t => {
 const root=await temp(),file=join(root,'source.bin'),data=Buffer.from('abcdefgh');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(file,data);
 const options={directory:join(root,'cache'),blockBytes:4,eligible:()=>true,statfs:fakeFs()};
 const first=await createMediaCache(options);await bytes(await first.stream(file,info(8)));await first.close();
 const block=join(root,'cache',(await fs.readdir(join(root,'cache')))[0]);const bad=await fs.readFile(block);bad[bad.length-1]^=255;await fs.writeFile(block,bad);
 const second=await createMediaCache(options);assert.deepEqual(await bytes(await second.stream(file,info(8))),data);assert.equal(second.stats().misses,1);await second.close();
});

test('concurrent ranges cannot exceed cache budget and never delete source', async t=>{
 const root=await temp(),file=join(root,'source.bin'),data=Buffer.alloc(64,13);t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(file,data);
 const cache=await createMediaCache({directory:join(root,'cache'),blockBytes:4,maxBytes:144,reserveBytes:0,eligible:()=>true,statfs:fakeFs()});
 await Promise.all(Array.from({length:12},async(_,i)=>assert.deepEqual(await bytes(await cache.stream(file,info(64),{start:i*4,end:i*4+3})),data.subarray(i*4,i*4+4))));
 await cache.close();assert.ok(cache.stats().bytesCached<=144);assert.deepEqual(await fs.readFile(file),data);
});

test('close waits for an in-flight source load and its cache write',async t=>{
 const root=await temp(),file=join(root,'source.bin');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(file,'abcd');
 let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const cache=await createMediaCache({directory:join(root,'cache'),blockBytes:4,eligible:()=>true,statfs:async()=>{entered();await blocked;return {bavail:1e12,bsize:1};}});
 const reading=bytes(await cache.stream(file,info(4)));await started;let finished=false;const closing=cache.close().then(()=>finished=true);
 await new Promise(r=>setImmediate(r));assert.equal(finished,false);release();assert.equal((await reading).toString(),'abcd');await closing;assert.equal(cache.stats().inFlight,0);
});

test('disk pressure reclaims only cached blocks before a new write',async t=>{
 const root=await temp(),file=join(root,'source.bin');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(file,'abcdefghijkl');let free=1000;
 const cache=await createMediaCache({directory:join(root,'cache'),blockBytes:4,maxBytes:1000,reserveBytes:20,eligible:()=>true,statfs:async()=>({bavail:free,bsize:1})});
 await bytes(await cache.stream(file,info(12),{start:0,end:7}));assert.equal(cache.stats().bytesCached,72);
 free=10;assert.equal((await bytes(await cache.stream(file,info(12),{start:8,end:11}))).toString(),'ijkl');assert.equal(cache.stats().bytesCached,36);await cache.close();assert.equal((await fs.readFile(file)).toString(),'abcdefghijkl');
});
