import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { writeAtomically } from './atomic-write.js';

const VERSION = 1;
const MAX_ENTRIES = 500;
const MAX_POINTS = 100;
const MAX_POINT_TITLE = 120;

function validatePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    throw new TypeError('Playback history requires an absolute file path.');
  }
}

function validateSeconds(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, nonnegative number.`);
  }
}

function validatePoint(point) {
  if (!point || typeof point !== 'object' || Array.isArray(point) ||
      typeof point.id !== 'string' || !point.id.trim() || point.id.length > 128) {
    throw new Error('Invalid scene bookmark.');
  }
  validateSeconds(point.positionSeconds, 'Scene bookmark position');
  if (typeof point.title !== 'string' || !point.title.trim() || point.title.trim().length > MAX_POINT_TITLE) {
    throw new TypeError(`Scene bookmark title must contain 1–${MAX_POINT_TITLE} characters.`);
  }
  return { id: point.id, title: point.title.trim(), positionSeconds: point.positionSeconds };
}

function copyPoints(points) { return points.map(point => ({ ...point })); }

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid history entry.');
  validatePath(entry.path);
  validateSeconds(entry.positionSeconds, 'Playback position');
  validateSeconds(entry.durationSeconds, 'Playback duration');
  if (typeof entry.title !== 'string' || !entry.title.trim() || typeof entry.completed !== 'boolean' ||
      typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) {
    throw new Error('Invalid history entry.');
  }
  const savedPoints = entry.points === undefined ? [] : entry.points;
  if (!Array.isArray(savedPoints) || savedPoints.length > MAX_POINTS) throw new Error('Invalid scene bookmarks.');
  const points = savedPoints.map(validatePoint).sort((a, b) => a.positionSeconds - b.positionSeconds);
  if (new Set(points.map(point => point.id)).size !== points.length) throw new Error('Duplicate scene bookmark IDs.');
  return { path: entry.path, title: entry.title, positionSeconds: entry.positionSeconds,
    durationSeconds: entry.durationSeconds, completed: entry.completed, updatedAt: entry.updatedAt, points };
}


/**
 * Private, path-keyed watching history. Call set only after playback starts;
 * flush makes all changes made before that call durable. Entries are returned
 * newest first, with updatedAt as an ISO timestamp. Corrupt files are preserved
 * and reported to the caller, never silently replaced with an empty history.
 */
export async function loadPlaybackHistory(filePath) {
  validatePath(filePath);
  const entries = new Map();
  try {
    const data = JSON.parse(await readFile(filePath, 'utf8'));
    if (!data || data.version !== VERSION || !Array.isArray(data.entries)) {
      throw new Error('Unsupported playback history format.');
    }
    const saved = data.entries.map(validateEntry).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const entry of saved) {
      entries.delete(entry.path);
      entries.set(entry.path, entry);
    }
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read playback history: ${error.message}`, { cause: error });
  }

  let revision = 0;
  let savedRevision = 0;
  let writes = Promise.resolve();

  return {
    get(path) {
      validatePath(path);
      const entry = entries.get(path);
      return entry && !entry.completed ? entry.positionSeconds : 0;
    },

    list() {
      return Array.from(entries.values(), entry => ({ ...entry, points: copyPoints(entry.points) })).reverse();
    },

    set(path, { title, positionSeconds, durationSeconds, completed = false, reset = false } = {}) {
      validatePath(path);
      validateSeconds(positionSeconds, 'Playback position');
      if (durationSeconds !== undefined) validateSeconds(durationSeconds, 'Playback duration');
      if (typeof completed !== 'boolean' || typeof reset !== 'boolean') {
        throw new TypeError('Playback completion and reset must be booleans.');
      }
      if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
        throw new TypeError('Playback title must be a nonempty string.');
      }
      const previous = entries.get(path);
      // Some TVs report zero while stopping, reconnecting or loading the file.
      // Keep a good bookmark until the caller explicitly seeks to the start.
      if (positionSeconds === 0 && previous && !previous.completed && !reset && !completed) {
        positionSeconds = previous.positionSeconds;
      }
      const entry = {
        path,
        title: title?.trim() || previous?.title || basename(path),
        positionSeconds,
        durationSeconds: durationSeconds || previous?.durationSeconds || 0,
        completed,
        updatedAt: new Date().toISOString(),
        points: previous?.points || [],
      };
      if (previous && entry.title === previous.title && entry.positionSeconds === previous.positionSeconds &&
          entry.durationSeconds === previous.durationSeconds && entry.completed === previous.completed) return;
      entries.delete(path);
      entries.set(path, entry);
      while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      revision += 1;
    },

    getPoints(path) {
      validatePath(path);
      return copyPoints(entries.get(path)?.points || []);
    },

    addPoint(path, { title, positionSeconds } = {}) {
      validatePath(path);
      const entry = entries.get(path);
      if (!entry) throw new Error('Play this file before saving a scene bookmark.');
      const point = validatePoint({ id: randomUUID(), title, positionSeconds });
      if (entry.durationSeconds > 0 && point.positionSeconds > entry.durationSeconds) {
        throw new Error('Scene bookmark must be within the video duration.');
      }
      if (entry.points.length >= MAX_POINTS) throw new Error(`A video can have up to ${MAX_POINTS} scene bookmarks.`);
      entry.points.push(point);
      entry.points.sort((a, b) => a.positionSeconds - b.positionSeconds);
      revision += 1;
      return { ...point };
    },

    removePoint(path, id) {
      validatePath(path);
      if (typeof id !== 'string' || !id.trim()) throw new TypeError('Choose a valid scene bookmark.');
      const entry = entries.get(path);
      const index = entry?.points.findIndex(point => point.id === id) ?? -1;
      if (index < 0) return false;
      entry.points.splice(index, 1);
      revision += 1;
      return true;
    },

    flush() {
      const targetRevision = revision;
      const content = JSON.stringify({ version: VERSION, entries: [...entries.values()] }, null, 2) + '\n';
      // Recover the queue after a failed write so callers can retry. Each caller
      // still receives its own rejection, and snapshots commit in call order.
      const operation = writes.catch(() => {}).then(async () => {
        if (targetRevision <= savedRevision) return;
        await writeAtomically(filePath, content);
        savedRevision = targetRevision;
      });
      writes = operation;
      return operation;
    },
  };
}
