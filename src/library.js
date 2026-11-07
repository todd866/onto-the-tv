import { lstat, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeAtomically } from './atomic-write.js';

// Keep this list deliberately small. The library view is an index, so it must
// never claim that an arbitrary file is playable by the TV pipeline.
export const MEDIA_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts', '.m2ts']);

// An unmounted volume is ENOENT. A volume that is still attached but not
// answering is EIO or ENXIO. All three mean "this root is offline".
const OFFLINE_IO_CODES = new Set(['ENOENT', 'EIO', 'ENXIO']);

function markRootOffline(found, path, code) {
  found.partial = true;
  found.offline = found.offline || [];
  if (!found.offline.some(item => item.path === path)) found.offline.push({ path, code });
}

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
export async function scanMediaLibrary(roots = [], { maxDepth = 4, maxItems = 10000, io } = {}) {
  if (!Array.isArray(roots)) throw new TypeError('Media roots must be an array.');
  const list = io?.readdir || readdir;
  const statRoot = io?.lstat || lstat;
  const found = [];
  const seen = new Set();
  let limit = maxItems;
  function addFile(root, path) {
    if (seen.has(path) || !MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) return;
    // Hidden entries inside a chosen folder are skipped; a chosen folder may itself live under one.
    if (relative(root.path, path).split('/').some(part => part.startsWith('.'))) return;
    if (found.length >= limit) { found.truncated = true; return; }
    seen.add(path);
    const channel = root.label || (path === root.path ? '' : relative(root.path, dirname(path)).split('/')[0]) || '';
    found.push({ id: `file:${path}`, src: path, path, title: cleanTitle(basename(path)), channel,
      kind: ['show', 'film', 'episode', 'video'].includes(root.kind)
        ? root.kind : (/\bS\d{1,2}E\d{1,3}\b/i.test(basename(path)) ? 'show' : /film|movie|shorts/i.test(root.label + ' ' + basename(root.path) + ' ' + basename(path)) || /\b(?:19|20)\d{2}\b/.test(basename(path)) ? 'film' : 'video'), tier: '', duration: 0,
      positionSeconds: 0, durationSeconds: 0, completed: false });
  }
  async function visit(root, directory, depth) {
    if (found.truncated || found.partialPath || depth > maxDepth) return;
    let entries;
    try { entries = await list(directory, { withFileTypes: true }); } catch (error) {
      // A read failing at the root or halfway down the tree means the drive
      // dropped. The files found so far are not a catalogue.
      if (OFFLINE_IO_CODES.has(error.code)) {
        markRootOffline(found, root.path, error.code);
        found.partialPath = directory;
        return;
      }
      if (error.code === 'ENOTDIR' || error.code === 'EACCES') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.truncated || found.partialPath || !entry.name || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(root, path, depth + 1); continue; }
      if (entry.isFile()) addFile(root, path);
    }
  }
  const folders = [];
  const files = [];
  for (const input of roots) {
    const root = validRoot(input);
    let info;
    try { info = await statRoot(root.path); } catch (error) {
      if (OFFLINE_IO_CODES.has(error.code)) {
        // A named video that is gone was deleted. A folder that is gone is an unmounted library.
        if (!MEDIA_EXTENSIONS.has(extname(root.path).toLowerCase())) markRootOffline(found, root.path, error.code);
        continue;
      }
      if (error.code === 'EACCES') continue;
      throw error;
    }
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) files.push(root);
    else if (info.isDirectory()) folders.push(root);
  }
  // Folders go first so their files keep the folder's classification, but they
  // leave room for explicit files (watched history) so those are never crowded out.
  limit = Math.max(0, maxItems - files.length);
  for (const root of folders) {
    if (found.partialPath) break;
    await visit(root, root.path, 0);
  }
  limit = maxItems;
  for (const root of files) addFile(root, root.path);
  return found;
}

/** Whether each configured root can be listed. Offline roots are not scanned. */
export async function inspectLibraryRoots(roots = [], io = {}) {
  if (!Array.isArray(roots)) throw new TypeError('Media roots must be an array.');
  const list = io.readdir || readdir;
  const statRoot = io.lstat || lstat;
  const status = [];
  for (const input of roots) {
    const path = validRoot(input).path;
    try {
      const info = await statRoot(path);
      if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) {
        status.push({ path, online: true, symlink: true });
        continue;
      }
      if (typeof info.isDirectory !== 'function' || !info.isDirectory()) {
        status.push({ path, online: true });
        continue;
      }
      await list(path);
      status.push({ path, online: true });
    } catch (error) {
      if (OFFLINE_IO_CODES.has(error.code)) status.push({ path, online: false, code: error.code });
      else throw error;
    }
  }
  return status;
}

