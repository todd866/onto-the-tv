import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLibrary, scanMediaLibrary } from './library.js';

test('buildLibrary joins catalogue items with continue-watching history', () => {
  const result = buildLibrary([{ src: 'Bluey/Keep.mp4', file: '/videos/Bluey/Keep.mp4', title: 'Keep', channel: 'Bluey', tier: 'shared' }, { src: 'Movie Scenes/Piper.mp4', file: '/films/Piper.mp4', title: 'Piper', tier: 'big' }], [
    { path: '/videos/Bluey/Keep.mp4', title: 'Keep', positionSeconds: 20, durationSeconds: 100, completed: false, updatedAt: '2026-09-27T01:00:00Z' },
    { path: '/films/Piper.mp4', title: 'Piper', positionSeconds: 80, durationSeconds: 80, completed: true, updatedAt: '2026-09-27T02:00:00Z' },
  ]);
  assert.equal(result.items.length, 2);
  assert.equal(result.continueWatching[0].title, 'Keep');
  assert.equal(result.films[0].title, 'Piper');
  assert.equal(result.shows[0].channel, 'Bluey');
});

test('buildLibrary keeps readCatalogue absolute files and includes history-only resumes', () => {
  const result = buildLibrary([
    { src: 'Shows/One.mp4', path: '../library/Shows/One.mp4', file: '/private/Movies/library/Shows/One.mp4', title: 'One', tier: 'shared' },
  ], [{ path: '/private/Movies/Paw Patrol.The.Movie.2021.1080p.WEB-DL.mp4', title: 'PAW Patrol Dino Movie', positionSeconds: 42, durationSeconds: 600, completed: false, updatedAt: '2026-09-27T03:00:00Z' }]);
  assert.equal(result.items[0].path, '/private/Movies/library/Shows/One.mp4');
  assert.equal(result.items[0].kind, 'show', 'the macOS Movies parent folder is not a film classification');
  assert.equal(result.continueWatching[0].title, 'PAW Patrol Dino Movie');
  assert.equal(result.items.length, 2);
});

test('scanMediaLibrary is bounded, skips hidden files and symlinks, and accepts only media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'show.mp4'), '');
    await writeFile(join(root, 'nested', 'clip.mkv'), '');
    await writeFile(join(root, 'nested', '.secret.mp4'), '');
    await writeFile(join(root, 'notes.txt'), '');
    await symlink(join(root, 'show.mp4'), join(root, 'linked.mp4'));
    const found = await scanMediaLibrary([{ path: root, label: 'Films' }]);
    assert.deepEqual(found.map(item => item.title), ['clip', 'show']);
    assert.deepEqual(found.map(item => item.kind), ['film', 'film']);
    const rootLink = `${root}-link`;
    await symlink(root, rootLink);
    assert.deepEqual(await scanMediaLibrary([rootLink]), []);
    await rm(rootLink);
    await assert.rejects(scanMediaLibrary(['/tmp/\0bad']), /absolute paths/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('scanMediaLibrary accepts a library inside a hidden folder but still skips hidden entries within it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    const root = join(base, '.media', 'Films');
    await mkdir(join(root, '.cache'), { recursive: true });
    await writeFile(join(root, 'Piper.mp4'), '');
    await writeFile(join(root, '.cache', 'thumb.mp4'), '');
    assert.deepEqual((await scanMediaLibrary([root])).map(item => item.title), ['Piper']);
    assert.deepEqual((await scanMediaLibrary([join(root, 'Piper.mp4')])).map(item => item.title), ['Piper']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('scanMediaLibrary keeps explicitly listed files even when folders fill the limit', async () => {
  const base = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    await mkdir(join(base, 'shows'));
    for (const name of ['a', 'b', 'c']) await writeFile(join(base, 'shows', `${name}.mp4`), '');
    await writeFile(join(base, 'watched.mp4'), '');
    const found = await scanMediaLibrary([join(base, 'shows'), join(base, 'watched.mp4')], { maxItems: 2 });
    assert.ok(found.some(item => item.path === join(base, 'watched.mp4')));
    assert.equal(found.truncated, true);
  } finally { await rm(base, { recursive: true, force: true }); }
});
