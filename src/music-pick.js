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
export const MUSIC_EMBED_DIM = 3072;

const FEAT_MARKERS = [',', '&', ' feat.', ' feat ', ' ft.', ' ft ', ' featuring '];
const PUNCT_RE = /[^a-z0-9\s]+/g;
const SPACE_RE = /\s+/g;
const BRACKET_RE = /\[[^\]]*\]|\([^)]*\)/g;
const REMASTERED_RE = /\s*-\s*remastered.*$/i;
const MUSIC_SESSION_FOLDER_HINTS = [
  'kexp', 'tiny desk', 'mahogany', 'colors', 'cercle', 'like a version',
  'from the basement', 'live at the wireless', 'audiotree', 'npr',
];

function folderKey(text) {
  return String(text || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isMusicSessionFolder(channel) {
  const key = folderKey(channel);
  if (!key) return false;
  return MUSIC_SESSION_FOLDER_HINTS.some(hint => key === hint || key.includes(hint));
}

/** Glancebar embed.py normalize_title / match_key title half. */
export function normalizeTitle(title) {
  let text = String(title || '').toLowerCase();
  text = text.replace(REMASTERED_RE, '');
  text = text.replace(BRACKET_RE, '');
  text = text.replace(/[^\w\s]/g, ' ').replace(SPACE_RE, ' ').trim();
  return text;
}

export function songMatchKey(artist, title) {
  return `${normalizeArtist(artist)}\0${normalizeTitle(title)}`;
}

function stripTitleForParse(text) {
  return String(text || '').normalize('NFKC').replace(BRACKET_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Performing artist and song title for embed lookup; session folders never supply the artist. */
export function parseArtistTitleFromVideo(item) {
  const channel = String(item?.channel || '').trim();
  const session = isMusicSessionFolder(channel);
  let text = stripTitleForParse(item?.title || item?.src || '');

  const coverLav = /^(.+?)\s+covers?\s+(.+?)\s+for\s+like a version/i.exec(text);
  if (coverLav) return { artist: coverLav[1].trim(), title: coverLav[2].trim() };

  const performs = /^(.+?)\s+(?:performs?|plays?|sings?)\s+(.+?)\s+(?:live\s+)?(?:for|at|on|in)\s+(.+)$/i.exec(text);
  if (performs && (session || isMusicSessionFolder(performs[3]))) {
    return { artist: performs[1].trim(), title: performs[2].trim() };
  }

  const dash = /^(.+?)\s+(?:[—–\-]|·)\s+(.+)$/i.exec(text);
  if (dash) return { artist: dash[1].trim(), title: dash[2].trim() };

  const colon = /^([^:]{2,80}):\s*(.+)$/i.exec(text);
  if (colon && session && (isMusicSessionFolder(colon[2]) || folderKey(colon[2]).includes('tiny desk'))) {
    return { artist: colon[1].trim(), title: '' };
  }

  if (channel && !session) {
    const song = dash ? dash[2].trim() : (colon ? colon[2].trim() : text);
    return { artist: channel, title: song };
  }

  if (session) return { artist: text.trim(), title: '' };
  return { artist: text.trim(), title: '' };
}

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

export function artistFromVideo(item) {
  return parseArtistTitleFromVideo(item).artist;
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

export function buildMusicHeardMap({ historyList, videos, byFile = null, extra = null, nowMs = Date.now() }) {
  const byPath = byFile || new Map(videos.map(item => [item.file, item]));
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
    tracks: new Map(),
    dim: 0,
    dir: '',
    indexMtime: 0,
    f32Mtime: 0,
    lastCheck: 0,
  };
}

function embeddingVector(embed, item) {
  if (!embed?.ready || !item) return null;
  const { artist, title } = parseArtistTitleFromVideo(item);
  if (title) {
    const track = embed.tracks?.get(songMatchKey(artist, title));
    if (track) return track;
  }
  const key = normalizeArtist(artist);
  return key ? embed.centroids.get(key) : null;
}

export async function loadMusicEmbeddings(state, dir, log = () => {}, options = {}) {
  const expectedDim = options.expectedDim ?? MUSIC_EMBED_DIM;
  const indexPath = join(dir, 'tracks-index.jsonl');
  const f32Path = join(dir, 'tracks.f32');
  let indexInfo, f32Info;
  try {
    indexInfo = await stat(indexPath);
    f32Info = await stat(f32Path);
  } catch {
    if (!state.ready) {
      state.centroids = new Map();
      state.tracks = new Map();
    }
    state.ready = false;
    return false;
  }
  const raw = await readFile(f32Path);
  const lines = (await readFile(indexPath, 'utf8')).split('\n').filter(Boolean);
  const needBytes = lines.length * expectedDim * 4;
  if (!lines.length || raw.length !== needBytes) {
    log('music vectors: f32 size does not match index rows');
    return state.ready;
  }
  const view = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const dim = expectedDim;
  const sums = new Map();
  const counts = new Map();
  const tracks = new Map();
  for (let row = 0; row < lines.length; row++) {
    let rowMeta;
    try { rowMeta = JSON.parse(lines[row]); } catch { continue; }
    const rowVec = new Float32Array(dim);
    const offset = row * dim;
    for (let i = 0; i < dim; i++) rowVec[i] = view[offset + i];
    const unit = l2Normalize(rowVec, dim);
    if (unit && rowMeta.title) tracks.set(songMatchKey(rowMeta.artist, rowMeta.title), unit);
    const key = normalizeArtist(rowMeta.artist);
    if (!key) continue;
    if (!sums.has(key)) {
      sums.set(key, new Float64Array(dim));
      counts.set(key, 0);
    }
    const sum = sums.get(key);
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
  if (!centroids.size) {
    log('music vectors: empty index or f32');
    return state.ready;
  }
  state.ready = true;
  state.centroids = centroids;
  state.tracks = tracks;
  state.dim = dim;
  state.dir = dir;
  state.indexMtime = indexInfo.mtimeMs;
  state.f32Mtime = f32Info.mtimeMs;
  return true;
}

export function musicSimilarity(embed, fromItem, toItem) {
  if (!fromItem || !toItem) return MUSIC_NEUTRAL_SIMILARITY;
  const a = embeddingVector(embed, fromItem);
  const b = embeddingVector(embed, toItem);
  if (!a || !b) return MUSIC_NEUTRAL_SIMILARITY;
  return dot(a, b);
}

/** Saved videos and shared-account searches are independent, bounded signals. */
export function youtubeTasteBoost(item, youtubeTaste) {
  if (!youtubeTaste || !isMusicVideoItem(item)) return 1;
  const id = /\[([A-Za-z0-9_-]{11})\](?=\.[^/]+$|$)/.exec(item.src || '')?.[1];
  const saved = id && youtubeTaste.savedVideoIds.has(id) ? 2 : 1;
  const affinity = youtubeTaste.artistAffinity(artistFromVideo(item));
  return saved * (1 + 0.5 * Math.max(0, Math.min(1, Number(affinity) || 0)));
}

export function musicCandidateWeight({ index, videos, tasteWeight, embed, anchorItem, heard, youtubeTaste }) {
  const item = videos[index];
  const sim = anchorItem ? musicSimilarity(embed, anchorItem, item) : MUSIC_NEUTRAL_SIMILARITY;
  const flow = musicFlowFactor(sim);
  return heard.has(item.src) ? 0 : Math.max(0, tasteWeight) * flow * youtubeTasteBoost(item, youtubeTaste);
}

export function musicRankScore({ index, videos, tasteWeight, embed, anchorItem, heard, youtubeTaste }) {
  if (musicHeardRecently(videos[index].src, heard)) return -Infinity;
  return musicCandidateWeight({ index, videos, tasteWeight, embed, anchorItem, heard, youtubeTaste });
}

export function pickMusicVideoIndex({
  videos, pool, weights, currentIndex, played, random, embed, heard, anchorItem = null,
  youtubeTaste = null, preferLong = false, longFormSeconds = 20 * 60,
}) {
  let available = pool.filter(index => index !== currentIndex);
  if (!available.length) return -1;
  const currentArtist = currentIndex >= 0 ? artistKeyForVideo(videos[currentIndex]) : '';
  if (currentArtist) {
    const varied = available.filter(index => artistKeyForVideo(videos[index]) !== currentArtist);
    if (!varied.length) return -1;
    available = varied;
  }
  const unheard = available.filter(index => !heard.has(videos[index].src));
  const candidates = unheard;
  if (!candidates.length) return -1;
  const recentShows = played.slice(-2).map(index => artistKeyForVideo(videos[index]));
  const lastArtist = recentShows[recentShows.length - 1] || currentArtist;
  const maxWeight = candidates.reduce((max, index) => {
    const taste = weights[videos[index].src] ?? 1;
    return Math.max(max, musicCandidateWeight({ index, videos, tasteWeight: taste, embed, anchorItem, heard: new Map(), youtubeTaste }));
  }, 0);
  const pickWeight = index => {
    const taste = weights[videos[index].src] ?? 1;
    let anchor = anchorItem;
    if (!anchor && lastArtist) {
      const prior = played.slice().reverse().find(i => artistKeyForVideo(videos[i]) === lastArtist);
      if (prior !== undefined) anchor = videos[prior];
    }
    let w = musicCandidateWeight({ index, videos, tasteWeight: taste, embed, anchorItem: anchor, heard, youtubeTaste });
    if (lastArtist && artistKeyForVideo(videos[index]) === lastArtist) w *= 0.35;
    if (preferLong && (videos[index].duration || 0) >= longFormSeconds) w *= 1.25;
    return embed?.ready ? exploreBlend(w, maxWeight) : w;
  };
  return weightedChoice(candidates, pickWeight, random);
}

export function createMusicEmbedLoader({
  dir = DEFAULT_MUSIC_VECTORS_DIR, log = () => {}, pollMs = 60_000, now = () => Date.now(),
  expectedDim = MUSIC_EMBED_DIM,
} = {}) {
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
      if (!state.ready) {
        state.centroids = new Map();
        state.tracks = new Map();
      }
      state.dir = dir;
      return state.ready;
    }
    if (!force && state.ready && state.dir === dir
      && state.indexMtime === indexInfo.mtimeMs && state.f32Mtime === f32Info.mtimeMs) return true;
    loading = loading || loadMusicEmbeddings(state, dir, log, { expectedDim }).catch(error => {
      log(`music vectors unavailable: ${error.message}`);
      return state.ready;
    }).finally(() => { loading = null; });
    await loading;
    return state.ready;
  }
  return { state, refresh };
}