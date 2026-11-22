// Playback on this Mac: what Chromium can play as-is, converting the rest,
// audio and subtitle tracks, and the next episode.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, utimes, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { runCommand } from '../casting/src/pipeline.js';
import { listSidecars, readSubtitle } from './subtitles.js';

// Measured in this app's Electron on 2026-11-05: H.264/HEVC in MP4 or MKV play;
// AC3/E-AC3 audio plays silently; AVI and MPEG-TS do not open.
const VIDEO_OK = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const CONTAINER_OK = new Set(['mov', 'mp4', 'm4a', 'matroska', 'webm']);
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const GiB = 1024 ** 3;

const LANGUAGES = { eng:'English', en:'English', jpn:'Japanese', ja:'Japanese', fre:'French', fra:'French', fr:'French',
  ger:'German', deu:'German', de:'German', spa:'Spanish', es:'Spanish', ita:'Italian', it:'Italian', chi:'Chinese',
  zho:'Chinese', zh:'Chinese', kor:'Korean', ko:'Korean', por:'Portuguese', pt:'Portuguese', rus:'Russian', ru:'Russian',
  dut:'Dutch', nld:'Dutch', nl:'Dutch', swe:'Swedish', sv:'Swedish', hin:'Hindi', hi:'Hindi', ara:'Arabic', ar:'Arabic' };

const CHANNELS = { 1:'mono', 2:'stereo', 6:'5.1', 8:'7.1' };

function language(code) {
  const value = String(code || '').toLowerCase();
  return value && value !== 'und' ? LANGUAGES[value] || value.toUpperCase() : '';
}

/** A short, distinct label for an audio or subtitle track. */
export function trackLabel(track, index) {
  const parts = [language(track.lang) || track.title || `Track ${index + 1}`];
  if (track.title && language(track.lang) && !track.title.toLowerCase().includes(language(track.lang).toLowerCase())) parts.push(track.title);
  if (track.channels) parts.push(CHANNELS[track.channels] || `${track.channels} ch`);
  return parts.join(' · ');
}

/** Reduce ffprobe JSON to the streams the Mac player cares about. */
export function describeStreams(data) {
  const streams = data?.streams || [];
  const video = streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audio = streams.filter(stream => stream.codec_type === 'audio').map((stream, n) => ({
    n, codec: stream.codec_name || '', lang: stream.tags?.language || '', title: stream.tags?.title || '',
    channels: stream.channels || 0, isDefault: stream.disposition?.default === 1,
  }));
  const subtitles = streams.filter(stream => stream.codec_type === 'subtitle').map((stream, n) => ({
    n, codec: stream.codec_name || '', lang: stream.tags?.language || '', title: stream.tags?.title || '',
    isDefault: stream.disposition?.default === 1, forced: stream.disposition?.forced === 1,
  }));
  const duration = Number(data?.format?.duration);
  return { container: String(data?.format?.format_name || '').split(',')[0], videoCodec: video?.codec_name || '',
    hasVideo: Boolean(video), durationSeconds: Number.isFinite(duration) ? duration : 0, audio, subtitles };
}

export function defaultAudio(info) {
  return (info.audio.find(track => track.isDefault) || info.audio[0])?.n ?? -1;
}

/** Whether the chosen audio track plays as-is, and what a conversion would do. */
export function macPlan(info, audio = defaultAudio(info)) {
  const track = info.audio.find(item => item.n === audio);
  const video = !info.hasVideo || VIDEO_OK.has(info.videoCodec) ? 'copy' : 'h264';
  const sound = !track || AUDIO_OK.has(track.codec) ? 'copy' : 'aac';
  const direct = CONTAINER_OK.has(info.container) && video === 'copy' && sound === 'copy';
  return { direct, video, audio: sound, track: track ? track.n : -1 };
}

