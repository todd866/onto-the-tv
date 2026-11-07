import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLibrary, rebuildCatalogue, scanMediaLibrary } from './library.js';

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

test('a watched file listed explicitly keeps its folder classification', async () => {
  const base = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    await mkdir(join(base, 'Films'));
    await writeFile(join(base, 'Films', 'Piper.mp4'), '');
    const [item] = await scanMediaLibrary([{ path: join(base, 'Films'), label: 'Films' }, join(base, 'Films', 'Piper.mp4')]);
    assert.equal(item.kind, 'film');
    assert.equal(item.channel, 'Films');
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('a missing library root keeps the previous catalogue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    const catalogue = join(dir, 'library.json');
    const body = JSON.stringify({ version: 1, videos: [{ src: 'Movies/A.mp4', title: 'A' }, { src: 'Movies/B.mp4', title: 'B' }] }) + '\n';
    await writeFile(catalogue, body);
    const when = (await stat(catalogue)).mtime.toISOString();
    const missing = join(dir, 'Volumes', 'Stash', 'Movies');
    const warnings = [];
    let built = 0;
    const result = await rebuildCatalogue({
      roots: [missing],
      catalogueFile: catalogue,
      log: message => warnings.push(message),
      build: async () => { built += 1; },
    });
    assert.equal(built, 0);
    assert.equal(result.rescanned, false);
    assert.equal(result.roots[0].online, false);
    assert.equal(await readFile(catalogue, 'utf8'), body);
    assert.deepEqual(warnings, [`library root offline: ${missing}, serving last catalogue from ${when}`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a library root coming back triggers a rescan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    const root = join(dir, 'Movies');
    await mkdir(root);
    await writeFile(join(root, 'New.mp4'), '');
    const catalogue = join(dir, 'library.json');
    await writeFile(catalogue, JSON.stringify({ version: 1, videos: [{ src: 'old', title: 'Old' }] }) + '\n');
    let built = 0;
    const result = await rebuildCatalogue({
      roots: [root],
      catalogueFile: catalogue,
      log: () => {},
      build: async () => {
        built += 1;
        const found = await scanMediaLibrary([root]);
        await writeFile(catalogue, JSON.stringify({ version: 1, videos: found.map(item => ({ src: item.title, title: item.title })) }) + '\n');
      },
    });
    assert.equal(built, 1);
    assert.equal(result.rescanned, true);
    assert.equal(result.roots[0].online, true);
    const saved = JSON.parse(await readFile(catalogue, 'utf8'));
    assert.deepEqual(saved.videos, [{ src: 'New', title: 'New' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a read error mid-scan keeps the previous catalogue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    const root = join(dir, 'Movies');
    await mkdir(join(root, 'Shows'), { recursive: true });
    await writeFile(join(root, 'Keep.mp4'), '');
    await writeFile(join(root, 'Shows', 'A.mp4'), '');
    const catalogue = join(dir, 'library.json');
    const body = JSON.stringify({ version: 1, videos: [{ src: 'Kept', title: 'Kept' }, { src: 'Also', title: 'Also' }] }) + '\n';
    await writeFile(catalogue, body);
    const when = (await stat(catalogue)).mtime.toISOString();
    const warnings = [];
    const result = await rebuildCatalogue({
      roots: [root],
      catalogueFile: catalogue,
      log: message => warnings.push(message),
      io: {
        readdir: async (directory, options) => {
          if (directory === join(root, 'Shows')) throw Object.assign(new Error('Input/output error'), { code: 'EIO', path: directory });
          return readdir(directory, options);
        },
      },
      build: async ({ io }) => {
        const found = await scanMediaLibrary([root], { io });
        if (found.partial) throw Object.assign(new Error('library root offline'), { code: 'EIO', path: root, partial: true });
        await writeFile(catalogue, JSON.stringify({ version: 1, videos: found.map(item => ({ src: item.title, title: item.title })) }) + '\n');
      },
    });
    assert.equal(result.rescanned, false);
    assert.equal(await readFile(catalogue, 'utf8'), body);
    assert.equal((await stat(catalogue)).mtime.toISOString(), when);
    assert.deepEqual(warnings, [`library root offline: ${root}, serving last catalogue from ${when}`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a smaller catalogue is discarded when a root goes missing during the rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    const root = join(dir, 'Movies');
    await mkdir(root);
    await writeFile(join(root, 'A.mp4'), '');
    const catalogue = join(dir, 'library.json');
    const body = JSON.stringify({ version: 1, videos: [{ src: 'A' }, { src: 'B' }] }) + '\n';
    await writeFile(catalogue, body);
    const when = (await stat(catalogue)).mtime.toISOString();
    let mounted = true;
    const warnings = [];
    const result = await rebuildCatalogue({
      roots: [root],
      catalogueFile: catalogue,
      log: message => warnings.push(message),
      io: {
        lstat: async path => {
          if (!mounted) throw Object.assign(new Error('unmounted'), { code: 'ENOENT', path });
          return stat(path);
        },
      },
      build: async () => {
        mounted = false;
        await writeFile(catalogue, JSON.stringify({ version: 1, videos: [] }) + '\n');
      },
    });
    assert.equal(result.rescanned, false);
    assert.equal(await readFile(catalogue, 'utf8'), body);
    assert.equal((await stat(catalogue)).mtime.toISOString(), when);
    assert.deepEqual(warnings, [`library root offline: ${root}, serving last catalogue from ${when}`]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a smaller catalogue is kept when every library root stays online', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-library-'));
  try {
    const root = join(dir, 'Movies');
    await mkdir(root);
    await writeFile(join(root, 'A.mp4'), '');
    const catalogue = join(dir, 'library.json');
    await writeFile(catalogue, JSON.stringify({ version: 1, videos: [{ src: 'A' }, { src: 'B' }] }) + '\n');
    const result = await rebuildCatalogue({
      roots: [root],
      catalogueFile: catalogue,
      log: () => {},
      build: async () => {
        await writeFile(catalogue, JSON.stringify({ version: 1, videos: [{ src: 'A' }] }) + '\n');
      },
    });
    assert.equal(result.rescanned, true);
    assert.deepEqual(JSON.parse(await readFile(catalogue, 'utf8')).videos, [{ src: 'A' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
