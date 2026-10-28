import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary, createTvServer, isHomeAddress, isHomeHost, parseRange } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';

const videos = [
  { src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 },
  { src: 'Bluey/b.mp4', file: '/m/Bluey/b.mp4', title: 'B', channel: 'Bluey', tier: 'shared', duration: 420 },
  { src: 'Bing/c.mp4', file: '/m/Bing/c.mp4', title: 'C', channel: 'Bing', tier: 'preschool', duration: 300 },
  { src: 'Films/d.mkv', file: '/m/Films/d.mkv', title: 'D', channel: 'Films', tier: 'grownup', duration: 6000 },
];

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  return { dir, history, storage, library: createTvLibrary({ videos, history, storage, random: () => 0 }) };
}

test('only home-network addresses are served', () => {
  for (const address of ['127.0.0.1', '::1', '192.168.20.14', '::ffff:10.0.0.5', '172.20.1.1', '100.96.209.126', 'fd7a:115c::1', 'fe80::1'])
    assert.equal(isHomeAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::1', '', undefined])
    assert.equal(isHomeAddress(address), false, String(address));
});

test('only this Mac\'s own names are accepted as Host', () => {
  for (const host of ['192.168.1.20:8765', 'localhost:8765', 'iantodds-macbook-air.local:8765', '[fd7a::1]:8765',
    'iantodds-macbook-air.tail8cd07b.ts.net', 'm2']) assert.equal(isHomeHost(host), true, host);
  for (const host of ['evil.example.com', 'evil.example.com:8765', 'a.b.local.evil.com', '']) assert.equal(isHomeHost(host), false, host);
});

test('byte ranges', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true });
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=0-1,5-6', 1000), null);
});

test('home lists non-empty channels and shows with counts', async () => {
  const { library } = await setup();
  const home = library.home();
  assert.deepEqual(home.channels.map(channel => [channel.id, channel.count]), [['2', 3], ['6', 2], ['grown', 1], ['all', 4]]);
  assert.deepEqual(home.shows.map(show => [show.name, show.count]), [['Bing', 1], ['Bluey', 2], ['Films', 1]]);
});

test('a channel only picks from its own tiers and learns from a real rejection', async () => {
  const { library, storage } = await setup();
  for (let i = 0; i < 10; i++) assert.ok(['shared', 'preschool'].includes(library.next('2').tier));
  library.next('2', { current: 'Bluey/a.mp4', reason: 'skip', time: 60, watched: 60, duration: 420 });
  const weights = JSON.parse(storage.getItem('kidshuffle.weights.v2.s2'));
  assert.ok(weights['Bluey/a.mp4'] < 1, 'a minute watched then skipped is a dislike');
  library.next('2', { current: 'Bluey/b.mp4', reason: 'skip', time: 1, watched: 1, duration: 420 });
  assert.equal(JSON.parse(storage.getItem('kidshuffle.weights.v2.s2'))['Bluey/b.mp4'], undefined, 'surfing teaches nothing');
  assert.throws(() => library.next('nope'), /Unknown channel/);
});

test('progress: surfing is not history, a real watch resumes', async () => {
  const { library } = await setup();
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 10, durationSeconds: 420, completed: false }), false);
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 200, durationSeconds: 420, completed: false }), true);
  assert.deepEqual(library.home().continueWatching.map(item => [item.src, item.resume]), [['Bluey/a.mp4', 200]]);
  library.progress({ src: 'Bluey/a.mp4', positionSeconds: 0, durationSeconds: 420, completed: true });
  assert.equal(library.home().continueWatching.length, 0);
});

test('server streams only catalogue files and serves the UI', async () => {
  const { dir, history, storage } = await setup();
  const file = join(dir, 'clip.mp4');
  await writeFile(file, Buffer.alloc(1000, 7));
  await writeFile(join(dir, 'index.html'), '<!doctype html>ok');
  const library = createTvLibrary({ videos: [{ ...videos[0], file }], history, storage });
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const part = await fetch(`${base}/media?src=${encodeURIComponent('Bluey/a.mp4')}`, { headers: { Range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${base}/media?src=${encodeURIComponent('/etc/passwd')}`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fclip.mp4`)).status, 404);
    assert.equal(await (await fetch(`${base}/`)).text(), '<!doctype html>ok');
    const post = (body, headers = {}) => fetch(`${base}/api/next`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal((await post({ channel: 'all' })).status, 200);
    assert.equal((await fetch(`${base}/api/next?channel=all`)).status, 404, 'GET must not change taste');
    assert.equal((await post({ channel: 'all' }, { Origin: 'http://evil.example' })).status, 403);
    const paired = await post({ channel: 'all' }, { Origin: 'file://', 'X-Onto-Token': 'secret' });
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get('access-control-allow-origin'), 'file://');
    assert.equal((await fetch(`${base}/api/home`, { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await fetch(`${base}/api/home`)).headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${base}/api/progress`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
