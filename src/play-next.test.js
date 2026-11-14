import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlayNext } from './play-next.js';

const allow = src => src === 'Kids/Timmy Time.mp4';

test('the queue file accepts a library source and drops it when consumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-next-'));
  const file = join(dir, 'play-next.json');
  const queue = createPlayNext({ file, allowSrc: allow });
  assert.deepEqual(await queue.list(), { items: [] });
  assert.equal(await queue.add('../secret.mp4'), null);
  assert.equal(await queue.add('Other/nope.mp4'), null);
  assert.deepEqual(await queue.add('Kids/Timmy Time.mp4'), { items: ['Kids/Timmy Time.mp4'] });
  assert.deepEqual(await queue.add('Kids/Timmy Time.mp4'), { items: ['Kids/Timmy Time.mp4', 'Kids/Timmy Time.mp4'] });
  const again = createPlayNext({ file, allowSrc: allow });
  assert.deepEqual(await again.list(), { items: ['Kids/Timmy Time.mp4', 'Kids/Timmy Time.mp4'] });
  assert.deepEqual(await again.consume('Kids/Timmy Time.mp4'), { items: ['Kids/Timmy Time.mp4'] });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(raw.items, ['Kids/Timmy Time.mp4']);
});

test('a missing or broken queue file reads as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-next-'));
  const file = join(dir, 'play-next.json');
  const queue = createPlayNext({ file, allowSrc: allow });
  assert.deepEqual(await queue.list(), { items: [] });
  await writeFile(file, '{');
  assert.deepEqual(await queue.list(), { items: [] });
  await queue.add('Kids/Timmy Time.mp4');
  assert.deepEqual((await queue.list()).items, ['Kids/Timmy Time.mp4']);
});
