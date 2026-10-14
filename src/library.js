import { readdir, lstat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

// Keep this list deliberately small. The library view is an index, so it must
// never claim that an arbitrary file is playable by the TV pipeline.
export const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts', '.m2ts']);

function cleanTitle(value) {
  let text = String(value || '').replace(/\.(mp4|m4v|mov|mkv|webm|avi|ts|m2ts)$/i, '').trim()
    .replace(/\s*\[[\w-]{6,}\]\s*$/, '').trim();
  if (/\b(?:2160|1080|720)p\b|\b(?:WEB[- .]?DL|Blu[- .]?Ray|x26[45]|H\.?264)\b/i.test(text)) {
    text = text.replace(/[._]+/g, ' ')
      .replace(/\b(?:2160|1080|720)p\b.*$/i, '')
      .replace(/\b(?:WEB[- ]?DL|Blu[- ]?Ray|x26[45]|H\.?264)\b.*$/i, '')
      .replace(/\s+/g, ' ').trim();
  }
  return text || 'Untitled video';
}

function kindFor(item, src = '') {
  if (item && (item.kind === 'film' || item.kind === 'show')) return item.kind;
  const value = `${src} ${item?.channel || ''}`.toLowerCase();
  return /(?:^|[ /])(movie|movies|film|films|pixar shorts)(?:[ /]|$)/.test(value) ? 'film' : 'show';
}

function itemFrom(src, value, metadata = {}) {
  const path = metadata.file || (isAbsolute(metadata.path || '') ? metadata.path : value);
  if (typeof path !== 'string' || !isAbsolute(path) || !path || path.includes('\0')) return null;
  const channel = typeof metadata.channel === 'string' && metadata.channel
    ? metadata.channel
    : (src.includes('/') ? src.slice(0, src.indexOf('/')) : '');
  return {
    id: metadata.id || `catalogue:${src}`,
    src,
    path,
    title: cleanTitle(metadata.title || basename(path)),
    channel,
    kind: ['film', 'episode', 'video'].includes(metadata.kind) ? metadata.kind : kindFor(metadata, isAbsolute(src) ? basename(src) : src),
    tier: typeof metadata.tier === 'string' ? metadata.tier : '',
    duration: Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : 0,
    positionSeconds: 0,
    durationSeconds: Number.isFinite(metadata.duration) && metadata.duration > 0 ? metadata.duration : 0,
    completed: false,
  };
}

function catalogueEntries(catalogue) {
  if (Array.isArray(catalogue)) return catalogue.map(entry => [entry?.src || entry?.path || '', entry]);
  if (catalogue && typeof catalogue === 'object') return Object.entries(catalogue);
  return [];
}

/** Build a UI-safe, read-only index from the generated catalogue and history. */
export function buildLibrary(catalogue = {}, history = [], scannedItems = []) {
  const items = [];
  const byPath = new Map();
  for (const [src, value] of catalogueEntries(catalogue)) {
    const item = Array.isArray(catalogue) ? itemFrom(src, value?.file || value?.path || value, value) : itemFrom(src, value);
    if (!item || byPath.has(item.path)) continue;
    byPath.set(item.path, item);
    items.push(item);
  }
  // Explicitly supplied roots are normally the small set of known film
  // folders. They are already scanned by scanMediaLibrary; accepting the
  // result here makes the model useful to the main process without broadening
  // filesystem access inside this pure function.
  for (const entry of (Array.isArray(scannedItems) ? scannedItems : scannedItems?.items || [])) {
    const item = itemFrom(entry.src || entry.path, entry.path, entry);
    if (item && !byPath.has(item.path)) { byPath.set(item.path, item); items.push(item); }
  }
  const saved = Array.isArray(history) ? history : (history?.list?.() || []);
  for (const entry of saved) {
    if (typeof entry?.path !== 'string' || !isAbsolute(entry.path) || entry.path.includes('\0')) continue;
    let item = byPath.get(entry.path);
    if (!item) {
      item = itemFrom(`history:${entry.path}`, entry.path, { title: entry.title, kind: 'video' });
      if (!item) continue;
      byPath.set(item.path, item);
      items.push(item);
    }
    item.positionSeconds = Number.isFinite(entry.positionSeconds) ? Math.max(0, entry.positionSeconds) : 0;
    item.durationSeconds = Number.isFinite(entry.durationSeconds) && entry.durationSeconds > 0
      ? entry.durationSeconds : item.durationSeconds;
    item.completed = entry.completed === true;
    item.updatedAt = typeof entry.updatedAt === 'string' ? entry.updatedAt : '';
    if (entry.title) item.title = cleanTitle(entry.title);
  }
  const continueWatching = items.filter(item => !item.completed && item.positionSeconds > 5)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    items,
    continueWatching,
    films: items.filter(item => item.kind === 'film'),
    shows: items.filter(item => item.kind === 'show' || item.kind === 'episode'),
  };
}

function validRoot(root) {
  const value = typeof root === 'string' ? root : root?.path;
  if (!isAbsolute(value || '') || value.includes('\0')) throw new TypeError('Media roots must be absolute paths.');
  return { path: resolve(value), label: typeof root === 'object' && root.label ? String(root.label) : '', kind: typeof root === 'object' ? root.kind : undefined };
}

/**
 * Bounded read-only scan for explicitly supplied media folders. It does not
 * follow symlinks, hidden entries, or descend beyond maxDepth.
 */
export async function scanMediaLibrary(roots = [], { maxDepth = 4, maxItems = 10000 } = {}) {
  if (!Array.isArray(roots)) throw new TypeError('Media roots must be an array.');
  const found = [];
  const seen = new Set();
  function addFile(root, path) {
    if (seen.has(path) || !MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) return;
    // Hidden entries inside a chosen folder are skipped; a chosen folder may itself live under one.
    if (relative(root.path, path).split('/').some(part => part.startsWith('.'))) return;
    if (found.length >= maxItems) { found.truncated = true; return; }
    seen.add(path);
    const channel = root.label || (path === root.path ? '' : relative(root.path, dirname(path)).split('/')[0]) || '';
    found.push({ id: `file:${path}`, src: path, path, title: cleanTitle(basename(path)), channel,
      kind: ['show', 'film', 'episode', 'video'].includes(root.kind)
        ? root.kind : (/\bS\d{1,2}E\d{1,3}\b/i.test(basename(path)) ? 'show' : /film|movie|shorts/i.test(root.label + ' ' + basename(root.path) + ' ' + basename(path)) || /\b(?:19|20)\d{2}\b/.test(basename(path)) ? 'film' : 'video'), tier: '', duration: 0,
      positionSeconds: 0, durationSeconds: 0, completed: false });
  }
  async function visit(root, directory, depth) {
    if (found.truncated || depth > maxDepth) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.truncated || !entry.name || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(root, path, depth + 1); continue; }
      if (entry.isFile()) addFile(root, path);
    }
  }
  const folders = [];
  // Explicit files (such as watched history) come first so a full folder scan cannot crowd them out.
  for (const input of roots) {
    const root = validRoot(input);
    let info;
    try { info = await lstat(root.path); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') continue;
      throw error;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) addFile(root, root.path);
    else if (info.isDirectory()) folders.push(root);
  }
  for (const root of folders) await visit(root, root.path, 0);
  return found;
}
