import { expandPaths as expandPathsDefault, normalizeUri } from './paths.js';

// A file that stopped within this many seconds of its end finished on its own.
const END_SLACK_SECONDS = 10;

export function createSession({ config, prepareMedia, createServer, createRenderer,
  expandPaths = expandPathsDefault, fs, pollMs = 2000 } = {}) {
  let server, renderer, timer;
  let items = [];
  let currentIndex = -1;
  let armedIndex = -1;
  let started = false;
  let closed = false;
  let generation = 0;
  let status = 'idle';
  let error = null;
  let position = { positionSeconds: 0, durationSeconds: 0, uri: '' };
  let transportState = 'NO_MEDIA_PRESENT';
  let operations = Promise.resolve();
  let polling = false;
  const listeners = new Set();

  function serialize(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
  }
  function getState() {
    const current = started ? items[currentIndex] : null;
    return {
      status, error, tvHost: config?.tvHost ?? '', transportState,
      current: current ? { title: current.title, url: current.url,
        positionSeconds: position.positionSeconds || 0,
        durationSeconds: current.durationSeconds || position.durationSeconds || 0 } : null,
      upcoming: items.slice(current ? currentIndex + 1 : 0).map(({ title }) => ({ title })),
      count: items.length,
    };
  }
  function emit() { for (const listener of listeners) listener(getState()); }
  async function ensure() {
    if (closed) throw new Error('This TV session is closed.');
    if (!config?.avTransportUrl) throw new Error('Choose a TV in Settings before sending a video.');
    if (!server) {
      const candidate = createServer({ host: config.bindHost });
      await candidate.listen();
      server = candidate;
    }
    if (!renderer) renderer = createRenderer({ avTransportUrl: config.avTransportUrl });
  }
  async function dispose(media) {
    await Promise.allSettled(media.map((item) => item.cleanup?.()));
  }
  async function clearQueue() {
    const previous = items;
    items = [];
    started = false;
    currentIndex = -1;
    armedIndex = -1;
    position = { positionSeconds: 0, durationSeconds: 0, uri: '' };
    server?.clear?.();
    await dispose(previous);
  }
  async function playAt(index) {
    await renderer.play(items[index]);
    currentIndex = index;
    started = true;
    armedIndex = -1;
    transportState = 'PLAYING';
    position = { positionSeconds: 0, durationSeconds: items[index].durationSeconds || 0, uri: items[index].url };
  }
  async function armNext() {
    const following = currentIndex + 1;
    if (following < items.length && armedIndex !== following) {
      await renderer.setNext(items[following]);
      armedIndex = following;
    }
  }
  function addFiles(paths) {
    const requestedGeneration = generation;
    return serialize(async () => {
      if (closed) throw new Error('This TV session is closed.');
      if (requestedGeneration !== generation) return getState();
      const prepared = [];
      let appended = false;
      error = null;
      status = 'preparing';
      emit();
      try {
        const files = fs ? await expandPaths(paths, fs) : paths.filter(Boolean);
        if (!files.length) throw new Error('No video files in that drop.');
        await ensure();
        for (const path of files) {
          prepared.push(await prepareMedia(path, config, { log: () => {} }));
          if (requestedGeneration !== generation || closed) {
            await dispose(prepared);
            return getState();
          }
        }
        items.push(...prepared.map((media) => ({ ...media, ...server.serveFile(media) })));
        appended = true;
        if (!started) await playAt(0);
        await armNext();
        status = transportState === 'PAUSED_PLAYBACK' ? 'paused' : 'playing';
        emit();
        return getState();
      } catch (err) {
        if (!appended) await dispose(prepared);
        if (!started) await clearQueue();
        error = err.message;
        status = started ? (transportState === 'PAUSED_PLAYBACK' ? 'paused' : 'playing') : 'idle';
        emit();
        throw err;
      }
    });
  }
  function tick() {
    return serialize(async () => {
      if (!renderer || !started || closed) return getState();
      try {
        const [transport, pos] = await Promise.all([renderer.transportInfo(), renderer.positionInfo()]);
        const previous = position;
        transportState = transport.state;
        position = pos;
        const reportedIndex = items.findIndex((item) => normalizeUri(item.url) === normalizeUri(pos.uri));
        if (reportedIndex >= 0) currentIndex = reportedIndex;
        const stopped = transportState === 'STOPPED' || transportState === 'NO_MEDIA_PRESENT';
        if (stopped) {
          // A stop well before the end is the remote or another controller, not the
          // file finishing: relinquish the queue instead of starting the next file.
          const duration = items[currentIndex]?.durationSeconds || previous.durationSeconds || 0;
          const interrupted = previous.positionSeconds > 0 && duration > 0 && previous.positionSeconds < duration - END_SLACK_SECONDS;
          if (interrupted) {
            await clearQueue();
            status = 'idle';
          } else if (currentIndex + 1 < items.length) {
            await playAt(currentIndex + 1);
            await armNext();
            status = 'playing';
          } else {
            await clearQueue();
            status = 'idle';
          }
        } else if (reportedIndex < 0 && pos.uri) {
          // Another controller has taken over. Relinquish our queued files.
          await clearQueue();
          status = 'idle';
        } else {
          await armNext();
          status = transportState === 'PAUSED_PLAYBACK' ? 'paused' : 'playing';
        }
        error = null;
      } catch (err) { error = err.message; }
      emit();
      return getState();
    });
  }
  function pause() {
    return serialize(async () => {
      if (!renderer || !started || closed) return getState();
      await renderer.pause();
      transportState = 'PAUSED_PLAYBACK'; status = 'paused'; emit();
      return getState();
    });
  }
  function resume() {
    return serialize(async () => {
      if (!renderer || !started || closed) return getState();
      await renderer.resume();
      transportState = 'PLAYING'; status = 'playing'; emit();
      return getState();
    });
  }
  function stop() {
    generation += 1;
    return serialize(async () => {
      if (renderer && started) { try { await renderer.stop(); } catch {} }
      await clearQueue();
      transportState = 'STOPPED'; status = 'idle'; error = null; emit();
      return getState();
    });
  }
  function onChange(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); }
  if (pollMs > 0) {
    timer = setInterval(() => {
      if (polling || closed) return;
      polling = true;
      tick().catch(() => {}).finally(() => { polling = false; });
    }, pollMs);
    timer.unref?.();
  }
  function close() {
    closed = true;
    generation += 1;
    clearInterval(timer);
    return serialize(async () => {
      if (renderer && started) { try { await renderer.stop(); } catch {} }
      await clearQueue();
      if (server) { await server.close(); server = null; }
      status = 'idle'; transportState = 'STOPPED'; emit();
      listeners.clear();
    });
  }
  return { addFiles, tick, pause, resume, stop, getState, onChange, close };
}
