import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary, createTvServer, fileWantsRecordedAds } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';
import {
  analyseMedia, chaptersFromProbe, clusterAdBreaks, createSceneStore, ffmpegBlackArgs, ffmpegSceneArgs,
  indexCatalogue, parseBlackdetect, parseComskip, scenePaths, thinCuts,
} from './scenes.js';

test('chapters win, scene cuts stay 20 s apart, and black frames are kept', () => {
  const chapter = chaptersFromProbe({
    chapters: [
      { start_time: '0', end_time: '30', tags: { title: 'Intro' } },
      { start_time: '10', end_time: '15', tags: { title: 'Cold open' } },
      { start_time: '15', end_time: '600', tags: { title: 'Episode' } },
      { start_time: '600', end_time: '660', tags: { title: 'Credits' } },
      { start_time: '660', end_time: '690', tags: { title: 'Self-promo' } },
    ],
  });
  assert.equal(chapter.chapters, true);
  assert.deepEqual(chapter.cuts, [10, 15, 600, 660]);
  assert.deepEqual(chapter.segments, [
    { start: 0, end: 30, kind: 'intro' },
    { start: 600, end: 660, kind: 'credits' },
    { start: 660, end: 690, kind: 'selfpromo' },
  ]);
  assert.deepEqual(thinCuts([10, 15.5, 40.2, 70]), [10, 40.2, 70]);
  assert.deepEqual(parseBlackdetect('black_start:12.5 black_end:13.1 black_duration:0.6\nblack_start:400\n'), [12.5, 400]);
  assert.deepEqual(parseComskip('120.00\t180.50\t3\n200 210 2\n'), [{ start: 120, end: 180.5, kind: 'ad' }]);
  assert.deepEqual(clusterAdBreaks([10, 100, 130, 155, 500], [10.2, 100.2, 129.2, 155.4, 800]), [
    { start: 100, end: 155, kind: 'ad' },
  ]);
  assert.deepEqual(clusterAdBreaks([100, 115], [100, 115]), [{ start: 100, end: 115, kind: 'ad' }]);
  assert.deepEqual(clusterAdBreaks([100, 160], [100, 160]), [{ start: 100, end: 160, kind: 'ad' }]);
  assert.deepEqual(clusterAdBreaks([100, 161], [100, 161]), []);
});

test('a file with chapters is not scene-detected, and recorded ads use comskip then silence', async () => {
  const calls = [];
  const work = await mkdtemp(join(tmpdir(), 'onto-comskip-'));
  const record = await analyseMedia('/v/Show.mp4', {
    execute: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'ffprobe') {
        return { stdout: JSON.stringify({ chapters: [{ start_time: '0', end_time: '12', tags: { title: 'Intro' } }, { start_time: '12', end_time: '40', tags: { title: 'Part' } }] }) };
      }
      if (args.includes('blackdetect=d=0.3:pix_th=0.1')) return { stderr: 'black_start:20 black_end:20.4 black_duration:0.4\n' };
      throw new Error(`unexpected ${cmd}`);
    },
  });
  assert.equal(record.chapters, true);
  assert.deepEqual(record.cuts, [12]);
  assert.deepEqual(record.blacks, [20]);
  assert.deepEqual(record.segments, [{ start: 0, end: 12, kind: 'intro' }]);
  assert.equal(calls.some(call => call[1].indexOf(ffmpegSceneArgs('/v/Show.mp4')[4]) >= 0), false);

  calls.length = 0;
  const detected = await analyseMedia('/v/Tape.mp4', {
    recordedAds: true,
    workDir: work,
    comskip: 'comskip',
    execute: async (cmd, args) => {
      calls.push(args.join(' '));
      if (cmd === 'ffprobe') return { stdout: '{"chapters":[]}' };
      if (String(cmd).includes('comskip')) {
        const ini = args.find(arg => arg.startsWith('--ini=')).slice(6);
        await writeFile(join(work, 'Tape.edl'), '15 45 0\n');
        assert.equal(ini.startsWith(work), true);
        return { stdout: '' };
      }
      if (args.includes('blackdetect=d=0.3:pix_th=0.1')) return { stderr: 'black_start:15\n' };
      if (args.join(' ').includes("select='gt(scene,0.35)'")) return { stderr: 'pts_time:10\npts_time:18\npts_time:50\n' };
      throw new Error(args.join(' '));
    },
  });
  assert.equal(detected.chapters, false);
  assert.deepEqual(detected.cuts, [10, 50]);
  assert.deepEqual(detected.segments, [{ start: 15, end: 45, kind: 'ad' }]);
  assert.equal(calls.some(line => line.includes('silencedetect')), false);
  assert.deepEqual(ffmpegBlackArgs('/v/Tape.mp4').slice(0, 5), ['-hide_banner', '-i', '/v/Tape.mp4', '-vf', 'blackdetect=d=0.3:pix_th=0.1']);
});

