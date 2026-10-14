import { expandPaths as expandPathsDefault, normalizeUri } from './paths.js';

const END_SLACK_SECONDS = 10;
// Steady playback only moves the position; save it this often, and everything else at once.
const HISTORY_SAVE_MS = 15_000;

export function createSession({ config, prepareMedia, createServer, createRenderer,
  expandPaths = expandPathsDefault, fs, history, pollMs = 2000, now = Date.now } = {}) {
  let server, renderer, timer, preparation;
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
  let startingPolls = 0;
  let seekGuard = null;
  let playbackConfirmed = false;
  let channelQueue = false;
  let transition = null;
  let retiredUri = '';
  let stoppedPolls = 0;
  let foreignTransitionPolls = 0;
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
      current: current ? { title: current.title, url: current.url, path: current.sourcePath || '',
        positionSeconds: position.positionSeconds || 0,
        durationSeconds: current.durationSeconds || position.durationSeconds || 0,
        chapters: current.chapters || [], points: history?.getPoints?.(current.sourcePath) || [],
        seekable: current.seekable !== false && typeof renderer?.seek === 'function' } : null,
      upcoming: items.slice(current ? currentIndex + 1 : 0).map(({ title, sourcePath }) => ({ title, path: sourcePath || '' })),
      history: history?.list() || [],
      count: items.length,
      ...(transition ? { transition } : {}),
    };
  }
  function emit() { for (const listener of listeners) listener(getState()); }
  function remember({ item = items[currentIndex], pos = position, completed = false, reset = false } = {}) {
    // Channel bookmarks belong to the channel's audience, not the file history.
    if (!item?.historyConfirmed || !history) return;
    if (reset) item.resumeFailedAt = 0;
    if (!completed && !reset && item.resumeFailedAt > pos.positionSeconds) return;
    history.set(item.sourcePath, { title: item.title, positionSeconds: pos.positionSeconds,
      durationSeconds: item.durationSeconds || pos.durationSeconds || 0, completed, reset });
  }
  let historySavedAt = -Infinity;
  async function flushHistory({ steady = false } = {}) {
    if (steady && now() - historySavedAt < HISTORY_SAVE_MS) return;
    historySavedAt = now();
    try { await history?.flush(); }
    catch (err) { error = `Could not save watch history: ${err.message}`; }
  }
  function cancelPending() { generation += 1; preparation?.abort(); }
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
  async function dispose(media) { await Promise.allSettled(media.map(item => item.cleanup?.())); }
  async function clearQueue() {
    const previous = items;
    items = []; started = false; currentIndex = -1; armedIndex = -1;
    channelQueue = false; transition = null; retiredUri = '';
    stoppedPolls = 0; foreignTransitionPolls = 0;
    seekGuard = null;
    position = { positionSeconds: 0, durationSeconds: 0, uri: '' };
    server?.clear?.();
    await dispose(previous);
  }
  function resumePosition(item) {
    return Number.isFinite(item.startSeconds) ? item.startSeconds : history?.get(item.sourcePath) || 0;
  }
  async function playAt(index, requestedGeneration = generation) {
    const item = items[index];
    await renderer.play(item);
    transition = null; stoppedPolls = 0; foreignTransitionPolls = 0;
    currentIndex = index; started = true; armedIndex = -1; startingPolls = 0;
    transportState = 'PLAYING'; playbackConfirmed = false; item.historyConfirmed = false;
    position = { positionSeconds: 0, durationSeconds: item.durationSeconds || 0, uri: item.url };
    if (closed || generation !== requestedGeneration) return;
    const start = resumePosition(item);
    if (start > 5 && renderer.seek && item.seekable !== false) {
      try {
        const target = clampSeek(start);
        await renderer.seek(target);
        position.positionSeconds = target;
        seekGuard = { target, until: Date.now() + 6000 };
      } catch {
        item.resumeFailedAt = start;
        error = 'The TV could not resume this file. Playing from the beginning; your saved place is kept.';
      }
    }
    // Do not replace a saved place with the initial zero while the TV is loading.
    remember();
  }
  async function armNext() {
    const following = currentIndex + 1;
    if (following < items.length && armedIndex !== following) {
      // The TV's native queue cannot restore a saved position. Let tick start it.
      if (resumePosition(items[following]) > 5) return;
      armedIndex = following;
      // Some Samsung renderers lack SetNext. Software advancement still works.
      try { await renderer.setNext(items[following]); } catch {}
    }
  }
  async function append(paths, requestedGeneration) {
    if (closed || requestedGeneration !== generation) return getState();
    const prepared = [];
    let appended = false;
    error = null; status = 'preparing'; emit();
    const controller = new AbortController();
    preparation = controller;
    try {
      const requested = paths.map(entry => (entry && typeof entry === 'object' ? entry : { path: entry }));
      const starts = new Map(requested.map(({ path, startSeconds }) => [path, startSeconds]));
      const files = fs ? await expandPaths(requested.map(({ path }) => path), fs) : requested.map(({ path }) => path).filter(Boolean);
      if (!files.length) throw new Error('No video files in that drop.');
      if (requestedGeneration !== generation || closed) return getState();
      await ensure();
      for (const path of files) {
        controller.signal.throwIfAborted();
        prepared.push({ ...await prepareMedia(path, config, { log: () => {}, signal: controller.signal }),
          sourcePath: path, startSeconds: starts.get(path), remember: !Number.isFinite(starts.get(path)) });
        if (requestedGeneration !== generation || closed) { await dispose(prepared); return getState(); }
      }
      items.push(...prepared.map(media => ({ ...media, ...server.serveFile(media) })));
      appended = true;
      if (!started) await playAt(0, requestedGeneration);
      if (requestedGeneration !== generation || closed) return getState();
      await armNext();
      status = transportState === 'PAUSED_PLAYBACK' ? 'paused' : 'playing';
      await flushHistory(); emit(); return getState();
    } catch (err) {
      if (!appended) await dispose(prepared);
      if (requestedGeneration !== generation || closed) return getState();
      if (!started) await clearQueue();
      error = err.message;
      status = started ? (transportState === 'PAUSED_PLAYBACK' ? 'paused' : 'playing') : 'idle';
      emit(); throw err;
    } finally { if (preparation === controller) preparation = null; }
  }
  function addFiles(paths) {
    const requestedGeneration = generation;
    return serialize(() => append(paths, requestedGeneration));
  }
  function queueNext(entry, expectedPath) {
    const requestedGeneration = generation;
    return serialize(async () => {
      if (closed || requestedGeneration !== generation || !started ||
          items[currentIndex]?.sourcePath !== expectedPath || currentIndex + 1 < items.length) return getState();
      channelQueue = true;
      return append([{ path: entry.path, startSeconds: 0 }], requestedGeneration);
    });
  }
  function departure(item, pos, nextItem, completed) {
    return { fromPath: item.sourcePath, toPath: nextItem.sourcePath,
      positionSeconds: pos.positionSeconds || 0,
      durationSeconds: item.durationSeconds || pos.durationSeconds || 0, completed };
  }
  function atEnd(item, pos) {
    const duration = item?.durationSeconds || pos.durationSeconds || 0;
    return duration > 0 && pos.positionSeconds >= Math.max(duration - END_SLACK_SECONDS, duration * .95);
  }
  async function pruneChannel() {
    if (!channelQueue || currentIndex <= 0) return;
    const consumed = items.splice(0, currentIndex);
    retiredUri = consumed.at(-1)?.url || '';
    armedIndex -= currentIndex;
    currentIndex = 0;
    for (const item of consumed) server?.revoke?.(item.url);
    await dispose(consumed);
  }
  function tick() {
    const requestedGeneration = generation;
    return serialize(async () => {
      if (!renderer || !started || closed || requestedGeneration !== generation) return getState();
      try {
        const [transport, pos] = await Promise.all([renderer.transportInfo(), renderer.positionInfo()]);
        if (closed || requestedGeneration !== generation) return getState();
        const previous = position;
        const previousItem = items[currentIndex];
        const before = { status, index: currentIndex, confirmed: Boolean(previousItem?.historyConfirmed) };
        const reportedIndex = pos.uri ? items.findIndex(item => normalizeUri(item.url) === normalizeUri(pos.uri)) : -1;
        // A delayed response for the episode just consumed is not a new owner.
        if (retiredUri && pos.uri && normalizeUri(pos.uri) === normalizeUri(retiredUri) && !['STOPPED', 'NO_MEDIA_PRESENT'].includes(transport.state)) return getState();
        // SetURI/Play can complete before GetPositionInfo switches away from
        // the previous file. Do not mistake those first stale reports for a
        // native queue transition or another controller taking over.
        if (!playbackConfirmed && reportedIndex !== currentIndex && pos.uri && ++startingPolls <= 2) return getState();
        const stopped = transport.state === 'STOPPED' || transport.state === 'NO_MEDIA_PRESENT';
        if (!stopped) stoppedPolls = 0;
        transportState = transport.state;
        if (reportedIndex < 0 && pos.uri) {
          if (transport.state === 'TRANSITIONING' && ++foreignTransitionPolls < 2) return getState();
          remember(); await clearQueue(); status = 'idle';
        } else if (stopped) {
          // Samsung may clear URI/time on Stop. Only advance with evidence of an end.
          const best = reportedIndex === currentIndex && acceptPosition(pos) ? pos : previous;
          const duration = previousItem?.durationSeconds || best.durationSeconds || 0;
          const completed = (playbackConfirmed || (reportedIndex === currentIndex && pos.positionSeconds > 0 && acceptPosition(pos))) && duration > 0 && best.positionSeconds >= Math.max(duration - END_SLACK_SECONDS, duration * .95);
          if (!playbackConfirmed && !completed && ++startingPolls <= 2) return getState();
          // Samsung can briefly retain a URI while stopped between tracks or
          // while buffering. Keep serving it until a second poll confirms Stop.
          if (!completed && reportedIndex >= 0 && ++stoppedPolls < 2) return getState();
          if (reportedIndex === currentIndex && pos.positionSeconds > 0 && acceptPosition(pos)) previousItem.historyConfirmed = true;
          remember({ pos: best, completed });
          if (completed && currentIndex + 1 < items.length) {
            const moved = departure(previousItem, best, items[currentIndex + 1], true);
            await playAt(currentIndex + 1, requestedGeneration);
            if (requestedGeneration !== generation || closed) return getState();
            transition = moved;
            await pruneChannel();
            await armNext(); status = 'playing';
          } else { await clearQueue(); status = completed ? 'finished' : 'idle'; }
        } else {
          foreignTransitionPolls = 0;
          if (reportedIndex >= 0 && ['PLAYING', 'PAUSED_PLAYBACK'].includes(transportState)) {
            playbackConfirmed = true; items[reportedIndex].historyConfirmed = true;
          }
          if (reportedIndex >= 0 && reportedIndex !== currentIndex) {
            remember({ item: previousItem, pos: previous, completed: previousItem.durationSeconds > 0 && previous.positionSeconds >= Math.max(previousItem.durationSeconds - END_SLACK_SECONDS, previousItem.durationSeconds * .95) });
            currentIndex = reportedIndex;
            position = pos; seekGuard = null;
            transition = departure(previousItem, previous, items[currentIndex], atEnd(previousItem, previous));
          }
          // A transient empty/zero response must not erase an acknowledged seek.
          if (reportedIndex === currentIndex && acceptPosition(pos)) position = pos;
          remember(); await pruneChannel(); await armNext();
          status = transportState === 'PAUSED_PLAYBACK' ? 'paused' : 'playing';
        }
        await flushHistory({ steady: status === before.status && currentIndex === before.index &&
          items[currentIndex] === previousItem && before.confirmed });
      } catch (err) { error = err.message; }
      emit(); return getState();
    });
  }
  function playNext() {
    const requestedGeneration = generation;
    return serialize(async () => {
      if (!renderer || !started || closed || requestedGeneration !== generation) return getState();
      if (currentIndex + 1 >= items.length) return getState();
      remember(); error = null;
      const moved = departure(items[currentIndex], position, items[currentIndex + 1], atEnd(items[currentIndex], position));
      await playAt(currentIndex + 1, requestedGeneration);
      if (requestedGeneration !== generation || closed) return getState();
      transition = moved;
      await pruneChannel();
      await armNext(); status = 'playing'; await flushHistory(); emit(); return getState();
    });
  }
  function acceptPosition(pos) {
    if (!Number.isFinite(pos.positionSeconds) || pos.positionSeconds < 0) return false;
    if (seekGuard) {
      if (Math.abs(pos.positionSeconds - seekGuard.target) <= 5 || Date.now() >= seekGuard.until) seekGuard = null;
      else return false;
    }
    return pos.positionSeconds > 0 || !position.positionSeconds;
  }
  async function refreshPosition() {
    if (!started || !renderer?.positionInfo) return;
    let deadline;
    try {
      // Preparation may have blocked polling. Bound the final read so an offline
      // TV cannot keep Stop or app shutdown waiting for a full SOAP timeout.
      const pos = await Promise.race([renderer.positionInfo(), new Promise(resolve => {
        deadline = setTimeout(() => resolve(null), 750);
      })]);
      if (pos?.uri && normalizeUri(pos.uri) === normalizeUri(items[currentIndex]?.url) && acceptPosition(pos)) {
        position = pos;
        if (pos.positionSeconds > 0) items[currentIndex].historyConfirmed = true;
      }
    } catch {} finally { clearTimeout(deadline); }
  }
  async function endPlayback() {
    await refreshPosition();
    remember();
    if (renderer && started) { try { await renderer.stop(); } catch (err) { error = `The TV did not confirm Stop: ${err.message}`; } }
    await clearQueue();
    transportState = 'STOPPED'; status = 'idle';
    await flushHistory();
  }
  function playOnly(paths) {
    cancelPending();
    const requestedGeneration = generation;
    return serialize(async () => {
      if (closed || requestedGeneration !== generation) return getState();
      error = null;
      await endPlayback();
      // Keep replacement and preparation in one operation. A later Open/Stop wins.
      return append(paths, requestedGeneration);
    });
  }
  function control(action, state, nextStatus) {
    const requestedGeneration = generation;
    return serialize(async () => {
      if (!renderer || !started || closed || requestedGeneration !== generation) return getState();
      await renderer[action]();
      transportState = state; status = nextStatus; remember(); await flushHistory(); emit(); return getState();
    });
  }
  function clampSeek(seconds) {
    const duration = items[currentIndex]?.durationSeconds || position.durationSeconds || 0;
    return Math.round(Math.max(0, Math.min(seconds, duration > 0 ? Math.max(0, duration - 1) : 12 * 3600)));
  }
  function seek(seconds, relative = false, expectedPath) {
    const requestedGeneration = generation;
    const requestedItem = items[currentIndex];
    return serialize(async () => {
      if (!Number.isFinite(seconds)) throw new Error('Choose a valid playback time.');
      if (!renderer || !started || closed || requestedGeneration !== generation) return getState();
      if (requestedItem !== items[currentIndex] || (expectedPath && expectedPath !== items[currentIndex]?.sourcePath)) return getState();
      if (!renderer.seek || items[currentIndex].seekable === false) throw new Error('The TV cannot seek in this file.');
      const target = clampSeek(relative ? position.positionSeconds + seconds : seconds);
      try {
        await renderer.seek(target);
        position.positionSeconds = target;
        seekGuard = { target, until: Date.now() + 6000 };
        error = null; remember({ reset: true }); await flushHistory(); emit(); return getState();
      } catch (err) {
        error = `The TV could not skip to that time: ${err.message}`; emit(); throw new Error(error);
      }
    });
  }
  function addPoint(title, expectedPath) {
    const requestedGeneration = generation;
    return serialize(async () => {
      const current = items[currentIndex];
      if (!history || !started || closed || requestedGeneration !== generation || current?.sourcePath !== expectedPath) {
        throw new Error('Open the video before saving a scene point.');
      }
      await refreshPosition();
      current.historyConfirmed = true;
      remember();
      history.addPoint(current.sourcePath, { title, positionSeconds: position.positionSeconds });
      await history.flush(); emit(); return getState();
    });
  }
  function removePoint(id, expectedPath) {
    return serialize(async () => {
      if (!history || !started || items[currentIndex]?.sourcePath !== expectedPath) return getState();
      history.removePoint(expectedPath, id);
      await history.flush(); emit(); return getState();
    });
  }
  function stop() {
    cancelPending();
    return serialize(async () => { error = null; await endPlayback(); emit(); return getState(); });
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
    closed = true; cancelPending(); clearInterval(timer);
    return serialize(async () => {
      await endPlayback();
      if (server) { await server.close(); server = null; }
      emit(); listeners.clear();
    });
  }
  return { addFiles, queueNext, addPoint, removePoint, playNext, playOnly, tick, seek: (seconds, path) => seek(seconds, false, path), seekBy: (seconds, path) => seek(seconds, true, path),
    pause: () => control('pause', 'PAUSED_PLAYBACK', 'paused'),
    resume: () => control('resume', 'PLAYING', 'playing'), stop, getState, onChange, close };
}
