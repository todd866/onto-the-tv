import { execFile } from 'node:child_process';
import { access, chmod, mkdir, lstat, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

const execFileAsync = promisify(execFile);
const MAX_PENDING = 64;
const MAX_CACHED = 4000;
const WORKERS = 2;
const MAX_SEEK_SECONDS = 120;
const FRAME_FILTER = 'scale=640:360:force_original_aspect_ratio=increase,crop=640:360';

function validAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path.`);
  }
  return value;
}

function duration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function resultStdout(result) {
  return typeof result === 'string' ? result : result?.stdout;
}

async function safeUnlink(path) {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

/**
 * Remove the least recently used thumbnails beyond maxFiles. Keys include the
 * source's size and mtime, so replaced or edited videos otherwise leave orphans.
 */
export async function pruneArtwork(directory, { maxFiles = MAX_CACHED } = {}) {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const thumbnails = await Promise.all(names.filter(name => /^[0-9a-f]{64}\.jpg$/.test(name)).map(async name => {
    const path = join(directory, name);
    try { return { path, used: (await stat(path)).mtimeMs }; } catch { return null; }
  }));
  const stale = thumbnails.filter(Boolean).sort((a, b) => b.used - a.used).slice(maxFiles);
  for (const { path } of stale) await safeUnlink(path);
  return stale.length;
}

/**
 * Small, private thumbnail cache for the library tiles. The caller is expected
 * to validate that `path` belongs to its media inventory before calling get.
 * A failed thumbnail is deliberately not cached: a transient ffmpeg failure
 * can be retried on the next render.
 */
export function createArtworkCache({ directory, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', execute = execFileAsync } = {}) {
  validAbsolutePath(directory, 'Artwork directory');
  if (typeof ffmpeg !== 'string' || !ffmpeg || typeof ffprobe !== 'string' || !ffprobe) {
    throw new TypeError('ffmpeg and ffprobe must be command names.');
  }
  if (typeof execute !== 'function') throw new TypeError('execute must be a function.');

  let closed = false;
  let active = 0;
  const pending = [];
  const jobs = new Map();
  const pathJobs = new Map();
  const idleWaiters = [];
  const abortController = new AbortController();
  const counters = { requests: 0, hits: 0, generated: 0, failures: 0, saturated: 0 };
  let directoryReady;

  function ensureDirectory() {
    return directoryReady ||= mkdir(directory, { recursive: true, mode: 0o700 });
  }

  function snapshot() {
    return { ...counters, queued: pending.length, active };
  }

  function signalIdle() {
    if (active || pending.length) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function pump() {
    while (!closed && active < WORKERS && pending.length) {
      const job = pending.shift();
      active += 1;
      processJob(job).then(job.resolve, job.reject).finally(() => {
        active -= 1;
        jobs.delete(job.key);
        pump();
        signalIdle();
      });
    }
    signalIdle();
  }

  async function processJob({ source, output, seekSeconds }) {
    let temporary;
    try {
      await ensureDirectory();
      try {
        await access(output); counters.hits += 1;
        const touched = new Date();
        await utimes(output, touched, touched).catch(() => {});
        return output;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      let seek = seekSeconds;
      if (!seek) {
        try {
          const probe = await execute(ffprobe, [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', source,
          ], { signal: abortController.signal, windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10_000 });
          const seconds = duration(Number.parseFloat(resultStdout(probe) || ''));
          seek = Math.min(seconds * 0.1, MAX_SEEK_SECONDS);
        } catch { seek = 0; }
      }
      temporary = `${output}.${randomUUID()}.tmp`;
      await execute(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, seek)),
        '-i', source, '-frames:v', '1', '-vf', FRAME_FILTER, '-threads', '1',
        '-q:v', '3', '-f', 'image2', '-vcodec', 'mjpeg', '-y', temporary,
      ], { signal: abortController.signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
      await chmod(temporary, 0o600);
      await rename(temporary, output);
      temporary = undefined;
      counters.generated += 1;
      return output;
    } catch {
      counters.failures += 1;
      if (temporary) await safeUnlink(temporary);
      return null;
    }
  }

  async function get(source, { durationSeconds } = {}) {
    counters.requests += 1;
    validAbsolutePath(source, 'Artwork source');
    if (closed) return null;
    const existingPath = pathJobs.get(source);
    if (existingPath) return existingPath;
    const request = (async () => {
      let info;
      try { info = await lstat(source); } catch { counters.failures += 1; return null; }
      if (closed) return null;
      if (!info.isFile() || info.isSymbolicLink()) { counters.failures += 1; return null; }
      const key = createHash('sha256').update(`${source}\0${info.size}\0${info.mtimeMs}`).digest('hex');
      const output = join(directory, `${key}.jpg`);
      const knownDuration = duration(durationSeconds);
      const seekSeconds = knownDuration ? Math.min(knownDuration * 0.1, MAX_SEEK_SECONDS) : 0;
      const existing = jobs.get(key);
      if (existing) return existing;
      if (pending.length >= MAX_PENDING) { counters.saturated += 1; return null; }
      let resolveJob;
      let rejectJob;
      const promise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
      jobs.set(key, promise);
      pending.push({ key, source, output, seekSeconds, resolve: resolveJob, reject: rejectJob });
      pump();
      return promise;
    })();
    pathJobs.set(source, request);
    request.then(() => pathJobs.delete(source), () => pathJobs.delete(source));
    return request;
  }

  async function close() {
    closed = true;
    abortController.abort();
    while (pending.length) pending.shift().resolve(null);
    if (active || pending.length) await new Promise(resolve => idleWaiters.push(resolve));
  }

  return { get, stats: snapshot, close };
}
