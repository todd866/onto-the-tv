import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshLibrary } from './refresh.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// A fake make_shuffler.py: instead of probing real videos, write a valid player
// HTML to settings.playerPath so prepareChannels can read it for real.
function fakeRunner(videos) {
  return async (command, args, options) => {
    assert.equal(command, 'python3');
    const output = args[args.indexOf('--output') + 1];
    const json = JSON.stringify(videos).replaceAll('<', '\\u003c');
    await writeFile(output, `<script>const VIDEOS = ${json};</script>`);
    return { stdout: `Wrote ${output}: ${videos.length} videos` };
  };
}

test('refreshLibrary rebuilds the player and prepares channels end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-refresh-'));
  try {
    const playerPath = join(dir, 'kids-shuffler.html');
    const settings = { playerPath };
    const userData = join(dir, 'support');
    const videos = [
      { src: 'Peppa/one.mp4', path: 'Peppa/one.mp4', title: 'One', channel: 'Peppa', tier: 'preschool', duration: 300 },
      { src: 'Bluey/two.mp4', path: 'Bluey/two.mp4', title: 'Two', channel: 'Bluey', tier: 'shared', duration: 420 },
    ];
    const result = await refreshLibrary(root, settings, userData, { runner: fakeRunner(videos) });
    assert.equal(result.prepared, true);
    assert.match(result.buildMessage, /2 videos/);
    assert.equal(result.count, 2);
    const channels = await readFile(join(userData, 'channels.html'), 'utf8');
    assert.ok(channels.includes('Peppa/one.mp4'));
    assert.ok(channels.includes('Bluey/two.mp4'));
    assert.ok(channels.includes('media-src file:'));
    const library = JSON.parse(await readFile(join(userData, 'library.json'), 'utf8'));
    assert.equal(library.videos.length, 2);
    assert.equal((await stat(join(userData, 'channels.html'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('buildOnly rebuilds the player without touching userData', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-refresh-buildonly-'));
  try {
    const playerPath = join(dir, 'kids-shuffler.html');
    const settings = { playerPath };
    const userData = join(dir, 'support');
    await mkdir(userData, { recursive: true });
    const videos = [{ src: 'Peppa/one.mp4', path: 'Peppa/one.mp4', title: 'One', channel: 'Peppa', tier: 'preschool', duration: 300 }];
    const result = await refreshLibrary(root, settings, userData, { runner: fakeRunner(videos), buildOnly: true });
    assert.equal(result.prepared, false);
    assert.match(result.buildMessage, /1 videos/);
    assert.ok(await stat(playerPath));
    await assert.rejects(() => access(join(userData, 'channels.html')));
    await assert.rejects(() => access(join(userData, 'library.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refreshLibrary surfaces a failed build before preparing channels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-refresh-fail-'));
  try {
    const playerPath = join(dir, 'kids-shuffler.html');
    const settings = { playerPath };
    const userData = join(dir, 'support');
    const failing = async () => { throw Object.assign(new Error('boom'), { stderr: 'No playable videos' }); };
    await assert.rejects(refreshLibrary(root, settings, userData, { runner: failing }), /No playable videos/);
    await assert.rejects(() => access(join(userData, 'channels.html')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
