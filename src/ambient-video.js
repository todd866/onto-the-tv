import { mkdtemp, chmod, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../casting/src/pipeline.js';

export function ambientAnimationGraph(slides, pace, { fps = 24, transition = 2 } = {}) {
  const graph = [];
  // Each input lasts through its outgoing blend. A final copy of the first
  // keyframe closes the loop, so the next rotation also has generated frames.
  for (let i = 0; i <= slides.length; i++) {
    const slide = slides[i % slides.length];
    const duration = slide.durationSeconds || pace + transition;
    const motion = slide.kind === 'photo'
      ? `zoompan=z='1+0.025*sin(PI*on/${duration * fps - 1})':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=1280x720:fps=${fps},`
      : '';
    graph.push(`[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},${motion}format=yuv420p,settb=AVTB,trim=duration=${duration},setpts=PTS-STARTPTS[v${i}]`);
  }
  let previous = 'v0';
  let offset = 0;
  for (let i = 1; i <= slides.length; i++) {
    offset += (slides[i - 1].durationSeconds || pace + transition) - transition;
    graph.push(`[${previous}][v${i}]xfade=transition=fade:duration=${transition}:offset=${offset}[mix${i}]`);
    previous = `mix${i}`;
  }
  // Start just after the initial blend would have finished; finish at the
  // equivalent point in the repeated first frame for a continuous loop.
  graph.push(`[${previous}]trim=start=${transition}:duration=${offset},setpts=PTS-STARTPTS[out]`);
  return graph.join(';');
}

// Only bounded, locally rendered frames enter ffmpeg; no feed text is shell code.
export async function buildAmbientVideo({ slides, pace = 20, capture, signal,
  ffmpeg = 'ffmpeg', execute = runCommand, seconds = 300, directory = tmpdir(), weatherVideo }) {
  if (!slides?.length && !weatherVideo) throw new Error('Choose an available screensaver source.');
  if (!Number.isInteger(pace) || ![10, 20, 40].includes(pace)) throw new Error('Choose a screensaver pace.');
  const root = await mkdtemp(join(directory, 'onto-ambient-'));
  await chmod(root, 0o700);
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const requested = (slides || []).slice(0, 18);
    const captured = requested.length ? await capture(requested, signal) : [];
    // Capture returns null for a slide it could not render; keep slides and frames paired.
    const chosen = requested.filter((_, i) => captured[i]);
    const frames = captured.filter(Boolean);
    signal?.throwIfAborted();
    if (!frames.length && !weatherVideo) throw new Error('No screensaver frames could be prepared.');
    const segments = [];
    if (weatherVideo) {
      if (!(weatherVideo.durationSeconds >= 4 && weatherVideo.durationSeconds <= 120)) throw new Error('Weather animation has an unsupported duration.');
      const path = join(root, 'weather.mp4');
      await copyFile(weatherVideo.path, path);
      segments.push({ kind:'film', path, durationSeconds:weatherVideo.durationSeconds });
    }
    for (const [i, frame] of frames.entries()) {
      await writeFile(join(root, `frame-${i}.png`), frame, { mode: 0o600 });
      segments.push({ ...chosen[i], path:join(root, `frame-${i}.png`) });
    }
    const cycle = join(root, 'cycle.mp4');
    const inputs = [];
    for (let i = 0; i <= segments.length; i++) {
      const segment = segments[i % segments.length];
      if (segment.kind !== 'film') inputs.push('-loop', '1', '-framerate', '24');
      inputs.push('-i', segment.path);
    }
    const cycleSeconds = segments.reduce((sum, segment) => sum + (segment.durationSeconds ? segment.durationSeconds - 2 : pace), 0);
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-filter_complex_threads', '1', '-filter_complex', ambientAnimationGraph(segments, pace),
      '-map', '[out]', '-map', `${segments.length + 1}:a`, '-t', String(cycleSeconds), '-r', '24',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '24', '-threads', '2',
      '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-level', '3.1', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', cycle], { signal, timeoutMs: 180_000 });
    const path = join(root, 'Screensaver.mp4');
    const segmentSeconds = cycleSeconds * Math.max(1, Math.round(Math.max(30, Math.min(600, seconds)) / cycleSeconds));
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', cycle,
      '-t', String(segmentSeconds), '-c', 'copy', '-movflags', '+faststart', path],
    { signal, timeoutMs: 30_000 });
    signal?.throwIfAborted();
    // The playable file is all that is retained for the current/next segment.
    await Promise.all([...frames.keys()].map(i => rm(join(root, `frame-${i}.png`))));
    await rm(cycle);
    if (weatherVideo) await rm(join(root, 'weather.mp4'));
    return { path, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
