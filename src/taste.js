import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateTaste(input) {
  if (!object(input) || JSON.stringify(input).length > 4_000_000) throw new Error('Invalid taste data.');
  const profiles = {};
  for (const id of ['grown', 'mum', 'dad', 'both']) {
    const profile = input[id];
    if (!object(profile) || !object(profile.weights) || !object(profile.bookmarks)) throw new Error('Invalid taste profile.');
    const weights = Object.create(null), bookmarks = Object.create(null);
    for (const [key, value] of Object.entries(profile.weights)) {
      if (key.length > 4096 || !Number.isFinite(value) || value < 0.15 || value > 4) throw new Error('Invalid preference.');
      weights[key] = value;
    }
    for (const [key, value] of Object.entries(profile.bookmarks)) {
      if (key.length > 4096 || !object(value) || !Number.isFinite(value.time) || value.time < 0
          || !Number.isFinite(value.updated) || value.updated < 0 || typeof value.saved !== 'boolean') throw new Error('Invalid bookmark.');
      bookmarks[key] = { time:value.time, saved:value.saved, updated:value.updated };
    }
    profiles[id] = { weights, bookmarks };
  }
  return { version:1, updatedAt:new Date().toISOString(), profiles };
}

export function createTasteWriter(userData) {
  let pending = Promise.resolve();
  return input => {
    const content = JSON.stringify(validateTaste(input), null, 2) + '\n';
    // Serialize writes so an older snapshot cannot replace a newer one.
    const write = pending.catch(() => {}).then(async () => {
      await mkdir(userData, { recursive:true });
      const output = join(userData, 'taste.json');
      const temporary = output + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, content, { mode:0o600 });
      await rename(temporary, output);
    });
    pending = write;
    return write;
  };
}
