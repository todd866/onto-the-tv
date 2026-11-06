#!/usr/bin/env node
// Talk to the TV that is on: npm run tv -- now|play <src>|next <src>|pause|resume|seek <s>|tune <ch>|back
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTvArgs, runTv } from '../src/tv-remote.js';

const parsed = parseTvArgs(process.argv.slice(2));
if (parsed.ok && !parsed.token) {
  parsed.token = (await readFile(join(homedir(), 'Library/Application Support/Onto the TV/tv-server/pairing-token'), 'utf8').catch(() => '')).trim();
}
const result = parsed.ok === false ? parsed : await runTv(parsed);
if (result.line) console.log(result.line);
process.exit(result.code || 0);
