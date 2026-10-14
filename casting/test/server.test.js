import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtemp, open, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaServer } from '../src/server.js';

describe('MediaServer', () => {
  let dir;
  let server;

  after(async () => {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves only the issued token path with range and DLNA headers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-'));
    const filePath = join(dir, 'clip.mp4');
    const payload = Buffer.alloc(2048, 7);
    await writeFile(filePath, payload);

    server = new MediaServer({ host: '127.0.0.1' });
    await server.listen();
    const item = server.serveFile({
      filePath,
      mimeType: 'video/mp4',
      title: 'clip.mp4',
      seekable: true,
    });

    const forbidden = await fetch(`http://127.0.0.1:${server.port}/nope`);
    assert.equal(forbidden.status, 404);

    const head = await fetch(item.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    assert.equal(head.headers.get('content-length'), '2048');
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(head.headers.get('transfermode.dlna.org'), 'Streaming');
    assert.match(head.headers.get('contentfeatures.dlna.org') ?? '', /DLNA\.ORG_OP=01/);

    const ranged = await fetch(item.url, { headers: { Range: 'bytes=0-15' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-15/2048');
    assert.equal(Buffer.from(await ranged.arrayBuffer()).length, 16);
    await server.close();
    server = null;
    await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('serves files whose names contain spaces from encoded and decoded paths', async () => {
    dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-space-'));
    const filePath = join(dir, 'Luxo Jr. - Pixar (1986).mp4');
    await writeFile(filePath, Buffer.alloc(64, 9));
    server = new MediaServer({ host: '127.0.0.1' });
    await server.listen();
    const item = server.serveFile({ filePath, mimeType: 'video/mp4', seekable: true });
    const encoded = await fetch(item.url, { method: 'HEAD' });
    assert.equal(encoded.status, 200);
    const decodedPath = decodeURI(new URL(item.url).pathname);
    const decoded = await fetch(`http://127.0.0.1:${server.port}${decodedPath}`, { method: 'HEAD' });
    assert.equal(decoded.status, 200);
  });
});

it('handles suffix ranges, malformed ranges, empty files, and revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-range-'));
  const server = new MediaServer({ host: '127.0.0.1' });
  try {
    const path = join(dir, 'clip.mp4');
    await writeFile(path, '0123456789');
    await server.listen();
    const item = server.serveFile({ filePath: path });
    for (const [range, body] of [['bytes=-3', '789'], ['bytes=-100', '0123456789'], ['bytes=5-', '56789']]) {
      const response = await fetch(item.url, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(await response.text(), body);
    }
    for (const range of ['bytes=-0', 'bytes=-', 'bytes=10-', 'bytes=0-1,4-5', 'bytes=99999999999999999999-']) {
      const response = await fetch(item.url, { headers: { Range: range } });
      assert.equal(response.status, 416);
      await response.arrayBuffer();
    }
    await writeFile(path, '');
    const empty = await fetch(item.url);
    assert.equal(empty.status, 200);
    assert.equal(await empty.text(), '');
    server.clear();
    const revoked = await fetch(item.url);
    assert.equal(revoked.status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('revokes only the consumed resource while preserving a queued lookahead', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-revoke-isolated-'));
  const server = new MediaServer({ host: '127.0.0.1' });
  try {
    const firstPath = join(dir, 'first.mp4');
    const nextPath = join(dir, 'next.mp4');
    await writeFile(firstPath, 'first');
    await writeFile(nextPath, 'next');
    await server.listen();
    const first = server.serveFile({ filePath: firstPath });
    const next = server.serveFile({ filePath: nextPath });
    server.revoke(first.url);
    assert.equal((await fetch(first.url)).status, 404);
    const response = await fetch(next.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'next');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('revokes an active stream for a paused client and keeps serving newly issued files', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-revoke-stream-'));
  const server = new MediaServer({ host: '127.0.0.1' });
  let client, response;
  try {
    const path = join(dir, 'large.mp4');
    const size = 64 * 1024 * 1024;
    const file = await open(path, 'w');
    try { await file.truncate(size); } finally { await file.close(); }
    await server.listen();
    const item = server.serveFile({ filePath: path });
    let received = 0;
    let aborted = false;
    let closed;
    response = await new Promise((resolve, reject) => {
      client = http.get(item.url, res => {
        res.on('error', () => {});
        res.once('aborted', () => { aborted = true; });
        closed = new Promise(done => res.once('close', done));
        res.on('data', chunk => { received += chunk.length; });
        res.once('data', () => { res.pause(); resolve(res); });
      });
      client.once('error', reject);
    });
    server.clear();
    response.resume();
    await closed;
    assert.equal(aborted, true);
    assert.equal(response.complete, false);
    assert.ok(received < size, 'revocation must interrupt the unfinished response');
    assert.equal((await fetch(item.url)).status, 404);

    const replacement = server.serveFile({ filePath: path });
    const next = await fetch(replacement.url, { headers: { Range: 'bytes=0-15' } });
    assert.equal(next.status, 206);
    assert.equal((await next.arrayBuffer()).byteLength, 16);
  } finally {
    response?.destroy();
    client?.destroy();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not open a revoked file stream after its pending stat completes', { timeout: 10_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-revoke-stat-'));
  let releaseStat, signalStat, signalStatCompleted;
  const waitingForStat = new Promise(resolve => { signalStat = resolve; });
  const statGate = new Promise(resolve => { releaseStat = resolve; });
  const statCompleted = new Promise(resolve => { signalStatCompleted = resolve; });
  const server = new MediaServer({ host: '127.0.0.1', statFile: async path => {
    signalStat();
    await statGate;
    const info = await stat(path);
    signalStatCompleted();
    return info;
  } });
  const originalReadStream = fs.createReadStream;
  const streamSpy = t.mock.method(fs, 'createReadStream', (...args) => originalReadStream(...args));
  let client;
  try {
    const path = join(dir, 'clip.mp4');
    await writeFile(path, 'media');
    await server.listen();
    const item = server.serveFile({ filePath: path });
    const requested = new Promise(resolve => {
      client = http.get(item.url, res => {
        res.resume();
        resolve({ status: res.statusCode });
      });
      client.once('error', error => resolve({ error }));
    });
    await waitingForStat;
    server.clear();
    const result = await requested;
    assert.equal(result.error?.code, 'ECONNRESET');
    releaseStat();
    await statCompleted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(streamSpy.mock.callCount(), 0);
    assert.equal((await fetch(item.url)).status, 404);
  } finally {
    releaseStat();
    client?.destroy();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
