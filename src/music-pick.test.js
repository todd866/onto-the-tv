import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybackHistory } from './playback-history.js';
import player from '../shuffler/player.js';
import {
  artistKeyForVideo, buildMusicHeardMap, createMusicEmbedState, createMusicEmbedLoader, loadMusicEmbeddings,
  isMusicSessionFolder, mildMusicSkipWeight, musicHeardRecently, musicRankScore, musicSimilarity, normalizeArtist,
  parseArtistTitleFromVideo, pickMusicVideoIndex, songMatchKey, MUSIC_EMBED_DIM, MUSIC_HEARD_MS,
} from './music-pick.js';
import { createFileStorage, createTvLibrary } from './tv-server.js';

const tune = (src, channel, title = 'Track', extra = {}) => ({
  src, file: `/m/${src}`, title, channel, tier: 'music', duration: 240, ...extra,
});

async function fixtureVectors(dir, { dim = 4, rows } = {}) {
  const trackRows = rows || [
    { id: '1', artist: 'Alpha One', title: 'Song A' },
    { id: '2', artist: 'Alpha Two', title: 'Song B' },
    { id: '3', artist: 'Beta Band', title: 'Song C' },
  ];
  await writeFile(join(dir, 'tracks-index.jsonl'), trackRows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const buf = Buffer.alloc(trackRows.length * dim * 4);
  const vectors = trackRows.map((_, i) => {
    const v = new Array(dim).fill(0);
    v[i % dim] = 1;
    if (i === 1 && dim > 1) v[0] = 0.98;
    return v;
  });
  let at = 0;
  for (const vec of vectors) {
    for (const v of vec) { buf.writeFloatLE(v, at); at += 4; }
  }
  await writeFile(join(dir, 'tracks.f32'), buf);
  return { dim, trackRows };
}

test('normalizeArtist strips the prefix, feat, and accents', () => {
  assert.equal(normalizeArtist('The Chemical Brothers'), 'chemical brothers');
  assert.equal(normalizeArtist('Fred again.. feat. Delilah'), 'fred again');
  assert.equal(normalizeArtist('RÜFÜS DU SOL & Tourist'), 'rufus du sol');
});

test('session folders take the performer from the title, not the folder name', () => {
  assert.equal(isMusicSessionFolder('KEXP'), true);
  assert.equal(isMusicSessionFolder('Tiny Desk'), true);
  const kexp = tune('music/KEXP/live.mp4', 'KEXP', 'Radiohead — Live');
  assert.equal(artistKeyForVideo(kexp), 'radiohead');
  const tiny = tune('music/Tiny Desk/x.mp4', 'Tiny Desk', 'Post Malone: Tiny Desk Concert');
  assert.equal(artistKeyForVideo(tiny), 'post malone');
  const lav = tune('music/LAV/x.mp4', 'Like A Version', 'Gang of Youths covers Bowie for Like A Version');
  assert.equal(parseArtistTitleFromVideo(lav).artist, 'Gang of Youths');
  assert.equal(parseArtistTitleFromVideo(lav).title, 'Bowie');
});

test('embed loader builds centroids and reads dim from file size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  const { dim } = await fixtureVectors(dir);
  const state = createMusicEmbedState();
  assert.equal(await loadMusicEmbeddings(state, dir, () => {}, { expectedDim: dim }), true);
  assert.equal(state.dim, dim);
  assert.equal(state.centroids.has('alpha one'), true);
  const a = { channel: 'Alpha One', title: 'Song A' };
  const b = { channel: 'Alpha Two', title: 'Song B' };
  const c = { channel: 'Beta Band', title: 'Song C' };
  assert.ok(musicSimilarity(state, a, b) > musicSimilarity(state, a, c));
});

test('inconsistent vector snapshots keep the previous valid state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  const { dim } = await fixtureVectors(dir);
  const state = createMusicEmbedState();
  assert.equal(await loadMusicEmbeddings(state, dir, () => {}, { expectedDim: dim }), true);
  assert.equal(state.centroids.size, 3);
  await writeFile(join(dir, 'tracks.f32'), Buffer.alloc(99));
  assert.equal(await loadMusicEmbeddings(state, dir, () => {}, { expectedDim: MUSIC_EMBED_DIM }), true);
  assert.equal(state.centroids.size, 3);
});

