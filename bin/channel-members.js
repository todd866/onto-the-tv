#!/usr/bin/env node
// List a TV channel's members from the server's catalogue, one JSON object per line:
//   node bin/channel-members.js dance [--app-data DIR]
// For tools that measure or score a channel's videos (scripts/measure_dance.py).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TV_CHANNELS, inTvGenre, loadCatalogue } from '../src/tv-server.js';

const args = process.argv.slice(2);
const at = args.indexOf('--app-data');
const appData = at >= 0 ? args.splice(at, 2)[1] : join(homedir(), 'Library/Application Support/Onto the TV');
const channel = args[0];
if (!TV_CHANNELS.some(entry => entry.id === channel)) {
  console.error(`usage: channel-members.js <${TV_CHANNELS.map(entry => entry.id).join('|')}> [--app-data DIR]`);
  process.exit(2);
}
const videos = await loadCatalogue(join(appData, 'tv-server', 'catalogue.html'));
for (const item of videos) {
  if (!inTvGenre(item, channel)) continue;
  console.log(JSON.stringify({ src: item.src, file: item.file, show: item.channel || '', title: item.title || '', duration: item.duration || 0 }));
}
