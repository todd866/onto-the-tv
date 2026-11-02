import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';

// The console tile: RetroArch on the Mac behind the TV, driven by Bluetooth
// controllers. The library stays a video thing; this only lists ROMs under the
// shared ROM drive and launches one with the matching core.
const SYSTEMS = {
  snes: { core: 'snes9x_libretro.dylib', exts: ['.sfc', '.smc'] },
  n64: { core: 'mupen64plus_next_libretro.dylib', exts: ['.z64', '.n64', '.v64'] },
  nes: { core: 'nestopia_libretro.dylib', exts: ['.nes'] },
  genesis: { core: 'genesis_plus_gx_libretro.dylib', exts: ['.md', '.gen'] },
  gb: { core: 'gambatte_libretro.dylib', exts: ['.gb', '.gbc'] },
};

const bad = (status, error) => ({ status, body: { error } });

export function createConsoleLauncher({
  retroArch = '/Applications/RetroArch.app/Contents/MacOS/RetroArch',
  coresDir = join(homedir(), 'Library/Application Support/RetroArch/cores'),
  romRoot = '/Volumes/Stash/ROMs',
  // Detached spawn so the server keeps serving while the game runs.
  run = (command, args) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return Promise.resolve();
  },
} = {}) {
  const root = resolve(romRoot);

  async function games() {
    const found = [];
    for (const [system, config] of Object.entries(SYSTEMS)) {
      const dir = join(root, system);
      let files = [];
      try { files = await readdir(dir); } catch { continue; }
      for (const file of files.sort()) {
        if (!config.exts.includes(extname(file).toLowerCase())) continue;
        found.push({ system, name: file.replace(/\.[^.]+$/, ''), file });
      }
    }
    return found;
  }

  async function launch({ system, file } = {}) {
    const config = SYSTEMS[system];
    if (!config) return bad(404, 'Unknown console.');
    if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('/')) return bad(400, 'Invalid game.');
    const rom = resolve(join(root, system, file));
    if (!rom.startsWith(root + '/') || !config.exts.includes(extname(rom).toLowerCase())) return bad(400, 'Invalid game.');
    const info = await stat(rom).catch(() => null);
    if (!info?.isFile()) return bad(404, 'No such game.');
    try { await run(retroArch, ['-L', join(coresDir, config.core), '--fullscreen', rom]); }
    catch { return bad(500, 'Could not start RetroArch.'); }
    return { status: 200, body: { launched: true, system, file } };
  }

  return { games, launch };
}
