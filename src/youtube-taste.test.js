import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYouTubeTasteLoader, loadYouTubeTaste } from './youtube-taste.js';
import { musicCandidateWeight, pickMusicVideoIndex, youtubeTasteBoost } from './music-pick.js';
import { createFileStorage, createTvLibrary } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';
import { defaults, readSettings, writeSettings } from './settings.js';

const dir = fileURLToPath(new URL('../fixtures/youtube-takeout/', import.meta.url));
const nowMs = Date.parse('2026-01-01T00:00:00Z');
const load = () => loadYouTubeTaste({ dir, nowMs });
const tune = (id, artist) => ({ src: `music/${artist}/Track [${id}].mp4`, file: `/fake/${id}.mp4`, title: `${artist} — Track`, channel: artist, tier: 'music', duration: 240 });

test('only own playlists contribute saves; metadata IDs and quoted CSV work', async () => {
  const taste = await load();
  assert.deepEqual([...taste.savedVideoIds].sort(), ['sample00000', 'sample00001', 'sample00002', 'sample00003']);
});

test('affinity normalizes artists, matches whole phrases, decays yearly and caps', async () => {
  const taste = await load();
  assert.equal(taste.artistAffinity('Azure Echo'), 0.25);
  assert.equal(taste.artistAffinity('Old Ensemble'), 0.125);
  assert.equal(taste.artistAffinity('Household Band'), 0);
  assert.equal(taste.artistAffinity('Video Quartet'), 0.25);
  assert.equal(taste.artistAffinity('Later Artist'), 0.25);
  assert.equal(taste.artistAffinity('The RUFUS Fiction & Other'), 0.25);
  assert.equal(taste.artistAffinity('Capped Artist'), 1);
  assert.equal(taste.artistAffinity('Azure Ech'), 0);
  assert.equal(taste.artistAffinity(''), 0);
});

test('loader reads once, including missing and unconfigured snapshots with one log', async () => {
  for (const path of [dir, join(dir, 'missing'), undefined]) {
    const logs = [];
    let clockCalls = 0;
    const loader = createYouTubeTasteLoader({ dir: path, log: s => logs.push(s), now: () => { clockCalls++; return nowMs; } });
    const [a, b] = await Promise.all([loader(), loader()]);
    assert.equal(a, b);
    assert.equal(await loader(), a);
    assert.equal(clockCalls, 1);
    assert.equal(logs.length, path === dir ? 0 : 1);
    if (path !== dir) {
      assert.equal(a.savedVideoIds.size, 0);
      assert.equal(a.artistAffinity('Azure Echo'), 0);
    }
  }
});

test('saved and search boosts combine and heard tracks remain ineligible', async () => {
  const youtubeTaste = await load();
  const videos = [tune('sample00000', 'Capped Artist'), tune('unsaved0000', 'Neutral')];
  assert.equal(youtubeTasteBoost(videos[0], youtubeTaste), 3);
  assert.equal(youtubeTasteBoost(tune('unsaved0000', 'Capped Artist'), youtubeTaste), 1.5);
  assert.equal(youtubeTasteBoost({ ...videos[0], tier: 'grownup' }, youtubeTaste), 1);
  const base = { index: 0, videos, tasteWeight: 1, heard: new Map() };
  assert.equal(musicCandidateWeight({ ...base, youtubeTaste }), musicCandidateWeight(base) * 3);
  const options = { videos, pool: [0, 1], weights: {}, currentIndex: -1, played: [], random: () => 0.6, heard: new Map() };
  assert.equal(pickMusicVideoIndex(options), 1);
  assert.equal(pickMusicVideoIndex({ ...options, youtubeTaste }), 0);
  assert.equal(pickMusicVideoIndex({ ...options, youtubeTaste, heard: new Map([[videos[0].src, nowMs]]) }), 1);
  assert.equal(pickMusicVideoIndex({ ...options, youtubeTaste, heard: new Map(videos.map(v => [v.src, nowMs])) }), -1);
});

test('TV picks and directions share boosts and never fall back to heard music', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'youtube-taste-'));
  const history = await loadPlaybackHistory(join(temp, 'history.json'));
  const storage = await createFileStorage(join(temp, 'taste.json'));
  const videos = [tune('neutral0000', 'Neutral'), tune('sample00000', 'Saved'), tune('sample00001', 'Heard')];
  await history.set(videos[2].file, { updatedAt: new Date(nowMs).toISOString(), positionSeconds: 10, durationSeconds: 240 });
  const library = createTvLibrary({ videos, history, storage, youtubeTaste: await load(), random: () => 0.4, now: () => nowMs });
  const row = library.directions('music', { viewers: 'dad' });
  assert.equal(row.tiles[0].src, videos[1].src);
  assert.ok(row.tiles.every(item => item.src !== videos[2].src));
  assert.equal(library.next('music', { viewers: 'dad' }).src, videos[1].src);
  assert.equal(library.next('music', { viewers: 'dad' }).src, videos[0].src);
  assert.throws(() => library.next('music', { viewers: 'dad' }), /empty/);
});

test('settings retain the configurable Takeout directory', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'youtube-settings-'));
  const path = join(temp, 'settings.json');
  await writeSettings(path, { ...defaults(), youtubeTakeoutDir: dir });
  assert.equal((await readSettings(path)).youtubeTakeoutDir, dir);
});

test('staged music is invalidated when another channel has played it', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'youtube-staged-'));
  const history = await loadPlaybackHistory(join(temp, 'history.json'));
  const storage = await createFileStorage(join(temp, 'taste.json'));
  const videos = [tune('sample00000', 'Bicep'), tune('sample00001', 'Flume')];
  const library = createTvLibrary({ videos, history, storage, youtubeTaste: await load(), random: () => 0, now: () => nowMs });
  library.home('dad');
  const first = library.next('dance', { viewers: 'sam' });
  const second = library.next('music', { viewers: 'dad' });
  assert.notEqual(first.src, second.src);
  assert.throws(() => library.next('music', { viewers: 'dad' }), /empty/);
  assert.doesNotThrow(() => library.home('dad'));
  assert.equal(library.directions('music', { viewers: 'dad' }).tiles.length, 0);
});