/** Root reachability plus the mtime of the catalogue file the server is serving. */
export async function catalogueStatus(roots, catalogueFile, io) {
  const rootsStatus = await inspectLibraryRoots(roots, io);
  let catalogueBuiltAt = null;
  if (catalogueFile) {
    try {
      const info = await (io?.stat || stat)(catalogueFile);
      catalogueBuiltAt = info.mtime.toISOString();
    } catch (error) {
      if (error.code !== 'ENOENT' && !OFFLINE_IO_CODES.has(error.code)) throw error;
    }
  }
  return { roots: rootsStatus, catalogueBuiltAt };
}

/** What /api/health reports. Age is seconds since the catalogue file was written. */
export function libraryHealthReport({ roots = [], catalogueBuiltAt = null, now = Date.now() } = {}) {
  const built = typeof catalogueBuiltAt === 'string' ? Date.parse(catalogueBuiltAt) : Number.NaN;
  return {
    roots: roots.map(root => ({ path: root.path, online: root.online === true })),
    catalogueBuiltAt: Number.isFinite(built) ? new Date(built).toISOString() : null,
    catalogueAgeSeconds: Number.isFinite(built) ? Math.max(0, Math.round((now - built) / 1000)) : null,
  };
}

function catalogueCount(content) {
  if (content == null) return null;
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.videos)) return data.videos.length;
    if (Array.isArray(data)) return data.length;
  } catch { /* the TV catalogue is the shuffler HTML, not JSON */ }
  const match = text.match(/const VIDEOS = ([\s\S]*?);\s*<\/script>/);
  if (!match) return null;
  try {
    const videos = JSON.parse(match[1]);
    return Array.isArray(videos) ? videos.length : null;
  } catch { return null; }
}

function isOfflineFailure(error) {
  if (!error) return false;
  if (error.partial === true || OFFLINE_IO_CODES.has(error.code)) return true;
  return `${error.stderr || ''}\n${error.message || ''}`.includes('library root offline:');
}

function offlinePath(error) {
  if (typeof error?.path === 'string' && error.path) return error.path;
  const match = `${error?.stderr || ''}\n${error?.message || ''}`.match(/library root offline:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

function warnOffline(log, roots, when) {
  const time = when || 'unknown';
  for (const root of roots) log(`library root offline: ${root.path}, serving last catalogue from ${time}`);
}

async function restoreCatalogue(catalogueFile, previous, builtAt) {
  const current = await readFile(catalogueFile).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current && current.equals(previous)) return;
  await writeAtomically(catalogueFile, previous);
  const when = builtAt ? new Date(builtAt) : null;
  if (when && !Number.isNaN(when.getTime())) await utimes(catalogueFile, when, when);
}

/**
 * Rebuild the catalogue only when every configured root can be read.
 * A missing root, or a read that fails while the new catalogue is being built,
 * leaves the previous file byte for byte. A smaller catalogue is kept only
 * when every root was online for the whole rebuild: that is a real deletion.
 */
export async function rebuildCatalogue({ roots = [], catalogueFile, build, log = () => {}, io } = {}) {
  if (typeof build !== 'function') throw new TypeError('A catalogue build is required.');
  if (typeof catalogueFile !== 'string' || !catalogueFile) throw new TypeError('A catalogue file is required.');
  const status = await catalogueStatus(roots, catalogueFile, io);
  const offline = status.roots.filter(root => !root.online);
  if (offline.length) {
    warnOffline(log, offline, status.catalogueBuiltAt);
    return { rescanned: false, roots: status.roots, catalogueBuiltAt: status.catalogueBuiltAt };
  }
  const previous = await readFile(catalogueFile).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let built;
  try {
    built = await build({ io });
  } catch (error) {
    if (!isOfflineFailure(error)) throw error;
    if (previous) await restoreCatalogue(catalogueFile, previous, status.catalogueBuiltAt);
    const path = offlinePath(error) || status.roots[0]?.path || 'unknown';
    warnOffline(log, [{ path }], status.catalogueBuiltAt);
    return { rescanned: false, roots: status.roots, catalogueBuiltAt: status.catalogueBuiltAt };
  }
  const after = await catalogueStatus(roots, catalogueFile, io);
  const dropped = after.roots.filter(root => !root.online);
  const previousCount = catalogueCount(previous);
  const nextCount = catalogueCount(await readFile(catalogueFile).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }));
  if (previous && dropped.length && previousCount != null && nextCount != null && nextCount < previousCount) {
    await restoreCatalogue(catalogueFile, previous, status.catalogueBuiltAt);
    warnOffline(log, dropped, status.catalogueBuiltAt);
    return { rescanned: false, roots: after.roots, catalogueBuiltAt: status.catalogueBuiltAt };
  }
  return { rescanned: built !== false, roots: after.roots, catalogueBuiltAt: after.catalogueBuiltAt };
}
