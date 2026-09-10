import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { prepareMedia, runCommand } from '../src/pipeline.js';
import { MediaServer } from '../src/server.js';

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
