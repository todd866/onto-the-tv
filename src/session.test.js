import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybackHistory } from './playback-history.js';
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
    async positionInfo() { return { uri: this.uri || '', positionSeconds: this.positionSeconds ?? 12, durationSeconds: this.durationSeconds ?? 100 }; },
    async seek(seconds) { calls.push(['seek', seconds]); this.positionSeconds = seconds; },
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

function createTestSession(renderer = mockRenderer(), options = {}) {
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
    ...options,
    pollMs: 0,
  });
  session.renderer = renderer;
  session.prepared = prepared;
  return session;
}

describe('createSession', () => {
  it('plays the first dropped file immediately', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      assert.deepEqual(session.renderer.calls, [['play', 'Luxo.mp4']]);
      assert.equal(session.getState().status, 'playing');
      assert.equal(session.getState().current.title, 'Luxo.mp4');
    } finally { await session.close(); }
  });

  it('queues a second drop without replacing the current title', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      await session.addFiles(['/videos/Presto.mp4']);
      assert.equal(session.renderer.calls.filter((call) => call[0] === 'play').length, 1);
      assert.deepEqual(session.getState().upcoming.map((item) => item.title), ['Presto.mp4']);
    } finally { await session.close(); }
  });

  it('plays the queued file when the TV stops at the end of the current one', async () => {
    const renderer = mockRenderer();
    renderer.positionSeconds = 97;
    const session = createTestSession(renderer);
    try {
      await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
      await session.tick();
      session.renderer.state = 'STOPPED';
      await session.tick();
      assert.ok(session.renderer.calls.some((call) => call[0] === 'play' && call[1] === 'Presto.mp4'));
    } finally { await session.close(); }
  });

  it('treats a stop in the middle of a file as the remote stopping playback', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
      await session.tick();
      assert.equal(session.getState().current.positionSeconds, 12);
      session.renderer.state = 'STOPPED';
      await session.tick();
      await session.tick();
      assert.ok(!session.renderer.calls.some((call) => call[0] === 'play' && call[1] === 'Presto.mp4'));
      assert.equal(session.getState().status, 'idle');
      assert.equal(session.getState().count, 0);
    } finally { await session.close(); }
  });
});

it('serializes concurrent drops and never starts the first file twice', async () => {
  const session = createTestSession();
  try {
    await Promise.all([session.addFiles(['/a.mp4']), session.addFiles(['/b.mp4'])]);
    assert.deepEqual(session.prepared, ['a.mp4', 'b.mp4']);
    assert.equal(session.renderer.calls.filter(([action]) => action === 'play').length, 1);
    assert.deepEqual(session.getState().upcoming, [{ title: 'b.mp4', path: '/b.mp4' }]);
  } finally { await session.close(); }
});

