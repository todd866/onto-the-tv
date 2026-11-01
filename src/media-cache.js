import { createHash } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export async function createMediaCache({ directory, maxBytes = 20 * GiB,
  reserveBytes = 40 * GiB, blockBytes = 4 * MiB, eligible = file => file.startsWith('/Volumes/'),
  log = () => {}, statfs = path => fs.statfs(path) }) {
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
  let hits = 0, memoryHits = 0, misses = 0, bypasses = 0;

  const identity = (file, info) => `${file}\0${info.size}\0${info.mtimeMs}`;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const cachePath = (key, index) => join(root, `${digest(key)}-${index}.block`);
  const packed = data => Buffer.concat([createHash('sha256').update(data).digest(), data]);
  const unpack = (data, expected) => {
    if (data.length !== expected + 32) return null;
    const body = data.subarray(32);
    return createHash('sha256').update(body).digest().equals(data.subarray(0, 32)) ? body : null;
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
  const makeRoom = async extra => {
    let files = await cacheFiles();
    let total = files.reduce((n, f) => n + f.size, 0);
    let free = await freeBytes().catch(() => 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total + extra <= maxBytes && free >= reserveBytes + extra) break;
      if (active.has(file.path)) continue;
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
    const handle = await fs.open(file, 'r');
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
      for (let i = first; i <= last && !closed; i++) { await getBlock(file, info, identity(file, info), i, { background: true }); await new Promise(resolve => setTimeout(resolve, 200)); }
    }
  };
  return {
    stream,
    warm,
    close: async () => { closed = true; pump(); await Promise.allSettled([...inFlight.values()]); await writeQueue; },
    stats: () => ({ hits, memoryHits, misses, bypasses, inFlight: inFlight.size, queued: jobs.length, running, bytesCached: [...cacheIndex.values()].reduce((n, f) => n + f.size, 0), maxBytes, reserveBytes, closed, directory: root, blockBytes }),
  };
}
