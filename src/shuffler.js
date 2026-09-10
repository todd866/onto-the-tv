import { stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, extname } from 'node:path';

const execute = promisify(execFile);

export async function playerExists(settings) {
  if (extname(settings.playerPath).toLowerCase() !== '.html') return false;
  try { return (await stat(settings.playerPath)).isFile(); } catch { return false; }
}

export function generatorArgs(root, settings) {
  const args = [join(root, 'shuffler', 'make_shuffler.py'), '--library', settings.library,
    '--output', settings.playerPath];
  if (settings.sourcesPath) args.push('--sources', settings.sourcesPath);
  else args.push('--no-sources');
  if (settings.tiersPath) args.push('--tiers', settings.tiersPath);
  return args;
}

export async function buildPlayer(root, settings, runner = execute) {
  try {
    const { stdout } = await runner('python3', generatorArgs(root, settings), {
      timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: process.env,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'Python 3 is required to build the player. Install Python 3 and FFmpeg first.'
      : String(error.stderr || error.message).trim().slice(-1800));
  }
}
