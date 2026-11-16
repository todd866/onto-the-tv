import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeArtist } from './music-pick.js';

export const SEARCH_HALF_LIFE_MS = 365 * 24 * 60 * 60 * 1000;

// Takeout CSV permits quoted commas, newlines and doubled quotes.
function csv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift()?.map(x => x.replace(/^\uFEFF/, '')) || [];
  return rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] || ''])));
}

function ownMusicPlaylist(title) {
  return /^(?:Music|Watch later)$/i.test(title)
    || /^(?:YouTube Library Sync|Apple Music Delta)(?:\s|$)/i.test(title)
    || /\bmusic\b/i.test(title);
}

/** One snapshot per loader, including failed loads; no request-time filesystem reads. */
export function createYouTubeTasteLoader({ dir, log = () => {}, now = () => Date.now() } = {}) {
  let loading;
  return () => loading ||= loadYouTubeTaste({ dir, log, nowMs: now() });
}

export async function loadYouTubeTaste({ dir, log = () => {}, nowMs = Date.now() } = {}) {
  const savedVideoIds = new Set();
  const searches = [];
  const cache = new Map();
  const taste = {
    savedVideoIds,
    artistAffinity(name) {
      const key = normalizeArtist(name);
      if (!key) return 0;
      if (!cache.has(key)) {
        const phrase = ` ${key} `;
        const count = searches.reduce((sum, entry) => sum + (entry.text.includes(phrase) ? entry.weight : 0), 0);
        // Four fresh searches reach the cap; shared-household searches stay below saves.
        cache.set(key, Math.min(1, count / 4));
      }
      return cache.get(key);
    },
  };
  try {
    if (!dir) throw new Error('not configured');
    const playlistDir = join(dir, 'playlists');
    const [files, metadata, history] = await Promise.all([
      readdir(playlistDir), readFile(join(playlistDir, 'playlists.csv'), 'utf8'),
      readFile(join(dir, 'history/search-history.json'), 'utf8'),
    ]);
    const titles = new Map(csv(metadata).map(row => [row['Playlist ID'], row['Playlist Title (Original)']]));
    const selected = files.filter(file => {
      if (!file.endsWith('.csv') || file === 'playlists.csv') return false;
      const stem = file.replace(/(?:-videos)?\.csv$/, '');
      return ownMusicPlaylist(titles.get(stem) || stem);
    });
    const lists = await Promise.all(selected.map(file => readFile(join(playlistDir, file), 'utf8')));
    const entries = JSON.parse(history);
    if (!Array.isArray(entries)) throw new Error('invalid search history');
    for (const list of lists) for (const row of csv(list)) {
      const id = row['Video ID']?.trim();
      if (/^[\w-]{11}$/.test(id || '')) savedVideoIds.add(id);
    }
    for (const entry of entries) {
      const title = String(entry?.title || '');
      let url;
      try { url = new URL(entry.titleUrl); } catch { continue; }
      const youtube = /^(?:www\.|music\.)?youtube\.com$/.test(url.hostname);
      const music = entry.header === 'YouTube Music' || entry.products?.includes('YouTube Music') || url.hostname === 'music.youtube.com';
      const query = /^Searched for /i.test(title) && music;
      const video = youtube && url.pathname === '/watch' && url.searchParams.has('v');
      const at = Date.parse(entry.time);
      if (!youtube || (!query && !video) || !Number.isFinite(at)) continue;
      // Keep the whole query/title: artist normalization's feat/comma truncation
      // is appropriate for a name, but would discard later artist mentions here.
      const text = title.replace(/^(?:Searched for|Watched)\s+/i, '').toLowerCase()
        .normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
      searches.push({ text: ` ${text} `, weight: 2 ** (-Math.max(0, nowMs - at) / SEARCH_HALF_LIFE_MS) });
    }
  } catch {
    savedVideoIds.clear(); searches.length = 0;
    log('YouTube taste: Takeout missing or unreadable; no boost applied.');
  }
  return taste;
}
