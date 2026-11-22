import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_AGE = 15 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

function copy(value) {
  if (value === undefined) return undefined;
  try { return structuredClone(value); } catch { return String(value); }
}

export class Blackbox {
  constructor({ userData, file, now = () => Date.now(), maxEntries = MAX_ENTRIES, maxAge = MAX_AGE, onError } = {}) {
    this.userData = userData;
    this.file = file;
    this.now = now;
    this.maxEntries = maxEntries;
    this.maxAge = maxAge;
    this.onError = onError;
    this.entries = [];
    this.writeQueue = Promise.resolve();
  }

  prune(at = this.now()) {
    const cutoff = at - this.maxAge;
    this.entries = this.entries.filter(entry => Date.parse(entry.at) >= cutoff).slice(-this.maxEntries);
  }

  record(type, data = {}, at = this.now()) {
    const entry = { ...copy(data), at: new Date(at).toISOString(), type };
    this.entries.push(entry);
    this.prune(at);
    this.#mirror(entry);
    return copy(entry);
  }

  add(type, data, at) { return this.record(type, data, at); }
  getEntries() { this.prune(); return this.entries.map(copy); }
  snapshot() { return this.getEntries(); }

  async flush() { await this.writeQueue; }

  #mirror(entry) {
    const path = this.file || (this.userData && join(this.userData, 'blackbox.jsonl'));
    if (!path) return;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      try {
        const line = `${JSON.stringify(entry)}\n`;
        if ((await stat(path)).size + Buffer.byteLength(line) > MAX_BYTES) {
          await rename(path, `${path}.previous`).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }).catch(error => { this.onError?.(error); });
  }
}

export function createBlackbox(options) { return new Blackbox(options); }

export async function readBlackboxFile(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
