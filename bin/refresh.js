#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSettings } from '../src/settings.js';
import { refreshLibrary } from '../src/refresh.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');

// Matches Electron's app.getPath('userData') for an app named "Onto the TV" on macOS.
const defaultUserData = join(homedir(), 'Library', 'Application Support', 'Onto the TV');

const USAGE = `Onto the TV — refresh the library and channels without opening the app.

Usage:
  npm run refresh [-- --build-only] [-- --user-data DIR]

Rebuilds the player (ffprobe of every video) and prepares channels.html + library.json
in the app's userData — exactly what the Refresh button does. The next app launch loads
the prebuilt channels with no probe wait. Safe to run while the app is open: writes are
atomic and the app re-stamps channels.html on the next launch.

Options:
  --build-only      Rebuild the player only; skip preparing channels.html.
  --user-data DIR   Override the userData directory.
  --help, -h        Show this help.

Environment:
  ONTO_USER_DATA    Same as --user-data.
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { buildOnly: false, userData: process.env.ONTO_USER_DATA || defaultUserData };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--build-only') flags.buildOnly = true;
    else if (arg === '--user-data') flags.userData = args[++i];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

export async function main(argv = process.argv) {
  let flags;
  try { flags = parseArgs(argv); }
  catch (error) { console.error(error.message); return 2; }
  if (flags.help) { console.log(USAGE); return 0; }

  const settingsPath = join(flags.userData, 'settings.json');
  const settings = await readSettings(settingsPath);
  const result = await refreshLibrary(appRoot, settings, flags.userData, { buildOnly: flags.buildOnly });

  console.log(result.buildMessage);
  if (result.prepared) {
    console.log(`Prepared ${result.count} channel video${result.count === 1 ? '' : 's'} in ${flags.userData}`);
  } else {
    console.log('Player rebuilt. Channels will be prepared on the next app launch.');
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
