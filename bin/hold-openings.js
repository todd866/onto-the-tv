#!/usr/bin/env node
// Hold the opening of every title on a shelf, so those titles still start at once after their files have left
// the drive and only their later blocks come from the cloud copy (docs/media-cache.md, "Cloud source").
//
//   node bin/hold-openings.js --openings-dir DIR --shelf sitcoms [--shelf grown-ups ...]   hold those shelves
//   … --plan                 say what it would hold and how much room that takes; write nothing
//   … --seconds 60           how much of each opening (default 60)
//   … --max-gb 40            ceiling for the whole store (default 40)
//   … --cloud-source         also fetch openings for titles already on no drive, from the cloud copy
//   … --app-data DIR         the TV server's data folder (default: the app's own)
//
// A shelf is the first part of a title's src in the catalogue: the label of a root in the sources file
// ("sitcoms", "grown-ups", "scifi"), or the show name for a pick ("Films"). Run it before a shelf's files are
// moved off the drive, and wrap it in disk-slot when the shelf is on an external drive: it reads every title.
// It can be run again at any time; what is already held is skipped. The server uses the store when it is started
// with the same --openings-dir.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createMediaCache } from '../src/media-cache.js';
import { openCloudSource } from '../src/cloud-source.js';
import { loadCatalogue } from '../src/tv-server.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const every = name => args.flatMap((value, index) => (value === name && args[index + 1] ? [args[index + 1]] : []));
const GiB = 1024 ** 3;

export function shelfOf(video) { return video.src.includes('/') ? video.src.slice(0, video.src.indexOf('/')) : ''; }

// The pass itself, separated from the command line so it can be tested with a stand-in cache.
export async function holdShelves({ videos, shelves, cache, statFile = file => stat(file), plan = false, seconds = 60, blockBytes = 4 * 1024 * 1024, log = () => {} }) {
  const wanted = new Set(shelves);
  const chosen = videos.filter(video => wanted.has(shelfOf(video)));
  const summary = { titles: chosen.length, held: 0, already: 0, skipped: 0, bytes: 0, failed: [] };
  for (const video of chosen) {
    // Size and mtime from the drive while the file is there; from the catalogue's cloud marker when it has gone.
    const info = await statFile(video.file).then(st => ({ size: st.size, mtimeMs: st.mtimeMs }), () => video.cloud || null);
    if (!info) { summary.skipped++; continue; }
    if (plan) {
      const total = Math.ceil(info.size / blockBytes);
      const first = Math.min(total, Math.max(1, video.duration > 0 ? Math.ceil((info.size / video.duration) * seconds * 1.5 / blockBytes) : Math.ceil(32 * 1024 * 1024 / blockBytes)));
      const indexes = new Set([...Array(first).keys(), total - 1]);
      for (const index of indexes) summary.bytes += Math.min(blockBytes, info.size - index * blockBytes);
      summary.held++;
      continue;
    }
    try {
      const result = await cache.holdOpening(video.file, info, { durationSeconds: video.duration });
      summary.bytes += result.bytes;
      if (result.blocks) summary.held++; else summary.already++;
      if ((summary.held + summary.already) % 50 === 0) log(`${summary.held + summary.already} of ${chosen.length} titles done`);
    } catch (error) {
      if (error.code === 'ENOSPC') { summary.failed.push({ src: video.src, reason: 'the openings store is full' }); break; }
      summary.failed.push({ src: video.src, reason: error.code || error.message });
    }
  }
  return summary;
}

async function main() {
  const directory = option('--openings-dir', ''), shelves = every('--shelf'), plan = args.includes('--plan');
  if (!directory || !shelves.length) {
    console.error('usage: hold-openings.js --openings-dir DIR --shelf NAME [--shelf NAME ...] [--plan] [--seconds 60] [--max-gb 40] [--cloud-source]');
    process.exit(2);
  }
  const appData = option('--app-data', join(homedir(), 'Library/Application Support/Onto the TV'));
  const seconds = Number(option('--seconds', 60)) || 60, maxBytes = (Number(option('--max-gb', 40)) || 40) * GiB;
  const videos = await loadCatalogue(join(appData, 'tv-server', 'catalogue.html'));
  const known = new Set(videos.map(shelfOf));
  const unknown = shelves.filter(name => !known.has(name));
  if (unknown.length) {
    console.error(`no such shelf: ${unknown.join(', ')}. Shelves in the catalogue: ${[...known].filter(Boolean).sort().join(', ')}`);
    process.exit(2);
  }
  let remote = null;
  if (args.includes('--cloud-source') && !plan) {
    try { remote = await openCloudSource({ configPath: join(appData, 'tv-server', 'cloud-source.json'), idFile: join(appData, 'tv-server', 'cloud-folder-ids.json') }); }
    catch (error) { console.error(`cloud source unavailable: ${error.message}`); }
  }
  // Its own empty ordinary cache, with no room: this pass must not write into, or evict from, the server's.
  const scratch = await mkdtemp(join(tmpdir(), 'onto-hold-openings-'));
  const cache = await createMediaCache({ directory: scratch, maxBytes: 0, reserveBytes: 0, eligible: () => true, remote,
    openings: { directory, seconds, maxBytes } });
  try {
    const before = cache.stats().openingBytes;
    const summary = await holdShelves({ videos, shelves, cache, plan, seconds, log: line => console.log(line) });
    const gb = bytes => (bytes / 1e9).toFixed(1);
    if (plan) console.log(`plan: ${summary.held} titles on ${shelves.join(', ')} would take about ${gb(summary.bytes)} GB at ${seconds} s each (${summary.skipped} have no file and no cloud marker). The store holds ${gb(before)} GB now; its ceiling is ${gb(maxBytes)} GB.`);
    else console.log(`held ${summary.held} titles (${gb(summary.bytes)} GB new), ${summary.already} already held, ${summary.skipped} skipped, ${summary.failed.length} failed. The store now holds ${gb(cache.stats().openingBytes)} GB of ${gb(maxBytes)} GB.`);
    for (const item of summary.failed.slice(0, 10)) console.log(`  failed: ${item.src}: ${item.reason}`);
    process.exitCode = summary.failed.length ? 1 : 0;
  } finally {
    await cache.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
