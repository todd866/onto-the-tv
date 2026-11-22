import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DIRECTORY = join(homedir(), 'Library', 'Caches', 'Isobar', 'wall');
const MAX_JSON_BYTES = 128 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_PROGRAMME_AGE_MS = 36 * 60 * 60 * 1000;

function iso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

async function safePath(root, candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || isAbsolute(candidate)) throw new Error('Weather programme archive is invalid.');
  const resolved = resolve(root, candidate);
  const actual = await realpathOrNull(resolved);
  if (!actual || !inside(root, actual)) throw new Error('Weather programme archive is invalid.');
  return actual;
}

async function realpathOrNull(path) {
  try { return await realpath(path); } catch { return null; }
}

async function boundedJson(path) {
  let info;
  try { info = await stat(path); } catch { throw new Error('Weather programme archive is unavailable.'); }
  if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new Error('Weather programme metadata is invalid.');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Weather programme metadata is invalid.'); }
}

function validKeyframes(value, from, to, duration) {
  if (!Array.isArray(value) || value.length > 200) return false;
  return value.every(frame => frame && typeof frame === 'object' && Number.isFinite(frame.seconds) && frame.seconds >= 0 && frame.seconds <= duration && iso(frame.validTime) != null && iso(frame.validTime) >= from && iso(frame.validTime) <= to && typeof frame.label === 'string' && frame.label.length <= 200 && (!('region' in frame) || typeof frame.region === 'string'));
}

/** Read the immutable Isobar wall programme without copying or mutating it. */
export async function readIsobarProgramme({ directory = process.env.ISOBAR_WALL_DIR || DEFAULT_DIRECTORY, now = Date.now } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')) throw new Error('Weather programme archive is invalid.');
  const root = await realpathOrNull(resolve(directory));
  if (!root) return null;
  let currentPath;
  try { currentPath = await safePath(root, 'current.json'); }
  catch { if (!await realpathOrNull(join(root, 'current.json'))) return null; throw new Error('Weather programme archive is invalid.'); }
  let current;
  try { current = await boundedJson(currentPath); } catch (error) {
    if (error.message.includes('unavailable')) return null;
    throw error;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current) || typeof current.generation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(current.generation)) throw new Error('Weather programme archive is invalid.');
  const generationDir = await safePath(root, join('generations', current.generation));
  const metadataPath = await safePath(root, current.metadata || join('generations', current.generation, 'fronts.json'));
  if (dirname(metadataPath) !== generationDir) throw new Error('Weather programme archive is invalid.');
  const metadata = await boundedJson(metadataPath);
  const generatedAt = iso(metadata.generatedAt);
  const validFrom = iso(metadata.validFrom);
  const validTo = iso(metadata.validTo);
  const currentTime = now();
  const duration = metadata.durationSeconds;
  if (generatedAt != null && currentTime - generatedAt > MAX_PROGRAMME_AGE_MS) throw new Error('Weather maps need a refresh.');
  if (iso(metadata.chartPublishedAt) != null && currentTime - iso(metadata.chartPublishedAt) > MAX_PROGRAMME_AGE_MS) throw new Error('Weather maps need a refresh.');
  if (!generatedAt || !validFrom || !validTo || validFrom > validTo || generatedAt > currentTime + MAX_FUTURE_MS || currentTime > validTo || !Number.isFinite(duration) || duration < 4 || duration > 120 || typeof metadata.attribution !== 'string' || !metadata.attribution.trim() || metadata.attribution.length > 500 || !validKeyframes(metadata.keyframes, validFrom, validTo, duration)) throw new Error('Weather programme metadata is invalid.');
  if (metadata.chartPublishedAt !== undefined && !iso(metadata.chartPublishedAt)) throw new Error('Weather programme metadata is invalid.');
  const videoCandidate = current.video === undefined ? join('generations', current.generation, 'fronts.mp4') : current.video;
  const videoPath = await safePath(root, videoCandidate);
  if (dirname(videoPath) !== generationDir) throw new Error('Weather programme archive is invalid.');
  let videoInfo;
  try { videoInfo = await stat(videoPath); } catch { return null; }
  if (!videoInfo.isFile() || videoInfo.size <= 0 || videoInfo.size > MAX_VIDEO_BYTES || !videoPath.toLowerCase().endsWith('.mp4')) throw new Error('Weather programme video is invalid.');
  return {
    path: videoPath,
    durationSeconds: duration,
    metadata,
    slide: { kind: 'weather-film', video: pathToFileURL(videoPath).href, durationSeconds:duration,
      eyebrow: 'Isobar', title: 'Australia weather', detail: 'Animated forecast', footer: metadata.attribution },
  };
}
