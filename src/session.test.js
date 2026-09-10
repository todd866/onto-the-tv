import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './session.js';

function mockRenderer() {
  const calls = [];
  return {
    calls,
    async play(item) { calls.push(['play', item.title]); this.uri = item.url; this.state = 'PLAYING'; },
    async setNext(item) { calls.push(['setNext', item.title]); },
    async pause() { calls.push(['pause']); this.state = 'PAUSED_PLAYBACK'; },
    async resume() { calls.push(['resume']); this.state = 'PLAYING'; },
    async stop() { calls.push(['stop']); this.state = 'STOPPED'; this.uri = ''; },
    async transportInfo() { return { state: this.state || 'NO_MEDIA_PRESENT', status: 'OK' }; },
    async positionInfo() { return { uri: this.uri || '', positionSeconds: 12, durationSeconds: 100 }; },
  };
}

function mockServer() {
  return {
    port: 9,
    async listen() { return this; },
    serveFile(prepared) {
      return { ...prepared, url: `http://host/${encodeURIComponent(prepared.title)}` };
    },
    async close() {},
  };
}

function createTestSession(renderer = mockRenderer()) {
  const prepared = [];
  const session = createSession({
    config: { bindHost: '127.0.0.1', avTransportUrl: 'http://tv/control' },
    prepareMedia: async (filePath) => {
      const title = filePath.split('/').at(-1);
      prepared.push(title);
      return { filePath, title, mimeType: 'video/mp4', durationSeconds: 100, cleanup: async () => {} };
    },
    createServer: () => mockServer(),
    createRenderer: () => renderer,
    pollMs: 10_000,
  });
  session.renderer = renderer;
  session.prepared = prepared;
  return session;
}

describe('createSession', () => {
  it('plays the first dropped file immediately', async () => {
    const session = createTestSession();
    await session.addFiles(['/videos/Luxo.mp4']);
    assert.deepEqual(session.renderer.calls, [['play', 'Luxo.mp4']]);
    assert.equal(session.getState().status, 'playing');
    assert.equal(session.getState().current.title, 'Luxo.mp4');
  });

  it('queues a second drop without replacing the current title', async () => {
    const session = createTestSession();
    await session.addFiles(['/videos/Luxo.mp4']);
    await session.addFiles(['/videos/Presto.mp4']);
    assert.equal(session.renderer.calls.filter((call) => call[0] === 'play').length, 1);
    assert.deepEqual(session.getState().upcoming.map((item) => item.title), ['Presto.mp4']);
  });

  it('plays the queued file when the TV stops at the end of the current one', async () => {
    const renderer = mockRenderer();
    renderer.positionInfo = async function () { return { uri: this.uri || '', positionSeconds: 97, durationSeconds: 100 }; };
    const session = createTestSession(renderer);
    await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
    await session.tick();
    session.renderer.state = 'STOPPED';
    await session.tick();
    assert.ok(session.renderer.calls.some((call) => call[0] === 'play' && call[1] === 'Presto.mp4'));
  });

  it('treats a stop in the middle of a file as the remote stopping playback', async () => {
    const session = createTestSession();
    await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
    await session.tick();
    assert.equal(session.getState().current.positionSeconds, 12);
    session.renderer.state = 'STOPPED';
    await session.tick();
    assert.ok(!session.renderer.calls.some((call) => call[0] === 'play' && call[1] === 'Presto.mp4'));
    assert.equal(session.getState().status, 'idle');
    assert.equal(session.getState().count, 0);
  });
});

it('serializes concurrent drops and never starts the first file twice', async () => {
  const session = createTestSession();
  try {
    await Promise.all([session.addFiles(['/a.mp4']), session.addFiles(['/b.mp4'])]);
    assert.deepEqual(session.prepared, ['a.mp4', 'b.mp4']);
    assert.equal(session.renderer.calls.filter(([action]) => action === 'play').length, 1);
    assert.deepEqual(session.getState().upcoming, [{ title: 'b.mp4' }]);
  } finally { await session.close(); }
});

it('finishes the final item when the TV clears its URI, and starts fresh on the next drop', async () => {
  const session = createTestSession();
  try {
    await session.addFiles(['/a.mp4', '/b.mp4']);
    session.renderer.state = 'STOPPED';
    await session.tick();
    session.renderer.uri = '';
    session.renderer.state = 'NO_MEDIA_PRESENT';
    await session.tick();
    assert.equal(session.getState().status, 'idle');
    assert.equal(session.getState().current, null);
    assert.equal(session.getState().count, 0);
    await session.addFiles(['/c.mp4']);
    assert.equal(session.getState().current.title, 'c.mp4');
  } finally { await session.close(); }
});

it('cleans up prepared files on a failed batch, on stop, and on close', async () => {
  const cleaned = [];
  const server = mockServer();
  let revoked = 0;
  server.clear = () => { revoked += 1; };
  const session = createSession({
    config: { avTransportUrl: 'http://tv/control' },
    prepareMedia: async (path) => {
      if (path === '/bad.mp4') throw new Error('Invalid media');
      return { filePath: path, title: path, cleanup: async () => cleaned.push(path) };
    },
    createServer: () => server, createRenderer: mockRenderer, pollMs: 0,
  });
  await assert.rejects(session.addFiles(['/a.mp4', '/bad.mp4']), /Invalid media/);
  assert.deepEqual(cleaned, ['/a.mp4']);
  assert.equal(session.getState().status, 'idle');
  await session.addFiles(['/b.mp4']);
  await session.stop();
  await session.addFiles(['/c.mp4']);
  await session.close();
  assert.deepEqual(cleaned, ['/a.mp4', '/b.mp4', '/c.mp4']);
  assert.ok(revoked >= 3);
});

it('cancels a preparing drop when Stop is requested', async () => {
  let finish;
  let began;
  let cleaned = false;
  const ready = new Promise((resolve) => { began = resolve; });
  const renderer = mockRenderer();
  const session = createSession({
    config: { avTransportUrl: 'http://tv/control' },
    prepareMedia: async () => {
      began();
      await new Promise((resolve) => { finish = resolve; });
      return { title: 'a', cleanup: async () => { cleaned = true; } };
    },
    createServer: mockServer, createRenderer: () => renderer, pollMs: 0,
  });
  try {
    const adding = session.addFiles(['/a.mp4']);
    await ready;
    const stopping = session.stop();
    finish();
    await Promise.all([adding, stopping]);
    assert.deepEqual(renderer.calls, []);
    assert.equal(cleaned, true);
    assert.equal(session.getState().status, 'idle');
  } finally { await session.close(); }
});

it('requires TV configuration without opening a media server', async () => {
  const session = createSession({ config: {}, createServer: () => assert.fail('Must not bind'), pollMs: 0 });
  try {
    await assert.rejects(session.addFiles(['/a.mp4']), /Choose a TV/);
    assert.equal(session.getState().status, 'idle');
  } finally { await session.close(); }
});
