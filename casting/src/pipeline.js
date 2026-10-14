import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { classifyYouTubeItem } from './art-track.js';
import { mimeFromPath } from './dlna.js';
import { decidePipeline, isSamsungCompatible } from './probe.js';
import { parseYouTubeId, pickYtDlpFormat } from './youtube.js';

export function runCommand(command, args, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let failure;
    let failed = false;
    let settled = false;
    const stop = (error) => {
      if (settled || failed) return;
      failed = true;
      failure = error;
      child.kill('SIGKILL');
    };
    const onAbort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new Error(`${basename(command)} timed out`)), timeoutMs);
    const onStdout = (chunk) => stdout.push(chunk);
    const onStderr = (chunk) => stderr.push(chunk);
    const onError = (error) => {
      if (!failed) {
        failed = true;
        failure = error;
      }
    };
    const onClose = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.removeListener('data', onStdout);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      // Wait for the process to exit before callers remove its temporary files.
      if (failed) {
        reject(failure);
        return;
      }
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${basename(command)} exited ${code}: ${err.slice(-800) || out.slice(-800)}`));
        return;
      }
      resolve({ stdout: out, stderr: err });
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function normalizeChapters(chapters, durationSeconds) {
  if (!Array.isArray(chapters)) return [];
  const maximum = Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : Infinity;
  return chapters.flatMap(chapter => {
    const rawStart = chapter?.start_time;
    if (typeof rawStart !== 'number' && (typeof rawStart !== 'string' || !rawStart.trim())) return [];
    const startSeconds = Number(rawStart);
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > maximum) return [];
    const rawTitle = chapter?.tags?.title ?? chapter?.tags?.TITLE;
    const title = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 240) : '';
    return [{ title, startSeconds }];
  }).sort((a, b) => a.startSeconds - b.startSeconds)
    .slice(0, 200)
    .map((chapter, index) => ({ ...chapter, title: chapter.title || `Chapter ${index + 1}` }));
}

export async function probeFile(ffprobe, filePath, { signal } = {}) {
  const { stdout } = await runCommand(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    '-show_chapters',
    filePath,
  ], { signal });
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio');
  const container = (data.format?.format_name || '').split(',')[0];
  const durationSeconds = data.format?.duration ? Number(data.format.duration) : null;
  return {
    container,
    durationSeconds,
    chapters: normalizeChapters(data.chapters, durationSeconds),
    videoCodec: video?.codec_name,
    videoProfile: video?.profile,
    videoLevel: video?.level,
    width: video?.width,
    height: video?.height,
    audioCodec: audio?.codec_name,
    audioChannels: audio?.channels,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

export async function classifyPlayerResponse(videoId, fetchImpl = fetch, { signal } = {}) {
  signal?.throwIfAborted();
  const response = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20240815.00.00', hl: 'en' } },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!response.ok) return classifyYouTubeItem(null);
  return classifyYouTubeItem(await response.json());
}

export async function prepareMedia(source, config, { log = () => {}, signal } = {}) {
  const temps = [];
  const cleanup = async () => {
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  };

  try {
    signal?.throwIfAborted();
    const youtubeId = parseYouTubeId(source);
    const prepared = youtubeId
      ? await prepareYouTube(source, youtubeId, config, temps, log, signal)
      : await prepareLocal(source, config, temps, log, signal);
    signal?.throwIfAborted();
    return prepared;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function prepareLocal(source, config, temps, log, signal) {
  const info = await probeFile(config.ffprobe, source, { signal });
  const compatible = isSamsungCompatible(info);
  const decision = decidePipeline({
    source: 'file',
    compatible,
    hasVideo: info.hasVideo,
    isArtTrack: false,
  });
  if (decision.action === 'serve') {
    log(`Serving ${basename(source)} as-is (${info.videoCodec || 'audio'}/${info.audioCodec || 'none'}).`);
    return {
      filePath: source,
      mimeType: mimeFromPath(source),
      title: basename(source),
      seekable: true,
      transcoded: false,
      durationSeconds: info.durationSeconds,
      chapters: info.chapters,
      isArtTrack: false,
      cleanup: async () => {},
    };
  }
  const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-'));
  temps.push(dir);
  const output = join(dir, decision.container === 'm4a' ? 'audio.m4a' : 'video.mp4');
  log(`Transcoding ${basename(source)} to ${decision.container} for the 2017 Samsung renderer.`);
  await transcode(config.ffmpeg, source, output, decision, { signal });
  const probed = await probeFile(config.ffprobe, output, { signal });
  return {
    filePath: output,
    mimeType: decision.container === 'm4a' ? 'audio/mp4' : 'video/mp4',
    title: basename(source),
    seekable: true,
    transcoded: true,
    durationSeconds: probed.durationSeconds,
    // Conversion preserves the timeline even if the output loses chapter tags.
    chapters: info.chapters,
    isArtTrack: false,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function prepareYouTube(source, youtubeId, config, temps, log, signal) {
  let classification = { videoId: youtubeId, isArtTrack: false };
  try {
    classification = await classifyPlayerResponse(youtubeId, fetch, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    log(`Art Track probe failed (${error.message}); continuing fail-open.`);
  }
  if (classification.isArtTrack) {
    log(`YouTube ${youtubeId} is an Art Track. Playing audio via DLNA so the Tizen YouTube app is never opened.`);
  }

  const { stdout } = await runCommand(config.ytdlp, ['-J', '--no-playlist', '--no-download', source], { timeoutMs: 90_000, signal });
  const dump = JSON.parse(stdout);
  const title = dump.title || youtubeId;
  const decision = decidePipeline({
    source: 'youtube',
    compatible: false,
    hasVideo: !classification.isArtTrack,
    isArtTrack: classification.isArtTrack,
  });

  const dir = await mkdtemp(join(tmpdir(), 'samsungtv-cast-yt-'));
  temps.push(dir);

  if (decision.action === 'audio') {
    const output = join(dir, 'audio.m4a');
    await runCommand(config.ytdlp, [
      '-f', 'ba[acodec^=mp4a]/bestaudio',
      '-x',
      '--audio-format', 'm4a',
      '--no-playlist',
      '-o', output,
      source,
    ], { timeoutMs: 180_000, signal });
    const probed = await probeFile(config.ffprobe, output, { signal });
    return {
      filePath: output,
      mimeType: 'audio/mp4',
      title,
      seekable: true,
      transcoded: true,
      durationSeconds: probed.durationSeconds,
      isArtTrack: true,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }

  const picked = pickYtDlpFormat(dump.formats || []);
  const formatId = picked?.format_id || 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4]/best';
  const downloaded = join(dir, 'download.%(ext)s');
  log(`Downloading YouTube ${youtubeId} with yt-dlp format ${formatId}.`);
  await runCommand(config.ytdlp, [
    '-f', formatId,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', downloaded,
    source,
  ], { timeoutMs: 300_000, signal });

  const fileName = (await readdir(dir)).find((name) => name.startsWith('download.'));
  if (!fileName) throw new Error('yt-dlp did not produce an output file');
  let filePath = join(dir, fileName);
  const info = await probeFile(config.ffprobe, filePath, { signal });
  if (!isSamsungCompatible(info)) {
    const output = join(dir, 'video.mp4');
    log('Downloaded YouTube media is not 2017-safe; transcoding to H.264/AAC 1080p.');
    await transcode(config.ffmpeg, filePath, output, { action: 'transcode', container: 'mp4', video: 'h264', audio: 'aac' }, { signal });
    filePath = output;
  }
  const probed = await probeFile(config.ffprobe, filePath, { signal });
  return {
    filePath,
    mimeType: 'video/mp4',
    title,
    seekable: true,
    transcoded: true,
    durationSeconds: probed.durationSeconds,
    isArtTrack: false,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export function transcode(ffmpeg, input, output, decision, { signal } = {}) {
  const args = ['-y', '-i', input, '-sn'];
  if (decision.video === 'h264') {
    args.push(
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1920,iw)':-2",
      '-preset', 'veryfast',
      '-crf', '20',
    );
  } else {
    args.push('-vn');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', output);
  return runCommand(ffmpeg, args, { timeoutMs: 600_000, signal });
}
