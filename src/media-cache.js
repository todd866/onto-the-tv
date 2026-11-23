import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export async function createMediaCache({ directory, maxBytes = 20 * GiB,
  reserveBytes = 40 * GiB, blockBytes = 4 * MiB, eligible = file => file.startsWith('/Volumes/'),
  log = () => {}, statfs = path => fs.statfs(path), remote = null, openings = null }) {
  // openings (22 Nov 2026): { directory, seconds = 60, maxBytes = 40 GiB, reserveBytes = 0 }. A second store for
  // the first stretch of a title and its last block, written only by holdOpening and never touched by trim or
  // makeRoom. It is what lets a title start at once after its file has left the drive: the ordinary cache
  // protects only the few dozen titles about to play and evicts the rest. Measured for the 1,365 grown-up titles
  // (500 GB whole): 26 GB at 60 s each, 16 GB at 30 s. Same block format and identity as the ordinary cache.
  // remote (22 Nov 2026): async (file, start, length) => Buffer, asked only when the file is not on a drive
  // here. The owner: "local copies of enough to start a show, then backfill from the cloud". The blocks are the
  // same blocks under the same identity (path, size, mtime), so whatever was cached while the file was on the
  // drive, its opening above all, still plays after the file has gone. The caller must pass size and mtimeMs
  // for such a file, since there is nothing to stat. src/cloud-source.js is the reader for the Google copy.
  const root = directory;
  await fs.mkdir(root, { recursive: true });
  const inFlight = new Map();
  const active = new Set();
  const recent = new Map();
  const jobs = [];
  let running = 0;
  let writeQueue = Promise.resolve();
  const cacheIndex = new Map();
  let closed = false;
  let hits = 0, memoryHits = 0, misses = 0, bypasses = 0, remoteReads = 0;
  // Titles about to play (every card's pick and the one after, for every profile): their blocks are
  // never evicted to make room for something else. keep() replaces the whole list.
  let kept = new Set();

  const identity = (file, info) => `${file}\0${info.size}\0${info.mtimeMs}`;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const cachePath = (key, index) => join(root, `${digest(key)}-${index}.block`);
  const packed = data => Buffer.concat([createHash('sha256').update(data).digest(), data]);
  const unpack = (data, expected) => {
    if (data.length !== expected + 32) return null;
    const body = data.subarray(32);
    return createHash('sha256').update(body).digest().equals(data.subarray(0, 32)) ? body : null;
  };
  const openRoot = openings?.directory || null;
  const openSeconds = Math.max(1, Number(openings?.seconds) || 60);
  const openMax = Number.isFinite(openings?.maxBytes) ? openings.maxBytes : 40 * GiB;
  const openReserve = Number.isFinite(openings?.reserveBytes) ? openings.reserveBytes : 0;
  const openingIndex = new Map();       // path -> bytes on disk
  let openingBytes = 0, openingHits = 0;
  const openingPath = (key, index) => join(openRoot, `${digest(key)}-${index}.block`);
  if (openRoot) {
    await fs.mkdir(openRoot, { recursive: true });
    for (const entry of await fs.readdir(openRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.block')) continue;
      const path = join(openRoot, entry.name);
      try { const st = await fs.stat(path); openingIndex.set(path, st.size); openingBytes += st.size; } catch {}
    }
  }
  const dropOpening = async path => {
    openingBytes -= openingIndex.get(path) || 0;
    openingIndex.delete(path);
    await fs.unlink(path).catch(() => {});
  };
  const readOpening = async (key, index, expected) => {
    if (!openRoot) return null;
    const path = openingPath(key, index);
    if (!openingIndex.has(path)) return null;
    try {
      const data = unpack(await fs.readFile(path), expected);
      if (data) return data;
    } catch { /* gone or unreadable: treated as damaged */ }
    await dropOpening(path);
    return null;
  };
  const sourceInfo = async (file, info = {}) => {
    if (Number.isFinite(info.size) && Number.isFinite(info.mtimeMs)) return info;
    const st = await fs.stat(file);
    return { ...info, size: st.size, mtimeMs: st.mtimeMs };
  };
  const freeBytes = async () => {
    const st = await statfs(root);
    return Number(st.bavail ?? st.blocksAvailable ?? 0) * Number(st.bsize ?? st.blockSize ?? 1);
  };
  const cacheFiles = async () => {
    return [...cacheIndex.values()];
  };
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9]{64}-\d+\.block\.\d+\.\d+\.tmp$/.test(entry.name)) {
      const temporary = join(root, entry.name);
      const info = await fs.stat(temporary).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 3600000) await fs.unlink(temporary).catch(() => {});
    }
    if (!entry.isFile() || !entry.name.endsWith('.block')) continue;
    const path = join(root, entry.name);
    try { const st = await fs.stat(path); cacheIndex.set(path, { path, size: st.size, mtimeMs: st.mtimeMs }); } catch {}
  }
  // The cache never holds more than maxBytes, and gives way whenever the disk's free space falls under
  // reserveBytes: kept titles last, but they go too, since a full internal disk is worse than a slow start.
  const trim = async () => {
    await makeRoom(0);
    let free = await freeBytes().catch(() => Infinity);
    if (free >= reserveBytes) return;
    for (const file of (await cacheFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (free >= reserveBytes) break;
      if (active.has(file.path)) continue;
      try { await fs.unlink(file.path); cacheIndex.delete(file.path); free += file.size; } catch {}
    }
  };
  const makeRoom = async extra => {
    let files = await cacheFiles();
    let total = files.reduce((n, f) => n + f.size, 0);
    let free = await freeBytes().catch(() => 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total + extra <= maxBytes && free >= reserveBytes + extra) break;
      if (active.has(file.path)) continue;
      if (kept.size && kept.has(file.path.slice(file.path.lastIndexOf('/') + 1, -('.block'.length)).replace(/-\d+$/, ''))) continue;
      try { await fs.unlink(file.path); cacheIndex.delete(file.path); total -= file.size; free += file.size; } catch {}
    }
    return total + extra <= maxBytes && free >= reserveBytes + extra;
  };
  const persist = (path, data) => {
    const job = writeQueue.then(async () => {
      active.add(path);
      try {
        if (!(await makeRoom(data.length + 32))) return;
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        try { await fs.writeFile(tmp, packed(data), { flag: 'wx' });
          await fs.rename(tmp, path);
        } finally { await fs.unlink(tmp).catch(() => {}); }
        const st = await fs.stat(path); cacheIndex.set(path, { path, size: st.size, mtimeMs: st.mtimeMs });
      } finally { active.delete(path); }
    }).catch(error => log({ event: 'cache-write-bypass', error: error.code || error.name }));
    writeQueue = job.catch(() => {});
    return job;
  };
  const readSourceBlock = async (file, index, size) => {
    const start = index * blockBytes;
    const length = Math.min(blockBytes, size - start);
    let handle;
    try { handle = await fs.open(file, 'r'); }
    catch (error) {
      // Not on a drive here: the file lives only in the cloud copy, or its drive is away.
      if (!remote || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      const data = await remote(file, start, length);
      if (!Buffer.isBuffer(data) || data.length !== length) throw new Error('remote source returned the wrong amount of data');
      remoteReads++;
      return data;
    }
    try {
      const buffer = Buffer.alloc(length); let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (!bytesRead) throw new Error('source ended before requested block');
        offset += bytesRead;
      }
      return buffer;
    }
    finally { await handle.close(); }
  };
  const loadBlock = async (file, info, key, index) => {
    const path = cachePath(key, index);
    const expected = Math.min(blockBytes, info.size - index * blockBytes);
    if (expected <= 0) return Buffer.alloc(0);
    try {
      const data = unpack(await fs.readFile(path), expected);
      if (data) { hits++; await fs.utimes(path, new Date(), new Date()).catch(() => {}); const st = await fs.stat(path).catch(() => null); if (st) cacheIndex.set(path, { path, size: st.size, mtimeMs: st.mtimeMs }); return data; }
      await fs.unlink(path).catch(() => {}); cacheIndex.delete(path);
    } catch { cacheIndex.delete(path); }
    const held = await readOpening(key, index, expected);
    if (held) { openingHits++; return held; }
    misses++;
    const data = await readSourceBlock(file, index, info.size);
    if (data.length !== expected) return data;
    await persist(path, data);
    return data;
  };
  const pump = () => {
    while (!closed && running < 3 && jobs.length) {
      const position = jobs.findIndex(job => !job.background);
      const job = jobs.splice(position < 0 ? 0 : position, 1)[0];
      running++;
      loadBlock(job.file, job.info, job.key, job.index).then(job.resolve, job.reject).finally(() => { running--; pump(); });
    }
    while (closed && jobs.length) jobs.shift().reject(new Error('media cache closed'));
  };
  const getBlock = (file, info, key, index, { background = false } = {}) => {
    const token = `${key}:${index}`;
    if (recent.has(token)) { memoryHits++; return Promise.resolve(recent.get(token)); }
    if (!inFlight.has(token)) {
      const promise = new Promise((resolve, reject) => { jobs.push({ file, info, key, index, background, resolve, reject }); pump(); })
        .then(data => { recent.set(token, data); while (recent.size > 8) recent.delete(recent.keys().next().value); return data; })
        .finally(() => inFlight.delete(token));
      inFlight.set(token, promise);
    }
    return inFlight.get(token);
  };
  const stream = async (file, info = {}, { start = 0, end } = {}) => {
    if (closed) throw new Error('media cache closed');
    file = resolve(file);
    info = await sourceInfo(file, info);
    const last = Math.max(0, Math.min(info.size - 1, end ?? info.size - 1));
    const first = Math.max(0, Math.min(start, last));
    const key = identity(file, info);
    if (!eligible(file)) { bypasses++; return createReadStream(file, { start: first, end: last }); }
    async function* chunks() {
      let index = Math.floor(first / blockBytes);
      const final = Math.floor(last / blockBytes);
      while (index <= final) {
        const data = await getBlock(file, info, key, index);
        for (let ahead = 1; ahead <= 2 && index + ahead <= final; ahead++) void getBlock(file, info, key, index + ahead, { background: true }).catch(() => {});
        const from = index === Math.floor(first / blockBytes) ? first % blockBytes : 0;
        const to = index === final ? (last % blockBytes) + 1 : data.length;
        if (to > from) yield data.subarray(from, to);
        index++;
      }
    }
    return Readable.from(chunks());
  };
  const warm = async (file, info = {}, { durationSeconds = 120 } = {}) => {
    file = resolve(file);
    info = await sourceInfo(file, info);
    if (!eligible(file) || await freeBytes().catch(() => 0) < reserveBytes + blockBytes) return;
    const seconds = Math.max(1, Number(durationSeconds) || 120);
    const estimate = info.size <= 32 * MiB ? info.size : Math.min(128 * MiB, Math.max(32 * MiB, info.size * ((120 * 1.5) / seconds)));
    const ranges = [{ start: 0, end: Math.min(info.size, estimate) - 1 }, { start: Math.max(0, info.size - 4 * MiB), end: info.size - 1 }];
    for (const range of ranges) {
      if (closed) break;
      const first = Math.floor(range.start / blockBytes), last = Math.floor(range.end / blockBytes);
      for (let i = first; i <= last && !closed; i++) {
        // A block already on disk costs nothing: only reads from the source are paced (they were all paced,
        // so a pass over 235 warm titles took minutes and never reached the cold ones, 15 Nov 2026).
        if (cacheIndex.has(cachePath(identity(file, info), i))) continue;
        await getBlock(file, info, identity(file, info), i, { background: true });
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  };
  const keep = async list => {
    const next = new Set();
    for (const entry of list || []) {
      try {
        const file = resolve(entry.file);
        if (!eligible(file)) continue;
        next.add(digest(identity(file, await sourceInfo(file, entry.info || {}))));
      } catch { /* a file that has gone is not kept */ }
    }
    kept = next;
    return kept.size;
  };
  const isKept = (file, info) => kept.has(digest(identity(resolve(file), info)));
  // Hold a title's opening: the first `seconds` of it (at its average bitrate, with half as much again) and its
  // last block, where players look for trailing metadata. Blocks come from the ordinary cache if it has them,
  // else from the source (the drive, or the cloud copy when the file has gone), and are not added to the
  // ordinary cache: a pass over a whole shelf must not push out what is about to play.
  const holdOpening = async (file, info = {}, { durationSeconds } = {}) => {
    if (!openRoot || closed) return { blocks: 0, bytes: 0, already: 0 };
    file = resolve(file);
    info = await sourceInfo(file, info);
    const key = identity(file, info), total = Math.ceil(info.size / blockBytes);
    if (total <= 0) return { blocks: 0, bytes: 0, already: 0 };
    const duration = Number(durationSeconds) > 0 ? Number(durationSeconds) : 0;
    const wanted = duration ? Math.ceil((info.size / duration) * openSeconds * 1.5 / blockBytes) : Math.ceil(32 * MiB / blockBytes);
    const first = Math.min(total, Math.max(1, wanted));
    const indexes = [...new Set([...Array(first).keys(), total - 1])];
    let blocks = 0, bytes = 0, already = 0;
    for (const index of indexes) {
      const path = openingPath(key, index);
      if (openingIndex.has(path)) { already++; continue; }
      const expected = Math.min(blockBytes, info.size - index * blockBytes);
      const full = openingBytes + expected + 32 > openMax
        || (openReserve > 0 && Number((await statfs(openRoot).then(st => Number(st.bavail ?? st.blocksAvailable ?? 0) * Number(st.bsize ?? st.blockSize ?? 1), () => Infinity))) < openReserve + expected);
      if (full) throw Object.assign(new Error('the openings store is full'), { code: 'ENOSPC' });
      let data = null;
      try { data = unpack(await fs.readFile(cachePath(key, index)), expected); } catch { /* not in the ordinary cache */ }
      if (!data) data = await readSourceBlock(file, index, info.size);
      if (data.length !== expected) throw new Error('source returned the wrong amount of data for an opening');
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      try { await fs.writeFile(tmp, packed(data), { flag: 'wx' }); await fs.rename(tmp, path); }
      finally { await fs.unlink(tmp).catch(() => {}); }
      openingIndex.set(path, expected + 32); openingBytes += expected + 32;
      blocks++; bytes += expected;
    }
    return { blocks, bytes, already };
  };
  return {
    stream,
    warm,
    keep,
    isKept,
    holdOpening,
    trim,
    close: async () => { closed = true; pump(); await Promise.allSettled([...inFlight.values()]); await writeQueue; },
    stats: () => ({ hits, memoryHits, misses, bypasses, remoteReads, openingHits, openingBlocks: openingIndex.size, openingBytes, kept: kept.size, inFlight: inFlight.size, queued: jobs.length, running, bytesCached: [...cacheIndex.values()].reduce((n, f) => n + f.size, 0), maxBytes, reserveBytes, closed, directory: root, blockBytes }),
  };
}
