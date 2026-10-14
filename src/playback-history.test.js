import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybackHistory } from './playback-history.js';

async function withHistory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'onto-history-'));
  try { await run(join(directory, 'history.json'), directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('history survives restart with independent bookmarks, titles and private permissions', async () => {
  await withHistory(async (path, directory) => {
    const history = await loadPlaybackHistory(path);
    assert.deepEqual(history.list(), []);
    assert.equal(history.get('/films/one.mp4'), 0);
    history.set('/films/one.mp4', { title: 'One', positionSeconds: 125.5, durationSeconds: 600 });
    history.set('/films/two.mp4', { positionSeconds: 42, durationSeconds: 900 });
    await history.flush();
    const restored = await loadPlaybackHistory(path);
    assert.equal(restored.get('/films/one.mp4'), 125.5);
    assert.equal(restored.get('/films/two.mp4'), 42);
    assert.deepEqual(restored.list().map(entry => entry.title), ['two.mp4', 'One']);
    assert.ok(Number.isFinite(Date.parse(restored.list()[0].updatedAt)));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['history.json']);
    const copy = restored.list();
    copy[0].positionSeconds = 999;
    assert.equal(restored.get('/films/two.mp4'), 42);
  });
});

test('TV reset zeros preserve a bookmark while an explicit seek to the start resets it', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/films/one.mp4', { positionSeconds: 0, durationSeconds: 600 });
    assert.equal(history.list().length, 1, 'starting playback is visible before its first position update');
    history.set('/films/one.mp4', { title: 'One', positionSeconds: 599, durationSeconds: 600 });
    history.set('/films/one.mp4', { positionSeconds: 0, durationSeconds: 0 });
    assert.equal(history.get('/films/one.mp4'), 599, 'being near the end is not completion');
    assert.equal(history.list()[0].durationSeconds, 600);
    assert.equal(history.list()[0].title, 'One');
    history.set('/films/one.mp4', { positionSeconds: 0, reset: true });
    assert.equal(history.get('/films/one.mp4'), 0);
  });
});

test('completed files remain in history but resume from the beginning', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/films/one.mp4', { positionSeconds: 300, durationSeconds: 300, completed: true });
    await history.flush();
    const restored = await loadPlaybackHistory(path);
    assert.equal(restored.get('/films/one.mp4'), 0);
    assert.equal(restored.list()[0].completed, true);
    assert.equal(restored.list()[0].positionSeconds, 300);
    restored.set('/films/one.mp4', { positionSeconds: 0 });
    assert.equal(restored.list()[0].completed, false);
    assert.equal(restored.get('/films/one.mp4'), 0);
  });
});

test('history rejects corrupt files without replacing or deleting their contents', async () => {
  await withHistory(async path => {
    for (const content of ['{broken', JSON.stringify({ version: 2, entries: [] }),
      JSON.stringify({ version: 1, entries: [{ path: '/films/one.mp4', positionSeconds: -1 }] })]) {
      await writeFile(path, content);
      await assert.rejects(loadPlaybackHistory(path), /Cannot read playback history/);
      assert.equal(await readFile(path, 'utf8'), content);
    }
  });
});

test('history validates numeric inputs and absolute paths before changing any entries', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    for (const positionSeconds of [NaN, Infinity, -1, '20', undefined]) {
      assert.throws(() => history.set('/films/one.mp4', { positionSeconds }), /finite, nonnegative/);
    }
    for (const durationSeconds of [NaN, Infinity, -1, '20']) {
      assert.throws(() => history.set('/films/one.mp4', { positionSeconds: 20, durationSeconds }), /finite, nonnegative/);
    }
    assert.throws(() => history.set('relative.mp4', { positionSeconds: 20 }), /absolute/);
    assert.throws(() => history.get('relative.mp4'), /absolute/);
    assert.throws(() => history.set('/films/one.mp4', { positionSeconds: 20, completed: 'yes' }), /booleans/);
    assert.deepEqual(history.list(), []);
  });
});

test('history retains only the 500 most recently watched files, including across restart', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    for (let i = 0; i < 500; i++) history.set(`/films/${i}.mp4`, { positionSeconds: i + 1 });
    history.set('/films/0.mp4', { positionSeconds: 15 });
    history.set('/films/new.mp4', { positionSeconds: 10 });
    assert.equal(history.list().length, 500);
    assert.equal(history.get('/films/1.mp4'), 0);
    assert.equal(history.get('/films/0.mp4'), 15);
    assert.deepEqual(history.list().slice(0, 2).map(entry => entry.path), ['/films/new.mp4', '/films/0.mp4']);
    await history.flush();
    const restored = await loadPlaybackHistory(path);
    assert.equal(restored.list().length, 500);
    assert.deepEqual(restored.list(), history.list());
  });
});

