import { extname, join } from 'node:path';

export const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.m4v', '.mov', '.webm', '.avi', '.m4a', '.mp3', '.aac', '.flac',
]);

export function isVideoPath(filePath) {
  return VIDEO_EXT.has(extname(filePath).toLowerCase());
}

export function normalizeUri(uri) {
  if (!uri) return '';
  const decoded = String(uri)
      .replaceAll('&apos;', "'")
      .replaceAll('&#39;', "'")
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&');
  try { return decodeURIComponent(decoded); } catch { return decoded; }
}

export async function expandPaths(paths, fs) {
  const out = [];
  if (!Array.isArray(paths)) throw new TypeError('Files must be a list of paths.');
  for (const path of paths) {
    if (typeof path !== 'string' || !path || path.includes('\0')) continue;
    let info;
    try {
      info = await fs.stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const names = await fs.readdir(path);
      for (const name of names) {
        const child = join(path, name);
        if (!isVideoPath(child)) continue;
        try { if ((await fs.stat(child)).isFile()) out.push(child); } catch {}
      }
    } else if (info.isFile() && isVideoPath(path)) {
      out.push(path);
    }
  }
  return [...new Set(out)];
}
