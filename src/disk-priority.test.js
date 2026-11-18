import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskPriority, volumeRoots } from './disk-priority.js';

test('volume roots: one per external volume, the fast cache volume left out', () => {
  assert.deepEqual(volumeRoots(['/Volumes/Stash/Movies/a.mkv', '/Volumes/Stash/b.mp4', '/Volumes/Fast/c.mp4', '/Users/x/d.mp4'], ['/Volumes/Fast']),
    ['/Volumes/Stash']);
});

test('writes the label and paths, then only refreshes the time, at most once per gap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disk-priority-')), file = join(dir, 'priority', 'onto-the-tv');
  let clock = Date.now();
  const marker = createDiskPriority({ file, roots: () => ['/Volumes/Stash'], now: () => clock });
  assert.equal(await marker.touch(), true);
  assert.equal(await readFile(file, 'utf8'), 'onto-the-tv\n/Volumes/Stash\n');
  clock += 5_000;
  assert.equal(await marker.touch(), false);
  await utimes(file, new Date(0), new Date(0));
  clock += 30_000;
  assert.equal(await marker.touch(), true);
  assert.ok((await stat(file)).mtimeMs > 1000);
  assert.equal(await readFile(file, 'utf8'), 'onto-the-tv\n/Volumes/Stash\n');
});

test('no roots, no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'disk-priority-')), file = join(dir, 'p');
  assert.equal(await createDiskPriority({ file, roots: () => [] }).touch(), false);
  await assert.rejects(stat(file));
});