test('overlapping flushes serialize snapshots and keep the newest playback position', async () => {
  await withHistory(async (path, directory) => {
    const history = await loadPlaybackHistory(path);
    const flushes = [];
    for (let i = 1; i <= 30; i++) {
      history.set('/films/one.mp4', { positionSeconds: i });
      flushes.push(history.flush());
    }
    await Promise.all(flushes);
    const restored = await loadPlaybackHistory(path);
    assert.equal(restored.get('/films/one.mp4'), 30);
    assert.deepEqual(await readdir(directory), ['history.json']);
  });
});

test('a failed flush reports the error and permits a later retry without losing changes', async () => {
  await withHistory(async (path, directory) => {
    const nested = join(directory, 'nested');
    const history = await loadPlaybackHistory(join(nested, 'history.json'));
    await writeFile(nested, 'not a directory');
    history.set('/films/one.mp4', { positionSeconds: 10 });
    await assert.rejects(history.flush());
    await rm(nested);
    await mkdir(nested);
    history.set('/films/one.mp4', { positionSeconds: 20 });
    await history.flush();
    assert.equal((await loadPlaybackHistory(join(nested, 'history.json'))).get('/films/one.mp4'), 20);
  });
});

test('named scene bookmarks survive playback updates, completion and restart in timeline order', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/films/one.mp4', { positionSeconds: 10, durationSeconds: 600 });
    const later = history.addPoint('/films/one.mp4', { title: '  The chase  ', positionSeconds: 400.5 });
    const earlier = history.addPoint('/films/one.mp4', { title: 'Opening', positionSeconds: 0 });
    assert.match(later.id, /^[a-f0-9-]{36}$/);
    assert.notEqual(later.id, earlier.id);
    assert.equal(later.title, 'The chase');
    history.set('/films/one.mp4', { positionSeconds: 30 });
    history.set('/films/one.mp4', { positionSeconds: 600, completed: true });
    await history.flush();
    const restored = await loadPlaybackHistory(path);
    assert.deepEqual(restored.getPoints('/films/one.mp4'), [earlier, later]);
    assert.deepEqual(restored.list()[0].points, [earlier, later]);
    assert.equal(restored.list()[0].completed, true);
    restored.set('/films/one.mp4', { positionSeconds: 0, reset: true });
    assert.deepEqual(restored.getPoints('/films/one.mp4'), [earlier, later]);
  });
});

test('scene bookmark edits preserve viewing time and recency and return defensive copies', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/films/one.mp4', { positionSeconds: 10, durationSeconds: 600 });
    history.set('/films/two.mp4', { positionSeconds: 20 });
    const before = history.list();
    const point = history.addPoint('/films/one.mp4', { title: 'The chase', positionSeconds: 400 });
    assert.deepEqual(history.list().map(({ path, updatedAt }) => ({ path, updatedAt })),
      before.map(({ path, updatedAt }) => ({ path, updatedAt })));
    point.title = 'Changed returned point';
    const points = history.getPoints('/films/one.mp4');
    points[0].positionSeconds = 500;
    points.push({ id: 'extra', title: 'Extra', positionSeconds: 0 });
    const entries = history.list();
    entries[1].points[0].title = 'Changed listed point';
    entries[1].points.length = 0;
    assert.deepEqual(history.getPoints('/films/one.mp4'), [{ id: point.id, title: 'The chase', positionSeconds: 400 }]);
    assert.deepEqual(history.getPoints('/films/unknown.mp4'), []);
    await history.flush();
    assert.equal(history.removePoint('/films/one.mp4', point.id), true);
    assert.equal(history.removePoint('/films/one.mp4', point.id), false);
    assert.equal(history.removePoint('/films/unknown.mp4', point.id), false);
    assert.deepEqual(history.list(), before);
    await history.flush();
    assert.deepEqual((await loadPlaybackHistory(path)).list(), before);
  });
});

