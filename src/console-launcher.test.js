import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleLauncher } from './console-launcher.js';

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'console-launcher-'));
  await mkdir(join(root, 'snes'), { recursive: true });
  await mkdir(join(root, 'nes'), { recursive: true });
  await writeFile(join(root, 'snes', 'Super Mario World.sfc'), 'x');
  await writeFile(join(root, 'snes', 'Zelda.txt'), 'x'); // wrong extension, ignored
  await writeFile(join(root, 'nes', 'Excitebike.nes'), 'x');
  return root;
}

test('games lists only matching extensions, sorted, per system', async () => {
  const root = await makeRoot();
  try {
    const run = async () => {};
    const launcher = createConsoleLauncher({ romRoot: root, run });
    assert.deepEqual(await launcher.games(), [
      { system: 'snes', name: 'Super Mario World', file: 'Super Mario World.sfc' },
      { system: 'nes', name: 'Excitebike', file: 'Excitebike.nes' },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('games skips systems with no directory', async () => {
  const root = await makeRoot();
  try {
    await rm(join(root, 'nes'), { recursive: true });
    const launcher = createConsoleLauncher({ romRoot: root, run: async () => {} });
    const games = await launcher.games();
    assert.equal(games.length, 1);
    assert.equal(games[0].system, 'snes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launch runs retroarch with the core and rom', async () => {
  const root = await makeRoot();
  try {
    const calls = [];
    const launcher = createConsoleLauncher({
      romRoot: root, retroArch: '/usr/bin/retroarch', coresDir: '/cores',
      run: async (command, args) => { calls.push([command, args]); },
    });
    const result = await launcher.launch({ system: 'snes', file: 'Super Mario World.sfc' });
    assert.deepEqual(result, { status: 200, body: { launched: true, system: 'snes', file: 'Super Mario World.sfc' } });
    assert.deepEqual(calls, [['/usr/bin/retroarch', ['-L', '/cores/snes9x_libretro.dylib', '--fullscreen', join(root, 'snes', 'Super Mario World.sfc')]]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launch rejects unknown systems, bad files and traversal', async () => {
  const root = await makeRoot();
  try {
    const launcher = createConsoleLauncher({ romRoot: root, run: async () => {} });
    assert.equal((await launcher.launch({ system: 'atari', file: 'x.nes' })).status, 404);
    for (const file of ['../nes/Excitebike.nes', 'sub/dir/game.nes', '', 'no-extension', 'a\0b.nes', undefined]) {
      assert.equal((await launcher.launch({ system: 'nes', file })).status, 400, file);
    }
    assert.equal((await launcher.launch({ system: 'nes', file: 'Excitebike.sfc' })).status, 400);
    assert.equal((await launcher.launch({ system: 'nes', file: 'Ghost.nes' })).status, 404);
    assert.equal((await launcher.launch()).status, 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launch reports a run failure as 500', async () => {
  const root = await makeRoot();
  try {
    const launcher = createConsoleLauncher({ romRoot: root, run: async () => { throw new Error('boom'); } });
    assert.equal((await launcher.launch({ system: 'nes', file: 'Excitebike.nes' })).status, 500);
    // The default runner routes the async spawn error event through the promise
    // (a missing RetroArch binary must not crash the server).
    const real = createConsoleLauncher({ romRoot: root, retroArch: '/nonexistent/retroarch' });
    assert.equal((await real.launch({ system: 'nes', file: 'Excitebike.nes' })).status, 500);
  } finally { await rm(root, { recursive: true, force: true }); }
});
