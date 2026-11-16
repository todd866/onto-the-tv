import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const MUSIC_VIDEO_CHANNEL_IDS = new Set(['music', 'dance', 'livesets', 'triplej', 'doublej']);
export const MUSIC_HEARD_MS = 3 * 24 * 60 * 60 * 1000;
export const MUSIC_EARLY_SKIP_SECONDS = 30;
export const MUSIC_EXPLORATION_SHARE = 0.12;
export const MUSIC_NEUTRAL_SIMILARITY = 0.8;
export const MUSIC_WEIGHT_FLOOR = 0.15;
export const MUSIC_MILD_DISLIKE = 0.85;
export const DEFAULT_MUSIC_VECTORS_DIR = join(homedir(), '.local/state/glancebar-music-embed/vectors');

const FEAT_MARKERS = [',', '&', ' feat.', ' feat ', ' ft.', ' ft ', ' featuring '];
const PUNCT_RE = /[^a-z0-9\s]+/g;
const SPACE_RE = /\s+/g;

export function isMusicVideoChannel(channelId) {
  return MUSIC_VIDEO_CHANNEL_IDS.has(channelId);
}

export function isMusicVideoItem(item) {
  return item?.tier === 'music';
}

export function isMusicVideoPick(channelId, item) {
  return isMusicVideoChannel(channelId) && isMusicVideoItem(item);
}

/** Glancebar embed.py primary_artist + "the " prefix strip. */
export function normalizeArtist(artist) {
  let text = String(artist || '').toLowerCase();
  for (const needle of FEAT_MARKERS) {
    const idx = text.indexOf(needle);
    if (idx >= 0) text = text.slice(0, idx);
  }
  text = text.normalize('NFD').replace(/\p{M}/gu, '');
  text = text.replace(PUNCT_RE, ' ').replace(SPACE_RE, ' ').trim();
  if (text.startsWith('the ')) text = text.slice(4).trim();
  return text;
}

/** Folder/show name, else the artist part of "Artist — Song". */
export function artistFromVideo(item) {
  const show = String(item?.channel || '').trim();
  if (show) return show;
  const title = String(item?.title || item?.src || '');
  const match = title.match(/^(.+?)\s+(?:[—–\-]|·)\s+/);
  return match ? match[1].trim() : title.trim();
}

export function artistKeyForVideo(item) {
  const key = normalizeArtist(artistFromVideo(item));
  return key || '';
}

/** Glancebar MusicSpaceFlowFactor (pure.m). */
export function musicFlowFactor(sim) {
  const x = Math.exp((sim - 0.85) / 0.03);
  if (x < 0.05) return 0.05;
  if (x > 20) return 20;
  return x;
}