test('heard-recently goes behind unheard picks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const vecDir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  const { dim } = await fixtureVectors(vecDir);
  const musicEmbed = createMusicEmbedLoader({ dir: vecDir, log: () => {}, pollMs: 0, expectedDim: 4 });
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

test('heard filtering works when embeddings are missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One'),
    tune('music/Beta Band/c.mp4', 'Beta Band'),
  ];
  const heardAt = new Date(Date.now() - MUSIC_HEARD_MS + 3600_000).toISOString();
  await history.set(videos[0].file, { title: videos[0].title, positionSeconds: 5, durationSeconds: 240, completed: false, updatedAt: heardAt });
  const musicEmbed = createMusicEmbedLoader({ dir: join(dir, 'missing'), log: () => {}, pollMs: 0 });
  await musicEmbed.refresh(true);
  const library = createTvLibrary({ videos, history, storage, musicEmbed, random: () => 0 });
  library.home('dad');
  const pick = library.next('music', { viewers: 'dad' });
  assert.equal(pick.src, videos[1].src);
});

test('artist variety is checked before unheard preference', () => {
  const videos = [
    tune('music/A/a.mp4', 'A', 'A — one'),
    tune('music/A/b.mp4', 'A', 'A — two'),
    tune('music/B/c.mp4', 'B', 'B — three'),
  ];
  const heard = new Map([[videos[0].src, Date.now()]]);
  const weights = Object.fromEntries(videos.map(item => [item.src, 1]));
  const pick = pickMusicVideoIndex({
    videos, pool: [0, 1, 2], weights, currentIndex: 0, played: [0], random: () => 0,
    embed: createMusicEmbedState(), heard,
  });
  assert.equal(pick, 2);
});

test('same-artist-only pool returns no eligible track', () => {
  const videos = [
    tune('music/A/a.mp4', 'A', 'A — one'),
    tune('music/A/b.mp4', 'A', 'A — two'),
  ];
  const pick = pickMusicVideoIndex({
    videos, pool: [0, 1], weights: { [videos[0].src]: 1, [videos[1].src]: 1 },
    currentIndex: 0, played: [0], random: () => 0, embed: createMusicEmbedState(), heard: new Map(),
  });
  assert.equal(pick, -1);
});

test('a skip within 30 seconds lowers taste weight', () => {
  assert.equal(mildMusicSkipWeight(1, 'skip', 12), 0.85);
  assert.equal(mildMusicSkipWeight(2, 'skip', 40), null);
  assert.equal(mildMusicSkipWeight(1, 'ended', 5), null);
});

test('early music skip stores mild dislike, not the generic learner value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const video = tune('music/Alpha One/a.mp4', 'Alpha One');
  const library = createTvLibrary({ videos: [video], history: await loadPlaybackHistory(join(dir, 'history.json')), storage, random: () => 0 });
  assert.throws(() => library.next('music', { viewers: 'dad', current: video.src, reason: 'skip', time: 12, duration: 240, watched: 5 }), /empty/);
  const stored = player.readStored(storage, 'grown');
  assert.equal(stored[video.src], 0.85);
});

test('music videos never resume from history or channel left-on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One'),
    { src: 'Films/x.mkv', file: '/m/Films/x.mkv', title: 'Film', channel: 'Films', tier: 'grownup', duration: 6000 },
  ];
  let nowMs = Date.now();
  const fresh = createTvLibrary({ videos, history, storage, random: () => 0, now: () => nowMs });
  fresh.progress({ src: videos[0].src, positionSeconds: 120, durationSeconds: 240, completed: false });
  assert.throws(() => fresh.next('music', { viewers: 'dad' }), /empty/);
  nowMs += MUSIC_HEARD_MS + 1000;
  const back = fresh.next('music', { viewers: 'dad' });
  assert.equal(back.resume, 0);
  fresh.next('movies', { viewers: 'dad' });
  assert.throws(() => fresh.next('music', { viewers: 'dad' }), /empty/);
});

