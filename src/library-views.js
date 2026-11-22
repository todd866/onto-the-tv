// /api/library and /api/shows off the request path. Building either view walks the whole catalogue, and on the
// M2 one request blocked the event loop for 15 s (every TV stalled with it). Here the views are built in a
// worker thread that holds the catalogue, and each answer is kept as JSON per audience until the catalogue or
// the watch history changes (or ten minutes pass, since "continue watching" ages). Concurrent requests for the
// same view share one build.
import { Worker } from 'node:worker_threads';
import { libraryView, showsView, audienceKey } from './tv-library-api.js';

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;

/** A cheap fingerprint of a history list sorted newest first: any set() moves an entry to the front. */
export function historySignature(list) {
  if (!Array.isArray(list) || !list.length) return '0';
  const top = list[0] || {};
  return `${list.length}|${top.path}|${top.updatedAt}|${top.positionSeconds}|${top.completed === true}`;
}

const VIEWS = { library: libraryView, shows: showsView };

function inlineBuilder() {
  let videos = [];
  return {
    setVideos(list) { videos = list; },
    async build(kind, viewers, rating, history, now) { return JSON.stringify(VIEWS[kind]({ videos, history, viewers, rating, now })); },
    close() {},
  };
}

function workerBuilder(log) {
  let worker = null, broken = false, videos = [], posted = null, next = 1;
  const pending = new Map();
  const fallback = inlineBuilder();
  function fail(error) {
    if (!broken) log(`library views: worker unavailable, building inline (${error?.message || error})`);
    broken = true;
    for (const { reject } of pending.values()) reject(error instanceof Error ? error : new Error(String(error)));
    pending.clear();
    worker = null;
  }
  function ensure() {
    if (broken) return null;
    if (worker) return worker;
    try {
      worker = new Worker(new URL('./library-views-worker.js', import.meta.url));
      worker.unref();
      worker.on('message', message => {
        const job = pending.get(message.id);
        if (!job) return;
        pending.delete(message.id);
        if (message.error) job.reject(new Error(message.error)); else job.resolve(message.json);
      });
      worker.on('error', fail);
      worker.on('exit', code => { if (pending.size || code) fail(new Error(`worker exited ${code}`)); worker = null; posted = null; });
      posted = null;
      return worker;
    } catch (error) { fail(error); return null; }
  }
  return {
    setVideos(list) { videos = list; fallback.setVideos(list); },
    async build(kind, viewers, rating, history, now) {
      const live = ensure();
      if (!live) return fallback.build(kind, viewers, rating, history, now);
      if (posted !== videos) { live.postMessage({ type: 'videos', videos }); posted = videos; }
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        live.postMessage({ type: 'view', id, kind, viewers, rating, history, now });
      }).catch(error => (broken ? fallback.build(kind, viewers, rating, history, now) : Promise.reject(error)));
    },
    close() { worker?.terminate(); worker = null; },
  };
}

/**
 * createLibraryViews({ catalogue: () => videos, history: () => list }) → { json(kind, viewers, rating),
 * object(kind, viewers, rating), close() }. `viewers` is the raw query value (undefined = everyone).
 */
export function createLibraryViews({ catalogue, history, useWorker = true, now = Date.now, log = () => {} }) {
  const builder = useWorker ? workerBuilder(log) : inlineBuilder();
  const cache = new Map();
  let videosRef = null, generation = 0;

  function lookup(kind, viewers, rating) {
    const videos = catalogue();
    if (videos !== videosRef) { videosRef = videos; generation++; builder.setVideos(videos); cache.clear(); }
    const list = history();
    const key = `${kind}|${audienceKey(viewers, rating)}`;
    const stamp = `${generation}|${historySignature(list)}`;
    return { key, stamp, list };
  }

  async function json(kind, viewers, rating = null) {
    if (!VIEWS[kind]) throw new Error(`Unknown view ${kind}.`);
    const { key, stamp, list } = lookup(kind, viewers, rating);
    const held = cache.get(key);
    if (held && held.stamp === stamp && now() - held.at < TTL_MS) return held.promise;
    const at = now();
    const promise = builder.build(kind, viewers, rating, list, at);
    const entry = { stamp, at, promise, parsed: null };
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
    return promise;
  }

  async function object(kind, viewers, rating = null) {
    const text = await json(kind, viewers, rating);
    const entry = cache.get(`${kind}|${audienceKey(viewers, rating)}`);
    if (entry && entry.parsed && entry.parsed.text === text) return entry.parsed.value;
    const value = JSON.parse(text);
    if (entry) entry.parsed = { text, value };
    return value;
  }

  return { json, object, close: () => builder.close(), size: () => cache.size };
}
