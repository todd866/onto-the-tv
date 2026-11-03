import { readFile } from 'node:fs/promises';
import { buildPlayer, prepareChannels, readCatalogue } from './shuffler.js';
import { formatTvChannelPoolReport } from './tv-server.js';

// Rebuild the offline player and prepare channels without opening the app.
// Mirrors the Refresh button: buildPlayer runs make_shuffler.py (ffprobe of every
// video); prepareChannels reads the result and writes channels.html + library.json
// into userData. Safe to run while the app is open: both writes are atomic, and the
// app regenerates channels.html (with a fresh taste token) on the next launch.
export async function refreshLibrary(appRoot, settings, userData, { runner, buildOnly = false } = {}) {
  let buildMessage = await buildPlayer(appRoot, settings, runner);
  const catalogue = readCatalogue(
    await readFile(settings.playerPath, 'utf8'), settings.playerPath, settings.playerPath);
  buildMessage = `${buildMessage}\n${formatTvChannelPoolReport(catalogue)}`;
  if (buildOnly) return { buildMessage, prepared: false };
  const channels = await prepareChannels(appRoot, settings, userData);
  return { buildMessage, prepared: true, url: channels.url, count: channels.count, exportToken: channels.exportToken };
}
