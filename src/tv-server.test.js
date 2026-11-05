import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TV_CHANNELS, countTvChannelVideos, createFileStorage, createTvLibrary, createTvServer, inTvGenre, isHomeAddress, isHomeHost, layeredHistory, parseRange } from './tv-server.js';
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
    ['sam', 'Sam', true], ['jake', 'Jake', true], ['mum', 'Fran', true], ['dad', 'Ian', true],
  ]);
  assert.deepEqual(home.channels.map(channel => [channel.number, channel.id, channel.name]),
    [[1, 'cartoons', 'Cartoons'], [2, 'littleones', 'Little Ones'], [3, 'bluey', 'Bluey']], 'numbered in the order shown');
  assert.equal(home.channels[0].now.show, 'Bluey');
  assert.equal(home.channels[0].count, 3, 'channels report their pool size at this ceiling');
  assert.equal(home.channels[0].now.art, '/art?src=Bluey%2Fa.mp4');
  assert.equal(home.shows, undefined);
  assert.equal(home.continueWatching, undefined);

  const dad = library.home('dad');
  assert.equal(dad.ceiling, 'M');
  assert.deepEqual(dad.viewers.map(person => person.on), [false, false, false, true]);
  assert.equal(dad.channels.some(channel => ['cartoons', 'littleones', 'bluey'].includes(channel.id)), false, 'kids\' channels live on the kids\' tabs, not a grown-up\'s');
  assert.equal(dad.channels.find(channel => channel.id === 'movies').now.show, 'D', 'a film card names the film');

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
  assert.deepEqual(sam.channels.map(channel => channel.id), ['cartoons', 'hophop', 'littleones', 'bluey', 'music', 'christmas'], 'kids see their channels first');
  assert.deepEqual(library.next('hophop', { viewers: 'sam' }).show, 'Hop Hop the Owl');
  const jake = library.home('jake');
  assert.equal(jake.ceiling, 'PG');
  assert.ok(jake.channels.find(channel => channel.id === 'cartoons'));
  assert.equal(jake.channels.some(channel => channel.id === 'sitcoms'), false);
  assert.equal(library.next('cartoons', { viewers: 'jake' }).tier === 'older', false);
  const adults = library.home('mum,dad');
  assert.equal(adults.ceiling, 'M');
  for (const id of ['movies', 'sitcoms', 'music']) assert.ok(adults.channels.some(channel => channel.id === id), id);
  assert.equal(adults.channels.some(channel => channel.id === 'cartoons'), false, 'no kids\' channels without a child');

  library.next('movies', { viewers: 'dad', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sgrown'))['Films/d.mkv'] < 1);
  library.next('movies', { viewers: 'mum', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.smum'))['Films/d.mkv'] < 1);
  library.next('movies', { viewers: 'mum,dad', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sboth'))['Films/d.mkv'] < 1);
  assert.equal(library.home('dad').channels.find(channel => channel.id === 'movies').now.show === 'Sci-Fi Show'
    || library.home('dad').channels.find(channel => channel.id === 'movies').now.show === 'D', true);
});

test('countTvChannelVideos uses inTvGenre and ignores ads', () => {
  const library = [
    { src: 'Bluey/a.mp4', tier: 'shared', channel: 'Bluey' },
    { src: 'Match/a.mp4', tier: 'sports', channel: 'Match' },
    { src: 'ads/80s/ad.mp4', tier: 'sports', channel: 'Match' },
  ];
  assert.equal(countTvChannelVideos(library, 'cartoons'), 1);
  assert.equal(countTvChannelVideos(library, 'sports'), 1);
  assert.equal(countTvChannelVideos(library, 'music'), 0);
});

test('Rides & Adventures matches its shows and applies a PG channel rating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const names = [
    'Knight Rider (1982)', 'The A-Team (1983)', 'The Dukes of Hazzard (1979)',
    'Airwolf (1984)', 'CHiPs (1977)', 'Baywatch (1989)', 'Top Gear',
  ];
  const rides = names.map((name, index) => ({
    src: `${name.replaceAll(' ', '_')}/episode.${index}.mp4`, file: `/m/${name}/episode.${index}.mp4`,
    title: name, channel: name, tier: 'grownup', duration: 1200,
  }));
  assert.ok(rides.every(item => inTvGenre(item, 'rides')));
  assert.ok(names.every(name => inTvGenre({ channel: name.replaceAll(' ', '.'), src: 'episode.mp4' }, 'rides')));
  assert.ok(rides.every(item => inTvGenre({ ...item, channel: '' }, 'rides')));
  assert.equal(inTvGenre({ channel: 'Top Gearbox', src: 'other.mp4' }, 'rides'), false);
  assert.equal(inTvGenre({ channel: 'Knight Rider', src: 'ads/80s/ad.mp4' }, 'rides'), false);
  const library = createTvLibrary({ videos: rides, history, storage, random: () => 0 });
  assert.equal(library.home('sam').channels.some(channel => channel.id === 'rides'), false);
  assert.ok(library.home('jake').channels.some(channel => channel.id === 'rides'));
  assert.equal(library.next('rides', { viewers: 'jake' }).show, names[0]);
  assert.throws(() => library.next('rides', { viewers: 'sam' }), /empty/);
  assert.throws(() => library.next('rides', { viewers: 'sam,jake' }), /empty/);
  const misplaced = createTvLibrary({ videos: rides.map(item => ({ ...item, tier: 'shared' })), history, storage });
  assert.equal(misplaced.home('sam').channels.some(channel => channel.id === 'rides'), false);
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
    assert.equal(dadHome.channels.some(channel => channel.id === 'cartoons'), false);
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
  assert.equal(library.next('grownups', { viewers: 'dad' }).title, 'MobLand S01E05');
  // Part-way through E05: the shuffle still lands on it.
  history.set(serial[0].file, { title: 'E05', positionSeconds: 600, durationSeconds: 3000 });
  assert.equal(library.next('grownups', { viewers: 'dad' }).title, 'MobLand S01E05');
  // Finishing E05 plays E06, not the shuffle's choice.
  assert.equal(library.next('grownups', { viewers: 'dad', current: serial[0].src, reason: 'ended', time: 3000, watched: 2400, duration: 3000 }).title,
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
  const next = library.next('grownups', { viewers: 'dad' });
  assert.equal(next.title, 'MobLand S01E08');
  assert.equal(next.resume, 900);
  // Then watched further on the TV: its newer place wins; the app's file is untouched.
  await new Promise(resolve => setTimeout(resolve, 5));
  library.progress({ src: serial[3].src, positionSeconds: 1500, durationSeconds: 2500, completed: false });
  assert.equal(library.next('grownups', { viewers: 'dad' }).resume, 1500);
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

test('taped sport is rated PG so the kids can watch it', async () => {
  const { TIER_RATINGS } = await import('./tv-server.js');
  assert.equal(TIER_RATINGS.sports, 'PG');
});

test('Movies is films only; grown-up TV has its own Mum & Dad channel', () => {
  const cdwm = { src: 'Come Dine With Me/e1.mp4', channel: 'Come Dine With Me', tier: 'grownup' };
  const couple = { src: 'Couples Come Dine With Me/e1.mp4', channel: 'Couples Come Dine With Me', tier: 'couple' };
  const bruges = { src: 'Films/In Bruges.mkv', channel: 'Films', tier: 'grownup' };
  const nemo = { src: 'Family Films/Finding Nemo.mkv', channel: 'Family Films', tier: 'shared' };
  // Grown-up films are filed one folder per film, named with the year (the M2's real layout).
  const snatch = { src: 'grown-ups/Snatch (2000)/Snatch (2000) [1080p]/Snatch.2000.1080p.mp4', channel: 'Snatch (2000)', tier: 'grownup' };
  const nile = { src: 'together/Death on the Nile (2022)/Death.on.the.Nile.2022.mp4', channel: 'Death on the Nile (2022)', tier: 'couple' };
  // A series folder named with a year is still TV when its files are episodes.
  const series = { src: 'grown-ups/Utopia (2014)/Utopia S01E01.mp4', channel: 'Utopia (2014)', tier: 'grownup' };
  const mobland = { src: 'grown-ups/Mobland/Mobland S01E05.mp4', channel: 'Mobland', tier: 'grownup' };
  for (const show of [cdwm, couple, series, mobland]) {
    assert.equal(inTvGenre(show, 'movies'), false, show.src);
    assert.equal(inTvGenre(show, 'grownups'), true, show.src);
  }
  for (const film of [bruges, nemo, snatch, nile]) {
    assert.equal(inTvGenre(film, 'movies'), true, film.src);
    assert.equal(inTvGenre(film, 'grownups'), false, film.src);
    assert.equal(inTvGenre(film, 'cartoons'), false, film.src);
  }
});

test('the people set the default rating and the rating switch overrides it either way', async () => {
  const { library } = await setup();
  const family = library.home('sam,jake,mum,dad');
  assert.equal(family.ceiling, 'G');
  assert.equal(family.defaultCeiling, 'G');
  assert.equal(family.rating, null);
  const up = library.home('sam,jake,mum,dad', 'M');
  assert.equal(up.ceiling, 'M');
  assert.equal(up.defaultCeiling, 'G');
  assert.equal(up.rating, 'M');
  assert.ok(up.channels.some(channel => channel.id === 'movies'));
  assert.equal(up.channels[0].id, 'movies', 'an M ceiling orders grown-up channels first');
  const down = library.home('dad', 'g');
  assert.equal(down.ceiling, 'G');
  assert.equal(down.channels.some(channel => channel.id === 'movies'), false);
  assert.equal(down.channels[0].id, 'cartoons');
  assert.equal(library.home('dad', 'nonsense').ceiling, 'M', 'an unknown rating is ignored');
  assert.equal(library.home('', 'M').channels.length, 0, 'nobody watching stays blocked');
  assert.equal(library.next('movies', { viewers: 'sam', rating: 'M' }).show, 'Films');
  assert.throws(() => library.next('movies', { viewers: 'dad', rating: 'G' }), /empty/);
  assert.equal(library.allowed('Films/d.mkv', 'sam'), false);
  assert.equal(library.allowed('Films/d.mkv', 'sam', 'M'), true);
});

test('the lineup splits shows into their own channels and each adult gets a personal one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const v = (show, tier, name = 'S01E01') => ({ src: `${show}/${name}.mp4`, file: `/m/${show}/${name}.mp4`, title: name, channel: show, tier, duration: 1300 });
  const catalogue = [
    v('Bing', 'preschool'), v('Bluey', 'shared'), v('Octonauts', 'shared'), v('Numberblocks', 'shared'), v('Shaun the Sheep', 'shared'),
    v('Track Time', 'big'), v('Futurama (1999)', 'adultanim'), v('Blackadder (1983)', 'bbc'), v('Friends (1994)', 'sitcom'),
    v('Seinfeld (1989)', 'sitcom'), v("Miss Fisher's Murder Mysteries", 'couple'), v('48 Hours', 'grownup'),
    v('Come Dine With Me', 'grownup'), v('In Bruges (2008)', 'grownup', 'In Bruges (2008)'),
  ];
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => 0 });
  const of = channel => catalogue.filter(item => inTvGenre(item, channel)).map(item => item.channel);
  assert.deepEqual(of('littleones'), ['Bing']);
  assert.deepEqual(of('bluey'), ['Bluey']);
  assert.deepEqual(of('adventures'), ['Octonauts']);
  assert.deepEqual(of('learn'), ['Numberblocks']);
  assert.deepEqual(of('shorts'), ['Shaun the Sheep']);
  assert.deepEqual(of('trains'), ['Track Time']);
  assert.deepEqual(of('adultanim'), ['Futurama (1999)']);
  assert.equal(of('cartoons').includes('Futurama (1999)'), false, 'grown-up cartoons leave the kids channel');
  assert.ok(of('sitcoms').includes('Blackadder (1983)'));
  assert.deepEqual(of('friends'), ['Friends (1994)']);
  assert.deepEqual(of('seinfeld'), ['Seinfeld (1989)']);
  assert.deepEqual(of('crime'), ["Miss Fisher's Murder Mysteries"]);
  assert.deepEqual(of('truecrime'), ['48 Hours']);
  assert.deepEqual(of('reality'), ['Come Dine With Me']);
  assert.equal(of('fordad').includes('In Bruges (2008)'), false, 'films stay on Movies');
  assert.equal(of('fordad').includes('Bluey'), false);
  assert.equal(of('formum').includes('Futurama (1999)'), false, 'no animation on Fran\'s channel');
  assert.ok(of('formum').includes('Come Dine With Me') && of('formum').includes('Friends (1994)'));
  assert.ok(of('formum').includes("Miss Fisher's Murder Mysteries"), 'other grown-up shows stay on as discoveries');
  assert.equal(of('formum').includes('Futurama (1999)'), false);
  // Her favourites lead: over many picks, Come Dine With Me and Friends dominate.
  const seq = [0.02, 0.31, 0.57, 0.83, 0.11, 0.66, 0.44, 0.95, 0.27, 0.73];
  let n = 0;
  const many = [];
  for (const [show, tier] of [['Come Dine With Me', 'grownup'], ['Friends (1994)', 'sitcom'], ["Miss Fisher's Murder Mysteries", 'couple'],
    ['Shetland', 'couple'], ['48 Hours', 'grownup'], ['Kath & Kim', 'sitcom']]) for (let e = 1; e <= 8; e++) many.push(v(show, tier, `S01E0${e}`));
  const favourites = createTvLibrary({ videos: many, history, storage, random: () => seq[n++ % seq.length] });
  const shown = [];
  for (let i = 0; i < 40; i++) shown.push(favourites.next('formum', { viewers: 'mum' }).show);
  const share = shown.filter(show => /Come Dine|Friends/.test(show)).length / shown.length;
  assert.ok(share >= 0.6, `favourites share ${share}`);

  const ids = viewers => library.home(viewers).channels.map(channel => channel.id);
  assert.ok(ids('dad').includes('fordad'));
  assert.equal(ids('dad').includes('formum'), false);
  assert.ok(ids('mum,dad').includes('fordad') && ids('mum,dad').includes('formum'));
  assert.equal(ids('sam,dad').includes('fordad'), false, 'no personal channel with a child in the room');
  assert.equal(ids('mum,dad').length >= 11, true);
  assert.equal(ids('mum,dad').some(id => ['cartoons', 'hophop', 'littleones', 'bluey', 'forjake'].includes(id)), false, 'kids\' channels stay on the kids\' tabs');
  assert.equal(new Set(TV_NUMBERS()).size, TV_NUMBERS().length, 'channel numbers are unique');
  assert.deepEqual(library.home('mum,dad').channels.map(channel => channel.number), library.home('mum,dad').channels.map((_, i) => i + 1));
  const shows = library.home('mum,dad').channels.map(channel => channel.now.show);
  assert.equal(shows.some(show => /\((?:19|20)\d\d\)$/.test(show)), false, 'no folder years on the cards');

  assert.ok(ids('jake,mum,dad').includes('forjake'), 'Jake gets his own channel');
  assert.equal(ids('sam,jake,mum,dad').includes('forjake'), false, 'not when Sam is the youngest');
  assert.equal(ids('mum,dad').includes('forjake'), false);
  assert.equal(library.home('jake,mum,dad').channels[0].id, 'forjake', "his channel leads Jake's lineup");
  assert.ok(of('forjake').includes('Track Time') && of('forjake').includes('Bluey'));
  assert.equal(of('forjake').includes('Bing'), false, 'preschool stays off');
  library.next('fordad', { viewers: 'mum,dad', current: 'Friends (1994)/S01E01.mp4', reason: 'skip', time: 60, watched: 60, duration: 1300 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sgrown'))['Friends (1994)/S01E01.mp4'] < 1, "Dad's channel learns on Dad's key");
});

function TV_NUMBERS() { return TV_CHANNELS.map(channel => channel.number).concat([6, 7, 20]); }

test('rationed shows stay rare and never get top billing while there is anything else', async () => {
  const { history, storage } = await setup();
  const v = (show, n) => ({ src: `${show}/S01E0${n}.mp4`, file: `/m/${show}/S01E0${n}.mp4`, title: `S01E0${n}`, channel: show, tier: 'big', duration: 600 });
  const catalogue = [];
  for (let n = 1; n <= 6; n++) catalogue.push(v('Billy’s Aviation', n), v('Track Time', n), v('SciShow Kids', n));
  let r = 0;
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => (r = (r * 7 + 0.37) % 1) });
  for (let i = 0; i < 12; i++) assert.notEqual(library.home('jake,mum,dad').channels.find(c => c.id === 'forjake').now.show, 'Billy’s Aviation');
  const shows = [];
  for (let i = 0; i < 60; i++) shows.push(library.next('forjake', { viewers: 'jake,mum,dad' }).show);
  const share = shows.filter(show => show === 'Billy’s Aviation').length / shows.length;
  assert.ok(share <= 0.1, `rationed share ${share}`);
});

test('cards carry the episode in words, its length and what comes next', async () => {
  const { history, storage } = await setup();
  const v = (n, title) => ({ src: `Kath & Kim/${title}.mp4`, file: `/m/Kath & Kim/${title}.mp4`, title, channel: 'Kath & Kim', tier: 'sitcom', duration: 1320 + n });
  const catalogue = [v(1, 'Series 3 Ep 1 Cactus Hour [DR0311V001S00]'), v(2, 'Series 3 Ep 2 Party [DR0311V002S00]')];
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => 0 });
  const now = library.home('dad').channels.find(channel => channel.id === 'sitcoms').now;
  assert.equal(now.show, 'Kath & Kim');
  assert.equal(now.title, 'S3 E1 · Cactus Hour');
  assert.equal(now.minutes, 22);
  assert.deepEqual(now.next, { show: 'Kath & Kim', title: 'S3 E2 · Party' });
  library.next('sitcoms', { viewers: 'dad' });
  assert.equal(library.home('dad').channels.find(channel => channel.id === 'sitcoms').now.title, 'S3 E2 · Party', 'next becomes the card');
});