it('finishes the final item when the TV clears its URI, and starts fresh on the next drop', async () => {
  const session = createTestSession();
  try {
    await session.addFiles(['/a.mp4', '/b.mp4']);
    session.renderer.positionSeconds = 97;
    await session.tick();
    session.renderer.state = 'STOPPED';
    await session.tick();
    await session.tick();
    session.renderer.positionSeconds = 0;
    session.renderer.uri = '';
    session.renderer.state = 'NO_MEDIA_PRESENT';
    await session.tick();
    assert.equal(session.getState().status, 'finished');
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
  try {
    await assert.rejects(session.addFiles(['/a.mp4', '/bad.mp4']), /Invalid media/);
    assert.deepEqual(cleaned, ['/a.mp4']);
    assert.equal(session.getState().status, 'idle');
    await session.addFiles(['/b.mp4']);
    await session.stop();
    await session.addFiles(['/c.mp4']);
  } finally { await session.close(); }
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

describe('handing a channel to the TV', () => {
  it('reports the source path of the current and queued files', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
      assert.equal(session.getState().current.path, '/videos/Luxo.mp4');
      assert.deepEqual(session.getState().upcoming.map((item) => item.path), ['/videos/Presto.mp4']);
    } finally { await session.close(); }
  });

  it('jumps to the queued episode when the remote asks for the next one', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
      await session.playNext();
      assert.equal(session.getState().current.title, 'Presto.mp4');
      assert.equal(session.getState().upcoming.length, 0);
      assert.equal(session.renderer.calls.filter(([action]) => action === 'play').length, 2);
    } finally { await session.close(); }
  });

  it('does nothing when the remote asks for a next episode that is not queued', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      await session.playNext();
      assert.equal(session.getState().current.title, 'Luxo.mp4');
      assert.equal(session.renderer.calls.filter(([action]) => action === 'play').length, 1);
    } finally { await session.close(); }
  });

  it('replaces the whole queue when the channel starts a different episode', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4', '/videos/Presto.mp4']);
      await session.playOnly(['/videos/Geri.mp4']);
      assert.equal(session.getState().current.title, 'Geri.mp4');
      assert.equal(session.getState().count, 1);
      assert.deepEqual(session.getState().upcoming, []);
    } finally { await session.close(); }
  });

  it('guards a channel lookahead against a stale current path and queues only one item', async () => {
    const session = createTestSession();
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      const stale = await session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/other.mp4');
      assert.deepEqual(stale.upcoming, []);
      assert.deepEqual(session.renderer.calls.filter(([action]) => action === 'setNext'), []);

      const queued = await session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      assert.deepEqual(queued.upcoming.map(item => item.path), ['/videos/Presto.mp4']);
      assert.deepEqual(session.renderer.calls.filter(([action]) => action === 'setNext'), [['setNext', 'Presto.mp4']]);

      const duplicate = await session.queueNext({ path: '/videos/Geri.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      assert.deepEqual(duplicate.upcoming.map(item => item.path), ['/videos/Presto.mp4']);
    } finally { await session.close(); }
  });

  it('reports a native URI transition with the prior position and completion state', async () => {
    const renderer = mockRenderer();
    const session = createTestSession(renderer);
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      await session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      renderer.positionSeconds = 12;
      await session.tick();
      renderer.positionSeconds = 97;
      await session.tick();
      await session.queueNext({ path: '/videos/Geri.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      renderer.uri = 'http://host/Presto.mp4';
      renderer.positionSeconds = 0;
      renderer.state = 'PLAYING';
      const state = await session.tick();
      assert.equal(state.current.path, '/videos/Presto.mp4');
      assert.deepEqual(state.transition, {
        fromPath: '/videos/Luxo.mp4', toPath: '/videos/Presto.mp4',
        positionSeconds: 97, durationSeconds: 100, completed: true,
      });
    } finally { await session.close(); }
  });

  it('keeps a native transition alive through one stopped-to-playing sample on the retained URI', async () => {
    const renderer = mockRenderer();
    const session = createTestSession(renderer);
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      await session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      renderer.positionSeconds = 12;
      await session.tick();
      renderer.positionSeconds = 97;
      await session.tick();
      renderer.uri = 'http://host/Presto.mp4';
      renderer.positionSeconds = 0;
      renderer.state = 'PLAYING';
      const transitioned = await session.tick();
      assert.equal(transitioned.current.path, '/videos/Presto.mp4');
      renderer.state = 'STOPPED';
      const stopped = await session.tick();
      assert.equal(stopped.current.path, '/videos/Presto.mp4');
      assert.equal(stopped.status, 'playing');
      renderer.state = 'PLAYING';
      const resumed = await session.tick();
      assert.equal(resumed.current.path, '/videos/Presto.mp4');
    } finally { await session.close(); }
  });

  it('prunes and revokes consumed channel URLs without clearing the active lookahead', async () => {
    const revoked = [];
    const server = mockServer();
    server.revoke = url => revoked.push(url);
    const renderer = mockRenderer();
    const session = createTestSession(renderer, { createServer: () => server });
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      await session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      renderer.positionSeconds = 12;
      await session.tick();
      renderer.uri = 'http://host/Presto.mp4';
      renderer.positionSeconds = 0;
      renderer.state = 'PLAYING';
      const state = await session.tick();
      assert.equal(state.current.path, '/videos/Presto.mp4');
      assert.equal(state.count, 1);
      assert.deepEqual(state.upcoming, []);
      assert.equal(revoked.length, 1);
      assert.match(revoked[0], /Luxo/);
    } finally { await session.close(); }
  });

  it('cancels a pending channel lookahead on Stop without leaving it queued', async () => {
    const began = deferred();
    const release = deferred();
    const session = createTestSession(mockRenderer(), {
      prepareMedia: async (path, config, { signal }) => {
        if (path === '/videos/Presto.mp4') {
          began.resolve();
          await Promise.race([release.promise, new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })]);
        }
        return { filePath: path, title: path.split('/').at(-1), durationSeconds: 100 };
      },
    });
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      const queued = session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      await began.promise;
      const stopped = session.stop();
      release.resolve();
      await Promise.all([queued, stopped]);
      assert.equal(session.getState().count, 0);
      assert.deepEqual(session.getState().upcoming, []);
    } finally { release.resolve(); await session.close(); }
  });

  it('falls back to software channel advancement when native queue setup fails', async () => {
    const renderer = mockRenderer();
    renderer.setNext = async () => { throw new Error('native queue unavailable'); };
    const session = createTestSession(renderer);
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      await session.queueNext({ path: '/videos/Presto.mp4', startSeconds: 0 }, '/videos/Luxo.mp4');
      renderer.positionSeconds = 12;
      await session.tick();
      renderer.positionSeconds = 97;
      renderer.state = 'STOPPED';
      await session.tick();
      await session.tick();
      assert.equal(session.getState().current.path, '/videos/Presto.mp4');
      assert.equal(renderer.calls.filter(([action]) => action === 'play').length, 2);
    } finally { await session.close(); }
  });
});