test('the walker skips a current index and does not overlap files', async () => {
  let active = 0;
  let maxActive = 0;
  const writes = [];
  const result = await indexCatalogue([
    { file: '/v/a.mp4', src: 'a.mp4', tier: 'shared' },
    { file: '/v/b.mp4', src: 'b.mp4', tier: 'sports' },
    { file: '/v/c.mp4', src: 'c.mp4', tier: 'shared' },
  ], {
    stat: async () => ({ size: 10, mtimeMs: 5, isFile: () => true }),
    read: async file => (file.endsWith('/a.mp4') ? { size: 10, mtimeMs: 5, cuts: [1] } : null),
    indexOne: async file => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      if (file.endsWith('/c.mp4')) throw new Error('unreadable');
      return { chapters: false, cuts: [4], blacks: [8], segments: [] };
    },
    write: async (file, record) => { writes.push([file, record.points]); },
    recordedAds: fileWantsRecordedAds,
  });
  assert.deepEqual(result, { indexed: 1, skipped: 1, failed: 1 });
  assert.equal(maxActive, 1);
  assert.deepEqual(writes, [['/v/b.mp4', [0, 4]]]);
  assert.equal(fileWantsRecordedAds({ src: 'Game/a.mp4', tier: 'sports' }), true);
  assert.equal(fileWantsRecordedAds({ src: 'Bluey/a.mp4', tier: 'shared' }), false);
});

test('GET /api/scenes returns cuts, thumbs, chapters, segments and blacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-scenes-'));
  const file = join(dir, 'clip.mp4');
  await writeFile(file, Buffer.alloc(32, 1));
  const info = await stat(file);
  const store = createSceneStore(join(dir, 'scenes'));
  store.save(file, {
    version: 1, size: info.size, mtimeMs: info.mtimeMs, chapters: true,
    cuts: [12, 40], blacks: [100], points: [0, 12, 40],
    segments: [{ start: 0, end: 8, kind: 'intro' }, { start: 50, end: 70, kind: 'ad' }, { start: 1, end: 2, kind: 'nope' }],
  });
  const thumbs = scenePaths(join(dir, 'scenes'), file).thumbs;
  await mkdir(thumbs, { recursive: true });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(join(thumbs, '0.jpg'), jpeg);
  await writeFile(join(thumbs, '1.jpg'), jpeg);
  await writeFile(join(thumbs, '2.jpg'), jpeg);
  store.save(file, { version: 1, size: 1, mtimeMs: 1, chapters: true, cuts: [9], blacks: [], segments: [], points: [0, 9] });
  assert.deepEqual(store.api(file, 'Bluey/a.mp4').cuts, []);
  store.save(file, {
    version: 1, size: info.size, mtimeMs: info.mtimeMs, chapters: true,
    cuts: [12, 40], blacks: [100], points: [0, 12, 40],
    segments: [{ start: 0, end: 8, kind: 'intro' }, { start: 50, end: 70, kind: 'ad' }],
  });

  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({
    videos: [{ src: 'Bluey/a.mp4', file, title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 }],
    history, storage,
  });
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret', sceneStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = await (await fetch(`${base}/api/scenes?src=${encodeURIComponent('Bluey/a.mp4')}`)).json();
    assert.deepEqual(body.cuts, [12, 40]);
    assert.equal(body.chapters, true);
    assert.deepEqual(body.blacks, [100]);
    assert.deepEqual(body.segments, [{ start: 0, end: 8, kind: 'intro' }, { start: 50, end: 70, kind: 'ad' }]);
    assert.deepEqual(body.thumbs.map(url => url.includes('i=1')), [false, true, false]);
    const thumb = await fetch(`${base}${body.thumbs[0]}`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    assert.equal((await thumb.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(`${base}/api/scenes?src=${encodeURIComponent('missing')}`)).status, 404);
    const blocked = await fetch(`${base}/scene-thumb?src=${encodeURIComponent('Bluey/a.mp4')}&i=0`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(blocked.status, 403);
    const paired = await fetch(`${base}/scene-thumb?src=${encodeURIComponent('Bluey/a.mp4')}&i=0&t=secret`, { headers: { Origin: 'file://' } });
    assert.equal(paired.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
