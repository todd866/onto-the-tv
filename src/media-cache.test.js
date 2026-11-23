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

// 15 Nov 2026: warming all 4,084 openings through a 40 GB cache pushed out the very episodes the cards
// were about to play, and Ms Rachel took 9 s to start. What is about to play is kept.
test('kept titles survive pressure from other titles; a new keep list releases the old', async t => {
  const root = await temp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ['a', 'b', 'c', 'd'];
  for (const name of names) await fs.writeFile(join(root, name), name.repeat(8));
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, maxBytes: 3 * 36, reserveBytes: 0, eligible: () => true, statfs: fakeFs() });
  const file = name => ({ file: join(root, name), info: info(8) });
  const held = async name => (await fs.readdir(join(root, 'cache'))).filter(entry => entry.endsWith('.block')).length && cache.isKept(join(root, name), info(8));
  await cache.keep([file('a')]);
  assert.equal(cache.stats().kept, 1);
  await bytes(await cache.stream(join(root, 'a'), info(8)));                 // 2 blocks, kept
  for (const name of ['b', 'c', 'd']) await bytes(await cache.stream(join(root, name), info(8)));
  const original = fs.open; fs.open = async () => { throw new Error('source opened'); };
  try { assert.equal((await bytes(await cache.stream(join(root, 'a'), info(8)))).toString(), 'aaaaaaaa', 'kept title served from cache'); }
  finally { fs.open = original; }
  assert.equal(await held('a'), true);
  await cache.keep([file('b')]);
  assert.equal(cache.isKept(join(root, 'a'), info(8)), false);
  await cache.close();
});

test('the cache never gives itself entirely to kept titles: one block of room stays for playing anything else', async t => {
  const root = await temp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, 'a'), 'a'.repeat(8)); await fs.writeFile(join(root, 'z'), 'z'.repeat(8));
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, maxBytes: 2 * 36, reserveBytes: 0, eligible: () => true, statfs: fakeFs() });
  await cache.keep([{ file: join(root, 'a'), info: info(8) }]);
  await bytes(await cache.stream(join(root, 'a'), info(8)));
  // Nothing can be evicted for z: it still plays, straight from the source.
  assert.equal((await bytes(await cache.stream(join(root, 'z'), info(8)))).toString(), 'zzzzzzzz');
  await cache.close();
});

// Ian, 15 Nov 2026: "I just don't want the m2 internal drive getting full". A smaller ceiling takes effect
// at once, not on the next write, and kept titles are the last to go.
test('trim brings an over-full cache down to its ceiling, sparing kept titles', async t => {
  const root = await temp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['a', 'b', 'c']) await fs.writeFile(join(root, name), name.repeat(8));
  const big = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, maxBytes: 1e9, reserveBytes: 0, eligible: () => true, statfs: fakeFs() });
  for (const name of ['a', 'b', 'c']) await bytes(await big.stream(join(root, name), info(8)));
  await big.close();
  const small = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, maxBytes: 2 * 36, reserveBytes: 0, eligible: () => true, statfs: fakeFs() });
  assert.equal(small.stats().bytesCached, 6 * 36);
  await small.keep([{ file: join(root, 'b'), info: info(8) }]);
  await small.trim();
  assert.equal(small.stats().bytesCached, 2 * 36);
  const original = fs.open; fs.open = async () => { throw new Error('source opened'); };
  try { assert.equal((await bytes(await small.stream(join(root, 'b'), info(8)))).toString(), 'bbbbbbbb'); }
  finally { fs.open = original; await small.close(); }
});

test('kept titles go too when the disk itself runs short', async t => {
  const root = await temp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, 'a'), 'a'.repeat(8));
  let free = 1e6;
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, maxBytes: 1e9, reserveBytes: 1000, eligible: () => true, statfs: async () => ({ bavail: free, bsize: 1 }) });
  await cache.keep([{ file: join(root, 'a'), info: info(8) }]);
  await bytes(await cache.stream(join(root, 'a'), info(8)));
  assert.ok(cache.stats().bytesCached > 0);
  free = 10;
  await cache.trim();
  assert.equal(cache.stats().bytesCached, 0, 'the free-space floor outranks keeping');
  await cache.close();
});

// 22 Nov 2026 (owner: "local copies of enough to start a show, then backfill from the cloud"): a title whose file
// is no longer on a drive is read from a remote source, through the same blocks and the same cache.
test('a file that has left the drive is read from the remote source, then from the cache', async t => {
  const root = await temp(), data = Buffer.from('abcdefghijklmnop'), gone = join(root, 'not-on-a-drive.bin');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const remote = async (file, start, length) => { calls.push({ file, start, length }); return data.subarray(start, start + length); };
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs(), remote });
  assert.deepEqual(await bytes(await cache.stream(gone, info(data.length), { start: 3, end: 11 })), data.subarray(3, 12));
  assert.ok(calls.length >= 3 && calls.every(c => c.file === gone && c.start % 4 === 0 && c.length === 4));
  const fetched = calls.length;
  assert.deepEqual(await bytes(await cache.stream(gone, info(data.length), { start: 0, end: 7 })), data.subarray(0, 8));
  assert.equal(calls.length, fetched);
  assert.equal(cache.stats().remoteReads, fetched);
  await cache.close();
});

test('a file that is on the drive never touches the remote source', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = Buffer.from('abcdefgh');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, data);
  const remote = async () => { throw new Error('the remote source must not be asked'); };
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs(), remote });
  assert.deepEqual(await bytes(await cache.stream(file, info(data.length))), data);
  assert.equal(cache.stats().remoteReads, 0);
  await cache.close();
});

test('blocks cached while the file was on the drive still play after it has gone, with no remote read', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = Buffer.from('abcdefghijkl');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(file, data);
  const remote = async () => { throw new Error('the remote source must not be asked'); };
  const options = { directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs(), remote };
  let cache = await createMediaCache(options);
  assert.deepEqual(await bytes(await cache.stream(file, info(data.length))), data);
  await cache.close();
  await fs.rm(file);
  cache = await createMediaCache(options);
  assert.deepEqual(await bytes(await cache.stream(file, info(data.length), { start: 2, end: 9 })), data.subarray(2, 10));
  await cache.close();
});

test('a remote failure, or a short remote read, reaches the reader as an error', async t => {
  const root = await temp(), gone = join(root, 'not-on-a-drive.bin');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const failing = await createMediaCache({ directory: join(root, 'a'), blockBytes: 4, eligible: () => true, statfs: fakeFs(),
    remote: async () => { throw Object.assign(new Error('cloud read failed'), { code: 'EREMOTE' }); } });
  await assert.rejects(async () => bytes(await failing.stream(gone, info(8))), /cloud read failed/);
  await failing.close();
  const short = await createMediaCache({ directory: join(root, 'b'), blockBytes: 4, eligible: () => true, statfs: fakeFs(),
    remote: async () => Buffer.from('ab') });
  await assert.rejects(async () => bytes(await short.stream(gone, info(8))), /wrong amount/);
  await short.close();
});

test('without a remote source a missing file fails as it always did', async t => {
  const root = await temp();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs() });
  await assert.rejects(async () => bytes(await cache.stream(join(root, 'missing.bin'), info(8))), { code: 'ENOENT' });
  await cache.close();
});