test('scene bookmarks validate existing files, titles, times, duration and the per-file limit', async () => {
  await withHistory(async path => {
    const history = await loadPlaybackHistory(path);
    assert.throws(() => history.addPoint('/films/missing.mp4', { title: 'Opening', positionSeconds: 0 }), /Play this file/);
    history.set('/films/one.mp4', { positionSeconds: 10, durationSeconds: 600 });
    for (const title of ['', '  ', 'x'.repeat(121), null, 5, undefined]) {
      assert.throws(() => history.addPoint('/films/one.mp4', { title, positionSeconds: 20 }), /title/);
    }
    for (const positionSeconds of [NaN, Infinity, -1, '20', undefined]) {
      assert.throws(() => history.addPoint('/films/one.mp4', { title: 'A scene', positionSeconds }), /finite, nonnegative/);
    }
    assert.throws(() => history.addPoint('/films/one.mp4', { title: 'Too late', positionSeconds: 601 }), /duration/);
    assert.throws(() => history.getPoints('relative.mp4'), /absolute/);
    assert.throws(() => history.removePoint('/films/one.mp4', null), /valid scene bookmark/);
    assert.deepEqual(history.getPoints('/films/one.mp4'), []);
    for (let i = 0; i < 100; i++) history.addPoint('/films/one.mp4', { title: `Scene ${i}`, positionSeconds: i });
    assert.throws(() => history.addPoint('/films/one.mp4', { title: 'Extra', positionSeconds: 100 }), /up to 100/);
    assert.equal(history.getPoints('/films/one.mp4').length, 100);
    history.set('/films/unknown-duration.mp4', { positionSeconds: 0 });
    history.addPoint('/films/unknown-duration.mp4', { title: 'Later', positionSeconds: 3600 });
    assert.equal(history.getPoints('/films/unknown-duration.mp4')[0].positionSeconds, 3600);
  });
});

test('older version-one history without scene bookmarks remains readable and editable', async () => {
  await withHistory(async path => {
    const oldEntry = { path: '/films/one.mp4', title: 'One', positionSeconds: 10,
      durationSeconds: 600, completed: false, updatedAt: '2026-09-19T00:00:00.000Z' };
    await writeFile(path, JSON.stringify({ version: 1, entries: [oldEntry] }));
    const history = await loadPlaybackHistory(path);
    assert.deepEqual(history.list(), [{ ...oldEntry, points: [] }]);
    const point = history.addPoint('/films/one.mp4', { title: 'Opening', positionSeconds: 0 });
    await history.flush();
    const restored = await loadPlaybackHistory(path);
    assert.deepEqual(restored.getPoints('/films/one.mp4'), [point]);
    assert.equal(restored.list()[0].updatedAt, oldEntry.updatedAt);
  });
});

test('malformed persisted scene bookmarks are reported without altering the original file', async () => {
  await withHistory(async path => {
    const entry = { path: '/films/one.mp4', title: 'One', positionSeconds: 10,
      durationSeconds: 600, completed: false, updatedAt: '2026-09-19T00:00:00.000Z' };
    const valid = { id: 'scene-one', title: 'Opening', positionSeconds: 0 };
    for (const points of [null, {}, [{ ...valid, positionSeconds: -1 }], [{ ...valid, title: '' }],
      [{ ...valid, id: '' }], [valid, valid], Array.from({ length: 101 }, (_, index) => ({ ...valid, id: `scene-${index}` }))]) {
      const content = JSON.stringify({ version: 1, entries: [{ ...entry, points }] });
      await writeFile(path, content);
      await assert.rejects(loadPlaybackHistory(path), /Cannot read playback history/);
      assert.equal(await readFile(path, 'utf8'), content);
    }
  });
});

test('unchanged playback polls preserve viewing timestamps, recency and the file on disk', async () => {
  await withHistory(async path => {
    const oldEntries = [
      { path: '/films/one.mp4', title: 'One', positionSeconds: 10, durationSeconds: 600, completed: false,
        updatedAt: '2026-09-18T00:00:00.000Z' },
      { path: '/films/two.mp4', title: 'Two', positionSeconds: 20, durationSeconds: 900, completed: false,
        updatedAt: '2026-09-19T00:00:00.000Z' },
    ];
    const content = JSON.stringify({ version: 1, entries: oldEntries });
    await writeFile(path, content);
    const history = await loadPlaybackHistory(path);
    const before = history.list();
    history.set('/films/one.mp4', { title: ' One ', positionSeconds: 10, durationSeconds: 600 });
    history.set('/films/one.mp4', { positionSeconds: 0, durationSeconds: 0 });
    assert.deepEqual(history.list(), before);
    await history.flush();
    assert.equal(await readFile(path, 'utf8'), content, 'unchanged polling must not rewrite history');
    history.set('/films/one.mp4', { positionSeconds: 11 });
    assert.equal(history.list()[0].path, '/films/one.mp4');
    assert.notEqual(history.list()[0].updatedAt, oldEntries[0].updatedAt);
  });
});
