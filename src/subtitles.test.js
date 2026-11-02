import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary, createTvServer } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';
import { matchingSidecars, readSubtitle, srtToVtt } from './subtitles.js';

test('srt cues become webvtt and keep their text', () => {
  const vtt = srtToVtt('1\n00:00:01,000 --> 00:00:04,000\nHello\nthere\n\n2\n00:01:00,500 --> 00:01:02,000\nNext\n');
  assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello\nthere\n\n00:01:00.500 --> 00:01:02.000\nNext\n');
  assert.equal(srtToVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
});

test('only a sidecar beside the video is served, as webvtt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-subs-'));
  const file = join(dir, 'a.mp4');
  await writeFile(file, 'video');
  await writeFile(join(dir, 'a.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  await writeFile(join(dir, 'a.vtt'), 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nThere\n');
  await writeFile(join(dir, 'other.srt'), '1\n00:00:01,000 --> 00:00:02,000\nNo\n');
  assert.deepEqual(matchingSidecars(file, ['a.en.srt', 'a.vtt', 'other.srt', '../secret.srt']), [
    { id: 'a.en.srt', label: 'en', lang: 'en' },
    { id: 'a.vtt', label: 'Subtitles', lang: '' },
  ]);
  assert.equal(await readSubtitle(file, 'a.en.srt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  await assert.rejects(() => readSubtitle(file, '../secret.srt'), /No subtitles/);
  await assert.rejects(() => readSubtitle(file, 'other.srt'), /No subtitles/);

  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({
    videos: [{ src: 'Bluey/a.mp4', file, title: 'A', channel: 'Bluey', tier: 'shared', duration: 10 }],
    history, storage,
  });
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const listed = await (await fetch(`${base}/api/subs?src=${encodeURIComponent('Bluey/a.mp4')}`)).json();
    assert.deepEqual(listed.tracks.map(track => track.id), ['a.en.srt', 'a.vtt']);
    const body = await fetch(`${base}/subs?src=${encodeURIComponent('Bluey/a.mp4')}&name=${encodeURIComponent('a.en.srt')}`);
    assert.equal(body.status, 200);
    assert.equal(body.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.equal(await body.text(), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
    const blocked = await fetch(`${base}/subs?src=${encodeURIComponent('Bluey/a.mp4')}&name=a.en.srt`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(blocked.status, 403);
    const paired = await fetch(`${base}/subs?src=${encodeURIComponent('Bluey/a.mp4')}&name=a.vtt&t=secret`, { headers: { Origin: 'file://' } });
    assert.equal(paired.status, 200);
    assert.match(await paired.text(), /^WEBVTT/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