test('similar artist is preferred when embeddings are present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const vecDir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  const { dim } = await fixtureVectors(vecDir);
  const musicEmbed = createMusicEmbedLoader({ dir: vecDir, log: () => {}, pollMs: 0, expectedDim: 4 });
  await musicEmbed.refresh(true);
  const videos = [
    tune('music/Alpha One/a.mp4', 'Alpha One', 'Song A'),
    tune('music/Alpha Two/b.mp4', 'Alpha Two', 'Song B'),
    tune('music/Beta Band/c.mp4', 'Beta Band', 'Song C'),
  ];
  const heard = buildMusicHeardMap({ historyList: [], videos });
  const weights = Object.fromEntries(videos.map(item => [item.src, 1]));
  const first = pickMusicVideoIndex({
    videos, pool: [0, 1, 2], weights, currentIndex: 0, played: [0], random: () => 0,
    embed: musicEmbed.state, heard, anchorItem: videos[0],
  });
  assert.equal(first, 1);
  assert.ok(
    musicSimilarity(musicEmbed.state, videos[0], videos[1])
    > musicSimilarity(musicEmbed.state, videos[0], videos[2]),
  );
});

test('song vectors beat artist centroids when the title matches the index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  const rows = [
    { artist: 'Four Tet', title: 'Sing' },
    { artist: 'Four Tet', title: 'Lush' },
    { artist: 'Bonobo', title: 'Drift' },
  ];
  const { dim } = await fixtureVectors(dir, { rows });
  const state = createMusicEmbedState();
  await loadMusicEmbeddings(state, dir, () => {}, { expectedDim: dim });
  assert.equal(state.tracks.has(songMatchKey('Four Tet', 'Sing')), true);
  const from = { channel: 'Four Tet', title: 'Four Tet - Sing' };
  const near = { channel: 'Four Tet', title: 'Four Tet - Lush' };
  const far = { channel: 'Bonobo', title: 'Bonobo - Drift' };
  assert.ok(musicSimilarity(state, from, near) > musicSimilarity(state, from, far));
});

test('evening music picks unheard shorts over heard long sets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-music-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const longHeard = tune('music/Alpha One/long.mp4', 'Alpha One', 'Song A', { duration: 3600 });
  const shortNew = tune('music/Beta Band/short.mp4', 'Beta Band', 'Song C', { duration: 240 });
  const heardAt = new Date(Date.now() - MUSIC_HEARD_MS + 3600_000).toISOString();
  await history.set(longHeard.file, { title: longHeard.title, positionSeconds: 5, durationSeconds: 3600, completed: false, updatedAt: heardAt });
  const vecDir = await mkdtemp(join(tmpdir(), 'onto-music-vec-'));
  await fixtureVectors(vecDir);
  const musicEmbed = createMusicEmbedLoader({ dir: vecDir, log: () => {}, pollMs: 0, expectedDim: 4 });
  await musicEmbed.refresh(true);
  const library = createTvLibrary({
    videos: [longHeard, shortNew], history, storage, musicEmbed, random: () => 0,
    now: () => Date.UTC(2026, 0, 1, 20),
  });
  library.home('dad');
  const pick = library.next('music', { viewers: 'dad' });
  assert.equal(pick.src, shortNew.src);
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

test('buildMusicHeardMap reuses a supplied path lookup', () => {
  const videos = [tune('music/A/a.mp4', 'A')];
  const byFile = new Map(videos.map(item => [item.file, item]));
  let mapAllocs = 0;
  const origMap = videos.map;
  videos.map = (...args) => { mapAllocs += 1; return origMap.apply(videos, args); };
  try {
    buildMusicHeardMap({
      historyList: [{ path: videos[0].file, updatedAt: new Date().toISOString() }],
      videos, byFile,
    });
    assert.equal(mapAllocs, 0);
    buildMusicHeardMap({
      historyList: [{ path: videos[0].file, updatedAt: new Date().toISOString() }],
      videos,
    });
    assert.equal(mapAllocs, 1);
  } finally { videos.map = origMap; }
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