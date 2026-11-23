// The openings store (src/media-cache.js, `openings`): the first stretch of a title, held where the ordinary
// cache's eviction never reaches, so a title that has left the drive still starts at once and only its later
// blocks come from the cloud copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaCache } from './media-cache.js';

const temp = async () => fs.mkdtemp(join(tmpdir(), 'onto-openings-'));
const tidy = (t, root) => t.after(() => fs.rm(root, { recursive: true, force: true }));
const bytes = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); };
const info = (size, mtimeMs = 1) => ({ size, mtimeMs });
const fakeFs = (free = 1e12) => async () => ({ bavail: free, bsize: 1 });
const pattern = length => Buffer.from(Array.from({ length }, (_, i) => (i * 7) % 251));

// 100 bytes in 4-byte blocks over 100 "seconds": 1 byte a second, so a 10-second opening with the 1.5 margin is
// 15 bytes = blocks 0..3, plus the last block (24).
const options = (root, extra = {}) => ({ directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: fakeFs(),
  openings: { directory: join(root, 'openings'), seconds: 10 }, ...extra });

test('holding an opening stores the first stretch and the last block, once', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = pattern(100);
  tidy(t, root);
  await fs.writeFile(file, data);
  const cache = await createMediaCache(options(root));
  assert.deepEqual(await cache.holdOpening(file, info(100), { durationSeconds: 100 }), { blocks: 5, bytes: 20, already: 0 });
  assert.deepEqual(await cache.holdOpening(file, info(100), { durationSeconds: 100 }), { blocks: 0, bytes: 0, already: 5 });
  assert.equal((await fs.readdir(join(root, 'openings'))).filter(name => name.endsWith('.block')).length, 5);
  assert.deepEqual(await fs.readdir(join(root, 'cache')), []);          // a shelf pass does not fill the ordinary cache
  assert.equal(cache.stats().openingBlocks, 5);
  await cache.close();
});

test('after the file has gone, the opening plays with no remote read and only later blocks come from the cloud', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = pattern(100);
  tidy(t, root);
  await fs.writeFile(file, data);
  let cache = await createMediaCache(options(root));
  await cache.holdOpening(file, info(100), { durationSeconds: 100 });
  await cache.close();
  await fs.rm(file);
  const asked = [];
  const remote = async (_file, start, length) => { asked.push(start / 4); return data.subarray(start, start + length); };
  cache = await createMediaCache(options(root, { remote }));
  const head = await cache.stream(file, info(100), { start: 0, end: 7 });
  const first = [];
  for await (const chunk of head) { first.push(chunk); if (Buffer.concat(first).length >= 8) break; }
  assert.deepEqual(Buffer.concat(first).subarray(0, 8), data.subarray(0, 8));
  assert.ok(asked.every(index => index >= 4), `the opening must not be fetched, got blocks ${asked}`);
  assert.deepEqual(await bytes(await cache.stream(file, info(100), { start: 20, end: 39 })), data.subarray(20, 40));
  assert.ok(asked.includes(5) && asked.includes(9));
  assert.deepEqual(await bytes(await cache.stream(file, info(100), { start: 96, end: 99 })), data.subarray(96, 100));   // the last block is held too
  assert.ok(!asked.includes(24));
  assert.ok(cache.stats().openingHits >= 3);
  await cache.close();
});

test('openings survive the ordinary cache being squeezed to nothing', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = pattern(100);
  tidy(t, root);
  await fs.writeFile(file, data);
  const cache = await createMediaCache(options(root, { maxBytes: 0, reserveBytes: 0 }));
  await cache.holdOpening(file, info(100), { durationSeconds: 100 });
  await bytes(await cache.stream(file, info(100)));        // plays through; the ordinary cache may hold nothing
  await cache.trim();
  assert.equal((await fs.readdir(join(root, 'openings'))).filter(name => name.endsWith('.block')).length, 5);
  await cache.close();
});

test('a damaged opening block is thrown away and the block is read from its source again', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = pattern(100);
  tidy(t, root);
  await fs.writeFile(file, data);
  let cache = await createMediaCache(options(root));
  await cache.holdOpening(file, info(100), { durationSeconds: 100 });
  await cache.close();
  const folder = join(root, 'openings'), names = (await fs.readdir(folder)).sort();
  for (const name of names) await fs.writeFile(join(folder, name), Buffer.from('damaged'));
  cache = await createMediaCache(options(root));
  assert.deepEqual(await bytes(await cache.stream(file, info(100), { start: 0, end: 15 })), data.subarray(0, 16));
  assert.ok((await fs.readdir(folder)).length < names.length);
  await cache.close();
});

test('the store has its own ceiling, and a cache without one simply holds nothing', async t => {
  const root = await temp(), file = join(root, 'source.bin'), data = pattern(100);
  tidy(t, root);
  await fs.writeFile(file, data);
  const small = await createMediaCache(options(root, { openings: { directory: join(root, 'openings'), seconds: 10, maxBytes: 80 } }));
  await assert.rejects(small.holdOpening(file, info(100), { durationSeconds: 100 }), { code: 'ENOSPC' });
  await small.close();
  const none = await createMediaCache({ directory: join(root, 'cache2'), blockBytes: 4, eligible: () => true, statfs: fakeFs() });
  assert.deepEqual(await none.holdOpening(file, info(100), { durationSeconds: 100 }), { blocks: 0, bytes: 0, already: 0 });
  await none.close();
});

test('an opening can be rebuilt from the cloud copy when the file is already gone', async t => {
  const root = await temp(), gone = join(root, 'not-on-a-drive.bin'), data = pattern(100);
  tidy(t, root);
  const remote = async (_file, start, length) => data.subarray(start, start + length);
  const cache = await createMediaCache(options(root, { remote }));
  assert.deepEqual(await cache.holdOpening(gone, info(100), { durationSeconds: 100 }), { blocks: 5, bytes: 20, already: 0 });
  await cache.close();
});
