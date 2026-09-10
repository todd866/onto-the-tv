#!/usr/bin/env node
// Curates a ranked whitelist of kids' YouTube videos using the owner's algorithm,
// then writes it as JSON for the caster to stream. Needs a YouTube Data API v3 key.
//
// Usage:
//   YOUTUBE_API_KEY=... npm run curate -- --config curation/config.json
//   YOUTUBE_API_KEY=... npm run curate -- --max-duration 1500 --license creativeCommon
//
// Config shape (curation/config.json):
//   { "seeds": [ {"channel":"@PeppaPigOfficial"}, {"playlist":"PL..."}, {"search":"bluey"} ],
//     "filters": { "maxDurationSeconds": 1500, "license": "any", "channelWhitelist": ["UC.."] },
//     "channelTrust": { "UC..": 0.9 },
//     "exclude": ["videoId"] }

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createYoutube } from './youtube.js';
import { curate, defaultFilters, scoreVideo } from './curate.js';

const here = dirname(pathToFileURL(import.meta.url).href.replace('file://', ''));
const defaultConfig = join(here, '..', 'config.json');
const defaultOut = join(here, '..', 'whitelist.json');

const USAGE = `Onto the TV — curate a ranked YouTube whitelist with your own algorithm.

Usage:
  YOUTUBE_API_KEY=... npm run curate -- --config curation/config.json [--out curation/whitelist.json]
  YOUTUBE_API_KEY=... npm run curate -- --max-duration 1500 --license creativeCommon

Options:
  --config PATH        Config file with seeds/filters/channelTrust (default: curation/config.json)
  --out PATH           Where to write the ranked whitelist (default: curation/whitelist.json)
  --max-duration SEC   Override the duration cap (kills marathon dumps)
  --license any|creativeCommon   License filter
  --help, -h           Show this help

Environment:
  YOUTUBE_API_KEY     Required. YouTube Data API v3 key (console.cloud.google.com).
`;

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { config: defaultConfig, out: defaultOut, maxDuration: null, license: null, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--config') flags.config = args[++i];
    else if (a === '--out') flags.out = args[++i];
    else if (a === '--max-duration') flags.maxDuration = Number(args[++i]);
    else if (a === '--license') flags.license = args[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return flags;
}

export async function main(argv = process.argv, { env = process.env } = {}) {
  let flags;
  try { flags = parseArgs(argv); }
  catch (error) { console.error(error.message); return 2; }
  if (flags.help) { console.log(USAGE); return 0; }

  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) { console.error('YOUTUBE_API_KEY is required (YouTube Data API v3).'); return 2; }

  let config = { seeds: [], filters: {}, channelTrust: {}, exclude: [] };
  try { config = JSON.parse(await readFile(flags.config, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') { console.error(`Cannot read config: ${error.message}`); return 2; } }

  if (!config.seeds?.length) {
    console.error(`No seeds in ${flags.config}. Add a "seeds" list (channel/playlist/search) first.`);
    return 2;
  }

  const filterOverrides = { ...config.filters };
  if (flags.maxDuration != null) filterOverrides.maxDurationSeconds = flags.maxDuration;
  if (flags.license) filterOverrides.license = flags.license;
  const filters = defaultFilters(filterOverrides);
  const ranking = v => scoreVideo(v, { channelTrust: config.channelTrust || {} });

  const youtube = createYoutube({ apiKey });
  const result = await curate({ youtube, seeds: config.seeds, filters, ranking, exclude: config.exclude || [] });

  await mkdir(dirname(resolve(flags.out)), { recursive: true });
  await writeFile(resolve(flags.out), JSON.stringify({ version: 1, generated: new Date().toISOString(), videos: result }, null, 2) + '\n', { mode: 0o600 });

  console.log(`Curated ${result.length} video${result.length === 1 ? '' : 's'} -> ${flags.out}`);
  if (result.length) {
    const top = result.slice(0, 5);
    console.log('Top 5:');
    for (const v of top) console.log(`  ${(v.durationSeconds / 60).toFixed(0)}m  ${v.score.toFixed(3)}  ${v.channelTitle} — ${v.title}`);
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
