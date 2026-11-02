import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const KINDS = new Set(['sponsor', 'selfpromo', 'intro', 'outro', 'credits', 'ad']);
const SCENE_FILTER = "scale=160:-2,select='gt(scene,0.35)',showinfo";
const BLACK_FILTER = 'blackdetect=d=0.3:pix_th=0.1';
const SILENCE_FILTER = 'silencedetect=n=-50dB:d=0.3';

export function scenePaths(directory, file) {
  const key = createHash('sha256').update(String(file)).digest('hex');
  return { key, json: join(directory, `${key}.json`), thumbs: join(directory, key) };
}

function roundSeconds(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

export function segmentKind(title) {
  const text = String(title || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!text) return '';
  if (text === 'intro' || text.startsWith('intro ') || text.startsWith('introduction')) return 'intro';
  if (text === 'credits' || text.startsWith('credits ') || text === 'credit' || text.startsWith('credit ')) return 'credits';
  if (text === 'outro' || text.startsWith('outro ')) return 'outro';
  if (text === 'sponsor' || text.startsWith('sponsor ') || text.includes('sponsorship')) return 'sponsor';
  if (text === 'self promo' || text.includes('self promo')) return 'selfpromo';
  return '';
}

export function chaptersFromProbe(data) {
  const chapters = Array.isArray(data?.chapters) ? data.chapters : [];
  const cuts = [];
  const segments = [];
  for (const chapter of chapters) {
    const start = Number(chapter?.start_time);
    const end = Number(chapter?.end_time);
    if (Number.isFinite(start) && start > 0.05) cuts.push(roundSeconds(start));
    const kind = segmentKind(chapter?.tags?.title);
    if (kind && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      segments.push({ start: roundSeconds(start), end: roundSeconds(end), kind });
    }
  }
  return { chapters: chapters.length > 0, cuts, segments };
}

export function parseSceneTimes(text) {
  const times = [];
  const pattern = /pts_time:\s*([0-9.]+)/g;
  for (const match of String(text).matchAll(pattern)) {
    const time = Number(match[1]);
    if (Number.isFinite(time)) times.push(time);
  }
  return times;
}

export function parseBlackdetect(text) {
  return timed(text, /black_start:\s*([0-9.]+)/g);
}

export function parseSilencedetect(text) {
  return timed(text, /silence_start:\s*([0-9.]+)/g);
}

function timed(text, pattern) {
  const times = [];
  for (const match of String(text).matchAll(pattern)) {
    const time = Number(match[1]);
    if (Number.isFinite(time)) times.push(time);
  }
  return times;
}

/** Drop scene cuts closer than 20 s to the previous one kept. Chapters are not thinned. */
export function thinCuts(times, gap = 20) {
  const sorted = (times || []).map(Number).filter(time => Number.isFinite(time) && time > 0.05).sort((a, b) => a - b);
  const kept = [];
  for (const time of sorted) {
    if (!kept.length || time - kept[kept.length - 1] >= gap) kept.push(roundSeconds(time));
  }
  return kept;
}

/**
 * A hit is a black frame within 1.5 s of a silence. Several hits whose span is
 * 15–60 s are one in-broadcast break.
 */
export function clusterAdBreaks(blacks, silences) {
  const hits = (blacks || []).filter(black => (silences || []).some(silence => Math.abs(silence - black) <= 1.5)).sort((a, b) => a - b);
  const segments = [];
  let group = [];
  const close = () => {
    if (group.length >= 2) {
      const span = group[group.length - 1] - group[0];
      if (span >= 15 && span <= 60) {
        segments.push({ start: roundSeconds(group[0]), end: roundSeconds(group[group.length - 1]), kind: 'ad' });
      }
    }
    group = [];
  };
  for (const time of hits) {
    if (!group.length) { group = [time]; continue; }
    if (time - group[0] > 60) { close(); group = [time]; continue; }
    group.push(time);
  }
  close();
  return segments;
}

/** Comskip EDL: start, end, and action. 0 (cut) and 3 (commercial) are ad breaks. */
export function parseComskip(text) {
  const segments = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    const action = parts.length >= 3 ? Number(parts[2]) : 0;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (action !== 0 && action !== 3) continue;
    segments.push({ start: roundSeconds(start), end: roundSeconds(end), kind: 'ad' });
  }
  return segments;
}

export function ffmpegSceneArgs(file) {
  return ['-hide_banner', '-i', file, '-vf', SCENE_FILTER, '-an', '-f', 'null', '-'];
}

export function ffmpegBlackArgs(file) {
  return ['-hide_banner', '-i', file, '-vf', BLACK_FILTER, '-an', '-f', 'null', '-'];
}

export function ffmpegSilenceArgs(file) {
  return ['-hide_banner', '-i', file, '-af', SILENCE_FILTER, '-vn', '-f', 'null', '-'];
}