it('resumes a handed-over episode near where the laptop left it', async () => {
  const renderer = mockRenderer();
  renderer.seek = async function (seconds) { this.calls.push(['seek', seconds]); };
  const session = createTestSession(renderer);
  try {
    await session.addFiles([{ path: '/videos/Luxo.mp4', startSeconds: 90 }]);
    assert.deepEqual(session.renderer.calls, [['play', 'Luxo.mp4'], ['seek', 90]]);
    await session.playOnly([{ path: '/videos/Presto.mp4', startSeconds: 2 }]);
    assert.ok(!session.renderer.calls.some(([action, value]) => action === 'seek' && value === 2));
  } finally { await session.close(); }
});

it('keeps playing when the TV refuses to seek', async () => {
  const renderer = mockRenderer();
  renderer.seek = async () => { throw new Error('UPnP 710: seek mode not supported'); };
  const session = createTestSession(renderer);
  try {
    await session.addFiles([{ path: '/videos/Luxo.mp4', startSeconds: 90 }]);
    assert.equal(session.getState().current.title, 'Luxo.mp4');
    assert.match(session.getState().error, /could not resume.*saved place is kept/i);
    assert.equal(session.getState().status, 'playing');
  } finally { await session.close(); }
});

it('reports finished when the last file ends on its own', async () => {
  const renderer = mockRenderer();
  renderer.positionInfo = async function () { return { uri: this.uri || '', positionSeconds: 97, durationSeconds: 100 }; };
  const session = createTestSession(renderer);
  try {
    await session.addFiles(['/videos/Luxo.mp4']);
    session.renderer.state = 'STOPPED';
    await session.tick();
    assert.equal(session.getState().status, 'finished');
    assert.equal(session.getState().current, null);
  } finally { await session.close(); }
});

async function withSavedHistory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'onto-session-history-'));
  try { await run(join(directory, 'history.json')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

it('saves polled progress and stop to real history, then resumes after an app restart', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const session = createTestSession(mockRenderer(), { history });
    try {
      await session.playOnly(['/videos/Luxo.mp4']);
      session.renderer.positionSeconds = 42;
      await session.tick();
      assert.equal((await loadPlaybackHistory(path)).get('/videos/Luxo.mp4'), 42);
      await session.stop();
      assert.equal((await loadPlaybackHistory(path)).get('/videos/Luxo.mp4'), 42);
    } finally { await session.close(); }
    const restarted = createTestSession(mockRenderer(), { history: await loadPlaybackHistory(path) });
    try {
      await restarted.playOnly(['/videos/Luxo.mp4']);
      assert.deepEqual(restarted.renderer.calls, [['play', 'Luxo.mp4'], ['seek', 42]]);
      assert.equal(restarted.getState().current.positionSeconds, 42);
      assert.equal(restarted.getState().history[0].title, 'Luxo.mp4');
    } finally { await restarted.close(); }
  });
});

