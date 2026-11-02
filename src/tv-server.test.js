import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary, createTvServer, isHomeAddress, isHomeHost, layeredHistory, parseRange } from './tv-server.js';
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
  for (const host of ['192.168.1.20:8686', 'localhost:8686', 'iantodds-macbook-air.local:8686', '[fd7a::1]:8686',
    'iantodds-macbook-air.tail8cd07b.ts.net', 'm2']) assert.equal(isHomeHost(host), true, host);
  for (const host of ['evil.example.com', 'evil.example.com:8686', 'a.b.local.evil.com', '']) assert.equal(isHomeHost(host), false, host);
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

test('home is channel-first and the youngest viewer sets the ceiling', async () => {
  const { library } = await setup();
  const home = library.home();
  assert.equal(home.ceiling, 'G');
  assert.deepEqual(home.viewers.map(person => [person.id, person.name, person.on]), [
    ['sam', 'Sam', true], ['jake', 'Jake', true], ['mum', 'Mum', true], ['dad', 'Dad', true],
  ]);
  assert.deepEqual(home.channels.map(channel => [channel.number, channel.id, channel.name]), [[1, 'cartoons', 'Cartoons']]);
  assert.equal(home.channels[0].now.show, 'Bluey');
  assert.equal(home.channels[0].now.art, '/art?src=Bluey%2Fa.mp4');
  assert.equal(home.shows, undefined);
  assert.equal(home.continueWatching, undefined);

  const dad = library.home('dad');
  assert.equal(dad.ceiling, 'M');
  assert.deepEqual(dad.viewers.map(person => person.on), [false, false, false, true]);
  assert.deepEqual(dad.channels.map(channel => channel.id), ['cartoons', 'movies']);
  assert.equal(dad.channels.find(channel => channel.id === 'movies').now.show, 'Films');

  const withSam = library.home('sam,dad');
  assert.equal(withSam.ceiling, 'G');
  assert.equal(withSam.channels.some(channel => channel.id === 'movies'), false);

  const nobody = library.home('');
  assert.equal(nobody.ceiling, null);
  assert.equal(nobody.channels.length, 0);
  assert.ok(nobody.viewers.every(person => person.on === false));
});

test('a channel only offers titles under the ceiling and learns on the audience key', async () => {
  const { library, storage } = await setup();
  for (let i = 0; i < 10; i++) assert.ok(['shared', 'preschool'].includes(library.next('cartoons', { viewers: 'sam' }).tier));
  library.next('cartoons', { viewers: 'sam,dad', current: 'Bluey/a.mp4', reason: 'skip', time: 60, watched: 60, duration: 420 });
  const weights = JSON.parse(storage.getItem('kidshuffle.weights.v2.scartoons'));
  assert.ok(weights['Bluey/a.mp4'] < 1, 'a minute watched then skipped is a dislike');
  assert.equal(storage.getItem('kidshuffle.weights.v2.sgrown'), null, 'a child in the room does not write Dad\'s taste');
  library.next('cartoons', { viewers: 'sam', current: 'Bluey/b.mp4', reason: 'skip', time: 1, watched: 1, duration: 420 });
  assert.equal(JSON.parse(storage.getItem('kidshuffle.weights.v2.scartoons'))['Bluey/b.mp4'], undefined, 'surfing teaches nothing');
  assert.throws(() => library.next('movies'), /empty/);
  assert.throws(() => library.next('nope'), /Unknown channel/);
});

