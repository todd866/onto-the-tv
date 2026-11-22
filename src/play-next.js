import { readFile } from 'node:fs/promises';
import { writeAtomically } from './atomic-write.js';

const LIMIT = 32;

function sources(parsed) {
  const items = Array.isArray(parsed) ? parsed : parsed && parsed.items;
  if (!Array.isArray(items)) return [];
  return items.filter(src => typeof src === 'string' && src && !src.includes('..') && !src.includes('\\') && !src.includes('\0')).slice(0, LIMIT);
}

export function createPlayNext({ file, allowSrc, read = readFile, write = writeAtomically } = {}) {
  let memory = [];
  async function load() {
    if (!file) return memory.slice();
    try { return sources(JSON.parse(await read(file, 'utf8'))); }
    catch { return []; }
  }
  async function save(items) {
    const next = items.slice(0, LIMIT);
    if (!file) { memory = next; return { items: next.slice() }; }
    await write(file, `${JSON.stringify({ items: next })}\n`);
    return { items: next };
  }
  function allowed(src) {
    return typeof src === 'string' && src && !src.includes('..') && (typeof allowSrc !== 'function' || allowSrc(src));
  }
  return {
    async list() { return { items: await load() }; },
    async add(src) {
      if (!allowed(src)) return null;
      const items = await load();
      if (items.length >= LIMIT) return null;
      items.push(src);
      return save(items);
    },
    async consume(src) {
      const items = await load();
      const at = items.indexOf(src);
      if (at >= 0) items.splice(at, 1);
      return save(items);
    },
  };
}