function l2Normalize(vec, dim) {
  let acc = 0;
  for (let i = 0; i < dim; i++) acc += vec[i] * vec[i];
  if (acc <= 0) return null;
  const scale = acc ** -0.5;
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = vec[i] * scale;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function weightedChoice(items, weightFn, random) {
  let total = 0;
  for (const item of items) total += weightFn(item);
  if (!items.length) return -1;
  if (total <= 0) return items[0];
  let remaining = random() * total;
  for (const item of items) {
    remaining -= weightFn(item);
    if (remaining < 0) return item;
  }
  return items[items.length - 1];
}

export function buildMusicHeardMap({ historyList, videos, extra = null, nowMs = Date.now() }) {
  const byPath = new Map(videos.map(item => [item.file, item]));
  const heard = new Map();
  const horizon = nowMs - MUSIC_HEARD_MS;
  for (const entry of historyList || []) {
    const item = byPath.get(entry.path);
    if (!item) continue;
    const at = Date.parse(entry.updatedAt);
    if (!Number.isFinite(at) || at < horizon) continue;
    const prior = heard.get(item.src);
    if (!prior || at > prior) heard.set(item.src, at);
  }
  if (extra) for (const [src, at] of extra) {
    if (typeof at !== 'number' || at < horizon) continue;
    const prior = heard.get(src);
    if (!prior || at > prior) heard.set(src, at);
  }
  return heard;
}

export function musicHeardRecently(src, heard) {
  return heard.has(src);
}

export function mildMusicSkipWeight(was, reason, time) {
  if (reason !== 'skip' || !Number.isFinite(time) || time >= MUSIC_EARLY_SKIP_SECONDS) return null;
  return Math.max(MUSIC_WEIGHT_FLOOR, was * MUSIC_MILD_DISLIKE);
}

function exploreBlend(weight, maxWeight) {
  const target = Math.max(weight, maxWeight * MUSIC_EXPLORATION_SHARE);
  return weight * (1 - MUSIC_EXPLORATION_SHARE) + target * MUSIC_EXPLORATION_SHARE;
}

export function createMusicEmbedState() {
  return {
    ready: false,
    centroids: new Map(),
    dim: 0,
    dir: '',
    indexMtime: 0,
    f32Mtime: 0,
    lastCheck: 0,
  };
}

export async function loadMusicEmbeddings(state, dir, log = () => {}) {
  const indexPath = join(dir, 'tracks-index.jsonl');
  const f32Path = join(dir, 'tracks.f32');
  let indexInfo, f32Info;
  try {
    indexInfo = await stat(indexPath);
    f32Info = await stat(f32Path);
  } catch {
    state.ready = false;
    state.centroids = new Map();
    return false;
  }
  const raw = await readFile(f32Path);
  const lines = (await readFile(indexPath, 'utf8')).split('\n').filter(Boolean);
  if (!lines.length || raw.length < 4) {
    log('music vectors: empty index or f32');
    state.ready = false;
    return false;
  }
  const dim = Math.floor(raw.length / (lines.length * 4));
  if (dim < 1 || raw.length !== lines.length * dim * 4) {
    log('music vectors: f32 size does not match index rows');
    state.ready = false;
    return false;
  }
  const view = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const sums = new Map();
  const counts = new Map();
  for (let row = 0; row < lines.length; row++) {
    let rowMeta;
    try { rowMeta = JSON.parse(lines[row]); } catch { continue; }
    const key = normalizeArtist(rowMeta.artist);
    if (!key) continue;
    if (!sums.has(key)) {
      sums.set(key, new Float64Array(dim));
      counts.set(key, 0);
    }
    const sum = sums.get(key);
    const offset = row * dim;
    for (let i = 0; i < dim; i++) sum[i] += view[offset + i];
    counts.set(key, counts.get(key) + 1);
  }
  const centroids = new Map();
  for (const [key, sum] of sums) {
    const n = counts.get(key);
    const vec = new Float32Array(dim);
    for (let i = 0; i < dim; i++) vec[i] = sum[i] / n;
    const unit = l2Normalize(vec, dim);
    if (unit) centroids.set(key, unit);
  }
  state.ready = centroids.size > 0;
  state.centroids = centroids;
  state.dim = dim;
  state.dir = dir;
  state.indexMtime = indexInfo.mtimeMs;
  state.f32Mtime = f32Info.mtimeMs;
  return state.ready;
}

export function musicSimilarity(embed, fromKey, toKey) {
  if (!embed?.ready || !fromKey || !toKey) return MUSIC_NEUTRAL_SIMILARITY;
  const a = embed.centroids.get(fromKey);
  const b = embed.centroids.get(toKey);
  if (!a || !b) return MUSIC_NEUTRAL_SIMILARITY;
  return dot(a, b);
}

export function musicCandidateWeight({ index, videos, tasteWeight, embed, anchorKey, heard }) {
  const item = videos[index];
  const artistKey = artistKeyForVideo(item);
  const sim = anchorKey ? musicSimilarity(embed, anchorKey, artistKey) : MUSIC_NEUTRAL_SIMILARITY;
  const flow = musicFlowFactor(sim);
  return Math.max(0, tasteWeight) * flow * (heard.has(item.src) ? 0.02 : 1);
}

export function musicRankScore({ index, videos, tasteWeight, embed, anchorKey, heard }) {
  const unheardBoost = musicHeardRecently(videos[index].src, heard) ? 0 : 1e12;
  return unheardBoost + musicCandidateWeight({ index, videos, tasteWeight, embed, anchorKey, heard });
}

export function pickMusicVideoIndex({ videos, pool, weights, currentIndex, played, random, embed, heard, anchorKey }) {
  const available = pool.filter(index => index !== currentIndex);
  if (!available.length) return -1;
  if (available.length === 1) return available[0];
  const currentArtist = currentIndex >= 0 ? artistKeyForVideo(videos[currentIndex]) : '';
  let unheard = available.filter(index => !heard.has(videos[index].src));
  let candidates = unheard.length ? unheard : available;
  const maxWeight = candidates.reduce((max, index) => {
    const taste = weights[videos[index].src] ?? 1;
    return Math.max(max, musicCandidateWeight({ index, videos, tasteWeight: taste, embed, anchorKey, heard: new Map() }));
  }, 0);
  let sameArtistOnly = candidates.filter(index => artistKeyForVideo(videos[index]) === currentArtist);
  if (currentArtist && sameArtistOnly.length < candidates.length) candidates = candidates.filter(index => artistKeyForVideo(videos[index]) !== currentArtist);
  if (!candidates.length) candidates = sameArtistOnly.length ? sameArtistOnly : available;
  const recentShows = played.slice(-2).map(index => artistKeyForVideo(videos[index]));
  const lastArtist = recentShows[recentShows.length - 1] || currentArtist;
  const pickWeight = index => {
    const taste = weights[videos[index].src] ?? 1;
    let w = musicCandidateWeight({ index, videos, tasteWeight: taste, embed, anchorKey: anchorKey || lastArtist, heard });
    if (lastArtist && artistKeyForVideo(videos[index]) === lastArtist) w *= 0.35;
    return exploreBlend(w, maxWeight);
  };
  return weightedChoice(candidates, pickWeight, random);
}

export function createMusicEmbedLoader({ dir = DEFAULT_MUSIC_VECTORS_DIR, log = () => {}, pollMs = 60_000, now = () => Date.now() } = {}) {
  const state = createMusicEmbedState();
  let loading = null;
  async function refresh(force = false) {
    const t = now();
    if (!force && t - state.lastCheck < pollMs && state.dir === dir) return state.ready;
    state.lastCheck = t;
    const indexPath = join(dir, 'tracks-index.jsonl');
    const f32Path = join(dir, 'tracks.f32');
    let indexInfo, f32Info;
    try {
      indexInfo = await stat(indexPath);
      f32Info = await stat(f32Path);
    } catch {
      if (state.dir !== dir || state.ready) log('music vectors: missing or unreadable');
      state.ready = false;
      state.centroids = new Map();
      state.dir = dir;
      return false;
    }
    if (!force && state.ready && state.dir === dir
      && state.indexMtime === indexInfo.mtimeMs && state.f32Mtime === f32Info.mtimeMs) return true;
    loading = loading || loadMusicEmbeddings(state, dir, log).catch(error => {
      log(`music vectors unavailable: ${error.message}`);
      state.ready = false;
      return false;
    }).finally(() => { loading = null; });
    await loading;
    return state.ready;
  }
  return { state, refresh };
}