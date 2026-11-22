#!/usr/bin/env node
// Incremental scene index. One file at a time, skipping anything already indexed.
// Run it under the machine guard: heavy-slot -- node bin/scene-index.js
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { analyseMedia, createSceneStore, indexCatalogue, writeSceneThumbs } from '../src/scenes.js';
import { fileWantsRecordedAds, loadCatalogue } from '../src/tv-server.js';

const execute = promisify(execFile);
const defaultUserData = join(homedir(), 'Library', 'Application Support', 'Onto the TV');

const USAGE = `Onto the TV — scene index for the TV player.

Usage:
  heavy-slot -- node bin/scene-index.js [--user-data DIR]

Walks the TV catalogue once, one file at a time. Files already indexed at the
same size and mtime are skipped. Chapters come from ffprobe; otherwise ffmpeg
scene detection (160 px wide, scene score 0.35, cuts at least 20 s apart).
Black frames are always recorded. Channels flagged recordedAds also get
in-broadcast ad breaks (comskip when it is on PATH, otherwise black plus silence).

Options:
  --user-data DIR   App data directory (default: ~/Library/Application Support/Onto the TV).
  --help, -h        Show this help.

Environment:
  ONTO_USER_DATA    Same as --user-data.
  FFMPEG, FFPROBE   Override the binaries.
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { userData: process.env.ONTO_USER_DATA || defaultUserData, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--user-data') flags.userData = args[++i];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!flags.userData) throw new Error('Missing --user-data directory.');
  return flags;
}

async function commandOnPath(name) {
  try {
    const { stdout } = await execute('which', [name], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function main(argv = process.argv) {
  let flags;
  try { flags = parseArgs(argv); }
  catch (error) { console.error(error.message); return 2; }
  if (flags.help) { console.log(USAGE); return 0; }

  const catalogue = join(flags.userData, 'tv-server', 'catalogue.html');
  let videos;
  try { videos = await loadCatalogue(catalogue, catalogue); }
  catch (error) {
    console.error(error.message);
    return 1;
  }
  const directory = join(flags.userData, 'scenes');
  const store = createSceneStore(directory);
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const ffprobe = process.env.FFPROBE || 'ffprobe';
  const comskip = await commandOnPath('comskip');
  const result = await indexCatalogue(videos, {
    stat: file => stat(file),
    read: async file => store.load(file),
    write: async (file, record) => {
      await writeSceneThumbs(directory, file, record.points, { execute, ffmpeg });
      store.save(file, record);
    },
    indexOne: (file, opts) => analyseMedia(file, {
      execute, ffmpeg, ffprobe, comskip, recordedAds: opts.recordedAds,
      workDir: join(tmpdir(), 'onto-comskip'),
    }),
    recordedAds: fileWantsRecordedAds,
  });
  console.log(`scene index: ${result.indexed} new, ${result.skipped} current, ${result.failed} failed`);
  return 0;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
