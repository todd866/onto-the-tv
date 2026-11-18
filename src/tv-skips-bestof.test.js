import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';

const episode = (show, s, e) => {
  const tag = `S0${s}E${String(e).padStart(2, '0')}`;
  return { src: `${show}/${show} ${tag}.mp4`, file: `/m/${show}/${show} ${tag}.mp4`, title: `${show} ${tag}`, channel: show, tier: 'grownup', duration: 1300 };
};

async function make(videos, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-skip-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  let clock = Date.parse('2026-11-18T12:00:00Z');
  const library = createTvLibrary({ videos, history, storage, random: () => 0, now: () => clock, ...options });
  return { library, history, storage, tick: ms => { clock += ms; } };
}

test('a skipped episode rests on that channel for three weeks, then may come back', async () => {
  const videos = [1, 2, 3].map(e => episode('Seinfeld (1989)', 1, e));
  const { library, tick } = await make(videos);
  const first = library.next('seinfeld', { viewers: 'dad' });
  assert.equal(first.title, 'Seinfeld (1989) S01E01');
  const after = library.next('seinfeld', { viewers: 'dad', current: first.src, reason: 'skip', time: 30, watched: 30, duration: 1300 });
  assert.notEqual(after.src, first.src);
  // Tuning in again, the card and the pick avoid it.
  for (let i = 0; i < 5; i++) assert.notEqual(library.next('seinfeld', { viewers: 'dad' }).src, first.src);
  assert.notEqual(library.home('dad').channels.find(channel => channel.id === 'seinfeld').now.src, first.src);
  tick(22 * 86400000);
  const back = new Set();
  for (let i = 0; i < 6; i++) back.add(library.next('seinfeld', { viewers: 'dad' }).src);
  assert.ok(back.has(first.src), 'rested long enough, it can be picked again');
});

test('a recorded skip (the server records stops under two minutes too) rests the episode on that channel', async () => {
  const videos = [1, 2].map(e => episode('Friends (1994)', 1, e));
  const { library, storage } = await make(videos);
  assert.equal(library.skipped({ src: videos[0].src, channel: 'friends' }), true);
  const cooled = JSON.parse(storage.getItem('onto.tv.skipCooldown.v1'));
  assert.ok(cooled.friends[videos[0].src]);
  assert.equal(library.next('friends', { viewers: 'mum' }).src, videos[1].src);
});

test('two skips of a show inside a week make it rarer for a few days', async () => {
  const videos = [...[1, 2, 3, 4].map(e => episode('Aaa Show', 1, e)), ...[1, 2, 3, 4].map(e => episode('Zzz Show', 1, e))];
  const share = async skips => {
    let aaa = 0;
    for (let seed = 1; seed <= 150; seed++) {
      let state = seed * 7919;
      const random = () => { state = (state * 48271) % 2147483647; return state / 2147483647; };
      const { library, tick } = await make(videos, { random });
      if (skips) { library.skipped({ src: videos[0].src, channel: 'fordad' }); tick(2 * 86400000); library.skipped({ src: videos[1].src, channel: 'fordad' }); }
      if (library.next('fordad', { viewers: 'dad' }).src.startsWith('Aaa Show/')) aaa++;
    }
    return aaa;
  };
  const before = await share(false), after = await share(true);
  assert.ok(after < before * 0.75, `Aaa picked ${after} times after two skips, ${before} without`);
});

test('a show new to the household opens on one of its best episodes; after a few, it plays in order', async () => {
  const videos = [1, 2, 3, 4, 5, 6].map(e => episode('Seinfeld (1989)', 1, e));
  const best = { 'Seinfeld (1989)': { top: [{ season: 1, episode: 5, rating: 9.6 }, { season: 1, episode: 3, rating: 9.3 }] } };
  const { library, history } = await make(videos, { bestEpisodes: () => best });
  const first = library.next('seinfeld', { viewers: 'dad' });
  assert.ok(['Seinfeld (1989) S01E05', 'Seinfeld (1989) S01E03'].includes(first.title), first.title);
  // Three episodes watched: back to the story's order.
  for (const index of [0, 1, 2]) history.set(videos[index].file, { title: 'x', positionSeconds: 1300, durationSeconds: 1300, completed: true });
  const later = library.next('seinfeld', { viewers: 'dad', current: videos[2].src, reason: 'ended', time: 1300, watched: 1300, duration: 1300 });
  assert.equal(later.title, 'Seinfeld (1989) S01E04');
});

test('without ratings a new show still starts at the beginning', async () => {
  const videos = [1, 2, 3].map(e => episode('Seinfeld (1989)', 1, e));
  const { library } = await make(videos);
  assert.equal(library.next('seinfeld', { viewers: 'dad' }).title, 'Seinfeld (1989) S01E01');
});
