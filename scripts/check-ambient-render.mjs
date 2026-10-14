// Silent, offscreen Electron acceptance. Never contacts the TV.
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAmbientCapture } from '../src/ambient-capture.js';
import { createAmbientSources } from '../src/ambient-sources.js';
import { readIsobarProgramme } from '../src/weather-channel.js';
import { buildAmbientVideo } from '../src/ambient-video.js';
import { probeFile } from '../casting/src/pipeline.js';
import { isSamsungCompatible } from '../casting/src/probe.js';
import assert from 'node:assert/strict';
app.commandLine.appendSwitch('mute-audio');
app.disableHardwareAcceleration();
app.dock?.hide();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
 let video;
 try {
  await mkdir(resolve('audit'), { recursive: true });
  const weather = await createAmbientSources().snapshot({ weather: true });
  assert.ok(weather.slides.length, weather.issues.join(' '));
  const demo = process.env.AMBIENT_DEMO === '1';
  const slides = demo ? weather.slides : [weather.slides[0],
    { kind:'news', eyebrow:'Preview', title:'A calm screen for the room', detail:'Animation test', footer:'Test content · no TV playback' },
    { kind:'photo', image:pathToFileURL(resolve('brand/onto-the-tv-icon.png')).href, title:'Photo 1', footer:'Local image test' }];
  const capture = createAmbientCapture({ BrowserWindow, appRoot: resolve('.') });
  const frames = await capture(slides);
  for (const [i, frame] of frames.entries()) await writeFile(resolve(`audit/ambient-frame-${i}.png`), frame);
  if (frames.length > 1) assert.notDeepEqual(frames[0], frames[1]);
  const programme = await readIsobarProgramme();
  video = await buildAmbientVideo({ slides, pace:demo ? 20 : 10, seconds:40, capture:async()=>frames, weatherVideo:programme });
  const metadata = await probeFile('ffprobe', video.path);
  assert.ok(isSamsungCompatible(metadata), 'Encoded animation must take the direct Samsung playback path');
  await copyFile(video.path, resolve(demo ? 'audit/weather-channel-preview.mp4' : 'audit/ambient-motion.mp4'));
  console.log(`Offscreen Electron frames and animated H.264/AAC TV video verified${programme ? ', including the published Isobar weather film' : ''}.`);
 } finally { await video?.cleanup(); }
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