test('adults use the existing taste keys and hidden genres stay hidden', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const catalogue = [
    ...videos,
    { src: 'Older/o.mp4', file: '/m/Older/o.mp4', title: 'Older Show', channel: 'Older Show', tier: 'older', duration: 1200 },
    { src: 'Big/b.mp4', file: '/m/Big/b.mp4', title: 'Big Show', channel: 'Big Show', tier: 'big', duration: 600 },
    { src: 'Sitcom/s.mp4', file: '/m/Sitcom/s.mp4', title: 'Sitcom', channel: 'The Sitcom', tier: 'sitcom', duration: 1300 },
    { src: 'Music/m.mp4', file: '/m/Music/m.mp4', title: 'Song', channel: 'Music', tier: 'music', duration: 200 },
    { src: 'Bluey/xmas.mp4', file: '/m/Bluey/xmas.mp4', title: 'Christmas Episode', channel: 'Bluey', tier: 'shared', duration: 420 },
    { src: 'Hop Hop the Owl/h.mp4', file: '/m/Hop Hop the Owl/h.mp4', title: 'Hop Hop Episode', channel: 'Hop Hop the Owl', tier: 'preschool', duration: 300 },
    { src: 'Sci/s.mp4', file: '/m/Sci/s.mp4', title: 'Sci-Fi', channel: 'Sci-Fi Show', tier: 'scifi', duration: 2400 },
    { src: 'Anim/a.mp4', file: '/m/Anim/a.mp4', title: 'Adult Cartoon', channel: 'Adult Cartoon', tier: 'adultanim', duration: 1300 },
  ];
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => 0 });
  const sam = library.home('sam');
  assert.equal(sam.ceiling, 'G');
  assert.deepEqual(sam.channels.map(channel => channel.id), ['cartoons', 'music', 'christmas', 'hophop']);
  assert.deepEqual(library.next('hophop', { viewers: 'sam' }).show, 'Hop Hop the Owl');
  const jake = library.home('jake');
  assert.equal(jake.ceiling, 'PG');
  assert.ok(jake.channels.find(channel => channel.id === 'cartoons'));
  assert.equal(jake.channels.some(channel => channel.id === 'sitcoms'), false);
  assert.equal(library.next('cartoons', { viewers: 'jake' }).tier === 'older', false);
  const adults = library.home('mum,dad');
  assert.equal(adults.ceiling, 'M');
  for (const id of ['cartoons', 'movies', 'sitcoms', 'music', 'christmas']) assert.ok(adults.channels.some(channel => channel.id === id), id);

  library.next('movies', { viewers: 'dad', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sgrown'))['Films/d.mkv'] < 1);
  library.next('movies', { viewers: 'mum', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.smum'))['Films/d.mkv'] < 1);
  library.next('movies', { viewers: 'mum,dad', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sboth'))['Films/d.mkv'] < 1);
  assert.equal(library.home('dad').channels.find(channel => channel.id === 'movies').now.show === 'Sci-Fi Show'
    || library.home('dad').channels.find(channel => channel.id === 'movies').now.show === 'Films', true);
});

test('progress: surfing is not history, a real watch resumes', async () => {
  const { library } = await setup();
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 10, durationSeconds: 420, completed: false }), false);
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 200, durationSeconds: 420, completed: false }), true);
  const resumed = library.next('cartoons', { viewers: 'sam' });
  assert.equal(resumed.src, 'Bluey/a.mp4');
  assert.equal(resumed.resume, 200);
  library.progress({ src: 'Bluey/a.mp4', positionSeconds: 0, durationSeconds: 420, completed: true });
  for (let i = 0; i < 6; i++) {
    const item = library.next('cartoons', { viewers: 'sam' });
    if (item.src === 'Bluey/a.mp4') assert.equal(item.resume, 0);
  }
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
    assert.equal((await post({ channel: 'cartoons' })).status, 200);
    assert.equal((await fetch(`${base}/api/next?channel=cartoons`)).status, 404, 'GET must not change taste');
    assert.equal((await post({ channel: 'cartoons' }, { Origin: 'http://evil.example' })).status, 403);
    const paired = await post({ channel: 'cartoons' }, { Origin: 'file://', 'X-Onto-Token': 'secret' });
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get('access-control-allow-origin'), 'file://');
    assert.equal((await fetch(`${base}/api/home`, { headers: { Origin: 'null' } })).status, 403);
    assert.equal((await fetch(`${base}/api/home?t=secret`, { headers: { Origin: 'null' } })).status, 403, 'URL token only for files');
    assert.equal((await fetch(`${base}/media?src=${encodeURIComponent('Bluey/a.mp4')}&t=secret`, { headers: { Origin: 'null' } })).status, 200);
    assert.equal((await fetch(`${base}/api/home`)).headers.get('access-control-allow-origin'), null);
    const dadHome = await (await fetch(`${base}/api/home?viewers=dad`)).json();
    assert.equal(dadHome.ceiling, 'M');
    assert.equal(dadHome.viewers.find(person => person.id === 'dad').on, true);
    assert.equal(dadHome.viewers.find(person => person.id === 'sam').on, false);
    assert.ok(dadHome.channels.some(channel => channel.id === 'cartoons' && channel.now.show === 'Bluey'));
    const narrowed = await (await fetch(`${base}/api/home?viewers=sam`)).json();
    assert.equal(narrowed.ceiling, 'G');
    assert.equal(narrowed.channels.some(channel => channel.id === 'movies'), false);
    assert.equal((await fetch(`${base}/api/progress`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('diagnostics always requires the pairing token, including same-origin and no-origin requests', async () => {
  const { dir, history, storage, library } = await setup();
  await writeFile(join(dir, 'index.html'), 'ok');
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ session: 'abc', event: 'playing', build: 'test', page: 'player', engine: 'video',
    position: 1, duration: 10, paused: false, hidden: false, state: 'playing', server: 'http://spoof/path' });
  try {
    assert.equal((await fetch(`${base}/api/diagnostics`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 403);
    assert.equal((await fetch(`${base}/api/diagnostics`, { headers: { Origin: `http://${server.address().address}` } })).status, 403);
    const posted = await fetch(`${base}/api/diagnostics`, { method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-Onto-Token': 'secret' } });
    assert.equal(posted.status, 200);
    const snapshot = await fetch(`${base}/api/diagnostics`, { headers: { 'X-Onto-Token': 'secret' } }).then(response => response.json());
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].server, undefined);
    assert.equal((await fetch(`${base}/api/diagnostics`, { method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json', 'X-Onto-Token': 'secret' } })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('diagnostics reject an empty configured token', async () => {
  const { dir, history, storage, library } = await setup();
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/diagnostics`, { headers: { 'X-Onto-Token': '' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('serves the games page and wasm from a subfolder', async () => {
  const { dir, history, storage, library } = await setup();
  await mkdir(join(dir, 'games'));
  await writeFile(join(dir, 'games', 'index.html'), '<!doctype html>games');
  await writeFile(join(dir, 'games', 'number-snake.wasm'), Buffer.from([0, 97, 115, 109]));
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(`${base}/games/`)).text(), '<!doctype html>games');
    const wasm = await fetch(`${base}/games/number-snake.wasm`);
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal((await wasm.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(`${base}/games/../../package.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('grown-up serials play in order on the TV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const episode = n => ({ src: `MobLand/MobLand S01E0${n}.mp4`, file: `/m/MobLand/MobLand S01E0${n}.mp4`,
    title: `MobLand S01E0${n}`, channel: 'MobLand', tier: 'grownup', duration: 3000 });
  const serial = [episode(5), episode(7), episode(8), episode(6)];
  // A middling random draw would shuffle to a later episode.
  const library = createTvLibrary({ videos: serial, history, storage, random: () => 0.6 });
  // Nothing watched yet: the first episode on disk.
  assert.equal(library.next('movies', { viewers: 'dad' }).title, 'MobLand S01E05');
  // Part-way through E05: the shuffle still lands on it.
  history.set(serial[0].file, { title: 'E05', positionSeconds: 600, durationSeconds: 3000 });
  assert.equal(library.next('movies', { viewers: 'dad' }).title, 'MobLand S01E05');
  // Finishing E05 plays E06, not the shuffle's choice.
  assert.equal(library.next('movies', { viewers: 'dad', current: serial[0].src, reason: 'ended', time: 3000, watched: 2400, duration: 3000 }).title,
    'MobLand S01E06');
});

test('the TV picks up where the Mac app stopped, and the newer place wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const own = await loadPlaybackHistory(join(dir, 'tv.json'));
  const app = await loadPlaybackHistory(join(dir, 'app.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const episode = n => ({ src: `MobLand/MobLand S01E0${n}.mp4`, file: `/m/MobLand/MobLand S01E0${n}.mp4`,
    title: `MobLand S01E0${n}`, channel: 'MobLand', tier: 'grownup', duration: 2500 });
  const serial = [5, 6, 7, 8].map(episode);
  const history = layeredHistory(own, () => [app]);
  const library = createTvLibrary({ videos: serial, history, storage, random: () => 0 });
  // Watched E06 and E07 to the credits on the laptop: the TV goes on to E08.
  app.set(serial[0].file, { title: 'E05', positionSeconds: 5, durationSeconds: 2500 });
  app.set(serial[1].file, { title: 'E06', positionSeconds: 2440, durationSeconds: 2500 });
  app.set(serial[2].file, { title: 'E07', positionSeconds: 2444, durationSeconds: 2500 });
  app.set(serial[3].file, { title: 'E08', positionSeconds: 900, durationSeconds: 2500 });
  const next = library.next('movies', { viewers: 'dad' });
  assert.equal(next.title, 'MobLand S01E08');
  assert.equal(next.resume, 900);
  // Then watched further on the TV: its newer place wins; the app's file is untouched.
  await new Promise(resolve => setTimeout(resolve, 5));
  library.progress({ src: serial[3].src, positionSeconds: 1500, durationSeconds: 2500, completed: false });
  assert.equal(library.next('movies', { viewers: 'dad' }).resume, 1500);
  assert.equal(app.get(serial[3].file), 900);
});


test('a Bluey seed continues across the kids channel without selecting adult content', async () => {
  const { history, storage } = await setup();
  const library = createTvLibrary({ videos, history, storage, random: () => 0.99 });
  let current = videos[0];
  const shows = new Set();
  for (let n = 0; n < 12; n++) {
    const next = library.next('cartoons', { viewers: 'sam', current: current.src, reason: 'ended', time: current.duration, watched: current.duration, duration: current.duration });
    assert.ok(['shared', 'preschool'].includes(next.tier));
    assert.notEqual(next.src, current.src);
    shows.add(next.show);
    current = next;
  }
  assert.ok(shows.has('Bing'), 'continues beyond the selected show');
});