function commandOutput(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

async function runComskip(execute, comskip, file, workDir) {
  await mkdir(workDir, { recursive: true });
  const ini = join(workDir, 'comskip.ini');
  await writeFile(ini, `output_edl=1\noutput_dir=${workDir}\n`);
  await execute(comskip, [`--ini=${ini}`, file], { windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  const edl = join(workDir, `${basename(file, extname(file))}.edl`);
  return parseComskip(await readFile(edl, 'utf8'));
}

export async function analyseMedia(file, options = {}) {
  const execute = options.execute;
  if (typeof execute !== 'function') throw new TypeError('execute is required');
  const ffmpeg = options.ffmpeg || 'ffmpeg';
  const ffprobe = options.ffprobe || 'ffprobe';
  let probed = null;
  try {
    const result = await execute(ffprobe, ['-v', 'error', '-show_chapters', '-of', 'json', file]);
    const raw = typeof result === 'string' ? result : (result?.stdout || '');
    probed = JSON.parse(raw);
  } catch { probed = null; }
  const chapter = chaptersFromProbe(probed);
  let cuts = chapter.cuts;
  let chapters = chapter.chapters;
  if (!chapter.chapters) {
    const scene = await execute(ffmpeg, ffmpegSceneArgs(file));
    cuts = thinCuts(parseSceneTimes(commandOutput(scene)), 20);
    chapters = false;
  }
  const black = await execute(ffmpeg, ffmpegBlackArgs(file));
  const blacks = parseBlackdetect(commandOutput(black));
  let segments = chapter.chapters ? chapter.segments.slice() : [];
  if (options.recordedAds) {
    let ads = [];
    if (options.comskip && options.workDir) {
      try { ads = await runComskip(execute, options.comskip, file, options.workDir); }
      catch { ads = []; }
    }
    if (!ads.length) {
      const silence = await execute(ffmpeg, ffmpegSilenceArgs(file));
      ads = clusterAdBreaks(blacks, parseSilencedetect(commandOutput(silence)));
    }
    segments = segments.concat(ads);
  }
  return { chapters, cuts, blacks, segments };
}

/** One file at a time. A file already indexed at the same size and mtime is left alone. */
export async function indexCatalogue(videos, hooks) {
  const recordedAds = hooks.recordedAds || (() => false);
  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  for (const video of Array.isArray(videos) ? videos : []) {
    if (!video || typeof video.file !== 'string' || !video.file) continue;
    try {
      const info = await hooks.stat(video.file);
      if (info && typeof info.isFile === 'function' && !info.isFile()) continue;
      const prior = await hooks.read(video.file);
      if (prior && prior.size === info.size && prior.mtimeMs === info.mtimeMs) {
        skipped += 1;
        continue;
      }
      const analysis = await hooks.indexOne(video.file, { recordedAds: recordedAds(video) === true });
      await hooks.write(video.file, {
        version: 1,
        size: info.size,
        mtimeMs: info.mtimeMs,
        chapters: analysis?.chapters === true,
        cuts: analysis?.cuts || [],
        blacks: analysis?.blacks || [],
        segments: analysis?.segments || [],
        points: [0].concat(analysis?.cuts || []),
      });
      indexed += 1;
    } catch {
      failed += 1;
    }
  }
  return { indexed, skipped, failed };
}

function emptyScene() {
  return { cuts: [], thumbs: [], chapters: false, segments: [], blacks: [] };
}

export function createSceneStore(directory) {
  function load(file) {
    if (!file) return null;
    try {
      const parsed = JSON.parse(readFileSync(scenePaths(directory, file).json, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cuts)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  function fresh(file) {
    const parsed = load(file);
    if (!parsed) return false;
    try {
      const info = statSync(file);
      return info.size === parsed.size && info.mtimeMs === parsed.mtimeMs;
    } catch {
      return false;
    }
  }
  return {
    load,
    fresh,
    save(file, record) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(scenePaths(directory, file).json, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
    api(file, src) {
      if (!fresh(file)) return emptyScene();
      const parsed = load(file);
      const points = Array.isArray(parsed.points) && parsed.points.length ? parsed.points : [0, ...parsed.cuts];
      const folder = scenePaths(directory, file).thumbs;
      const thumbs = points.map((_, index) => (
        existsSync(join(folder, `${index}.jpg`)) ? `/scene-thumb?src=${encodeURIComponent(src)}&i=${index}` : ''
      ));
      const segments = [];
      for (const segment of Array.isArray(parsed.segments) ? parsed.segments : []) {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        if (!KINDS.has(segment?.kind) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        segments.push({ start, end, kind: segment.kind });
      }
      const blacks = (Array.isArray(parsed.blacks) ? parsed.blacks : [])
        .map(Number)
        .filter(time => Number.isFinite(time) && time >= 0);
      return {
        cuts: parsed.cuts.map(Number).filter(time => Number.isFinite(time)),
        thumbs,
        chapters: parsed.chapters === true,
        segments,
        blacks,
      };
    },
    thumbFile(file, index) {
      if (!fresh(file) || !Number.isInteger(index) || index < 0 || index > 10000) return '';
      const path = join(scenePaths(directory, file).thumbs, `${index}.jpg`);
      return existsSync(path) ? path : '';
    },
  };
}

export async function writeSceneThumbs(directory, file, points, { execute, ffmpeg = 'ffmpeg' }) {
  const folder = scenePaths(directory, file).thumbs;
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const times = Array.isArray(points) && points.length ? points : [0];
  for (let index = 0; index < times.length; index += 1) {
    const dest = join(folder, `${index}.jpg`);
    try {
      await execute(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Number(times[index]) || 0)),
        '-i', file, '-frames:v', '1', '-vf', 'scale=160:-2',
        '-q:v', '5', '-f', 'image2', '-vcodec', 'mjpeg', '-y', dest,
      ], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    } catch {
      // The cut is still usable without its thumbnail.
    }
  }
}
