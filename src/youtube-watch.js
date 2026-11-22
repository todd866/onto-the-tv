// What the household watches on YouTube (docs/youtube-watch.md), so the tube grid can lead with the same
// creators and videos. Another tool writes the file; this only reads it. A missing, unreadable or
// malformed file means no signal at all: the grid then orders exactly as it did before.
import { readFileSync, statSync } from 'node:fs';

const VERDICTS = new Set(['good', 'block', 'lowgrade', 'cleared', 'unsure', 'unjudged']);
// A Short has no length in the history; half a minute is a fair stand-in when adding up a creator's time.
export const SHORT_SECONDS = 30;

const count = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);

export function normaliseName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The YouTube id a downloaded file carries in its name: "Title [dQw4w9WgXcQ].mp4". */
export function youtubeIdOf(item) {
  const match = /\[([A-Za-z0-9_-]{11})\]\.[A-Za-z0-9]+$/.exec(String(item?.file || item?.src || ''));
  return match ? match[1] : null;
}

export function parseYouTubeWatch(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || doc.version !== 1 || !doc.channels || typeof doc.channels !== 'object' || !Array.isArray(doc.events)) return null;
  const channels = new Map();
  const byName = new Map();
  for (const [key, raw] of Object.entries(doc.channels)) {
    if (!raw || typeof raw !== 'object') continue;
    const recent = raw.recent && typeof raw.recent === 'object' ? raw.recent : {};
    const row = {
      key,
      name: String(raw.name || ''),
      verdict: VERDICTS.has(raw.verdict) ? raw.verdict : 'unjudged',
      events: count(raw.events),
      seconds: count(raw.seconds) + count(raw.shorts) * SHORT_SECONDS,
      // The grid mimics what is watched now, so ranking uses the recent window, not every year on record.
      recentSeconds: count(recent.seconds) + count(recent.shorts) * SHORT_SECONDS,
      last: String(raw.last || ''),
    };
    channels.set(key, row);
    const name = normaliseName(row.name);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(row);
  }
  const videos = new Map();
  for (const event of doc.events) {
    if (!event || typeof event.id !== 'string') continue;
    let video = videos.get(event.id);
    if (!video) { video = { channel: String(event.channel || ''), days: 0, pct: 0 }; videos.set(event.id, video); }
    video.days += 1;
    video.pct = Math.max(video.pct, count(event.pct));
  }
  return { generated: String(doc.generated || ''), channels, byName, videos };
}

/**
 * The ledger channels one library creator is. A file's own YouTube id decides it; only when no file of the
 * creator was ever watched there does an exact name match count, and never when two channels share that name.
 */
export function creatorChannels(index, items, name) {
  const found = new Map();
  for (const item of items) {
    const video = index.videos.get(youtubeIdOf(item));
    const row = video && index.channels.get(video.channel);
    if (row) found.set(row.key, row);
  }
  if (!found.size) {
    const rows = index.byName.get(normaliseName(name));
    if (rows && rows.length === 1) found.set(rows[0].key, rows[0]);
  }
  return [...found.values()];
}

/** A video watched to the end, or on more than one day, on YouTube is one the household chose. */
export function lovedOnYouTube(index, item) {
  const video = index.videos.get(youtubeIdOf(item));
  return Boolean(video && (video.days > 1 || video.pct >= 90));
}

/** Read like best-episodes.json: at most one stat a minute, a reload only when the file changed. */
export function createYouTubeWatchReader({ file, log = () => {}, now = () => Date.now() } = {}) {
  let cache = null, stamp = '', checkedAt = -Infinity;
  return () => {
    if (!file || now() - checkedAt < 60_000) return cache;
    checkedAt = now();
    try {
      const info = statSync(file);
      const next = `${info.mtimeMs}:${info.size}`;
      if (next !== stamp) {
        stamp = next;
        cache = parseYouTubeWatch(readFileSync(file, 'utf8'));
        if (!cache) log('youtube watch ledger is not a version 1 file; ignored');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') log('youtube watch ledger unread: ' + error.message);
      cache = null; stamp = '';
    }
    return cache;
  };
}
