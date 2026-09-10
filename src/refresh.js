import { buildPlayer, prepareChannels } from './shuffler.js';

// Rebuild the offline player and prepare channels without opening the app.
// Mirrors the Refresh button: buildPlayer runs make_shuffler.py (ffprobe of every
// video); prepareChannels reads the result and writes channels.html + library.json
// into userData. Safe to run while the app is open: both writes are atomic, and the
// app regenerates channels.html (with a fresh taste token) on the next launch.
export async function refreshLibrary(appRoot, settings, userData, { runner, buildOnly = false } = {}) {
  const buildMessage = await buildPlayer(appRoot, settings, runner);
  if (buildOnly) return { buildMessage, prepared: false };
  const channels = await prepareChannels(appRoot, settings, userData);
  return { buildMessage, prepared: true, url: channels.url, count: channels.count, exportToken: channels.exportToken };
}
