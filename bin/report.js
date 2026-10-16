#!/usr/bin/env node
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { copyBlackboxFiles, readHistoryTail, writeReport, readAppInfo } from '../src/report.js';
import { writeAtomically } from '../src/atomic-write.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const defaultUserData = join(homedir(), 'Library', 'Application Support', 'Onto the TV');
export const USAGE = `Onto the TV — save a report from on-disk app data.

Usage: npm run report -- [--user-data DIR] [optional note]

Options:
  --user-data DIR   Override the userData directory.
  --help, -h        Show this help.

Environment: ONTO_USER_DATA can also set the userData directory.
`;

export function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { userData: process.env.ONTO_USER_DATA || defaultUserData, note: '' };
  const notes = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--user-data') {
      flags.userData = args[++i];
      if (!flags.userData || flags.userData.startsWith('--')) throw new Error('--user-data requires a directory.');
    }
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
    else if (args[i].startsWith('--')) throw new Error(`Unknown argument: ${args[i]}`);
    else notes.push(args[i]);
  }
  flags.note = notes.join(' ');
  return flags;
}

async function readJson(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function main(argv = process.argv) {
  let flags;
  try { flags = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (flags.help) { console.log(USAGE); return 0; }
  const at = new Date().toISOString();
  const [settings, app] = await Promise.all([
    readJson(join(flags.userData, 'settings.json')),
    readAppInfo(appRoot),
  ]);
  const history = await readHistoryTail(flags.userData);
  const folder = await writeReport({ userData: flags.userData, at, source: 'cli', note: flags.note,
    app, settings, recentHistory: history, tvState: null, folderSuffix: 'cli' });
  await copyBlackboxFiles(flags.userData, folder);
  await writeAtomically(join(folder, 'playback-history.json'), `${JSON.stringify({ version: 1, entries: history }, null, 2)}\n`);
  console.log(folder);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then(code => process.exit(code)).catch(error => { console.error(error.message); process.exit(1); });