it('retains completed history through restart and replays completed files from the beginning', async () => {
  await withSavedHistory(async path => {
    const session = createTestSession(mockRenderer(), { history: await loadPlaybackHistory(path) });
    try {
      await session.addFiles(['/videos/Luxo.mp4']);
      session.renderer.positionSeconds = 97;
      await session.tick();
      session.renderer.positionSeconds = 0;
      session.renderer.uri = '';
      session.renderer.state = 'STOPPED';
      await session.tick();
      assert.equal(session.getState().status, 'finished');
    } finally { await session.close(); }
    const history = await loadPlaybackHistory(path);
    assert.equal(history.get('/videos/Luxo.mp4'), 0);
    assert.equal(history.list()[0].completed, true);
    assert.equal(history.list()[0].positionSeconds, 97);
    const restarted = createTestSession(mockRenderer(), { history });
    try {
      await restarted.playOnly(['/videos/Luxo.mp4']);
      assert.deepEqual(restarted.renderer.calls, [['play', 'Luxo.mp4']]);
      assert.equal(restarted.getState().current.positionSeconds, 0);
    } finally { await restarted.close(); }
  });
});

it('uses the explicit channel start instead of the file bookmark while recording watched history', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/videos/Luxo.mp4', { positionSeconds: 72, durationSeconds: 100 });
    await history.flush();
    const session = createTestSession(mockRenderer(), { history });
    try {
      await session.playOnly([{ path: '/videos/Luxo.mp4', startSeconds: 18 }]);
      assert.deepEqual(session.renderer.calls, [['play', 'Luxo.mp4'], ['seek', 18]]);
      session.renderer.positionSeconds = 18;
      await session.tick();
      session.renderer.positionSeconds = 25;
      await session.tick();
      await session.stop();
      assert.equal(history.get('/videos/Luxo.mp4'), 25);
      assert.equal(history.list()[0].title, 'Luxo.mp4');
      await session.playOnly([{ path: '/videos/Luxo.mp4', startSeconds: 0 }]);
      assert.equal(session.getState().current.positionSeconds, 0);
      assert.equal(session.renderer.calls.filter(([action]) => action === 'seek').length, 1);
    } finally { await session.close(); }
  });
});

it('rapid replacement requests and Stop obey the last request', async () => {
  const session = createTestSession();
  try {
    await Promise.all([session.playOnly(['/a.mp4']), session.playOnly(['/b.mp4'])]);
    assert.deepEqual(session.prepared, ['b.mp4']);
    assert.equal(session.getState().current.title, 'b.mp4');
    await Promise.all([session.playOnly(['/c.mp4']), session.playOnly(['/d.mp4']), session.stop()]);
    assert.equal(session.getState().current, null);
    assert.equal(session.getState().count, 0);
    assert.equal(session.getState().status, 'idle');
    assert.deepEqual(session.renderer.calls.filter(([action]) => action === 'play'), [['play', 'b.mp4']]);
  } finally { await session.close(); }
});

it('Stop aborts preparation promptly rather than waiting for media to finish preparing', async () => {
  const began = deferred();
  const release = deferred();
  let signal;
  const session = createTestSession(mockRenderer(), {
    prepareMedia: async (path, config, options) => {
      signal = options.signal;
      began.resolve();
      await Promise.race([release.promise, new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
      return { filePath: path, title: 'a.mp4' };
    },
  });
  let timeout;
  try {
    const opening = session.playOnly(['/a.mp4']);
    await began.promise;
    const stopping = session.stop();
    assert.equal(signal.aborted, true);
    await Promise.race([Promise.all([opening, stopping]), new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Stop did not cancel preparation promptly')), 500);
    })]);
    assert.deepEqual(session.renderer.calls, []);
    assert.equal(session.getState().status, 'idle');
    assert.equal(session.getState().error, null);
  } finally { clearTimeout(timeout); release.resolve(); await session.close(); }
});

it('a replacement aborts a preparing file and starts only the latest file', async () => {
  const began = deferred();
  const release = deferred();
  const session = createTestSession(mockRenderer(), {
    prepareMedia: async (path, config, { signal }) => {
      if (path === '/a.mp4') {
        began.resolve();
        await Promise.race([release.promise, new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })]);
      }
      return { filePath: path, title: path.slice(1), durationSeconds: 100 };
    },
  });
  try {
    const first = session.playOnly(['/a.mp4']);
    await began.promise;
    const latest = session.playOnly(['/b.mp4']);
    await Promise.all([first, latest]);
    assert.deepEqual(session.renderer.calls, [['play', 'b.mp4']]);
    assert.equal(session.getState().current.title, 'b.mp4');
  } finally { release.resolve(); await session.close(); }
});

