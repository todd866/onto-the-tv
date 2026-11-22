import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const home = {};
runInNewContext(readFileSync(new URL('../ui/continue.js', import.meta.url), 'utf8'), { globalThis: home });
const NOW = Date.parse('2026-11-05T13:00:00Z');
const ep = (n, pos, dur, at) => ({ path: `/u/Movies/grown-ups/Mobland/Mobland S01E0${n}.mp4`, title: `Mobland S01E0${n}`, kind: 'show',
  positionSeconds: pos, durationSeconds: dur, completed: false, updatedAt: at || '' });

test('Up next shows one card per show and moves past an episode in its credits', () => {
  const items = [ep(5, 432, 2480, '2026-11-05T12:36:00Z'), ep(6, 2340, 2562, '2026-11-05T12:36:00Z'),
    ep(7, 2133, 2453, '2026-11-05T12:36:00Z'), ep(8, 0, 0), ep(9, 0, 0)];
  const row = home.continueRow(items, NOW);
  assert.equal(row.length, 1);
  assert.equal(row[0].title, 'Mobland S01E08');
  assert.equal(row[0].upNext, true);
});

test('Up next drops stale and barely-started plays', () => {
  const old = { path: '/u/Movies/family-shorts/Lou (2017).mp4', title: 'Lou (2017)', kind: 'film', positionSeconds: 374, durationSeconds: 404, completed: false, updatedAt: '2026-10-15T01:35:00Z' };
  const surf = { path: '/u/Movies/family-films/Cars.mp4', title: 'Cars', kind: 'film', positionSeconds: 12, durationSeconds: 7000, completed: false, updatedAt: '2026-11-05T12:00:00Z' };
  assert.equal(home.continueRow([old, surf], NOW).length, 0);
});

test('collection rows put the most recently watched collection first and collapse shows', () => {
  const items = [ep(7, 2133, 2453, '2026-11-05T12:36:00Z'), ep(8, 0, 0), ep(9, 0, 0),
    { path: '/u/Movies/family-films/Cars (2006).mp4', title: 'Cars (2006)', kind: 'film', positionSeconds: 0, durationSeconds: 0, completed: false, updatedAt: '' },
    { path: '/u/Movies/family-shorts/Piper (2016).mp4', title: 'Piper (2016)', kind: 'film', positionSeconds: 300, durationSeconds: 366, completed: false, updatedAt: '2026-10-15T01:17:00Z' }];
  const rows = home.collectionRows(items);
  assert.deepEqual([...rows.map(row => row.title)], ['Grown ups', 'Family shorts', 'Family films']);
  assert.deepEqual([...rows[0].items.map(item => item.title)], ['Mobland S01E08']);
  assert.deepEqual([...home.collectionRows(items, new Set(['/u/Movies/grown-ups/Mobland'])).map(row => row.title)], ['Family shorts', 'Family films']);
});

test('watchedList offers a finished show and seen films, not shows with episodes left', () => {
  const finished = [ep(8, 2500, 2560, '2026-11-05T13:20:00Z'), ep(7, 2133, 2453, '2026-11-05T12:36:00Z')];
  const film = { path: '/u/Movies/family-films/Cars (2006).mp4', title: 'Cars (2006)', kind: 'film', positionSeconds: 7000, durationSeconds: 7000, completed: true, updatedAt: '2026-11-01T00:00:00Z' };
  const list = home.watchedList([...finished, film]);
  assert.deepEqual([...list.map(entry => entry.title)], ['Mobland'], 'family collections are never offered');
  assert.equal(list[0].paths.length, 2);
  assert.equal(home.watchedList([...finished, ep(9, 0, 0)]).length, 0, 'E09 still unseen');
});
