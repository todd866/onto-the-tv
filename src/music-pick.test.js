import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybackHistory } from './playback-history.js';
import {
  buildMusicHeardMap, createMusicEmbedState, createMusicEmbedLoader, loadMusicEmbeddings,
  mildMusicSkipWeight, musicHeardRecently, musicRankScore, musicSimilarity, normalizeArtist,
  pickMusicVideoIndex, MUSIC_HEARD_MS,
} from './music-pick.js';
import { createFileStorage, createTvLibrary } from './tv-server.js';

const tune = (src, channel, title = 'Track') => ({
  src, file: `/m/${src}`, title, channel, tier: 'music', duration: 240,
});

async function fixtureVectors(dir) {
  const dim = 4;
  const rows = [
    { id: '1', artist: 'Alpha One', title: 'Song A' },
    { id: '2', artist: 'Alpha Two', title: 'Song B' },
    { id: '3', artist: 'Beta Band', title: 'Song C' },
  ];
  await writeFile(join(dir, 'tracks-index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const buf = Buffer.alloc(rows.length * dim * 4);
  const vectors = [
    [1, 0, 0, 0],
    [0.98, 0.2, 0, 0],
    [0, 1, 0, 0],
  ];
  let at = 0;
  for (const vec of vectors) {
    for (const v of vec) { buf.writeFloatLE(v, at); at += 4; }
  }
  await writeFile(join(dir, 'tracks.f32'), buf);
  return dim;
}

test('normalizeArtist strips the prefix, feat, and accents', () => {
  assert.equal(normalizeArtist('The Chemical Brothers'), 'chemical brothers');
  assert.equal(normalizeArtist('Fred again.. feat. Delilah'), 'fred again');
  assert.equal(normalizeArtist('RÜFÜS DU SOL & Tourist'), 'rufus du sol');
});

test('embed loader builds centroids and reads dim from file size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  await fixtureVectors(dir);
  const state = createMusicEmbedState();
  assert.equal(await loadMusicEmbeddings(state, dir), true);
  assert.equal(state.dim, 4);
  assert.equal(state.centroids.has('alpha one'), true);
  assert.ok(musicSimilarity(state, 'alpha one', 'alpha two') > musicSimilarity(state, 'alpha one', 'beta band'));
});

test('heard-recently goes behind unheard picks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const vecDir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  await fixtureVectors(vecDir);
  const musicEmbed = createMusicEmbedLoader({ dir: vecDir, log: () => {}, pollMs: 0 });
  await musicEmbed.refresh(true);
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One'),
    tune('music/Alpha Two/b.mp4', 'Alpha Two'),
    tune('music/Beta Band/c.mp4', 'Beta Band'),
  ];
  const heardAt = new Date(Date.now() - MUSIC_HEARD_MS + 3600_000).toISOString();
  await history.set(videos[0].file, { title: videos[0].title, positionSeconds: 5, durationSeconds: 240, completed: false, updatedAt: heardAt });
  const library = createTvLibrary({ videos, history, storage, musicEmbed, random: () => 0, now: () => Date.now() });
  library.home('dad');
  const pick = library.next('music', { viewers: 'dad' });
  assert.notEqual(pick.src, videos[0].src);
});

test('a skip within 30 seconds lowers taste weight', () => {
  assert.equal(mildMusicSkipWeight(1, 'skip', 12), 0.85);
  assert.equal(mildMusicSkipWeight(2, 'skip', 40), null);
  assert.equal(mildMusicSkipWeight(1, 'ended', 5), null);
});

test('music videos never resume from history or channel left-on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One'),
    { src: 'Films/x.mkv', file: '/m/Films/x.mkv', title: 'Film', channel: 'Films', tier: 'grownup', duration: 6000 },
  ];
  const library = createTvLibrary({ videos, history, storage, random: () => 0 });
  library.progress({ src: videos[0].src, positionSeconds: 120, durationSeconds: 240, completed: false });
  const back = library.next('music', { viewers: 'dad' });
  assert.equal(back.resume, 0);
  library.next('music', { viewers: 'dad', current: back.src, reason: 'skip', time: 150, duration: 240, watched: 30 });
  library.next('movies', { viewers: 'dad' });
  const again = library.next('music', { viewers: 'dad' });
  assert.equal(again.resume, 0);
});

test('similar artist is preferred when embeddings are present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const vecDir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  await fixtureVectors(vecDir);
  const musicEmbed = createMusicEmbedLoader({ dir: vecDir, log: () => {}, pollMs: 0 });
  await musicEmbed.refresh(true);
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One'),
    tune('music/Alpha Two/b.mp4', 'Alpha Two'),
    tune('music/Beta Band/c.mp4', 'Beta Band'),
  ];
  const heard = buildMusicHeardMap({ historyList: [], videos });
  const weights = Object.fromEntries(videos.map(item => [item.src, 1]));
  const first = pickMusicVideoIndex({
    videos, pool: [0, 1, 2], weights, currentIndex: 0, played: [0], random: () => 0,
    embed: musicEmbed.state, heard, anchorKey: 'alpha one',
  });
  assert.equal(first, 1);
  const scores = [0, 1, 2].map(index => musicRankScore({
    index, videos, tasteWeight: 1, embed: musicEmbed.state, anchorKey: 'alpha one', heard,
  }));
  assert.ok(scores[1] > scores[2]);
});

test('missing vector files leave picks unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One'),
    tune('music/Beta Band/c.mp4', 'Beta Band'),
  ];
  const logs = [];
  const musicEmbed = createMusicEmbedLoader({ dir: join(dir, 'missing'), log: line => logs.push(line), pollMs: 0 });
  await musicEmbed.refresh(true);
  assert.equal(musicEmbed.state.ready, false);
  assert.ok(logs.some(line => line.includes('music vectors')));
  const library = createTvLibrary({ videos, history, storage, musicEmbed, random: () => 0 });
  const pick = library.next('music', { viewers: 'dad' });
  assert.ok(videos.some(item => item.src === pick.src));
});

test('musicHeardRecently honours history timestamps', () => {
  const videos = [tune('music/A/a.mp4', 'A')];
  const heard = buildMusicHeardMap({
    historyList: [{ path: videos[0].file, updatedAt: new Date().toISOString(), positionSeconds: 2 }],
    videos,
    nowMs: Date.now(),
  });
  assert.equal(musicHeardRecently(videos[0].src, heard), true);
  const old = buildMusicHeardMap({
    historyList: [{ path: videos[0].file, updatedAt: new Date(Date.now() - MUSIC_HEARD_MS - 1000).toISOString() }],
    videos,
  });
  assert.equal(musicHeardRecently(videos[0].src, old), false);
});