test("a grown-up audience's taste orders the channels outside a solo running order", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos: [
    { src: 'Sitcom/s.mp4', file: '/m/Sitcom/s.mp4', title: 'Sitcom', channel: 'The Sitcom', tier: 'sitcom', duration: 1300 },
    { src: 'Anim/a.mp4', file: '/m/Anim/a.mp4', title: 'Adult Cartoon', channel: 'Adult Cartoon', tier: 'adultanim', duration: 1300 },
  ], history: await loadPlaybackHistory(join(dir, 'history.json')), storage, random: () => 0 });
  const ids = () => library.home('mum,dad').channels.map(channel => channel.id);
  const before = ids();
  assert.ok(before.indexOf('sitcoms') >= 0 && before.indexOf('sitcoms') < before.indexOf('adultanim'), JSON.stringify(before));
  // Ian likes the grown-up cartoons and skips the sitcom.
  storage.setItem('kidshuffle.weights.v2.sboth', JSON.stringify({ 'Anim/a.mp4': 3, 'Sitcom/s.mp4': 0.5 }));
  const after = ids();
  assert.ok(after.indexOf('adultanim') < after.indexOf('sitcoms'), JSON.stringify(after));
});

test("Ian alone gets his own running order, one show per card, and no Christmas in November", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const make = (src, channel, tier, title = src) => ({ src, file: '/m/' + src, title, channel, tier, duration: 1300 });
  const library = createTvLibrary({ videos: [
    make('Seinfeld/1.mp4', 'Seinfeld (1989)', 'sitcom'), make('Seinfeld/2.mp4', 'Seinfeld (1989)', 'sitcom'),
    make('Utopia/1.mp4', 'Utopia', 'sitcom'), make('Star Trek/1.mp4', 'Star Trek The Next Generation (1987)', 'scifi'),
    make('Futurama/x.mp4', 'Futurama (1999)', 'adultanim', 'S2 E8 Xmas Story'), make('Futurama/1.mp4', 'Futurama (1999)', 'adultanim'),
    make('Fisk/1.mp4', 'Fisk', 'sitcom'), make('Come Dine/1.mp4', 'Come Dine With Me', 'grownup'), make('Snatch/s.mp4', 'Snatch (2000)', 'grownup', 'Snatch (2000)'),
  ], history: await loadPlaybackHistory(join(dir, 'history.json')), storage: await createFileStorage(join(dir, 'taste.json')),
  random: () => 0, now: () => Date.parse('2026-11-05T14:00:00Z') });
  const home = library.home('dad');
  const ids = home.channels.map(channel => channel.id);
  assert.equal(ids[0], 'fordad');
  assert.ok(ids.indexOf('scifi') < ids.indexOf('sitcoms') && ids.indexOf('adultanim') < ids.indexOf('sitcoms'), JSON.stringify(ids));
  // Come Dine With Me is the only show on both Ian & Fran and Reality here; everything else is distinct.
  const shows = home.channels.filter(channel => !['grownups', 'reality'].includes(channel.id)).map(channel => channel.now.show);
  assert.equal(new Set(shows).size, shows.length, 'each show billed once: ' + JSON.stringify(shows));
  assert.equal(home.channels.find(channel => channel.id === 'seinfeld').now.show, 'Seinfeld');
  assert.ok(!JSON.stringify(home.channels.filter(channel => channel.id !== 'christmas')).includes('Xmas'), 'no Christmas episodes in November outside the Christmas channel');
  for (let i = 0; i < 20; i++) assert.notEqual(library.next('fordad', { viewers: 'dad' }).show, 'Come Dine With Me', "Fran's shows stay off For Ian");
});