it('seek controls clamp to the file bounds and keep paused playback paused', async () => {
  const session = createTestSession();
  try {
    await session.addFiles(['/a.mp4']);
    await session.pause();
    await session.seek(200);
    assert.equal(session.getState().current.positionSeconds, 99);
    await session.seekBy(-500);
    assert.equal(session.getState().current.positionSeconds, 0);
    assert.equal(session.getState().status, 'paused');
    assert.equal(session.getState().transportState, 'PAUSED_PLAYBACK');
    assert.deepEqual(session.renderer.calls, [['play', 'a.mp4'], ['pause'], ['seek', 99], ['seek', 0]]);
  } finally { await session.close(); }
});

it('rapid skip requests accumulate instead of all using the same starting position', async () => {
  const session = createTestSession();
  try {
    await session.addFiles(['/a.mp4']);
    await Promise.all([session.seekBy(30), session.seekBy(30), session.seekBy(30)]);
    assert.equal(session.getState().current.positionSeconds, 90);
    assert.deepEqual(session.renderer.calls.filter(([action]) => action === 'seek'), [['seek', 30], ['seek', 60], ['seek', 90]]);
  } finally { await session.close(); }
});

it('rejects invalid seek times without sending them to the TV or changing playback position', async () => {
  const session = createTestSession();
  try {
    await session.addFiles(['/a.mp4']);
    await session.tick();
    for (const seconds of [NaN, Infinity, -Infinity, '30', undefined, null]) {
      await assert.rejects(session.seek(seconds), /valid playback time/);
      await assert.rejects(session.seekBy(seconds), /valid playback time/);
    }
    assert.equal(session.getState().current.positionSeconds, 12);
    assert.equal(session.renderer.calls.filter(([action]) => action === 'seek').length, 0);
  } finally { await session.close(); }
});

it('a failed seek leaves the acknowledged position and bookmark unchanged', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const session = createTestSession(mockRenderer(), { history });
    try {
      await session.addFiles(['/a.mp4']);
      session.renderer.positionSeconds = 42;
      await session.tick();
      session.renderer.seek = async () => { throw new Error('UPnP 710'); };
      await assert.rejects(session.seekBy(30), /could not skip.*UPnP 710/);
      assert.equal(session.getState().current.positionSeconds, 42);
      assert.equal(history.get('/a.mp4'), 42);
      assert.match(session.getState().error, /could not skip/);
    } finally { await session.close(); }
  });
});

it('does not apply a queued seek to a newly opened file', async () => {
  const entered = deferred();
  const release = deferred();
  const renderer = mockRenderer();
  renderer.pause = async function () { entered.resolve(); await release.promise; this.state = 'PAUSED_PLAYBACK'; };
  const session = createTestSession(renderer);
  try {
    await session.addFiles(['/a.mp4']);
    const pausing = session.pause();
    await entered.promise;
    const seeking = session.seekBy(30);
    const replacing = session.playOnly(['/b.mp4']);
    release.resolve();
    await Promise.all([pausing, seeking, replacing]);
    assert.equal(session.getState().current.title, 'b.mp4');
    assert.equal(session.getState().current.positionSeconds, 0);
    assert.equal(renderer.calls.filter(([action]) => action === 'seek').length, 0);
  } finally { release.resolve(); await session.close(); }
});

it('keeps playing and advances in software when the TV refuses its optional native queue', async () => {
  const renderer = mockRenderer();
  renderer.setNext = async () => { throw new Error('SetNext not supported'); };
  const session = createTestSession(renderer);
  try {
    await session.addFiles(['/a.mp4', '/b.mp4']);
    assert.equal(session.getState().status, 'playing');
    assert.equal(session.getState().error, null);
    renderer.positionSeconds = 97;
    await session.tick();
    renderer.state = 'STOPPED';
    await session.tick();
    assert.equal(session.getState().current.title, 'b.mp4');
    assert.equal(session.getState().status, 'playing');
  } finally { await session.close(); }
});

function longMedia(path) {
  return { filePath: path, title: path.split('/').at(-1), durationSeconds: 600 };
}

it('native advancement starts the next file at zero without inheriting the previous file position', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const renderer = mockRenderer();
    const session = createTestSession(renderer, { history, prepareMedia: longMedia });
    try {
      await session.addFiles(['/a.mp4', '/b.mp4']);
      renderer.positionSeconds = 595;
      await session.tick();
      renderer.uri = 'http://host/b.mp4';
      renderer.positionSeconds = 0;
      await session.tick();
      assert.equal(session.getState().current.title, 'b.mp4');
      assert.equal(session.getState().current.positionSeconds, 0);
      assert.equal(history.list().find(entry => entry.path === '/a.mp4').completed, true);
      const next = history.list().find(entry => entry.path === '/b.mp4');
      assert.equal(next.positionSeconds, 0);
      assert.equal(next.completed, false);
    } finally { await session.close(); }
  });
});

