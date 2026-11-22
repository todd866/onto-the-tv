import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { classifyPlayerResponse, normalizeChapters, prepareMedia, runCommand } from '../src/pipeline.js';
import { MediaServer } from '../src/server.js';

async function readWhenReady(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(filePath, 'utf8');
      if (contents) return contents;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(10);
  }
  throw new Error(`Child process did not create ${filePath}`);
}

describe('media preparation cancellation', () => {
  it('does not start a command when its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runCommand('not-a-real-command', [], { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('removes its abort listener when the command cannot start', async () => {
    const controller = new AbortController();
    await assert.rejects(runCommand('not-a-real-command', [], { signal: controller.signal }), { code: 'ENOENT' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('stops a running command promptly and removes its abort listener', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-cancel-command-'));
    const ready = join(dir, 'ready');
    const controller = new AbortController();
    const command = runCommand(process.execPath, ['-e', `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      setInterval(() => {}, 1000);
    `], { timeoutMs: 10_000, signal: controller.signal });
    const outcome = command.then((result) => ({ result }), (error) => ({ error }));
    try {
      const pid = Number(await readWhenReady(ready));
      const started = Date.now();
      controller.abort();
      assert.equal((await outcome).error?.name, 'AbortError');
      assert.ok(Date.now() - started < 2_000, 'cancellation should not wait for the command timeout');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      controller.abort();
      await outcome;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops a local conversion and removes its partially prepared media', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-cancel-local-'));
    const ready = join(dir, 'ready');
    const ffprobe = join(dir, 'ffprobe');
    const ffmpeg = join(dir, 'ffmpeg');
    await writeFile(ffprobe, `#!/usr/bin/env node
      console.log(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'vp9' }], format: { format_name: 'webm' } }));
    `, { mode: 0o755 });
    await writeFile(ffmpeg, `#!/usr/bin/env node
      const fs = require('node:fs');
      const output = process.argv.at(-1);
      fs.writeFileSync(output, 'partial conversion');
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ output, pid: process.pid }));
      setInterval(() => {}, 1000);
    `, { mode: 0o755 });
    const controller = new AbortController();
    const preparation = prepareMedia(join(dir, 'source.webm'), { ffprobe, ffmpeg }, { signal: controller.signal });
    const outcome = preparation.then((result) => ({ result }), (error) => ({ error }));
    try {
      const { output, pid } = JSON.parse(await readWhenReady(ready));
      controller.abort();
      assert.equal((await outcome).error?.name, 'AbortError');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await assert.rejects(access(dirname(output)), { code: 'ENOENT' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      controller.abort();
      const { result } = await outcome;
      await result?.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes cancellation to the YouTube classification request', async () => {
    const controller = new AbortController();
    const request = classifyPlayerResponse('example', async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort();
      options.signal.throwIfAborted();
    }, { signal: controller.signal });
    await assert.rejects(request, { name: 'AbortError' });
  });
});

describe('embedded chapter navigation', () => {
  it('sorts valid chapter times, limits them to the file duration, and supplies missing titles', () => {
    assert.deepEqual(normalizeChapters([
      { start_time: '12.500', tags: { title: '  The chase  ' } },
      { start_time: '0', tags: { TITLE: 'Opening' } },
      { start_time: 30, tags: { title: '  ' } },
      { start_time: '-1' }, { start_time: '31' }, { start_time: 'NaN' },
      { start_time: '' }, { start_time: null }, { start_time: true }, null,
    ], 30), [
      { title: 'Opening', startSeconds: 0 },
      { title: 'The chase', startSeconds: 12.5 },
      { title: 'Chapter 3', startSeconds: 30 },
    ]);
    assert.deepEqual(normalizeChapters(undefined, 30), []);
    assert.deepEqual(normalizeChapters([{ start_time: '12.5' }], null), [{ title: 'Chapter 1', startSeconds: 12.5 }]);
    const limited = normalizeChapters(Array.from({ length: 250 }, (_, index) => ({ start_time: 249 - index })), 300);
    assert.equal(limited.length, 200);
    assert.equal(limited[0].startSeconds, 0);
    assert.equal(limited.at(-1).startSeconds, 199);
  });

  it('keeps the original chapters when a local conversion drops the chapter metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-chapters-convert-'));
    let prepared;
    try {
      const ffprobe = join(dir, 'ffprobe');
      const ffmpeg = join(dir, 'ffmpeg');
      await writeFile(ffprobe, `#!/usr/bin/env node
        if (!process.argv.includes('-show_chapters')) throw new Error('Chapters were not requested');
        const source = process.argv.at(-1).endsWith('source.webm');
        console.log(JSON.stringify({
          streams: [{ codec_type: 'video', codec_name: source ? 'vp9' : 'h264' }],
          format: { format_name: source ? 'webm' : 'mp4', duration: '30' },
          chapters: source ? [{ start_time: '0', tags: { title: 'Opening' } }, { start_time: '12.5', tags: { title: 'The chase' } }] : [],
        }));
      `, { mode: 0o755 });
      await writeFile(ffmpeg, `#!/usr/bin/env node
        require('node:fs').writeFileSync(process.argv.at(-1), 'converted fixture');
      `, { mode: 0o755 });
      prepared = await prepareMedia(join(dir, 'source.webm'), { ffprobe, ffmpeg });
      assert.equal(prepared.transcoded, true);
      assert.deepEqual(prepared.chapters, [
        { title: 'Opening', startSeconds: 0 },
        { title: 'The chase', startSeconds: 12.5 },
      ]);
    } finally {
      await prepared?.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads real embedded MKV chapter titles and times without converting a compatible file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-chapters-mkv-'));
    let prepared;
    try {
      const metadata = join(dir, 'chapters.txt');
      const filePath = join(dir, 'chapters.mkv');
      const config = loadConfig();
      await writeFile(metadata, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Finale\n');
      await runCommand(config.ffmpeg, [
        '-y', '-f', 'lavfi', '-i', 'color=black:size=32x32:rate=1',
        '-f', 'ffmetadata', '-i', metadata,
        '-map', '0:v', '-map_metadata', '1', '-map_chapters', '1',
        '-t', '2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filePath,
      ]);
      prepared = await prepareMedia(filePath, config);
      assert.equal(prepared.transcoded, false);
      assert.deepEqual(prepared.chapters, [
        { title: 'Opening', startSeconds: 0 },
        { title: 'Finale', startSeconds: 1 },
      ]);
    } finally {
      await prepared?.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('local H.264 clip pipeline', () => {
  it('probes a generated clip as compatible and serves it with Content-Length', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-clip-'));
    const filePath = join(dir, 'clip.mp4');
    const config = loadConfig();
    try {
      await runCommand(config.ffmpeg, [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level:v', '4.1',
        '-c:a', 'aac', '-ac', '2',
        '-movflags', '+faststart',
        filePath,
      ]);
      const prepared = await prepareMedia(filePath, config);
      assert.equal(prepared.transcoded, false);
      assert.equal(prepared.mimeType, 'video/mp4');

      const server = new MediaServer({ host: '127.0.0.1' });
      await server.listen();
      try {
        const item = server.serveFile(prepared);
        const head = await fetch(item.url, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-type'), 'video/mp4');
        assert.ok(Number(head.headers.get('content-length')) > 0);
      } finally {
        await server.close();
        await prepared.cleanup();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