test("Ian's tab: no cosy mysteries or Fran's reality, his own channels, real episodes billed", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const make = (src, channel, tier, title = src) => ({ src, file: '/m/' + src, title, channel, tier, duration: 1300 });
  const library = createTvLibrary({ videos: [
    make('Shetland/1.mp4', 'Shetland', 'couple', 'S1 E1'), make('Vera/1.mp4', 'Vera', 'couple', 'S1 E1'),
    make('Come Dine/1.mp4', 'Come Dine With Me', 'grownup'), make('Line of Duty/1.mp4', 'Line of Duty', 'grownup', 'S1 E1'),
    make('Mayday/1.mp4', 'Mayday', 'grownup', 'S1 E1'), make('Top Gear/1.mp4', 'Top Gear', 'grownup', 'S1 E1'),
    make('Seinfeld/0.mp4', 'Seinfeld (1989)', 'sitcom', 'S0 E1 Alternative pilot'), make('Seinfeld/1.mp4', 'Seinfeld (1989)', 'sitcom', 'S1 E1'),
  ], history: await loadPlaybackHistory(join(dir, 'history.json')), storage: await createFileStorage(join(dir, 'taste.json')), random: () => 0 });
  const ian = library.home('dad');
  const ids = ian.channels.map(channel => channel.id);
  assert.ok(!JSON.stringify(ian.channels).match(/Shetland|Vera|Come Dine/), JSON.stringify(ian.channels.map(c => c.now.show)));
  for (const id of ['thrillers', 'aviation', 'motoring']) assert.ok(ids.includes(id), id);
  assert.ok(ids.indexOf('aviation') < ids.indexOf('seinfeld'), JSON.stringify(ids));
  assert.equal(ian.channels.find(channel => channel.id === 'seinfeld').now.title.includes('pilot'), false, 'billing skips Season 0 extras');
  const together = library.home('mum,dad');
  assert.ok(JSON.stringify(together.channels).includes('Shetland') || together.channels.some(channel => channel.id === 'crime'), 'Fran and Ian together still get the mysteries');
});