export function prepareArgs(source, output, plan) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', source, '-map', '0:V:0?'];
  if (plan.track >= 0) args.push('-map', `0:a:${plan.track}`);
  args.push('-sn', '-dn', '-map_chapters', '0');
  if (plan.video === 'copy') args.push('-c:v', 'copy');
  else args.push('-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
  if (plan.audio === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-progress', 'pipe:1', '-nostats', '-f', 'matroska', output);
  return args;
}

function natural(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }

/** The episode after this one: next file in its folder, else the first in the next sibling folder (Season 2). */
export function nextEpisode(items, path) {
  const current = items.find(item => item.path === path);
  if (!current || current.kind === 'film') return null;
  const folder = dirname(path);
  const episodes = items.filter(item => item.kind !== 'film');
  const here = episodes.filter(item => dirname(item.path) === folder).sort((a, b) => natural(a.path, b.path));
  const at = here.findIndex(item => item.path === path);
  if (at >= 0 && at < here.length - 1) return here[at + 1];
  const parent = dirname(folder);
  const later = episodes.filter(item => dirname(dirname(item.path)) === parent && natural(dirname(item.path), folder) > 0)
    .sort((a, b) => natural(a.path, b.path));
  return later[0] || null;
}

export function createMacMedia({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', directory, maxBytes = 10 * GiB, spawnImpl = spawn }) {
  const probes = new Map();
  let active = null;

  async function probe(path) {
    const info = await stat(path);
    const key = `${path}\0${info.size}\0${info.mtimeMs}`;
    if (!probes.has(key)) {
      probes.set(key, runCommand(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { timeoutMs: 30_000 })
        .then(({ stdout }) => ({ ...describeStreams(JSON.parse(stdout)), key })));
      probes.get(key).catch(() => probes.delete(key));
    }
    return probes.get(key);
  }

  function cacheName(info, plan, suffix) {
    return join(directory, createHash('sha1').update(`${info.key}\0${plan.track}\0${plan.video}\0${plan.audio}`).digest('hex').slice(0, 24) + suffix);
  }

  async function prune(keep) {
    let files = [];
    try { files = await readdir(directory); } catch { return; }
    const entries = [];
    for (const name of files) {
      const path = join(directory, name);
      try { const info = await stat(path); entries.push({ path, size: info.size, time: info.mtimeMs }); } catch {}
    }
    entries.sort((a, b) => b.time - a.time);
    let total = 0;
    for (const entry of entries) {
      total += entry.size;
      if (total > maxBytes && entry.path !== keep && !entry.path.endsWith('.part')) await rm(entry.path, { force: true });
    }
  }

  async function open(path) {
    const info = await probe(path);
    const sidecars = await listSidecars(path);
    const embedded = info.subtitles.filter(track => TEXT_SUBTITLES.has(track.codec));
    const plan = macPlan(info);
    return {
      durationSeconds: info.durationSeconds,
      direct: plan.direct,
      convert: plan.video !== 'copy' ? 'video' : plan.direct ? '' : 'audio',
      audio: info.audio.map((track, i) => ({ n: track.n, label: trackLabel(track, i), isDefault: track.n === plan.track,
        playable: AUDIO_OK.has(track.codec) })),
      subtitles: [
        ...sidecars.map(track => ({ id: `file:${track.id}`, label: language(track.lang) || track.label })),
        ...embedded.map((track, i) => ({ id: `embedded:${track.n}`, label: trackLabel(track, i) + (track.forced ? ' · forced' : ''), isDefault: track.isDefault })),
      ],
    };
  }

  function cancel() {
    if (active) { active.child.kill('SIGKILL'); active = null; }
  }

  /** A path Chromium can play with the chosen audio track; converts and caches when needed. */
  async function prepare(path, audio, onProgress = () => {}) {
    const info = await probe(path);
    const plan = macPlan(info, Number.isInteger(audio) && audio >= 0 ? audio : defaultAudio(info));
    if (plan.direct) return { path, direct: true };
    await mkdir(directory, { recursive: true });
    const output = cacheName(info, plan, '.mkv');
    try {
      await stat(output);
      const now = new Date(); await utimes(output, now, now);
      return { path: output, direct: false };
    } catch {}
    cancel();
    const part = `${output}.part`;
    const child = spawnImpl(ffmpeg, prepareArgs(path, part, plan), { stdio: ['ignore', 'pipe', 'pipe'] });
    const job = { child };
    active = job;
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/out_time_us=(\d+)/g);
      if (match && info.durationSeconds) onProgress(Math.min(0.99, Number(match.at(-1).split('=')[1]) / 1e6 / info.durationSeconds));
    });
    const code = await new Promise(resolve => { child.on('close', resolve); child.on('error', () => resolve(-1)); });
    if (active === job) active = null;
    if (code !== 0) {
      await rm(part, { force: true });
      if (child.killed) throw Object.assign(new Error('Stopped.'), { cancelled: true });
      throw new Error(`Could not convert ${basename(path)} for this Mac: ${errors.trim().split('\n').at(-1) || code}`);
    }
    await rename(part, output);
    onProgress(1);
    await prune(output);
    return { path: output, direct: false };
  }

  async function subtitle(path, id) {
    if (typeof id !== 'string') throw new Error('No subtitles.');
    if (id.startsWith('file:')) return readSubtitle(path, id.slice(5));
    const n = Number(id.replace(/^embedded:/, ''));
    const info = await probe(path);
    if (!id.startsWith('embedded:') || !info.subtitles.some(track => track.n === n && TEXT_SUBTITLES.has(track.codec))) throw new Error('No subtitles.');
    await mkdir(directory, { recursive: true });
    const cached = join(directory, createHash('sha1').update(`${info.key}\0sub${n}`).digest('hex').slice(0, 24) + '.vtt');
    try { return await readFile(cached, 'utf8'); } catch {}
    const { stdout } = await runCommand(ffmpeg, ['-hide_banner', '-nostdin', '-i', path, '-map', `0:s:${n}`, '-f', 'webvtt', 'pipe:1'], { timeoutMs: 300_000 });
    await writeFile(cached, stdout);
    return stdout;
  }

  return { open, prepare, subtitle, cancel };
}
