import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeStreams, macPlan, nextEpisode, trackLabel, prepareArgs, createMacMedia } from './mac-media.js';

const run = promisify(execFile);

const probe = (container, video, audio, subtitles = []) => describeStreams({
  format: { format_name: container, duration: '1200.5' },
  streams: [
    ...(video ? [{ codec_type: 'video', codec_name: video }] : []),
    ...audio.map(([codec, language, channels, isDefault]) => ({ codec_type: 'audio', codec_name: codec, channels,
      tags: { language }, disposition: { default: isDefault ? 1 : 0 } })),
    ...subtitles.map(([codec, language]) => ({ codec_type: 'subtitle', codec_name: codec, tags: { language } })),
  ],
});

test('files Chromium plays are played as they are', () => {
  assert.equal(macPlan(probe('matroska,webm', 'h264', [['aac', 'eng', 2, true]])).direct, true);
  assert.equal(macPlan(probe('mov,mp4,m4a,3gp,3g2,mj2', 'hevc', [['aac', 'eng', 6, true]])).direct, true);
});

test('unplayable audio, containers and video are converted only as far as needed', () => {
  assert.deepEqual(macPlan(probe('matroska,webm', 'h264', [['ac3', 'eng', 6, true]])), { direct: false, video: 'copy', audio: 'aac', track: 0 });
  assert.deepEqual(macPlan(probe('mpegts', 'h264', [['aac', 'eng', 2, true]])), { direct: false, video: 'copy', audio: 'copy', track: 0 });
  assert.deepEqual(macPlan(probe('avi', 'mpeg4', [['mp3', '', 2, true]])), { direct: false, video: 'h264', audio: 'copy', track: 0 });
});

test('the default audio track is chosen and a playable second track stays direct', () => {
  const info = probe('matroska,webm', 'h264', [['ac3', 'eng', 6, false], ['aac', 'jpn', 2, true]]);
  assert.deepEqual(macPlan(info), { direct: true, video: 'copy', audio: 'copy', track: 1 });
  assert.equal(macPlan(info, 0).direct, false);
  assert.deepEqual(prepareArgs('/in.mkv', '/out.mkv', macPlan(info, 0)).slice(5, 9), ['-map', '0:V:0?', '-map', '0:a:0']);
});

test('track labels name the language and channel layout', () => {
  assert.equal(trackLabel({ lang: 'eng', channels: 6 }, 0), 'English · 5.1');
  assert.equal(trackLabel({ lang: 'jpn', title: 'Commentary', channels: 2 }, 1), 'Japanese · Commentary · stereo');
  assert.equal(trackLabel({ lang: 'und' }, 2), 'Track 3');
});

test('next episode follows the folder, then the next season folder; films have none', () => {
  const items = [
    '/tv/Bluey/Season 1/Bluey S01E10.mkv', '/tv/Bluey/Season 1/Bluey S01E2.mkv', '/tv/Bluey/Season 1/Bluey S01E1.mkv',
    '/tv/Bluey/Season 2/Bluey S02E1.mkv', '/tv/Other/Other S01E1.mkv',
  ].map(path => ({ path, title: path.split('/').pop(), kind: 'show' }));
  items.push({ path: '/films/Up (2009).mp4', title: 'Up', kind: 'film' }, { path: '/films/Cars (2006).mp4', title: 'Cars', kind: 'film' });
  assert.equal(nextEpisode(items, '/tv/Bluey/Season 1/Bluey S01E2.mkv').path, '/tv/Bluey/Season 1/Bluey S01E10.mkv');
  assert.equal(nextEpisode(items, '/tv/Bluey/Season 1/Bluey S01E10.mkv').path, '/tv/Bluey/Season 2/Bluey S02E1.mkv');
  assert.equal(nextEpisode(items, '/tv/Bluey/Season 2/Bluey S02E1.mkv'), null);
  assert.equal(nextEpisode(items, '/films/Cars (2006).mp4'), null);
});

test('real files: AC3 audio and AVI convert, subtitles extract, cache is reused', async t => {
  try { await run('ffmpeg', ['-version']); } catch { t.skip('ffmpeg is unavailable'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'onto-mac-media-'));
  try {
    const srt = join(dir, 'subs.srt');
    await writeFile(srt, '1\n00:00:00,500 --> 00:00:01,500\nHello there\n');
    const source = ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=f=440'];
    const mkv = join(dir, 'Show S01E01.mkv');
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...source, '-i', srt, '-map', '0', '-map', '1', '-map', '2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-t', '2', mkv]);
    const avi = join(dir, 'Old.avi');
    await run('ffmpeg', ['-y', '-loglevel', 'error', ...source, '-map', '0', '-map', '1', '-c:v', 'mpeg4', '-c:a', 'mp3', '-t', '2', avi]);
    await writeFile(join(dir, 'Show S01E01.en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nSidecar\n');

    const media = createMacMedia({ directory: join(dir, 'ready') });
    const opened = await media.open(mkv);
    assert.equal(opened.direct, false);
    assert.equal(opened.convert, 'audio');
    assert.deepEqual(opened.audio.map(track => track.label), ['English · mono']);
    assert.deepEqual(opened.subtitles.map(track => track.id), ['file:Show S01E01.en.srt', 'embedded:0']);
    assert.match(await media.subtitle(mkv, 'embedded:0'), /WEBVTT[\s\S]*Hello there/);
    assert.match(await media.subtitle(mkv, 'file:Show S01E01.en.srt'), /Sidecar/);
    await assert.rejects(media.subtitle(mkv, 'embedded:5'));

    const progress = [];
    const ready = await media.prepare(mkv, 0, fraction => progress.push(fraction));
    assert.equal(ready.direct, false);
    assert.equal(progress.at(-1), 1);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', ready.path]);
    assert.deepEqual(stdout.trim().split('\n'), ['h264', 'aac']);
    assert.equal((await media.prepare(mkv, 0)).path, ready.path);

    const old = await media.prepare(avi, 0);
    const converted = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', old.path]);
    assert.deepEqual(converted.stdout.trim().split('\n'), ['h264', 'mp3']);
    assert.equal((await readdir(join(dir, 'ready'))).filter(name => name.endsWith('.part')).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
