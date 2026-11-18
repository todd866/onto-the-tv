#!/usr/bin/env node
// Each episodic show's best-rated episodes, for the TV's introductions (Ian, 18 Nov 2026: "try for 'best of' when
// you're introducing a new show"). Ratings are TVmaze's episode averages (no key, small JSON per show). Writes
// <tv-server data>/best-episodes.json: { shows: { "<catalogue show>": { tvmaze, name, fetchedAt, top: [{ season,
// episode, rating, name }] } } }. A show fetched in the last 30 days is kept as it is; --force refetches.
//
//   node scripts/best-episodes.mjs [--force] [--limit N]
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadCatalogue } from '../src/tv-server.js';
import { writeAtomically } from '../src/atomic-write.js';

const require = createRequire(import.meta.url);
const player = require('../shuffler/player.js');
const appData = join(homedir(), 'Library/Application Support/Onto the TV');
const data = join(appData, 'tv-server');
const out = join(data, 'best-episodes.json');
const args = process.argv.slice(2);
const force = args.includes('--force');
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const MONTH = 30 * 86400000, TOP = 20, MIN_EPISODES = 4;

export function showQuery(show) {
  const year = /\((\d{4})\)\s*$/.exec(show)?.[1] || null;
  return { name: show.replace(/\s*\(\d{4}\)\s*$/, '').trim(), year };
}

export function bestOf(episodes, top = TOP) {
  return episodes.filter(e => e && Number.isInteger(e.season) && e.season > 0 && Number.isInteger(e.number) && e.rating?.average)
    .sort((a, b) => b.rating.average - a.rating.average || a.season - b.season || a.number - b.number)
    .slice(0, top).map(e => ({ season: e.season, episode: e.number, rating: e.rating.average, name: e.name || '' }));
}

async function fetchShow(show) {
  const { name, year } = showQuery(show);
  const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(name)}`, { headers: { 'User-Agent': 'onto-the-tv/1' } });
  if (!response.ok) throw new Error(`search ${response.status}`);
  const hits = (await response.json()).map(hit => hit.show).filter(Boolean);
  const exact = hits.filter(hit => hit.name.toLowerCase() === name.toLowerCase());
  const pick = (year && (exact.find(hit => hit.premiered?.startsWith(year)) || hits.find(hit => hit.premiered?.startsWith(year)))) || exact[0] || null;
  if (!pick) return null;
  const episodes = await fetch(`https://api.tvmaze.com/shows/${pick.id}/episodes`, { headers: { 'User-Agent': 'onto-the-tv/1' } });
  if (!episodes.ok) throw new Error(`episodes ${episodes.status}`);
  return { tvmaze: pick.id, name: pick.name, fetchedAt: new Date().toISOString(), top: bestOf(await episodes.json()) };
}

async function main() {
  const videos = await loadCatalogue(join(data, 'catalogue.html'));
  const counts = new Map();
  for (const item of videos) {
    if (item.tier === 'music' || player.episodeNumber(item) === null) continue;
    const show = item.channel || 'Other';
    counts.set(show, (counts.get(show) || 0) + 1);
  }
  const shows = [...counts].filter(([, n]) => n >= MIN_EPISODES).map(([show]) => show).sort();
  let saved = {};
  try { saved = JSON.parse(await readFile(out, 'utf8')).shows || {}; } catch {}
  let fetched = 0;
  for (const show of shows) {
    if (fetched >= limit) break;
    const old = saved[show];
    if (!force && old && Date.now() - Date.parse(old.fetchedAt) < MONTH) continue;
    try {
      const result = await fetchShow(show);
      fetched++;
      if (result && result.top.length) { saved[show] = result; console.log(`${show}: ${result.name}, best ${result.top.slice(0, 3).map(e => `S${e.season}E${e.episode} ${e.rating}`).join(', ')}`); }
      else console.log(`${show}: no rated episodes found`);
    } catch (error) { console.log(`${show}: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, 700));      // TVmaze allows 20 calls per 10 s
  }
  await writeAtomically(out, JSON.stringify({ source: 'tvmaze', updatedAt: new Date().toISOString(), shows: saved }, null, 1) + '\n');
  console.log(`${Object.keys(saved).length} shows rated; ${fetched} fetched now -> ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
