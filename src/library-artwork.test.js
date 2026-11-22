import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createArtworkCache, pruneArtwork } from './library-artwork.js';

const execFileAsync = promisify(execFile);

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'onto-artwork-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('generates a real cache file, probes unknown duration, and passes ffmpeg without a shell', async () => {
  await fixture(async root => {
    const source = join(root, 'clip.mp4');
    const cacheDir = join(root, 'artwork');
    await writeFile(source, 'video');
    const calls = [];
    const execute = async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'probe') return { stdout: '200.0\n' };
      await writeFile(args.at(-1), 'jpeg bytes');
      return { stdout: '', stderr: '' };
    };
    const cache = createArtworkCache({ directory: cacheDir, ffmpeg: 'encode', ffprobe: 'probe', execute });
    const output = await cache.get(source);
    assert.equal(await readFile(output, 'utf8'), 'jpeg bytes');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, 'probe');
    assert.equal(calls[1].command, 'encode');
    assert.deepEqual(calls[1].args.slice(0, 8), ['-hide_banner', '-loglevel', 'error', '-ss', '20', '-i', source, '-frames:v']);
    const formatIndex = calls[1].args.indexOf('-threads');
    assert.deepEqual(calls[1].args.slice(formatIndex), ['-threads', '1', '-q:v', '3', '-f', 'image2', '-vcodec', 'mjpeg', '-y', calls[1].args.at(-1)]);
    assert.equal(calls[1].options.timeout, 30_000);
    assert.equal(calls[1].options.shell, undefined);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await cache.get(source)), output);
    assert.deepEqual(cache.stats(), { requests: 2, hits: 1, generated: 1, failures: 0, saturated: 0, queued: 0, active: 0 });
    await cache.close();
  });
});

test('limits real work to two workers and invalidates the key when media changes', async () => {
  await fixture(async root => {
    const sources = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const source = join(root, `clip-${index}.mp4`);
      await writeFile(source, `video-${index}`);
      return source;
    }));
    let running = 0;
    let maximum = 0;
    const execute = async (_command, args) => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 12));
      await writeFile(args.at(-1), 'jpeg');
      running -= 1;
    };
    const cache = createArtworkCache({ directory: join(root, 'artwork'), execute });
    const outputs = await Promise.all(sources.map(source => cache.get(source, { durationSeconds: 20 })));
    assert.equal(maximum, 2);
    assert.equal(new Set(outputs).size, 4);
    const first = outputs[0];
    await writeFile(sources[0], 'changed');
    await utimes(sources[0], new Date(), new Date(Date.now() + 1000));
    const second = await cache.get(sources[0], { durationSeconds: 20 });
    assert.notEqual(second, first);
    assert.equal(cache.stats().generated, 5);
    await cache.close();
  });
});

test('extracts a valid JPEG with the real ffmpeg toolchain when available', async t => {
  try { await execFileAsync('ffmpeg', ['-version']); } catch { t.skip('ffmpeg is unavailable'); return; }
  await fixture(async root => {
    const source = join(root, 'real.mp4');
    await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source]);
    const cache = createArtworkCache({ directory: join(root, 'artwork') });
    const output = await cache.get(source);
    assert.ok(output);
    const bytes = await readFile(output);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
    await cache.close();
  });
});

test('deduplicates concurrent requests and uses supplied duration without ffprobe', async () => {
  await fixture(async root => {
    const source = join(root, 'clip.mp4');
    await writeFile(source, 'video');
    let running = 0;
    let maximum = 0;
    let calls = 0;
    const execute = async (_command, args) => {
      calls += 1; running += 1; maximum = Math.max(maximum, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      await writeFile(args.at(-1), 'jpeg');
      running -= 1;
    };
    const cache = createArtworkCache({ directory: join(root, 'artwork'), execute });
    const [one, two] = await Promise.all([cache.get(source, { durationSeconds: 500 }), cache.get(source, { durationSeconds: 500 })]);
    assert.equal(one, two);
    assert.equal(calls, 1);
    assert.equal(maximum, 1);
    assert.equal((await cache.get(source, { durationSeconds: 500 })) , one);
    await cache.close();
  });
});

test('failed encodes return null and leave no temporary or failed cache files', async () => {
  await fixture(async root => {
    const source = join(root, 'clip.mp4');
    const artwork = join(root, 'artwork');
    await writeFile(source, 'video');
    const cache = createArtworkCache({ directory: artwork, execute: async (_command, args) => {
      if (args[0] === '-v') return { stdout: '10' };
      throw new Error('bad media');
    } });
    assert.equal(await cache.get(source), null);
    assert.deepEqual(await readdir(artwork), []);
    assert.equal(cache.stats().failures, 1);
    await cache.close();
  });
});

test('rejects symlinks and invalid paths without invoking ffmpeg', async () => {
  await fixture(async root => {
    const source = join(root, 'clip.mp4');
    const linked = join(root, 'linked.mp4');
    await writeFile(source, 'video');
    await symlink(source, linked);
    const cache = createArtworkCache({ directory: join(root, 'artwork'), execute: () => { throw new Error('unexpected'); } });
    await assert.rejects(cache.get('relative.mp4'), /absolute/);
    assert.equal(await cache.get(linked), null);
    await cache.close();
  });
});

test('close aborts active encodes and resolves callers promptly', async () => {
  await fixture(async root => {
    const source = join(root, 'clip.mp4');
    await writeFile(source, 'video');
    let startResolve;
    const started = new Promise(resolve => { startResolve = resolve; });
    const execute = async (_command, _args, options) => {
      startResolve();
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    };
    const cache = createArtworkCache({ directory: join(root, 'artwork'), execute });
    const running = cache.get(source, { durationSeconds: 20 });
    await started;
    await cache.close();
    assert.equal(await running, null);
    assert.equal(cache.stats().active, 0);
  });
});

test('pruning keeps the most recently used thumbnails and leaves other files alone', async () => {
  await fixture(async root => {
    for (let i = 0; i < 5; i++) {
      const path = join(root, `${'a'.repeat(63)}${i}.jpg`);
      await writeFile(path, 'jpeg');
      await utimes(path, 1000 + i, 1000 + i);
    }
    await writeFile(join(root, 'notes.txt'), 'keep');
    assert.equal(await pruneArtwork(root, { maxFiles: 3 }), 2);
    assert.deepEqual((await readdir(root)).sort(), [`${'a'.repeat(63)}2.jpg`, `${'a'.repeat(63)}3.jpg`, `${'a'.repeat(63)}4.jpg`, 'notes.txt']);
    assert.equal(await pruneArtwork(join(root, 'missing')), 0);
  });
});

test('a cache hit marks the thumbnail as recently used', async () => {
  await fixture(async root => {
    const source = join(root, 'clip.mp4');
    await writeFile(source, 'video');
    const execute = async (command, args) => { if (command !== 'probe') await writeFile(args.at(-1), 'jpeg'); return { stdout: '10' }; };
    const first = createArtworkCache({ directory: join(root, 'artwork'), ffmpeg: 'encode', ffprobe: 'probe', execute });
    const output = await first.get(source);
    await first.close();
    await utimes(output, 1000, 1000);
    const second = createArtworkCache({ directory: join(root, 'artwork'), ffmpeg: 'encode', ffprobe: 'probe', execute });
    assert.equal(await second.get(source), output);
    assert.ok((await stat(output)).mtimeMs > 1_000_000);
    await second.close();
  });
});