it('ignores stale nonzero TV reports after seeking until the TV acknowledges the new position', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const renderer = mockRenderer();
    const session = createTestSession(renderer, { history, prepareMedia: longMedia });
    try {
      await session.addFiles(['/a.mp4']);
      renderer.positionSeconds = 10;
      await session.tick();
      await session.seek(300);
      renderer.positionSeconds = 12;
      await session.tick();
      assert.equal(session.getState().current.positionSeconds, 300);
      assert.equal(history.get('/a.mp4'), 300);
      renderer.positionSeconds = 302;
      await session.tick();
      assert.equal(session.getState().current.positionSeconds, 302);
      renderer.positionSeconds = 350;
      await session.tick();
      assert.equal(session.getState().current.positionSeconds, 350);
      assert.equal(history.get('/a.mp4'), 350);
    } finally { await session.close(); }
  });
});

it('keeps a saved file bookmark when failed resume plays earlier positions from the beginning', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/a.mp4', { positionSeconds: 72, durationSeconds: 100 });
    await history.flush();
    const renderer = mockRenderer();
    renderer.seek = async () => { throw new Error('UPnP 710'); };
    const session = createTestSession(renderer, { history });
    try {
      await session.playOnly(['/a.mp4']);
      assert.match(session.getState().error, /saved place is kept/);
      renderer.positionSeconds = 12;
      await session.tick();
      assert.equal(session.getState().current.positionSeconds, 12);
      assert.equal(history.get('/a.mp4'), 72);
      await session.stop();
      assert.equal((await loadPlaybackHistory(path)).get('/a.mp4'), 72);
    } finally { await session.close(); }
  });
});

it('refreshes current progress on Stop when preparing another file has blocked polling', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const began = deferred();
    const release = deferred();
    const renderer = mockRenderer();
    const session = createTestSession(renderer, { history,
      prepareMedia: async (filePath, config, { signal }) => {
        if (filePath === '/b.mp4') {
          began.resolve();
          await Promise.race([release.promise, new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          })]);
        }
        return longMedia(filePath);
      },
    });
    try {
      await session.addFiles(['/a.mp4']);
      renderer.positionSeconds = 10;
      await session.tick();
      const adding = session.addFiles(['/b.mp4']);
      await began.promise;
      renderer.positionSeconds = 300;
      await Promise.all([adding, session.stop()]);
      assert.equal((await loadPlaybackHistory(path)).get('/a.mp4'), 300);
      assert.equal(history.list().some(entry => entry.path === '/b.mp4'), false);
      assert.equal(session.getState().status, 'idle');
      assert.deepEqual(renderer.calls.filter(([action]) => action === 'play'), [['play', 'a.mp4']]);
    } finally { release.resolve(); await session.close(); }
  });
});

it('bounds the final position read so an unresponsive TV cannot hold Stop indefinitely', async () => {
  const began = deferred();
  const release = deferred();
  const renderer = mockRenderer();
  const session = createTestSession(renderer);
  let timeout;
  try {
    await session.addFiles(['/a.mp4']);
    await session.tick();
    renderer.positionInfo = async () => { began.resolve(); return release.promise; };
    const stopping = session.stop();
    await began.promise;
    await Promise.race([stopping, new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Stop remained blocked by its final position read')), 2000);
    })]);
    assert.equal(session.getState().status, 'idle');
    assert.ok(renderer.calls.some(([action]) => action === 'stop'));
  } finally { clearTimeout(timeout); release.resolve({ uri: '', positionSeconds: 0 }); await session.close(); }
});

