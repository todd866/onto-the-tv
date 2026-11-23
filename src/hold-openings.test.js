// bin/hold-openings.js: the pass that holds the opening of every title on a shelf before the shelf leaves the drive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaCache } from './media-cache.js';
import { holdShelves, shelfOf } from '../bin/hold-openings.js';

const pattern = length => Buffer.from(Array.from({ length }, (_, i) => (i * 5) % 251));

test('a shelf is the first part of a title\'s src', () => {
  assert.equal(shelfOf({ src: 'sitcoms/A Sitcom/S01E01.mp4' }), 'sitcoms');
  assert.equal(shelfOf({ src: 'Films/A Film (1950).mp4' }), 'Films');
  assert.equal(shelfOf({ src: 'loose.mp4' }), '');
});

test('only the named shelves are held; a second run finds everything already there; the plan writes nothing', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'onto-hold-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const make = async (name, length) => { const file = join(root, name); await fs.writeFile(file, pattern(length)); return file; };
  const videos = [
    { src: 'sitcoms/A/1.mp4', file: await make('a1', 100), duration: 100 },
    { src: 'sitcoms/A/2.mp4', file: await make('a2', 60), duration: 60 },
    { src: 'kids/B/1.mp4', file: await make('b1', 100), duration: 100 },
    { src: 'sitcoms/A/3.mp4', file: join(root, 'gone-with-marker'), duration: 100, cloud: { size: 100, mtimeMs: 7 } },
    { src: 'sitcoms/A/4.mp4', file: join(root, 'gone-without'), duration: 100 },
  ];
  const data3 = pattern(100);
  const options = { directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: async () => ({ bavail: 1e12, bsize: 1 }),
    remote: async (_file, start, length) => data3.subarray(start, start + length), openings: { directory: join(root, 'openings'), seconds: 10 } };
  const cache = await createMediaCache(options);
  const plan = await holdShelves({ videos, shelves: ['sitcoms'], cache, plan: true, seconds: 10, blockBytes: 4 });
  assert.deepEqual({ titles: plan.titles, held: plan.held, skipped: plan.skipped, bytes: plan.bytes }, { titles: 4, held: 3, skipped: 1, bytes: 60 });
  assert.equal(cache.stats().openingBlocks, 0);
  const first = await holdShelves({ videos, shelves: ['sitcoms'], cache, seconds: 10 });
  assert.deepEqual({ held: first.held, already: first.already, skipped: first.skipped, bytes: first.bytes, failed: first.failed }, { held: 3, already: 0, skipped: 1, bytes: 60, failed: [] });
  const second = await holdShelves({ videos, shelves: ['sitcoms'], cache, seconds: 10 });
  assert.deepEqual({ held: second.held, already: second.already, bytes: second.bytes }, { held: 0, already: 3, bytes: 0 });
  assert.equal(cache.stats().openingBlocks, 15);            // nothing from the kids shelf
  await cache.close();
});

test('a full store stops the pass and says so, instead of failing every remaining title', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'onto-hold-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const videos = [];
  for (const n of [1, 2, 3]) { const file = join(root, `f${n}`); await fs.writeFile(file, pattern(100)); videos.push({ src: `sitcoms/A/${n}.mp4`, file, duration: 100 }); }
  const cache = await createMediaCache({ directory: join(root, 'cache'), blockBytes: 4, eligible: () => true, statfs: async () => ({ bavail: 1e12, bsize: 1 }),
    openings: { directory: join(root, 'openings'), seconds: 10, maxBytes: 200 } });
  const result = await holdShelves({ videos, shelves: ['sitcoms'], cache, seconds: 10 });
  assert.equal(result.held, 1);
  assert.deepEqual(result.failed.map(item => item.reason), ['the openings store is full']);
  await cache.close();
});
