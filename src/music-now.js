import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parseArtistTitleFromVideo, youtubeIdOf } from './music-pick.js';

// The shared now-playing bus (music-core design B/E): every playing surface heartbeats one small
// document, music/now/<listener>/<surface>-<host>.json, and readers (Glancebar, the 6IAN radio) treat
// it as live for 60 s. The TV writes only while a music video is on screen, at most every 10 s; when
// playback stops it simply stops writing and the document goes stale. Display only: nothing here
// changes picks or taste. Off unless settings.musicNowListener names the listener whose bus to join.
export const NOW_MIN_INTERVAL_MS = 10_000;

export function nowDoc({ item, listener, host, position = 0, at = new Date().toISOString(), sha = null }) {
  if (!item || item.tier !== 'music' || !listener) return null;
  const { artist, title } = parseArtistTitleFromVideo(item);
  const youtube = youtubeIdOf(item);
  const doc = { listener, surface: 'tv', host, at };
  if (sha) doc.sha = sha;
  if (youtube) doc.key = `youtube:${youtube}`;
  if (title) doc.title = String(title).slice(0, 200);
  if (artist) doc.artist = String(artist).slice(0, 200);
  if (Number.isFinite(position) && position >= 0) doc.position = Math.round(position);
  if (Number.isFinite(item.duration) && item.duration > 0) doc.duration = Math.round(item.duration);
  return doc;
}

export function nowHost(name = hostname()) {
  const short = String(name).toLowerCase().split('.')[0].replace(/[^a-z0-9_-]/g, '-').replace(/^-+/, '');
  if (/macbook-air/.test(short)) return 'm2'; // the fleet's name for the TV host
  return (short || 'tv').slice(0, 32);
}

/** The store's R2 remote from ~/.config/glancebar/music-store.json ({"remote": "name:bucket"}). */
export function storeRemote(configFile, exists = existsSync, read = readFileSync) {
  try {
    if (!exists(configFile)) return '';
    const remote = JSON.parse(read(configFile, 'utf8')).remote;
    return typeof remote === 'string' ? remote.replace(/\/+$/, '') : '';
  } catch { return ''; }
}

export function createNowWriter({ listener, remote, host = nowHost(), rclone = '/opt/homebrew/bin/rclone',
  shaFor = () => null, run = spawn, exists = existsSync, now = Date.now, log = () => {} } = {}) {
  const enabled = Boolean(listener && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(listener) && remote && exists(rclone));
  let lastAt = 0, lastSrc = null, busy = false;
  return function report({ item, position }) {
    if (!enabled || !item || item.tier !== 'music' || busy) return false;
    const t = now();
    if (item.src === lastSrc && t - lastAt < NOW_MIN_INTERVAL_MS) return false;
    const doc = nowDoc({ item, listener, host, position, at: new Date(t).toISOString(), sha: shaFor(item) });
    if (!doc) return false;
    lastAt = t; lastSrc = item.src; busy = true;
    try {
      const child = run(rclone, ['rcat', `${remote}/music/now/${listener}/tv-${host}.json`], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
      child.stderr?.on('data', chunk => { err = (err + chunk).slice(-300); });
      child.on('error', error => { clearTimeout(timer); busy = false; log(`now bus: ${error.message}`); });
      child.on('close', code => { clearTimeout(timer); busy = false; if (code) log(`now bus: rclone exit ${code} ${err.trim()}`); });
      child.stdin.end(JSON.stringify(doc));
    } catch (error) {
      busy = false;
      log(`now bus: ${error.message}`);
    }
    return true;
  };
}
