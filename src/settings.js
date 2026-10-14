import { readFile, copyFile, chmod, constants } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { writeAtomically } from './atomic-write.js';
import { homedir } from 'node:os';
import { isIPv4 } from 'node:net';
import { DEFAULT_AMBIENT_OPTIONS, validateAmbientOptions } from './ambient-sources.js';

export function defaults(home = homedir()) {
  const library = join(home, 'Movies', 'kids-holiday');
  return { tvHost: '', avTransportUrl: '', bindHost: '', library,
    playerPath: join(library, 'kids-shuffler.html'), tiersPath: '', sourcesPath: '', mediaFolders: [],
    ambient: { ...DEFAULT_AMBIENT_OPTIONS } };
}

export function validateTvSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Enter the TV address.');
  const result = {};
  for (const key of ['tvHost', 'avTransportUrl', 'bindHost']) {
    if (typeof input[key] !== 'string' || input[key].length > 2048) throw new Error('Invalid TV settings.');
    result[key] = input[key].trim();
  }
  if (result.tvHost && !isIPv4(result.tvHost)) throw new Error('Use the TV’s IPv4 address, for example 192.168.1.50.');
  if (result.bindHost && !isIPv4(result.bindHost)) throw new Error('Use this Mac’s IPv4 Wi-Fi address, or leave it blank.');
  if (result.avTransportUrl) {
    let url;
    try { url = new URL(result.avTransportUrl); } catch { throw new Error('The TV control address must be a full http:// URL.'); }
    if (url.protocol !== 'http:' || !isIPv4(url.hostname) || url.username || url.password || url.hash) {
      throw new Error('The TV control address must be an http:// IPv4 URL without a password.');
    }
    if (result.tvHost && url.hostname !== result.tvHost) throw new Error('The TV and control addresses must point to the same TV.');
    if (!result.tvHost) result.tvHost = url.hostname;
  }
  return result;
}

export async function readSettings(path, home) {
  const result = defaults(home);
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    Object.assign(result, validateTvSettings({ tvHost: data.tvHost || '',
      avTransportUrl: data.avTransportUrl || '', bindHost: data.bindHost || '' }));
    for (const key of ['library', 'playerPath', 'tiersPath', 'sourcesPath']) {
      if (typeof data[key] === 'string' && isAbsolute(data[key])) result[key] = data[key];
    }
    if (Array.isArray(data.mediaFolders)) result.mediaFolders = [...new Set(data.mediaFolders.filter(path =>
      typeof path === 'string' && path.length <= 4096 && !path.includes('\0') && isAbsolute(path)))].slice(0, 128);
    if (data.ambient) result.ambient = validateAmbientOptions(data.ambient);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read settings: ${error.message}`);
  }
  return result;
}

export async function writeSettings(path, settings) {
  await writeAtomically(path, JSON.stringify(settings, null, 2) + '\n');
}

/** Copy an unreadable settings file aside; returns the copy's path, or null if there was none. */
export async function preserveUnreadableSettings(path, now = Date.now) {
  const kept = `${path}.unreadable-${now()}`;
  try { await copyFile(path, kept, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  await chmod(kept, 0o600);
  return kept;
}