it('exposes embedded chapters and persists scene points while protecting the expected video', async () => {
  await withSavedHistory(async path => {
    const chapters = [{ title: 'Opening', startSeconds: 0 }, { title: 'The chase', startSeconds: 45 }];
    const history = await loadPlaybackHistory(path);
    const renderer = mockRenderer();
    const session = createTestSession(renderer, { history,
      prepareMedia: async filePath => ({ ...longMedia(filePath), chapters }),
    });
    try {
      await assert.rejects(session.addPoint('Opening', '/a.mp4'), /Open the video/);
      await session.addFiles(['/a.mp4']);
      assert.deepEqual(session.getState().current.chapters, chapters);
      assert.deepEqual(session.getState().current.points, []);
      renderer.positionSeconds = 42;
      const state = await session.addPoint('Favourite moment', '/a.mp4');
      assert.equal(state.current.points.length, 1);
      const point = state.current.points[0];
      assert.equal(point.title, 'Favourite moment');
      assert.equal(point.positionSeconds, 42);
      assert.deepEqual((await loadPlaybackHistory(path)).getPoints('/a.mp4'), [point]);
      await assert.rejects(session.addPoint('Wrong video', '/b.mp4'), /Open the video/);
      await session.removePoint(point.id, '/b.mp4');
      assert.deepEqual(history.getPoints('/a.mp4'), [point]);
      const removed = await session.removePoint(point.id, '/a.mp4');
      assert.deepEqual(removed.current.points, []);
      assert.deepEqual((await loadPlaybackHistory(path)).getPoints('/a.mp4'), []);
      assert.deepEqual(removed.current.chapters, chapters);
    } finally { await session.close(); }
  });
});

it('a seek queued while Next is starting another file cannot apply the old file target to it', async () => {
  const began = deferred();
  const release = deferred();
  const renderer = mockRenderer();
  const play = renderer.play;
  renderer.play = async function (item) {
    if (item.title === 'b.mp4') { began.resolve(); await release.promise; }
    await play.call(this, item);
  };
  const session = createTestSession(renderer, { prepareMedia: longMedia });
  try {
    await session.addFiles(['/a.mp4', '/b.mp4']);
    renderer.positionSeconds = 100;
    await session.tick();
    const next = session.playNext();
    await began.promise;
    const seek = session.seek(300);
    const skip = session.seekBy(30);
    release.resolve();
    await Promise.all([next, seek, skip]);
    assert.equal(session.getState().current.title, 'b.mp4');
    assert.equal(session.getState().current.positionSeconds, 0);
    assert.equal(renderer.calls.filter(([action]) => action === 'seek').length, 0);
  } finally { release.resolve(); await session.close(); }
});

it('ignores seek requests for a different expected path and accepts matching or omitted paths', async () => {
  const session = createTestSession();
  try {
    await session.addFiles(['/a.mp4']);
    await session.seek(30, '/a.mp4');
    await session.seek(80, '/b.mp4');
    await session.seekBy(30, '/b.mp4');
    assert.equal(session.getState().current.positionSeconds, 30);
    assert.deepEqual(session.renderer.calls.filter(([action]) => action === 'seek'), [['seek', 30]]);
    await session.seekBy(15, '/a.mp4');
    await session.seek(60);
    assert.equal(session.getState().current.positionSeconds, 60);
    assert.deepEqual(session.renderer.calls.filter(([action]) => action === 'seek'), [['seek', 30], ['seek', 45], ['seek', 60]]);
  } finally { await session.close(); }
});

it('survives two transient empty stopped reports immediately after restoring a saved place', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    history.set('/a.mp4', { positionSeconds: 72, durationSeconds: 100 });
    const renderer = mockRenderer();
    const session = createTestSession(renderer, { history });
    try {
      await session.playOnly(['/a.mp4']);
      const url = session.getState().current.url;
      renderer.uri = '';
      renderer.positionSeconds = 0;
      renderer.state = 'STOPPED';
      for (let poll = 0; poll < 2; poll++) {
        await session.tick();
        assert.equal(session.getState().current.path, '/a.mp4');
        assert.equal(session.getState().current.positionSeconds, 72);
        assert.equal(history.get('/a.mp4'), 72);
      }
      renderer.uri = url;
      renderer.state = 'PLAYING';
      renderer.positionSeconds = 73;
      await session.tick();
      assert.equal(session.getState().status, 'playing');
      assert.equal(session.getState().current.positionSeconds, 73);
      assert.equal(history.get('/a.mp4'), 73);
      assert.equal(renderer.calls.filter(([action]) => action === 'stop').length, 0);
    } finally { await session.close(); }
  });
});

