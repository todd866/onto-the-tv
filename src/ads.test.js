import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';
import { buildPlayQueue, midBreakTimes } from './ads.js';

const day = Date.parse('2026-11-02T03:00:00.000Z');
function row(item) { return item.kind === 'ad' ? item.src : item.kind; }

test('a break is two or three ads near two minutes, and a day does not repeat one', () => {
  const ads = [
    { src: 'ads/80s/a.mp4', title: 'A', duration: 30 },
    { src: 'ads/80s/b.mp4', title: 'B', duration: 30 },
    { src: 'ads/80s/c.mp4', title: 'C', duration: 70 },
    { src: 'ads/80s/d.mp4', title: 'D', duration: 50 },
    { src: 'ads/80s/e.mp4', title: 'E', duration: 50 },
  ];
  const first = buildPlayQueue({
    show: { src: 'Show/a.mp4', duration: 600 }, ads, now: day, ceiling: 'M',
  });
  assert.deepEqual(first.queue.map(row), ['ads/80s/a.mp4', 'ads/80s/b.mp4', 'ads/80s/c.mp4', 'show']);
  const second = buildPlayQueue({
    show: { src: 'Show/a.mp4', duration: 600 }, ads, played: first.played, now: day, ceiling: 'M',
  });
  assert.deepEqual(second.queue.map(row), ['ads/80s/d.mp4', 'ads/80s/e.mp4', 'show']);
  const nextDay = buildPlayQueue({
    show: { src: 'Show/a.mp4', duration: 600 }, ads, played: second.played, now: Date.parse('2026-11-03T03:00:00.000Z'), ceiling: 'M',
  });
  assert.equal(nextDay.queue[0].src, 'ads/80s/a.mp4');
});

test('tiers.json can raise an ad above the viewers, and long shows break near the black frames', () => {
  const ads = [
    { src: 'ads/80s/Milk/a.mp4', title: 'Milk', duration: 50 },
    { src: 'ads/80s/Beer/b.mp4', title: 'Beer', duration: 50 },
    { src: 'ads/80s/Milk/c.mp4', title: 'Milk 2', duration: 50 },
  ];
  const queued = buildPlayQueue({
    show: { src: 'Show/a.mp4', duration: 1800 },
    ads,
    blacks: [10, 600, 1200, 1790],
    tiers: { older: ['Beer'] },
    ceiling: 'G',
    now: day,
  });
  assert.deepEqual(queued.queue.map(row), ['ads/80s/Milk/a.mp4', 'ads/80s/Milk/c.mp4', 'show']);
  assert.deepEqual(queued.queue[2].breaks.map(item => item.at), [600, 1200]);
  assert.equal(queued.queue[2].breaks[0].ads[0].src, 'ads/80s/Milk/a.mp4');

  assert.deepEqual(midBreakTimes(1200, [400, 800]), []);
  assert.deepEqual(midBreakTimes(1800, [500, 700]), [500, 700]);
  assert.deepEqual(buildPlayQueue({
    show: { src: 'Show/a.mp4', duration: 600 }, ads, ceiling: 'G', blocked: true, now: day,
  }).queue.map(row), ['show']);
});

test('the decade channel queue is a pre-roll then the show, and ads are not programmes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-ads-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const videos = [
    { src: 'Cheers/a.mp4', file: '/m/Cheers/a.mp4', title: 'Pilot', channel: 'Cheers', tier: '80s', duration: 600 },
    { src: 'ads/80s/a.mp4', file: '/m/ads/80s/a.mp4', title: 'A', channel: 'ads', tier: 'shared', duration: 50 },
    { src: 'ads/80s/b.mp4', file: '/m/ads/80s/b.mp4', title: 'B', channel: 'ads', tier: 'shared', duration: 50 },
    { src: 'ads/80s/c.mp4', file: '/m/ads/80s/c.mp4', title: 'C', channel: 'ads', tier: 'older', duration: 50 },
    { src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 },
  ];
  const library = createTvLibrary({ videos, history, storage, random: () => 0, now: () => day });
  const adsOnly = createTvLibrary({
    videos: [videos[1]], history, storage, random: () => 0, now: () => day,
  });
  assert.throws(() => adsOnly.next('cartoons', { viewers: 'sam' }), /empty/);
  const sam = library.next('cartoons', { viewers: 'sam' });
  assert.equal(sam.src, 'Bluey/a.mp4');
  assert.deepEqual(sam.queue.map(row), ['show']);

  const first = library.next('d80', { viewers: 'dad' });
  assert.equal(first.src, 'Cheers/a.mp4');
  assert.equal(first.tier, '80s');
  assert.deepEqual(first.queue.map(row), ['ads/80s/a.mp4', 'ads/80s/b.mp4', 'show']);
  const second = library.next('d80', { viewers: 'dad', current: first.src, reason: 'ended', time: 600, duration: 600, watched: 600 });
  assert.equal(second.queue[0].src, 'ads/80s/c.mp4');
});