it('does not auto-advance an unknown-duration file when an early remote Stop cannot prove completion', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const renderer = mockRenderer();
    renderer.durationSeconds = 0;
    const session = createTestSession(renderer, { history,
      prepareMedia: async filePath => ({ filePath, title: filePath.slice(1), durationSeconds: 0 }),
    });
    try {
      await session.addFiles(['/a.mp4', '/b.mp4']);
      renderer.positionSeconds = 12;
      await session.tick();
      renderer.state = 'STOPPED';
      renderer.uri = '';
      renderer.positionSeconds = 0;
      await session.tick();
      assert.equal(session.getState().status, 'idle');
      assert.equal(session.getState().current, null);
      assert.deepEqual(renderer.calls.filter(([action]) => action === 'play'), [['play', 'a.mp4']]);
      assert.equal(history.get('/a.mp4'), 12);
      assert.equal(history.list()[0].completed, false);
      assert.equal(history.list().some(entry => entry.path === '/b.mp4'), false);
    } finally { await session.close(); }
  });
});

it('does not record accepted playback that never starts or alter its existing saved history', async () => {
  await withSavedHistory(async path => {
    const history = await loadPlaybackHistory(path);
    const renderer = mockRenderer();
    renderer.play = async function (item) {
      this.calls.push(['play', item.title]);
      this.state = 'STOPPED'; this.uri = ''; this.positionSeconds = 0;
    };
    renderer.seek = async function (seconds) { this.calls.push(['seek', seconds]); };
    const session = createTestSession(renderer, { history });
    try {
      await session.playOnly(['/a.mp4']);
      for (let poll = 0; poll < 3; poll++) await session.tick();
      assert.equal(session.getState().status, 'idle');
      assert.equal(session.getState().current, null);
      assert.deepEqual(history.list(), []);
      assert.deepEqual((await loadPlaybackHistory(path)).list(), []);

      history.set('/a.mp4', { title: 'Previously watched title', positionSeconds: 72, durationSeconds: 100 });
      history.addPoint('/a.mp4', { title: 'Favourite moment', positionSeconds: 42 });
      await history.flush();
      const previous = history.list();
      await session.playOnly(['/a.mp4']);
      for (let poll = 0; poll < 3; poll++) await session.tick();
      assert.equal(session.getState().status, 'idle');
      assert.equal(session.getState().current, null);
      assert.deepEqual(history.list(), previous);
      assert.deepEqual((await loadPlaybackHistory(path)).list(), previous);
    } finally { await session.close(); }
  });
});


it('ignores the previous URI while a replacement or queued Next is still loading', async () => {
  const renderer = mockRenderer();
  const session = createTestSession(renderer);
  try {
    await session.addFiles(['/a.mp4', '/b.mp4']);
    await session.tick();
    const oldUri = renderer.uri;
    await session.playNext();
    const nextUri = renderer.uri;
    renderer.uri = oldUri;
    await session.tick();
    assert.equal(session.getState().current.path, '/b.mp4');
    renderer.uri = nextUri;
    await session.tick();
    await session.playOnly(['/c.mp4']);
    const replacementUri = renderer.uri;
    renderer.uri = nextUri;
    await session.tick();
    assert.equal(session.getState().current.path, '/c.mp4');
    renderer.uri = replacementUri;
    await session.tick();
    assert.equal(session.getState().current.path, '/c.mp4');
  } finally { await session.close(); }
});

it('saves watch history at most every 15 seconds during steady playback but at once on pause and stop', async () => {
  let clock = 1_000_000;
  const flushes = [];
  const history = { entries: new Map(), get: () => 0, list: () => [], getPoints: () => [],
    set(path, data) { this.entries.set(path, data); }, async flush() { flushes.push(clock); } };
  const session = createTestSession(mockRenderer(), { history, now: () => clock });
  try {
    await session.playOnly(['/videos/Luxo.mp4']);
    const afterStart = flushes.length;
    for (let i = 0; i < 5; i++) { clock += 2000; session.renderer.positionSeconds = 12 + i * 2; await session.tick(); }
    assert.equal(flushes.length, afterStart + 1, 'only the first steady tick saves within 15 seconds');
    clock += 16_000; await session.tick();
    assert.equal(flushes.length, afterStart + 2, 'a steady tick saves again once 15 seconds pass');
    clock += 1000; session.renderer.state = 'PAUSED_PLAYBACK'; await session.tick();
    assert.equal(flushes.length, afterStart + 3, 'a change to paused saves immediately');
    clock += 1000; await session.stop();
    assert.equal(flushes.length, afterStart + 4, 'stop saves immediately');
  } finally { await session.close(); }
});
