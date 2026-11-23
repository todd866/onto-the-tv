import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TV_CHANNELS, applyScoredChannelWeight, channelScoresSignaturePart, createArtWarmer, mergeChannelScores, whoamiProof, countTvChannelVideos, createFileStorage, createTvLibrary, createTvServer, inTvGenre, isHomeAddress, isHomeHost, layeredHistory, parseChannelScores, parseRange, scoredRotationWeight } from './tv-server.js';
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

test('prefetch reads the staged channel item without consuming it', async () => {
  const { library } = await setup();
  library.home('kid1');
  const first = library.next('cartoons', { viewers: 'kid1', prefetch: true });
  const again = library.next('cartoons', { viewers: 'kid1', prefetch: true });
  assert.equal(again.src, first.src);
  assert.equal(again.prefetch, true);
  const taken = library.next('cartoons', { viewers: 'kid1' });
  assert.equal(taken.src, first.src);
  assert.notEqual(library.next('cartoons', { viewers: 'kid1' }).src, first.src);
});

test('only home-network addresses are served', () => {
  for (const address of ['127.0.0.1', '::1', '192.168.1.14', '::ffff:10.0.0.5', '172.20.1.1', '100.96.209.126', 'fd7a:115c::1', 'fe80::1'])
    assert.equal(isHomeAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860::1', '', undefined])
    assert.equal(isHomeAddress(address), false, String(address));
});

test('only this Mac\'s own names are accepted as Host', () => {
  for (const host of ['192.168.1.20:8686', 'localhost:8686', 'tv-mac.local:8686', '[fd7a::1]:8686',
    'tv-mac.example.ts.net', 'm2']) assert.equal(isHomeHost(host), true, host);
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
    ['kid1', 'Robin', true], ['kid2', 'Max', true], ['adult2', 'Jordan', true], ['adult1', 'Casey', true],
  ]);
  assert.deepEqual(home.channels.map(channel => [channel.number, channel.id, channel.name]),
    [[1, 'cartoons', 'Cartoons'], [2, 'littleones', 'Little Ones'], [3, 'bluey', 'Bluey']], 'numbered in the order shown');
  assert.equal(home.channels[0].now.show, 'Bluey');
  assert.equal(home.channels[0].count, 3, 'channels report their pool size at this ceiling');
  assert.equal(home.channels[0].now.art, '/art?src=Bluey%2Fa.mp4');
  assert.equal(home.shows, undefined);
  assert.equal(home.continueWatching, undefined);

  const dad = library.home('adult1');
  assert.equal(dad.ceiling, 'M');
  assert.deepEqual(dad.viewers.map(person => person.on), [false, false, false, true]);
  assert.equal(dad.channels.some(channel => ['cartoons', 'littleones', 'bluey'].includes(channel.id)), false, 'kids\' channels live on the kids\' tabs, not a grown-up\'s');
  assert.equal(dad.channels.find(channel => channel.id === 'movies').now.show, 'D', 'a film card names the film');

  const withSam = library.home('kid1,adult1');
  assert.equal(withSam.ceiling, 'G');
  assert.equal(withSam.channels.some(channel => channel.id === 'movies'), false);

  const nobody = library.home('');
  assert.equal(nobody.ceiling, null);
  assert.equal(nobody.channels.length, 0);
  assert.ok(nobody.viewers.every(person => person.on === false));
});

test('a channel only offers titles under the ceiling and learns on the audience key', async () => {
  const { library, storage } = await setup();
  for (let i = 0; i < 10; i++) assert.ok(['shared', 'preschool'].includes(library.next('cartoons', { viewers: 'kid1' }).tier));
  library.next('cartoons', { viewers: 'kid1,adult1', current: 'Bluey/a.mp4', reason: 'skip', time: 60, watched: 60, duration: 420 });
  const weights = JSON.parse(storage.getItem('kidshuffle.weights.v2.scartoons'));
  assert.ok(weights['Bluey/a.mp4'] < 1, 'a minute watched then skipped is a dislike');
  assert.equal(storage.getItem('kidshuffle.weights.v2.sgrown'), null, 'a child in the room does not write Dad\'s taste');
  library.next('cartoons', { viewers: 'kid1', current: 'Bluey/b.mp4', reason: 'skip', time: 1, watched: 1, duration: 420 });
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
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => 0, now: () => localHour(15) });
  const youngest = library.home('kid1');
  assert.equal(youngest.ceiling, 'G');
  assert.deepEqual(youngest.channels.map(channel => channel.id), ['bluey', 'littleones', 'hophop', 'cartoons', 'music', 'christmas'], 'Robin leads with Bluey, Little Ones and Hop Hop after 9am');
  assert.deepEqual(library.next('hophop', { viewers: 'kid1' }).show, 'Hop Hop the Owl');
  const older = library.home('kid2');
  assert.equal(older.ceiling, 'PG');
  assert.ok(older.channels.find(channel => channel.id === 'cartoons'));
  assert.equal(older.channels.some(channel => channel.id === 'sitcoms'), false);
  assert.equal(library.next('cartoons', { viewers: 'kid1' }).tier === 'older', false, 'the older tier never reaches the youngest');
  const adults = library.home('adult2,adult1');
  assert.equal(adults.ceiling, 'M');
  for (const id of ['movies', 'sitcoms', 'music']) assert.ok(adults.channels.some(channel => channel.id === id), id);
  assert.equal(adults.channels.some(channel => channel.id === 'cartoons'), false, 'no kids\' channels without a child');

  library.next('movies', { viewers: 'adult1', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sgrown'))['Films/d.mkv'] < 1);
  library.next('movies', { viewers: 'adult2', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.smum'))['Films/d.mkv'] < 1);
  library.next('movies', { viewers: 'adult2,adult1', current: 'Films/d.mkv', reason: 'skip', time: 120, watched: 120, duration: 6000 });
  assert.ok(JSON.parse(storage.getItem('kidshuffle.weights.v2.sboth'))['Films/d.mkv'] < 1);
  assert.equal(library.home('adult1').channels.find(channel => channel.id === 'movies').now.show === 'Sci-Fi Show'
    || library.home('adult1').channels.find(channel => channel.id === 'movies').now.show === 'D', true);
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
  assert.equal(library.home('kid1').channels.some(channel => channel.id === 'rides'), false);
  assert.ok(library.home('kid2').channels.some(channel => channel.id === 'rides'));
  assert.equal(library.next('rides', { viewers: 'kid2' }).show, names[0]);
  assert.throws(() => library.next('rides', { viewers: 'kid1' }), /empty/);
  assert.throws(() => library.next('rides', { viewers: 'kid1,kid2' }), /empty/);
  const misplaced = createTvLibrary({ videos: rides.map(item => ({ ...item, tier: 'shared' })), history, storage });
  assert.equal(misplaced.home('kid1').channels.some(channel => channel.id === 'rides'), false);
});

test('triple j and Double J take members and weights from the score file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const inFile = { src: 'music/Artist/Artist - Song [vid].mp4', file: '/m/music/Artist/Song.mp4', title: 'Song', channel: 'Artist', tier: 'music', duration: 240 };
  const outFile = { src: 'music/Other/Other - Track [x].mp4', file: '/m/music/Other/Track.mp4', title: 'Track', channel: 'Other', tier: 'music', duration: 240 };
  const kids = { ...inFile, src: 'music/Kids/Kids - Bop [k].mp4', tier: 'shared', channel: 'Kids' };
  const scores = {
    triplej: { items: { [inFile.src]: { score: 0.92 }, [kids.src]: { score: 0.8 }, 'missing/in-library.mp4': { score: 1 } } },
    doublej: { items: {} },
  };
  assert.equal(inTvGenre(inFile, 'triplej', scores), true);
  assert.equal(inTvGenre(outFile, 'triplej', scores), false);
  assert.equal(inTvGenre(inFile, 'triplej'), false);
  assert.equal(inTvGenre(kids, 'triplej', scores), false);
  assert.equal(inTvGenre({ ...inFile, src: 'ads/80s/ad.mp4' }, 'triplej', scores), false);
  const empty = createTvLibrary({ videos: [inFile, outFile], history, storage, random: () => 0 });
  assert.equal(empty.home('adult1').channels.some(channel => channel.id === 'triplej'), false);
  const library = createTvLibrary({ videos: [inFile, outFile], history, storage, channelScores: scores, random: () => 0 });
  assert.equal(countTvChannelVideos([inFile, outFile], 'triplej', scores), 1);
  const live = { src: 'music/Live/tiny desk set.mp4', file: '/m/Live/set.mp4', title: 'Set', channel: 'tiny desk', tier: 'music', duration: 1800 };
  const withLive = createTvLibrary({ videos: [inFile, live], history, storage, channelScores: scores, random: () => 0 });
  const dadIds = withLive.home('adult1').channels.map(channel => channel.id);
  assert.ok(dadIds.includes('triplej') && dadIds.includes('livesets'));
  assert.ok(dadIds.indexOf('triplej') < dadIds.indexOf('livesets'));
  const card = withLive.home('adult1').channels.find(channel => channel.id === 'triplej');
  assert.equal(card.about, 'triple j — on rotation, picked for you');
  assert.equal(applyScoredChannelWeight(1, 1), 2);
  assert.equal(applyScoredChannelWeight(1, 0), 0.4);
  assert.equal(scoredRotationWeight(7), scoredRotationWeight(1));
  assert.equal(parseChannelScores('not json'), null);
  assert.equal(parseChannelScores(JSON.stringify({ channels: [] })), null);
  assert.equal(parseChannelScores(JSON.stringify({ channels: { triplej: { items: { 'a.mp4': { score: 'nope' } } } } })), null);
  const scoreSeven = { channels: { triplej: { items: { 'a.mp4': { score: 7 } } } } };
  const clamped = parseChannelScores(JSON.stringify(scoreSeven));
  assert.equal(clamped.triplej.items['a.mp4'].score, 1);
  const partA = channelScoresSignaturePart('/tmp/scores.json', { mtimeMs: 1, size: 10 });
  const partB = channelScoresSignaturePart('/tmp/scores.json', { mtimeMs: 2, size: 10 });
  assert.notEqual(partA, partB);
});

test('progress: surfing is not history, a real watch resumes', async () => {
  const { library } = await setup();
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 10, durationSeconds: 420, completed: false }), false);
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 200, durationSeconds: 420, completed: false }), true);
  const resumed = library.next('cartoons', { viewers: 'kid1' });
  assert.equal(resumed.src, 'Bluey/a.mp4');
  assert.equal(resumed.resume, 200);
  library.progress({ src: 'Bluey/a.mp4', positionSeconds: 0, durationSeconds: 420, completed: true });
  for (let i = 0; i < 6; i++) {
    const item = library.next('cartoons', { viewers: 'kid1' });
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
    const dadHome = await (await fetch(`${base}/api/home?viewers=adult1`)).json();
    assert.equal(dadHome.ceiling, 'M');
    assert.equal(dadHome.viewers.find(person => person.id === 'adult1').on, true);
    assert.equal(dadHome.viewers.find(person => person.id === 'kid1').on, false);
    assert.equal(dadHome.channels.some(channel => channel.id === 'cartoons'), false);
    const narrowed = await (await fetch(`${base}/api/home?viewers=kid1`)).json();
    assert.equal(narrowed.ceiling, 'G');
    assert.equal(narrowed.channels.some(channel => channel.id === 'movies'), false);
    assert.equal((await fetch(`${base}/api/progress`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// The Mac app's Channels tab reaches the M2 through Tailscale's HTTPS proxy, which keeps the Host
// header: the page's Origin is then https://<host>. It refused every POST until 15 Nov 2026.
test('the server\'s own page stays same-origin behind an HTTPS proxy', async () => {
  const { dir, history, storage, library } = await setup();
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  const post = origin => fetch(`http://${host}/api/next`, { method: 'POST', body: JSON.stringify({ channel: 'cartoons' }),
    headers: { 'Content-Type': 'application/json', Origin: origin } });
  try {
    assert.equal((await post(`http://${host}`)).status, 200);
    const proxied = await post(`https://${host}`);
    assert.equal(proxied.status, 200, 'https://<same host> is this server behind a TLS proxy');
    assert.equal(proxied.headers.get('access-control-allow-origin'), null, 'same-origin needs no CORS grant');
    assert.equal((await post('https://evil.example')).status, 403);
    assert.equal((await post('https://127.0.0.1:1')).status, 403, 'another port is another origin');
    assert.equal((await post(`https://${host}.evil.example`)).status, 403);
    assert.equal((await post(`ftp://${host}`)).status, 403);
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
  assert.equal(library.next('grownups', { viewers: 'adult1' }).title, 'MobLand S01E05');
  // Part-way through E05: the shuffle still lands on it.
  history.set(serial[0].file, { title: 'E05', positionSeconds: 600, durationSeconds: 3000 });
  assert.equal(library.next('grownups', { viewers: 'adult1' }).title, 'MobLand S01E05');
  // Finishing E05 plays E06, not the shuffle's choice.
  assert.equal(library.next('grownups', { viewers: 'adult1', current: serial[0].src, reason: 'ended', time: 3000, watched: 2400, duration: 3000 }).title,
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
  const next = library.next('grownups', { viewers: 'adult1' });
  assert.equal(next.title, 'MobLand S01E08');
  assert.equal(next.resume, 900);
  // Then watched further on the TV: its newer place wins; the app's file is untouched.
  await new Promise(resolve => setTimeout(resolve, 5));
  library.progress({ src: serial[3].src, positionSeconds: 1500, durationSeconds: 2500, completed: false });
  assert.equal(library.next('grownups', { viewers: 'adult1' }).resume, 1500);
  assert.equal(app.get(serial[3].file), 900);
});


test('a Bluey seed continues across the kids channel without selecting adult content', async () => {
  const { history, storage } = await setup();
  const library = createTvLibrary({ videos, history, storage, random: () => 0.99 });
  let current = videos[0];
  const shows = new Set();
  for (let n = 0; n < 12; n++) {
    const next = library.next('cartoons', { viewers: 'kid1', current: current.src, reason: 'ended', time: current.duration, watched: current.duration, duration: current.duration });
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
  const family = library.home('kid1,kid2,adult2,adult1');
  assert.equal(family.ceiling, 'G');
  assert.equal(family.defaultCeiling, 'G');
  assert.equal(family.rating, null);
  const up = library.home('kid1,kid2,adult2,adult1', 'M');
  assert.equal(up.ceiling, 'M');
  assert.equal(up.defaultCeiling, 'G');
  assert.equal(up.rating, 'M');
  assert.ok(up.channels.some(channel => channel.id === 'movies'));
  assert.equal(up.channels[0].id, 'movies', 'an M ceiling orders grown-up channels first');
  const down = library.home('adult1', 'g');
  assert.equal(down.ceiling, 'G');
  assert.equal(down.channels.some(channel => channel.id === 'movies'), false);
  assert.equal(down.channels[0].id, 'cartoons');
  assert.equal(library.home('adult1', 'nonsense').ceiling, 'M', 'an unknown rating is ignored');
  assert.equal(library.home('', 'M').channels.length, 0, 'nobody watching stays blocked');
  assert.equal(library.next('movies', { viewers: 'kid1', rating: 'M' }).show, 'Films');
  assert.throws(() => library.next('movies', { viewers: 'adult1', rating: 'G' }), /empty/);
  assert.equal(library.allowed('Films/d.mkv', 'kid1'), false);
  assert.equal(library.allowed('Films/d.mkv', 'kid1', 'M'), true);
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
  assert.equal(of('foradult1').includes('In Bruges (2008)'), false, 'films stay on Movies');
  assert.equal(of('foradult1').includes('Bluey'), false);
  assert.equal(of('foradult2').includes('Futurama (1999)'), false, 'no animation on Jordan\'s channel');
  assert.ok(of('foradult2').includes('Come Dine With Me') && of('foradult2').includes('Friends (1994)'));
  assert.ok(of('foradult2').includes("Miss Fisher's Murder Mysteries"), 'other grown-up shows stay on as discoveries');
  assert.equal(of('foradult2').includes('Futurama (1999)'), false);
  // Her favourites lead: over many picks, Come Dine With Me and Friends dominate.
  const seq = [0.02, 0.31, 0.57, 0.83, 0.11, 0.66, 0.44, 0.95, 0.27, 0.73];
  let n = 0;
  const many = [];
  for (const [show, tier] of [['Come Dine With Me', 'grownup'], ['Friends (1994)', 'sitcom'], ["Miss Fisher's Murder Mysteries", 'couple'],
    ['Shetland', 'couple'], ['48 Hours', 'grownup'], ['Kath & Kim', 'sitcom']]) for (let e = 1; e <= 8; e++) many.push(v(show, tier, `S01E0${e}`));
  const favourites = createTvLibrary({ videos: many, history, storage, random: () => seq[n++ % seq.length] });
  const shown = [];
  for (let i = 0; i < 40; i++) shown.push(favourites.next('foradult2', { viewers: 'adult2' }).show);
  const share = shown.filter(show => /Come Dine|Friends/.test(show)).length / shown.length;
  assert.ok(share >= 0.6, `favourites share ${share}`);

  const ids = viewers => library.home(viewers).channels.map(channel => channel.id);
  assert.ok(ids('adult1').includes('foradult1'));
  assert.equal(ids('adult1').includes('foradult2'), false);
  assert.ok(ids('adult2,adult1').includes('foradult1') && ids('adult2,adult1').includes('foradult2'));
  assert.equal(ids('kid1,adult1').includes('foradult1'), false, 'no personal channel with a child in the room');
  assert.equal(ids('adult2,adult1').length >= 11, true);
  assert.equal(ids('adult2,adult1').some(id => ['cartoons', 'hophop', 'littleones', 'bluey', 'forkid2'].includes(id)), false, 'kids\' channels stay on the kids\' tabs');
  assert.equal(new Set(TV_NUMBERS()).size, TV_NUMBERS().length, 'channel numbers are unique');
  assert.deepEqual(library.home('adult2,adult1').channels.map(channel => channel.number), library.home('adult2,adult1').channels.map((_, i) => i + 1));
  const shows = library.home('adult2,adult1').channels.map(channel => channel.now.show);
  assert.equal(shows.some(show => /\((?:19|20)\d\d\)$/.test(show)), false, 'no folder years on the cards');

  assert.ok(ids('kid2,adult2,adult1').includes('forkid2'), 'Max gets his own channel');
  assert.equal(ids('kid1,kid2,adult2,adult1').includes('forkid2'), false, 'not when Robin is the youngest');
  assert.equal(ids('adult2,adult1').includes('forkid2'), false);
  assert.equal(library.home('kid2,adult2,adult1').channels[0].id, 'forkid2', "his channel leads Max's lineup");
  assert.ok(of('forkid2').includes('Track Time') && of('forkid2').includes('Bluey'));
  assert.equal(of('forkid2').includes('Bing'), false, 'preschool stays off');
  library.next('foradult1', { viewers: 'adult2,adult1', current: 'Friends (1994)/S01E01.mp4', reason: 'skip', time: 60, watched: 60, duration: 1300 });
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
  for (let i = 0; i < 12; i++) assert.notEqual(library.home('kid2,adult2,adult1').channels.find(c => c.id === 'forkid2').now.show, 'Billy’s Aviation');
  const shows = [];
  for (let i = 0; i < 60; i++) shows.push(library.next('forkid2', { viewers: 'kid2,adult2,adult1' }).show);
  const share = shows.filter(show => show === 'Billy’s Aviation').length / shows.length;
  assert.ok(share <= 0.1, `rationed share ${share}`);
});

test('cards carry the episode in words, its length and what comes next', async () => {
  const { history, storage } = await setup();
  const v = (n, title) => ({ src: `Kath & Kim/${title}.mp4`, file: `/m/Kath & Kim/${title}.mp4`, title, channel: 'Kath & Kim', tier: 'sitcom', duration: 1320 + n });
  const catalogue = [v(1, 'Series 3 Ep 1 Cactus Hour [DR0311V001S00]'), v(2, 'Series 3 Ep 2 Party [DR0311V002S00]')];
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => 0 });
  const now = library.home('adult1').channels.find(channel => channel.id === 'sitcoms').now;
  assert.equal(now.show, 'Kath & Kim');
  assert.equal(now.title, 'S3 E1 · Cactus Hour');
  assert.equal(now.minutes, 22);
  assert.deepEqual(now.next, { show: 'Kath & Kim', title: 'S3 E2 · Party' });
  library.next('sitcoms', { viewers: 'adult1' });
  assert.equal(library.home('adult1').channels.find(channel => channel.id === 'sitcoms').now.title, 'S3 E2 · Party', 'next becomes the card');
});

test("a grown-up audience's taste orders the channels outside a solo running order", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos: [
    { src: 'Sitcom/s.mp4', file: '/m/Sitcom/s.mp4', title: 'Sitcom', channel: 'The Sitcom', tier: 'sitcom', duration: 1300 },
    { src: 'Anim/a.mp4', file: '/m/Anim/a.mp4', title: 'Adult Cartoon', channel: 'Adult Cartoon', tier: 'adultanim', duration: 1300 },
  ], history: await loadPlaybackHistory(join(dir, 'history.json')), storage, random: () => 0 });
  const ids = () => library.home('adult2,adult1').channels.map(channel => channel.id);
  const before = ids();
  assert.ok(before.indexOf('sitcoms') >= 0 && before.indexOf('sitcoms') < before.indexOf('adultanim'), JSON.stringify(before));
  // Casey likes the grown-up cartoons and skips the sitcom.
  storage.setItem('kidshuffle.weights.v2.sboth', JSON.stringify({ 'Anim/a.mp4': 3, 'Sitcom/s.mp4': 0.5 }));
  const after = ids();
  assert.ok(after.indexOf('adultanim') < after.indexOf('sitcoms'), JSON.stringify(after));
});

test("Casey alone gets his own running order, one show per card, and no Christmas in November", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const make = (src, channel, tier, title = src) => ({ src, file: '/m/' + src, title, channel, tier, duration: 1300 });
  const library = createTvLibrary({ videos: [
    make('Seinfeld/1.mp4', 'Seinfeld (1989)', 'sitcom'), make('Seinfeld/2.mp4', 'Seinfeld (1989)', 'sitcom'),
    make('Utopia/1.mp4', 'Utopia', 'sitcom'), make('Star Trek/1.mp4', 'Star Trek The Next Generation (1987)', 'scifi'),
    make('Futurama/x.mp4', 'Futurama (1999)', 'adultanim', 'S2 E8 Xmas Story'), make('Futurama/1.mp4', 'Futurama (1999)', 'adultanim'),
    make('Fisk/1.mp4', 'Fisk', 'sitcom'), make('Come Dine/1.mp4', 'Come Dine With Me', 'grownup'), make('Snatch/s.mp4', 'Snatch (2000)', 'grownup', 'Snatch (2000)'),
  ], history: await loadPlaybackHistory(join(dir, 'history.json')), storage: await createFileStorage(join(dir, 'taste.json')),
  random: () => 0, now: () => Date.parse('2026-11-05T14:00:00Z') });
  const home = library.home('adult1');
  const ids = home.channels.map(channel => channel.id);
  assert.equal(ids[0], 'foradult1');
  assert.ok(ids.indexOf('scifi') < ids.indexOf('sitcoms') && ids.indexOf('adultanim') < ids.indexOf('sitcoms'), JSON.stringify(ids));
  // Come Dine With Me is the only show on both Casey & Jordan and Reality here; everything else is distinct.
  const shows = home.channels.filter(channel => !['grownups', 'reality'].includes(channel.id)).map(channel => channel.now.show);
  assert.equal(new Set(shows).size, shows.length, 'each show billed once: ' + JSON.stringify(shows));
  assert.equal(home.channels.find(channel => channel.id === 'seinfeld').now.show, 'Seinfeld');
  assert.ok(!JSON.stringify(home.channels.filter(channel => channel.id !== 'christmas')).includes('Xmas'), 'no Christmas episodes in November outside the Christmas channel');
  for (let i = 0; i < 20; i++) assert.notEqual(library.next('foradult1', { viewers: 'adult1' }).show, 'Come Dine With Me', "Jordan's shows stay off For Casey");
});

test("Casey's tab: no cosy mysteries or Jordan's reality, his own channels, real episodes billed", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  const make = (src, channel, tier, title = src) => ({ src, file: '/m/' + src, title, channel, tier, duration: 1300 });
  const library = createTvLibrary({ videos: [
    make('Shetland/1.mp4', 'Shetland', 'couple', 'S1 E1'), make('Vera/1.mp4', 'Vera', 'couple', 'S1 E1'),
    make('Come Dine/1.mp4', 'Come Dine With Me', 'grownup'), make('Line of Duty/1.mp4', 'Line of Duty', 'grownup', 'S1 E1'),
    make('Mayday/1.mp4', 'Mayday', 'grownup', 'S1 E1'), make('Top Gear/1.mp4', 'Top Gear', 'grownup', 'S1 E1'),
    make('Seinfeld/0.mp4', 'Seinfeld (1989)', 'sitcom', 'S0 E1 Alternative pilot'), make('Seinfeld/1.mp4', 'Seinfeld (1989)', 'sitcom', 'S1 E1'),
  ], history: await loadPlaybackHistory(join(dir, 'history.json')), storage: await createFileStorage(join(dir, 'taste.json')), random: () => 0 });
  const ian = library.home('adult1');
  const ids = ian.channels.map(channel => channel.id);
  assert.ok(!JSON.stringify(ian.channels).match(/Shetland|Vera|Come Dine/), JSON.stringify(ian.channels.map(c => c.now.show)));
  for (const id of ['thrillers', 'aviation', 'motoring']) assert.ok(ids.includes(id), id);
  assert.ok(ids.indexOf('aviation') < ids.indexOf('seinfeld'), JSON.stringify(ids));
  assert.equal(ian.channels.find(channel => channel.id === 'seinfeld').now.title.includes('pilot'), false, 'billing skips Season 0 extras');
  const together = library.home('adult2,adult1');
  assert.ok(JSON.stringify(together.channels).includes('Shetland') || together.channels.some(channel => channel.id === 'crime'), 'Jordan and Casey together still get the mysteries');
});

function localHour(hour, minute = 0) {
  return new Date(2026, 10, 6, hour, minute, 0).getTime();
}

function ep(show, n, tier, minutes = 22) {
  return {
    src: `${show}/S01E0${n}.mp4`, file: `/m/${show}/S01E0${n}.mp4`, title: `S1 E${n}`, channel: show, tier,
    duration: minutes * 60,
  };
}

async function libraryWith(videos, { random = () => 0, now = () => localHour(15), history } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  return {
    dir,
    library: createTvLibrary({
      videos, random, now,
      history: history || await loadPlaybackHistory(join(dir, 'history.json')),
      storage: await createFileStorage(join(dir, 'taste.json')),
    }),
  };
}

test('serials and personal channels resume a partial episode or the next unseen one', async () => {
  const futurama = ep('Futurama', 1, 'adultanim');
  const utopia = [ep('Utopia', 1, 'sitcom'), ep('Utopia', 2, 'sitcom')];
  const partial = await libraryWith([futurama, ...utopia]);
  partial.library.progress({ src: utopia[0].src, positionSeconds: 400, durationSeconds: 1320, completed: false });
  const resumed = partial.library.home('adult1').channels.find(channel => channel.id === 'foradult1').now;
  assert.equal(resumed.show, 'Utopia');
  assert.equal(resumed.title, 'S1 E1');

  const unseen = await libraryWith([futurama, ...utopia]);
  unseen.library.progress({ src: utopia[0].src, positionSeconds: 1320, durationSeconds: 1320, completed: true });
  const next = unseen.library.home('adult1').channels.find(channel => channel.id === 'foradult1').now;
  assert.equal(next.show, 'Utopia');
  assert.equal(next.title, 'S1 E2');

  const duty = ep('Line of Duty', 1, 'grownup');
  const mob = ep('MobLand', 1, 'grownup');
  const serial = await libraryWith([duty, mob]);
  serial.library.progress({ src: mob.src, positionSeconds: 800, durationSeconds: 1320, completed: false });
  assert.equal(serial.library.home('adult1').channels.find(channel => channel.id === 'grownups').now.show, 'MobLand');
});

test('billing skips an episode finished in the last 30 days and will bill it again later', async () => {
  const utopia = ep('Utopia', 1, 'sitcom');
  const futurama = ep('Futurama', 1, 'adultanim');
  const recent = await libraryWith([utopia, futurama]);
  recent.library.progress({ src: utopia.src, positionSeconds: 1320, durationSeconds: 1320, completed: true });
  assert.equal(recent.library.home('adult1').channels.find(channel => channel.id === 'foradult1').now.show, 'Futurama');

  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-'));
  await writeFile(join(dir, 'history.json'), JSON.stringify({
    version: 1,
    entries: [{
      path: utopia.file, title: 'S1 E1', positionSeconds: 1320, durationSeconds: 1320, completed: true,
      updatedAt: new Date(localHour(15) - 40 * 86400000).toISOString(), points: [],
    }],
  }));
  const older = await libraryWith([utopia, futurama], { history: await loadPlaybackHistory(join(dir, 'history.json')) });
  assert.equal(older.library.home('adult1').channels.find(channel => channel.id === 'foradult1').now.show, 'Utopia');
});

test('a channel does not repeat a show within three picks, and a personal channel mixes three shows an hour', async () => {
  const shows = ['Utopia', 'Fisk', 'Blackadder', 'Futurama'];
  const tiers = ['sitcom', 'sitcom', 'bbc', 'adultanim'];
  const videos = [];
  for (let i = 0; i < shows.length; i++) for (let n = 1; n <= 4; n++) videos.push(ep(shows[i], n, tiers[i], 10));
  const { library } = await libraryWith(videos);
  const sitcoms = [];
  for (let i = 0; i < 6; i++) sitcoms.push(library.next('sitcoms', { viewers: 'adult1' }).show);
  for (let i = 0; i + 3 <= sitcoms.length; i++) assert.equal(new Set(sitcoms.slice(i, i + 3)).size, 3, sitcoms.join(' · '));

  const hour = [];
  let seconds = 0;
  while (seconds < 3600) {
    const item = library.next('foradult1', { viewers: 'adult1' });
    hour.push(item.show);
    seconds += item.duration;
  }
  assert.ok(new Set(hour).size >= 3, hour.join(' · '));
  for (let i = 0; i + 3 <= hour.length; i++) assert.equal(new Set(hour.slice(i, i + 3)).size, 3, hour.join(' · '));
  assert.notEqual(library.home('adult1').channels.find(channel => channel.id === 'foradult1').now.show,
    library.home('adult1').channels.find(channel => channel.id === 'foradult1').now.next.show);
});

test('before 9am kids lead with Cartoons, Little Ones and Bluey; after 7pm grown-ups lead with long-form', async () => {
  const kid = (show, tier) => ({ src: `${show}/a.mp4`, file: `/m/${show}/a.mp4`, title: 'Episode', channel: show, tier, duration: 420 });
  const kids = [
    kid('Hop Hop the Owl', 'preschool'), kid('Hey Duggee', 'preschool'), kid('Bluey', 'shared'), kid('Bing', 'preschool'),
    kid('Minecraft', 'big'),
  ];
  const morning = await libraryWith(kids, { now: () => localHour(8) });
  assert.deepEqual(morning.library.home('kid1').channels.slice(0, 3).map(channel => channel.id), ['cartoons', 'littleones', 'bluey']);
  const jakeMorning = morning.library.home('kid2').channels.map(channel => channel.id);
  assert.equal(jakeMorning[0], 'forkid2');
  assert.deepEqual(jakeMorning.slice(1, 4), ['cartoons', 'littleones', 'bluey']);

  const day = await libraryWith(kids, { now: () => localHour(15) });
  assert.deepEqual(day.library.home('kid1').channels.slice(0, 3).map(channel => channel.id), ['bluey', 'littleones', 'hophop']);

  const grown = [
    { src: 'Films/short.mp4', file: '/m/Films/short.mp4', title: 'Short Film', channel: 'Films', tier: 'grownup', duration: 180 },
    { src: 'Films/long.mp4', file: '/m/Films/long.mp4', title: 'Long Film', channel: 'Films', tier: 'grownup', duration: 7200 },
    { src: 'Song/a.mp4', file: '/m/Song/a.mp4', title: 'Song', channel: 'Song', tier: 'music', duration: 200 },
    { src: 'Doc/b.mp4', file: '/m/Doc/b.mp4', title: 'S1 E1', channel: 'Quick Briefing', tier: 'docs', duration: 180 },
    { src: 'Doc/a.mp4', file: '/m/Doc/a.mp4', title: 'S1 E1', channel: 'Deep Ocean', tier: 'docs', duration: 3600 },
  ];
  const afternoon = await libraryWith(grown, { now: () => localHour(15) });
  const afternoonIds = afternoon.library.home('adult1').channels.map(channel => channel.id);
  assert.ok(afternoonIds.indexOf('music') < afternoonIds.indexOf('docs'), afternoonIds.join(' '));
  assert.equal(afternoon.library.home('adult1').channels.find(channel => channel.id === 'movies').now.show, 'Short Film');
  assert.equal(afternoon.library.home('adult1').channels.find(channel => channel.id === 'foradult1').now.show, 'Quick Briefing');

  const evening = await libraryWith(grown, { now: () => localHour(20, 30) });
  const eveningIds = evening.library.home('adult1').channels.map(channel => channel.id);
  assert.ok(eveningIds.indexOf('docs') < eveningIds.indexOf('music'), eveningIds.join(' '));
  assert.equal(evening.library.home('adult1').channels.find(channel => channel.id === 'movies').now.show, 'Long Film');
  assert.equal(evening.library.home('adult1').channels.find(channel => channel.id === 'foradult1').now.show, 'Deep Ocean');
});

test('home gives each channel a one-line about from the shows in its pool', async () => {
  const make = (show, n, tier = 'grownup') => ({
    src: `${show}/${n}.mp4`, file: `/m/${show}/${n}.mp4`, title: `S1 E${n}`, channel: show, tier, duration: 3000,
  });
  const { library } = await libraryWith([
    make('Band of Brothers', 1), make('Band of Brothers', 2), make('The Pacific', 1),
  ]);
  const home = library.home('adult1');
  const military = home.channels.find(channel => channel.id === 'military');
  assert.equal(military.about, 'War & Military — Band of Brothers, The Pacific');
  for (const channel of home.channels) {
    assert.equal(channel.about.includes('\n'), false, channel.id);
    assert.ok(channel.about.startsWith(channel.name + ' — '), channel.about);
  }
});

test('health reports which library roots are online and how old the catalogue is', async () => {
  const { dir, history, storage, library } = await setup();
  const root = join(dir, 'Movies');
  await mkdir(root);
  const missing = join(dir, 'Volumes', 'Stash', 'Movies');
  const catalogue = join(dir, 'library.json');
  await writeFile(catalogue, '{"version":1,"videos":[{"src":"A"}]}\n');
  const built = new Date('2026-11-01T03:04:05.000Z');
  await utimes(catalogue, built, built);
  const server = createTvServer({ library, history, storage, uiRoot: dir, libraryRoots: [root, missing], catalogueFile: catalogue });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = await (await fetch(`${base}/api/health`)).json();
    const when = (await stat(catalogue)).mtime.toISOString();
    const age = Math.round((Date.now() - Date.parse(when)) / 1000);
    assert.equal(body.ok, true);
    assert.deepEqual(body.library.roots, [{ online: true }, { online: false }]);
    assert.equal(body.library.rootsOnline, 1);
    assert.equal(body.library.rootsOffline, 1);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute path');
    assert.equal(body.library.catalogueBuiltAt, when);
    assert.ok(Math.abs(body.library.catalogueAgeSeconds - age) <= 2, body.library.catalogueAgeSeconds);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a catalogue file on an offline drive returns an error the player handles', async () => {
  const { dir, history, storage } = await setup();
  const file = join(dir, 'gone.mp4');
  const library = createTvLibrary({ videos: [{ ...videos[0], file }], history, storage });
  const server = createTvServer({ library, history, storage, uiRoot: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/media?src=${encodeURIComponent('Bluey/a.mp4')}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'This video is offline.' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Max's card leads Minecraft, Track Time, cars and RC; rationed shows stay off it", async () => {
  const kid = (show, tier) => ({ src: `${show}/S01E01.mp4`, file: `/m/${show}/S01E01.mp4`, title: 'S1 E1', channel: show, tier, duration: 600 });
  const videos = [
    kid('Billy’s Aviation', 'big'), kid('Bluey', 'shared'), kid('RC Odyssey', 'big'),
    kid('Hot Wheels', 'big'), kid('Track Time', 'big'), kid('Minecraft', 'big'),
  ];
  const card = await libraryWith(videos);
  const now = card.library.home('kid2').channels.find(channel => channel.id === 'forkid2').now;
  assert.equal(now.show, 'Minecraft');
  assert.notEqual(now.show, 'Billy’s Aviation');
  assert.notEqual(now.next.show, 'Billy’s Aviation');
  const played = await libraryWith(videos);
  const picks = [];
  for (let i = 0; i < 3; i++) picks.push(played.library.next('forkid2', { viewers: 'kid2' }).show);
  assert.deepEqual(picks, ['Minecraft', 'Track Time', 'Hot Wheels']);

  const cars = await libraryWith([kid('Oddbods', 'big'), kid('RC Odyssey', 'big'), kid('Bluey', 'shared')]);
  assert.equal(cars.library.home('kid2').channels.find(channel => channel.id === 'forkid2').now.show, 'RC Odyssey');
});

test('a like raises the episode on the audience\'s taste and taking it back restores it', async () => {
  const { dir, storage, library } = await setup();
  const likes = () => JSON.parse(storage.getItem('onto.tv.likes') || '{}');
  // The weight as the learner stored it, whichever audience key it went to.
  const stored = async () => {
    await storage.flush();
    const all = JSON.parse(await readFile(join(dir, 'taste.json'), 'utf8'));
    return Object.entries(all).filter(([key]) => key.startsWith('kidshuffle.weights.')).map(([, value]) => JSON.parse(value)['Films/d.mkv']).filter(value => value !== undefined);
  };
  assert.deepEqual(library.liked('Films/d.mkv'), { src: 'Films/d.mkv', liked: false });
  assert.deepEqual(library.like({ src: 'Films/d.mkv', viewers: 'adult1', liked: true }), { src: 'Films/d.mkv', liked: true });
  assert.equal(likes()['Films/d.mkv'].key, 'grown');
  assert.equal(likes()['Films/d.mkv'].was, 1);
  assert.deepEqual(await stored(), [2]);
  // Liking twice changes nothing.
  assert.deepEqual(library.like({ src: 'Films/d.mkv', viewers: 'adult1', liked: true }), { src: 'Films/d.mkv', liked: true });
  assert.deepEqual(await stored(), [2]);
  assert.equal(library.liked('Films/d.mkv').liked, true);
  // No `liked` given: toggle.
  assert.deepEqual(library.like({ src: 'Films/d.mkv', viewers: 'adult1' }), { src: 'Films/d.mkv', liked: false });
  assert.deepEqual(await stored(), [1]);
  assert.deepEqual(likes(), {});
  assert.throws(() => library.like({ src: 'Nope/x.mp4', liked: true }), /not in this library/);
});

test('directions offers different real episodes, never the one playing, and marks nothing down', async () => {
  const { storage, library } = await setup();
  const before = storage.getItem('kidshuffle.log.v1');
  const offer = library.directions('cartoons', { current: 'Bluey/a.mp4', viewers: 'kid1,kid2,adult2,adult1' });
  assert.equal(offer.from, 'Bluey/a.mp4');
  assert.ok(offer.tiles.length >= 2, JSON.stringify(offer.tiles.map(tile => tile.kind)));
  const srcs = offer.tiles.map(tile => tile.src);
  assert.equal(new Set(srcs).size, srcs.length, 'no episode is offered twice');
  assert.ok(!srcs.includes('Bluey/a.mp4'), 'the episode playing is not offered');
  const more = offer.tiles.find(tile => tile.kind === 'more');
  assert.equal(more.src, 'Bluey/b.mp4');
  assert.equal(more.label, 'Bluey');
  for (const tile of offer.tiles) {
    assert.ok(tile.kind && tile.label && tile.title && tile.channel && tile.channel.id, JSON.stringify(tile));
    assert.ok(library.allowed(tile.src, 'kid1,kid2,adult2,adult1'), tile.src + ' is allowed for this audience');
  }
  assert.equal(storage.getItem('kidshuffle.log.v1'), before, 'asking for directions teaches nothing');
  assert.throws(() => library.directions('nope', {}), /Unknown channel/);

  const opt = { current: 'Bluey/a.mp4', viewers: 'kid1,kid2,adult2,adult1' };
  const batchA = library.directions('cartoons', { ...opt, offset: 0, limit: 1 });
  const batchB = library.directions('cartoons', { ...opt, offset: 1, limit: 1 });
  assert.equal(batchA.tiles.length, 1);
  assert.equal(batchA.next, 1);
  assert.equal(batchB.tiles.length, 1);
  assert.notEqual(batchA.tiles[0].src, batchB.tiles[0].src, 'paged batches do not overlap');
  let cursor = 0, pages = 0, allSrcs = [];
  for (;;) {
    const page = library.directions('cartoons', { ...opt, offset: cursor, limit: 1 });
    pages += 1;
    for (const tile of page.tiles) assert.ok(!allSrcs.includes(tile.src), 'no duplicate src across pages');
    allSrcs.push(...page.tiles.map(tile => tile.src));
    if (page.next == null) break;
    cursor = page.next;
    if (pages > 40) break;
  }
  assert.ok(pages >= 2, 'directions eventually pages');
  assert.equal(storage.getItem('kidshuffle.log.v1'), before, 'paging for directions teaches nothing');
});

test('a channel resumes the episode left on it; a skip or a short look does not hold it', async () => {
  const { library } = await setup();
  const viewers = 'kid1,kid2,adult2,adult1';
  const other = library.home(viewers).channels.find(channel => channel.id !== 'cartoons').id;
  const first = library.next('cartoons', { viewers });
  // Two minutes in, then away to another channel and back.
  library.progress({ src: first.src, positionSeconds: 200, durationSeconds: first.duration, completed: false });
  library.next(other, { viewers });
  const back = library.next('cartoons', { viewers });
  assert.equal(back.src, first.src, 'coming back resumes what was left');
  assert.equal(back.resume, 200);
  // A preview of the channel shows the same episode, and the home card bills it.
  assert.equal(library.next('cartoons', { viewers, prefetch: true }).src, first.src);
  assert.equal(library.next('cartoons', { viewers }).src, first.src, 'the home card and OK agree');
  // Skipping it moves the channel on: the next episode is now the one the channel holds.
  const second = library.next('cartoons', { viewers, current: first.src, reason: 'skip', time: 205, watched: 5, duration: first.duration });
  assert.notEqual(second.src, first.src);
  library.progress({ src: second.src, positionSeconds: 150, durationSeconds: second.duration, completed: false });
  library.next(other, { viewers });
  const third = library.next('cartoons', { viewers });
  assert.equal(third.src, second.src, 'the channel holds the episode it moved on to, not the skipped one');
  assert.equal(third.resume, 150);
});

test('a channel does not resume a title within 30 s of its end', async () => {
  const { library } = await setup();
  const viewers = 'kid1,kid2,adult2,adult1';
  const other = library.home(viewers).channels.find(channel => channel.id !== 'cartoons').id;
  const first = library.next('cartoons', { viewers });
  const nearEnd = first.duration - 5;
  library.progress({ src: first.src, positionSeconds: nearEnd, durationSeconds: first.duration, completed: false });
  library.next(other, { viewers });
  const back = library.next('cartoons', { viewers });
  assert.notEqual(back.src, first.src, 'nearly over is not held as the episode left on this channel');
  assert.notEqual(library.next('cartoons', { viewers, prefetch: true }).src, first.src);
});

test('a channel does not hold an episode that was barely started', async () => {
  const { library } = await setup();
  const viewers = 'kid1,kid2,adult2,adult1';
  const other = library.home(viewers).channels.find(channel => channel.id !== 'cartoons').id;
  const first = library.next('cartoons', { viewers });
  // The same visit with two minutes watched is held (the test above); with one minute it is an ordinary pick,
  // which the shuffle makes without the resume position being the reason.
  library.progress({ src: first.src, positionSeconds: 60, durationSeconds: first.duration, completed: false });
  library.next(other, { viewers });
  const fresh = await setup();
  const control = fresh.library.next('cartoons', { viewers });
  fresh.library.next(other, { viewers });
  assert.equal(library.next('cartoons', { viewers }).src === first.src, fresh.library.next('cartoons', { viewers }).src === control.src,
    'a barely started episode changes nothing about what the channel picks');
});

test('home lists what was liked, newest first, for audiences allowed to watch it', async () => {
  const { library } = await setup();
  assert.deepEqual(library.home('adult2,adult1').liked, []);
  library.like({ src: 'Films/d.mkv', viewers: 'adult1', liked: true });
  library.like({ src: 'Bluey/a.mp4', viewers: 'adult1', liked: true });
  const grown = library.home('adult2,adult1').liked;
  assert.ok(grown.some(item => item.src === 'Films/d.mkv'));
  for (const item of grown) assert.ok(item.channel && item.channel.id && item.title, JSON.stringify(item));
  // A child in the room never sees the grown-up film among the likes.
  assert.ok(!library.home('kid1,kid2,adult2,adult1').liked.some(item => item.src === 'Films/d.mkv'));
});

// Robin's music (Ian, 15 Nov 2026): "Robin loves music but he doesn't necessarily need separate triple J and
// double J categories. He probably likes kids music, and he definitely loves any kinda danceable techno".
const tune = (src, show, tier = 'music', title = 'Track') => ({ src, file: '/m/' + src, title, channel: show, tier, duration: 240 });
const fred = tune('music/Fred again../Fred again.. - Delilah [a].mp4', 'Fred again..');
const chems = tune('music/The Chemical Brothers/Go [b].mp4', 'The Chemical Brothers');
const radiohead = tune('music/Radiohead/Creep [c].mp4', 'Radiohead');
const giants = tune('music/The Jungle Giants/Heavy Hearted [d].mp4', 'The Jungle Giants');
const wiggles = tune('preschool/The Wiggles/Gentle Songs [e].mp4', 'The Wiggles', 'preschool', 'Gentle Songs for Children');
const rachel = tune('preschool/Ms Rachel/Songs [f].mp4', 'Ms Rachel', 'preschool', 'Best Baby Songs with Ms Rachel');
const karaoke = tune('Numberblocks/k.mp4', 'Numberblocks', 'preschool', 'Five’s Friendship Song Karaoke!');
const samMusic = [...videos, fred, chems, radiohead, giants, wiggles, rachel, karaoke,
  tune('Hop Hop the Owl/h.mp4', 'Hop Hop the Owl', 'preschool', 'Episode')];
const stations = { triplej: { items: { [fred.src]: { score: 1 } } }, doublej: { items: { [radiohead.src]: { score: 1 } } } };

test('a child in the room gets Songs and Dance, and the radio stations stay with the grown-ups', async () => {
  const { history, storage } = await setup();
  const library = createTvLibrary({ videos: samMusic, history, storage, channelScores: stations, random: () => 0, now: () => localHour(15) });
  const ids = viewers => library.home(viewers).channels.map(channel => channel.id);
  for (const viewers of ['kid1,adult2,adult1', 'kid1', 'kid2,adult2,adult1']) {
    const lineup = ids(viewers);
    assert.ok(!lineup.includes('triplej') && !lineup.includes('doublej'), viewers);
    for (const id of ['kidsongs', 'dance', 'music']) assert.ok(lineup.includes(id), `${viewers} ${id}`);
  }
  for (const viewers of ['adult1', 'adult2,adult1']) {
    const lineup = ids(viewers);
    assert.ok(lineup.includes('triplej') && lineup.includes('doublej') && lineup.includes('music'), viewers);
    assert.ok(!lineup.includes('kidsongs') && !lineup.includes('dance'), viewers);
  }
  // Robin's own running order: his music follows his three favourites, ahead of the rest.
  assert.deepEqual(ids('kid1,adult2,adult1').slice(0, 5), ['bluey', 'littleones', 'hophop', 'kidsongs', 'dance']);
  const early = createTvLibrary({ videos: samMusic, history, storage, random: () => 0, now: () => localHour(8) });
  assert.deepEqual(early.home('kid1,adult2,adult1').channels.slice(0, 5).map(channel => channel.id), ['cartoons', 'littleones', 'bluey', 'kidsongs', 'dance']);
});

test('Dance is the danceable electronic acts; Songs is children\'s music by show or by title', () => {
  for (const item of [fred, chems, tune('music/ODESZA/x.mp4', 'ODESZA'), tune('music/Jungle/x.mp4', 'Jungle'), tune('music/RÜFÜS DU SOL/x.mp4', 'RÜFÜS DU SOL'),
    tune('music/Barry Can’t Swim/x.mp4', 'Barry Can’t Swim'), tune('music/Fred again . ./x.mp4', 'Fred again . .')]) assert.equal(inTvGenre(item, 'dance'), true, item.channel);
  for (const item of [radiohead, giants, wiggles, tune('music/Mac Miller/x.mp4', 'Mac Miller'), tune('music/Tiny Desk/x.mp4', 'Tiny Desk'),
    tune('ads/80s/ad.mp4', 'Fatboy Slim')]) assert.equal(inTvGenre(item, 'dance'), false, item.channel);
  for (const item of [wiggles, rachel, karaoke]) assert.equal(inTvGenre(item, 'kidsongs'), true, item.title);
  for (const item of [videos[0], fred, tune('music/Kids Songs Band/x.mp4', 'Kids Songs Band', 'music', 'Songs'),
    tune('Kangaroo Beach/w.mp4', 'Kangaroo Beach', 'shared', 'Series 3 Whale Song Spectacular')]) assert.equal(inTvGenre(item, 'kidsongs'), false, item.title);
});

test('a measured score leans Dance without deciding who is on it', async () => {
  const { history, storage } = await setup();
  const acts = ['Fred again..', 'The Chemical Brothers', 'ODESZA', 'Flume', 'Bicep', 'Caribou', 'Justice', 'Disclosure'].map((name, i) => tune(`music/${name}/${i}.mp4`, name));
  const bright = acts.slice(0, 4), plain = acts.slice(4);
  const scores = { dance: { items: { ...Object.fromEntries(bright.map(item => [item.src, { score: 1 }])), [radiohead.src]: { score: 1 } } } };
  assert.equal(inTvGenre(radiohead, 'dance', scores), false, 'a score alone does not put an act on Dance');
  assert.equal(inTvGenre(plain[0], 'dance', scores), true, 'an unmeasured act stays on');
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let nowMs = localHour(15);
  const library = createTvLibrary({ videos: [...videos, ...acts, radiohead], history, storage, channelScores: scores, random, now: () => nowMs });
  const picks = new Map();
  let current;
  for (let i = 0; i < 600; i++) {
    // Independent draws: prior plays must age out of the three-day exclusion.
    nowMs += 4 * 24 * 60 * 60 * 1000;
    // Surfing teaches nothing on a skip before half a minute; music's early-skip rule uses the clock position, not watched seconds.
    const item = library.next('dance', { viewers: 'kid1', current, reason: 'skip', time: 35, duration: 240, watched: 1 });
    picks.set(item.src, (picks.get(item.src) || 0) + 1); current = item.src;
  }
  const total = list => list.reduce((sum, item) => sum + (picks.get(item.src) || 0), 0);
  assert.equal(picks.has(radiohead.src), false);
  assert.ok(total(bright) > total(plain) * 1.3, `${total(bright)} bright, ${total(plain)} plain`);
  assert.ok(plain.every(item => picks.get(item.src) > 15), 'every unmeasured act still plays');
});

test('two cards never show the same show after a tune moves a channel on', async () => {
  const kid = (show, n) => ({ src: `${show}/${n}.mp4`, file: `/m/${show}/${n}.mp4`, title: `${show} ${n}`, channel: show, tier: 'preschool', duration: 420 });
  const catalogue = ['Bing', 'Peppa Pig', 'Hey Duggee', 'CBeebies Bedtime Stories', 'Sarah and Duck'].flatMap(show => [1, 2, 3].map(n => kid(show, n)));
  const { history, storage } = await setup();
  let seed = 3;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const library = createTvLibrary({ videos: catalogue, history, storage, random, now: () => localHour(15) });
  const shows = () => library.home('kid1').channels.filter(channel => ['cartoons', 'littleones'].includes(channel.id)).map(channel => channel.now.show);
  for (let i = 0; i < 40; i++) {
    const [cartoons, little] = shows();
    assert.notEqual(cartoons, little, `round ${i}`);
    library.next(i % 2 ? 'cartoons' : 'littleones', { viewers: 'kid1' });
  }
});

test('score files from several tools merge by channel, a later file replacing an earlier one\'s channel', () => {
  const stationsFile = parseChannelScores(JSON.stringify({ channels: { triplej: { items: { 'a.mp4': { score: 0.9 } } }, dance: { items: { 'old.mp4': { score: 0.1 } } } } }));
  const measured = parseChannelScores(JSON.stringify({ channels: { dance: { items: { 'b.mp4': { score: 0.7 } } } } }));
  const merged = mergeChannelScores([stationsFile, null, measured]);
  assert.deepEqual(Object.keys(merged).sort(), ['dance', 'triplej']);
  assert.deepEqual(Object.keys(merged.dance.items), ['b.mp4']);
  assert.equal(merged.triplej.items['a.mp4'].score, 0.9);
  assert.equal(mergeChannelScores([null, null]), null);
});

// Pictures ready before a card needs them: a fresh lineup from the M2 took 2 to 4 s to fill (15 Nov 2026).
test('billing lists what each card shows now, then what each will show next', async () => {
  const kid = (show, n) => ({ src: `${show}/${n}.mp4`, file: `/m/${show}/${n}.mp4`, title: `${show} ${n}`, channel: show, tier: 'preschool', duration: 420 });
  const catalogue = ['Bing', 'Peppa Pig', 'Hey Duggee', 'Sarah and Duck'].flatMap(show => [1, 2, 3].map(n => kid(show, n)));
  const { history, storage } = await setup();
  const library = createTvLibrary({ videos: catalogue, history, storage, random: () => 0, now: () => localHour(15) });
  const cards = library.home('kid1').channels;
  const billed = library.billing('kid1');
  assert.deepEqual(billed.slice(0, cards.length).map(item => '/art?src=' + encodeURIComponent(item.src)), cards.map(card => card.now.art));
  assert.ok(billed.length > cards.length, 'the next picks follow');
  assert.ok(billed.every(item => item.file && item.duration === 420));
  // A lineup just made is taken as given, not made again.
  assert.deepEqual(library.billing('kid1', null, cards).map(item => item.src), billed.map(item => item.src));
  // Asking does not move a channel on.
  assert.deepEqual(library.home('kid1').channels.map(card => card.now.art), cards.map(card => card.now.art));
});

test('the art warmer makes one picture at a time and does not double up for one audience', async () => {
  const order = [];
  let active = 0, most = 0;
  const artwork = { get: async file => { active++; most = Math.max(most, active); order.push(file); await new Promise(resolve => setTimeout(resolve, 2)); active--; return file + '.jpg'; } };
  const library = { billing: () => [{ file: '/m/a.mp4', duration: 60 }, { file: '/m/b.mp4', duration: 60 }, { file: '/m/c.mp4', duration: 60 }] };
  const warm = createArtWarmer({ library, artwork });
  const [first, second] = await Promise.all([warm('kid1'), warm('kid1')]);
  assert.deepEqual([first, second], [3, 0]);
  assert.deepEqual(order, ['/m/a.mp4', '/m/b.mp4', '/m/c.mp4']);
  assert.equal(most, 1);
  assert.equal(await createArtWarmer({ library, artwork: null })('kid1'), 0);
  assert.equal(await createArtWarmer({ library: {}, artwork })('kid1'), 0);
});

test('asking for the lineup starts its pictures', async () => {
  const { dir, history, storage, library } = await setup();
  const asked = [];
  const artwork = { get: async file => { asked.push(file); return null; } };
  const server = createTvServer({ library, history, storage, uiRoot: dir, artwork });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const home = await (await fetch(`http://127.0.0.1:${server.address().port}/api/home?viewers=kid1`)).json();
    for (let i = 0; i < 50 && asked.length < home.channels.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(asked.slice(0, home.channels.length).map(file => file.replace('/m/', '')), home.channels.map(card => decodeURIComponent(card.now.art.split('src=')[1])));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('whoami answers a nonce with proof of the token, and nothing without a token or a proper nonce', async () => {
  const { dir, history, storage, library } = await setup();
  const make = async token => { const server = createTvServer({ library, history, storage, uiRoot: dir, token }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; };
  const paired = await make('secret'), unpaired = await make('');
  const ask = (server, nonce) => fetch(`http://127.0.0.1:${server.address().port}/api/whoami?n=${nonce}`);
  try {
    const nonce = 'a'.repeat(32);
    const reply = await ask(paired, nonce);
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert.equal(body.proof, whoamiProof('secret', nonce));
    assert.ok(!JSON.stringify(body).includes('secret'));
    assert.equal((await ask(paired, 'short')).status, 404);
    assert.equal((await ask(paired, 'z'.repeat(32))).status, 404);
    assert.equal((await ask(unpaired, nonce)).status, 404);
  } finally { await Promise.all([paired, unpaired].map(server => new Promise(resolve => server.close(resolve)))); }
});

test('titles read as people write them: no emoji, broadcaster tags, upload padding or repeats of the show', async () => {
  const { tidyTitle } = await import('./tv-server.js');
  assert.equal(tidyTitle('Hidden treasure in Porthole？! 💰🗺️｜ Stan & Gran ｜ ABC Kids', 'Stan & Gran'), 'Hidden treasure in Porthole?!');
  assert.equal(tidyTitle("JoJo & Gran Gran： It's Time to Play Beach Cricket ｜ FULL EPISODE ｜ CBeebies", 'JoJo and Gran Gran'), "It's Time to Play Beach Cricket");
  assert.equal(tidyTitle('Bonobo - Drift (Official Video)', 'Bonobo'), 'Drift');
  assert.equal(tidyTitle('Kylie Minogue reads The Australian 12 Days of Christmas ｜ CBeebies Bedtime Story', 'CBeebies Bedtime Stories'), 'Kylie Minogue reads The Australian 12 Days of Christmas');
  assert.equal(tidyTitle('Camping in the Garden ｜ Season 3 Episode 21-22 ｜ ｜ 20+ MINS', 'Charlie and Lola'), 'Camping in the Garden · Season 3 Episode 21-22');
  assert.equal(tidyTitle('Boo', 'Bing'), 'Boo');
  assert.equal(tidyTitle('Baby cartoons & baby learning videos for kids - Hop Hop the owl & funny cartoons for kids', 'Hop Hop the Owl'), '');
  assert.equal(tidyTitle('Four Tet - Sing', 'Four Tet'), 'Sing');
  assert.equal(tidyTitle('Chet Faker performs Far Side of the Moon for Mahogany Sessions', 'Mahogany'), 'Chet Faker — Far Side of the Moon');
  assert.equal(tidyTitle('Post Malone: Tiny Desk Concert', 'Tiny Desk'), 'Post Malone');
  assert.equal(tidyTitle('The Horrors - Something To Remember Me By (Live on KEXP)', 'KEXP'), 'The Horrors — Something To Remember Me By');
  assert.equal(tidyTitle('Masego - Navajo ｜ A COLORS SHOW', 'COLORS'), 'Masego — Navajo');
  assert.equal(tidyTitle('Episode 5', 'Bluey'), 'Episode 5');
  assert.equal(tidyTitle('｜ CBeebies ｜', 'Bing'), 'CBeebies');
});

test('Fireplace channel takes only the Christmas Fireplace folder, for every audience', () => {
  const fire = { src: 'Christmas Fireplace/Fireplace 4K [abc].mkv', channel: 'Christmas Fireplace', tier: 'shared', title: 'Fireplace 4K' };
  const other = { src: 'Bluey/a.mp4', channel: 'Bluey', tier: 'shared', title: 'a' };
  const film = { src: 'films/Elf (2003)/Elf (2003).mp4', channel: 'films', tier: 'family', title: 'Elf' };
  assert.ok(inTvGenre(fire, 'fireplace'));
  assert.ok(!inTvGenre(other, 'fireplace'));
  assert.ok(!inTvGenre(film, 'fireplace'));
  const def = TV_CHANNELS.find(channel => channel.id === 'fireplace');
  assert.equal(def.audience, 'all');
  assert.equal(new Set(TV_NUMBERS()).size, TV_NUMBERS().length);
});

test('channel picture pools: one per folder, credits carried, Christmas film stills first, paths kept inside', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { scanChannelArt, channelArtFile } = await import('./tv-server.js');
  const dir = mkdtempSync(join(tmpdir(), 'hero-'));
  mkdirSync(join(dir, 'channels', 'trains'), { recursive: true });
  writeFileSync(join(dir, 'channels', 'trains', '01-f40.jpg'), 'x');
  writeFileSync(join(dir, 'channels', 'trains', 'notes.txt'), 'x');
  writeFileSync(join(dir, 'channels', 'trains', 'credits.json'), JSON.stringify({ '01-f40.jpg': { author: 'A. Photographer', licence: 'CC BY-SA 4.0' } }));
  const pools = scanChannelArt(dir, { 'Family Films/Elf (2003).mp4': 'elf-2003.jpg' });
  assert.deepEqual(pools.trains, [{ url: '/channel-art?c=trains&f=01-f40.jpg', credit: 'A. Photographer · CC BY-SA 4.0' }]);
  assert.equal(pools.christmas[0].url, '/channel-art?c=_stills&f=elf-2003.jpg');
  assert.equal(channelArtFile(dir, 'trains', '../x.jpg'), null);
  assert.equal(channelArtFile(dir, '../etc', 'a.jpg'), null);
  assert.equal(channelArtFile(dir, 'trains', '01-f40.jpg'), join(dir, 'channels', 'trains', '01-f40.jpg'));
});
// Grown-up tiers stay out of Max's grid. The 'older' tier is his since 22 Nov 2026 (it is rated PG).
const TUBE_FORBIDDEN = ['Films/d.mkv', 'Mobland/a.mp4'];

function tubeCatalogue() {
  return [
    { src: 'Bluey/a.mp4', file: '/m/Bluey/a.mp4', title: 'Bluey S01E01 Keepy Uppy', channel: 'Bluey', tier: 'shared', duration: 420 },
    { src: 'Bluey/b.mp4', file: '/m/Bluey/b.mp4', title: 'Bluey S01E02 Hospital', channel: 'Bluey', tier: 'shared', duration: 420 },
    { src: 'Bluey/c.mp4', file: '/m/Bluey/c.mp4', title: 'Bluey S01E03 Shadowlands', channel: 'Bluey', tier: 'shared', duration: 420 },
    { src: 'Grian/e1.mp4', file: '/m/Grian/e1.mp4', title: 'Hermitcraft S01E01 The Start', channel: 'Grian', tier: 'big', duration: 800 },
    { src: 'Grian/e2.mp4', file: '/m/Grian/e2.mp4', title: 'Hermitcraft S01E02 RC car jump', channel: 'Grian', tier: 'big', duration: 900 },
    { src: 'Mumbo/m.mp4', file: '/m/Mumbo/m.mp4', title: 'Redstone shop', channel: 'Mumbo Jumbo', tier: 'big', duration: 700 },
    { src: 'Films/d.mkv', file: '/m/Films/d.mkv', title: 'Grown Up Film RC', channel: 'Films', tier: 'grownup', duration: 6000 },
    { src: 'Mobland/a.mp4', file: '/m/Mobland/a.mp4', title: 'MobLand S01E01 The Sign', channel: 'Mobland', tier: 'grownup', duration: 3000 },
    { src: 'Older/rc.mp4', file: '/m/Older/rc.mp4', title: 'RC stunt special', channel: 'Stunt RC', tier: 'older', duration: 500 },
  ];
}

function assertOlderCannotSee(cards, where) {
  const srcs = cards.map(card => card.src);
  for (const src of TUBE_FORBIDDEN) assert.equal(srcs.includes(src), false, `${src} leaked into ${where}`);
  for (const card of cards) {
    assert.equal(typeof card.title, 'string');
    assert.equal(typeof card.creator, 'string');
    assert.equal(card.art.startsWith('/art?src='), true);
  }
}

async function tubeLibrary() {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-tube-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  storage.setItem('kidshuffle.weights.v2.sforkid2', JSON.stringify({
    'Mumbo/m.mp4': 3.5,
    'Grian/e2.mp4': 2,
    'Bluey/b.mp4': 1.2,
  }));
  const library = createTvLibrary({ videos: tubeCatalogue(), history, storage, random: () => 0 });
  assert.equal(library.progress({ src: 'Bluey/a.mp4', positionSeconds: 200, durationSeconds: 420, completed: false }), true);
  return { dir, history, storage, library };
}

test('tube feed, related, search and creators stay inside the audience', async () => {
  const { library } = await tubeLibrary();
  const older = { viewers: 'kid2,adult2,adult1' };
  const feed = library.feed(older);
  assert.equal(feed.cards[0].src, 'Bluey/a.mp4', 'a part-watched video leads');
  assert.equal(feed.cards[0].resume, 200);
  assert.equal(feed.cards[0].watched, false);
  assert.equal(feed.cards[1].src, 'Mumbo/m.mp4', 'unwatched favourites follow, highest learned weight first');
  assertOlderCannotSee(feed.cards, 'feed');
  assert.equal(feed.chips[0].id, 'all');
  assert.equal(feed.chips.some(chip => chip.label === 'Bluey'), true);
  assert.equal(feed.chips.some(chip => /mobland|films/i.test(chip.label)), false);
  assert.ok(feed.chips.length <= 9);
  let run = 1;
  for (let i = 1; i < feed.cards.length; i++) {
    run = feed.cards[i].show === feed.cards[i - 1].show ? run + 1 : 1;
    assert.ok(run <= 2, feed.cards.map(card => card.show).join(' '));
  }
  const bluey = library.feed({ ...older, chip: 'bluey' });
  assert.ok(bluey.cards.length > 0);
  assert.ok(bluey.cards.every(card => card.show === 'Bluey'));
  assert.deepEqual(bluey.cards.map(card => card.src), ['Bluey/c.mp4', 'Bluey/b.mp4', 'Bluey/a.mp4'], 'a creator chip is newest-first');
  assert.equal(library.feed({ ...older, chip: 'mobland' }).cards.length, 0);

  const youngest = library.feed({ viewers: 'kid1' });
  assert.equal(youngest.cards.some(card => card.src.startsWith('Grian/')), false, 'PG titles stay off Robin');
  assert.equal(youngest.cards.some(card => card.src.startsWith('Bluey/')), true);
  const dad = library.feed({ viewers: 'adult1' });
  assert.equal(dad.cards.some(card => card.src === 'Films/d.mkv'), true);

  const related = library.related('Grian/e1.mp4', older);
  assert.equal(related.cards[0].src, 'Grian/e2.mp4', 'the next episode is the autoplay pick');
  assertOlderCannotSee(related.cards, 'related');
  assert.equal(related.cards.some(card => card.src === 'Grian/e1.mp4'), false);
  assert.throws(() => library.related('missing.mp4', older), /not in this library/);
  assert.deepEqual(library.related('Films/d.mkv', older).cards, []);

  const found = library.search('rc', older.viewers, null);
  assert.deepEqual(found.cards.map(card => card.src), ['Grian/e2.mp4', 'Older/rc.mp4'], 'the older tier is his; the grown-up film is not');
  assert.equal(found.suggestions.includes('Stunt RC'), true);
  assert.deepEqual(library.search('rc', 'kid1', null).cards.map(card => card.src), [], 'nothing above G for the youngest');
  assert.deepEqual(library.search('grian', older.viewers, null).suggestions, ['Grian']);
  assert.equal(library.search('mobland', older.viewers, null).cards.length, 0);
  const dadSearch = library.search('rc', 'adult1', null);
  assert.equal(dadSearch.cards.some(card => card.src === 'Films/d.mkv'), true);
  assert.equal(dadSearch.suggestions.includes('Stunt RC'), true);

  const creators = library.creators(older);
  assert.equal(creators.creators.some(creator => creator.name === 'Mobland'), false);
  const grian = creators.creators.find(creator => creator.id === 'grian');
  assert.equal(grian.label, 'Grian');
  assert.equal(grian.count, 2);
  assert.equal(grian.art, '/art?src=' + encodeURIComponent('Grian/e2.mp4'));
  const episodes = library.creators({ ...older, id: 'grian' });
  assert.deepEqual(episodes.cards.map(card => card.src), ['Grian/e2.mp4', 'Grian/e1.mp4']);
});

test('tube HTTP endpoints filter a title Max cannot watch', async () => {
  const { dir, history, storage, library } = await tubeLibrary();
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const older = 'viewers=' + encodeURIComponent('kid2,adult2,adult1');
  try {
    const feed = await (await fetch(`${base}/api/feed?${older}`)).json();
    assertOlderCannotSee(feed.cards, 'GET /api/feed');
    assert.equal(feed.cards[0].src, 'Bluey/a.mp4');
    const related = await (await fetch(`${base}/api/related?src=${encodeURIComponent('Grian/e1.mp4')}&${older}`)).json();
    assert.equal(related.cards[0].src, 'Grian/e2.mp4');
    assertOlderCannotSee(related.cards, 'GET /api/related');
    const search = await (await fetch(`${base}/api/search?q=rc&${older}`)).json();
    assert.deepEqual(search.cards.map(card => card.src), ['Grian/e2.mp4', 'Older/rc.mp4']);
    assert.equal(search.suggestions.includes('Stunt RC'), true);
    const creators = await (await fetch(`${base}/api/creators?${older}`)).json();
    assert.equal(creators.creators.some(creator => TUBE_FORBIDDEN.some(src => creator.art.includes(encodeURIComponent(src)))), false);
    assert.equal((await fetch(`${base}/api/feed`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 405);
    assert.equal((await fetch(`${base}/api/related?src=nope`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the live library proxy in bin/tv-server.js forwards every method the HTTP routes call', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../bin/tv-server.js', import.meta.url), 'utf8');
  const proxy = src.slice(src.indexOf('const current = {'), src.indexOf('};', src.indexOf('const current = {')));
  for (const name of ['home', 'next', 'show', 'catalogue', 'allowed', 'feed', 'related', 'search', 'creators', 'knownInfo', 'rememberInfo']) {
    assert.ok(new RegExp('\\b' + name + ':').test(proxy), `proxy forwards ${name}`);
  }
});

// The household's YouTube ledger (src/youtube-watch.js) reorders the tube grid; it never admits a title.
async function tubeLibraryWithLedger(channels, events = []) {
  const { parseYouTubeWatch } = await import('./youtube-watch.js');
  const index = parseYouTubeWatch(JSON.stringify({ version: 1, generated: '2026-11-22T05:00:00Z', channels, events }));
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-tube-yt-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  storage.setItem('kidshuffle.weights.v2.sforkid2', JSON.stringify({ 'Mumbo/m.mp4': 3.5, 'Grian/e2.mp4': 2, 'Bluey/b.mp4': 1.2 }));
  return createTvLibrary({ videos: tubeCatalogue(), history, storage, random: () => 0, youtubeWatch: () => index });
}

test('creators watched on YouTube lately lead the tube chips and cards', async () => {
  const library = await tubeLibraryWithLedger({
    '@grian': { name: 'Grian', verdict: 'good', recent: { seconds: 7200, shorts: 0 } },
  });
  const feed = library.feed({ viewers: 'kid2,adult2,adult1' });
  assert.equal(feed.chips[1].label, 'Grian', 'the creator with YouTube time is the first chip');
  assert.equal(feed.cards[0].creator, 'Grian', 'a promoted, lately watched creator outranks a higher learned weight');
  assert.equal(library.creators({ viewers: 'kid2,adult2,adult1' }).creators[0].name, 'Grian');
});

test('YouTube time never brings a title past the audience rule', async () => {
  const library = await tubeLibraryWithLedger({
    '@mobland': { name: 'Mobland', verdict: 'good', recent: { seconds: 90000, shorts: 50 } },
    '@stuntrc': { name: 'Stunt RC', verdict: 'good', recent: { seconds: 90000, shorts: 50 } },
    '@films': { name: 'Films', verdict: 'good', recent: { seconds: 90000, shorts: 50 } },
  });
  const older = { viewers: 'kid2,adult2,adult1' };
  const feed = library.feed(older);
  assertOlderCannotSee(feed.cards, 'feed with a YouTube ledger');
  assert.equal(feed.chips.some(chip => /mobland|films/i.test(chip.label)), false);
  assertOlderCannotSee(library.related('Bluey/a.mp4', older).cards, 'related with a YouTube ledger');
  assertOlderCannotSee(library.search('rc', 'kid2,adult2,adult1').cards, 'search with a YouTube ledger');
  assert.equal(library.creators(older).creators.some(creator => /mobland|films/i.test(creator.name)), false);
  const youngest = { viewers: 'kid1,adult2,adult1' };
  const forSam = [...library.feed(youngest).cards, ...library.search('rc', 'kid1,adult2,adult1').cards];
  assert.equal(forSam.some(card => card.src === 'Older/rc.mp4' || card.src === 'Grian/e2.mp4'), false, 'the youngest viewer still sets the ceiling');
});

test('a creator the ledger blocks leaves the tube grid, search, related and creators', async () => {
  const library = await tubeLibraryWithLedger({ '@mumbo': { name: 'Mumbo Jumbo', verdict: 'block' } });
  const older = { viewers: 'kid2,adult2,adult1' };
  const has = cards => cards.some(card => card.src === 'Mumbo/m.mp4');
  assert.equal(has(library.feed(older).cards), false);
  assert.equal(has(library.related('Grian/e1.mp4', older).cards), false);
  assert.equal(has(library.search('redstone', 'kid2,adult2,adult1').cards), false);
  assert.equal(library.creators(older).creators.some(creator => creator.name === 'Mumbo Jumbo'), false);
  assert.equal(library.feed(older).cards.some(card => card.creator === 'Grian'), true, 'everything else stays');
});

test('a preschool creator watched on YouTube lifts the youngest viewer\'s grid, not an older child\'s', async () => {
  const { parseYouTubeWatch } = await import('./youtube-watch.js');
  const index = parseYouTubeWatch(JSON.stringify({ version: 1, generated: '2026-11-22T05:00:00Z', events: [], channels: {
    '@owl': { name: 'Owl Babies', verdict: 'good', recent: { seconds: 90000, shorts: 0 } },
    '@grian': { name: 'Grian', verdict: 'cleared', recent: { seconds: 1800, shorts: 0 } },
  } }));
  const videos = [...tubeCatalogue(),
    { src: 'Owl/a.mp4', file: '/m/Owl/a.mp4', title: 'Owl Babies one', channel: 'Owl Babies', tier: 'preschool', duration: 300 },
    { src: 'Owl/b.mp4', file: '/m/Owl/b.mp4', title: 'Owl Babies two', channel: 'Owl Babies', tier: 'preschool', duration: 300 }];
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-tube-little-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos, history, storage, random: () => 0, youtubeWatch: () => index });
  const older = library.feed({ viewers: 'kid2,adult2,adult1' });
  assert.equal(older.chips[1].label, 'Grian', 'the older child sees his own creator first');
  assert.equal(older.chips.some(chip => chip.label === 'Owl Babies'), false, 'household preschool time does not make a chip for him');
  assert.equal(older.cards.some(card => card.creator === 'Owl Babies'), true, 'the show itself is still there to choose');
  assert.notEqual(older.cards[0].creator, 'Owl Babies');
  const little = library.feed({ viewers: 'kid1,adult2,adult1' });
  assert.equal(little.chips[1].label, 'Owl Babies', 'with the little one watching it leads');
  assert.equal(little.cards[0].creator, 'Owl Babies');
});
test('with no ledger the tube grid orders as before', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-tube-plain-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  storage.setItem('kidshuffle.weights.v2.sforkid2', JSON.stringify({ 'Mumbo/m.mp4': 3.5, 'Grian/e2.mp4': 2, 'Bluey/b.mp4': 1.2 }));
  const plain = createTvLibrary({ videos: tubeCatalogue(), history, storage, random: () => 0 });
  const empty = createTvLibrary({ videos: tubeCatalogue(), history, storage, random: () => 0, youtubeWatch: () => null });
  const order = library => library.feed({ viewers: 'kid2,adult2,adult1' }).cards.map(card => card.src);
  assert.deepEqual(order(empty), order(plain));
  assert.equal(order(plain)[0], 'Mumbo/m.mp4');
});

test('streamFile serves SSD-warmed blocks with knownInfo without statting a sleeping USB drive', async () => {
  const { createServer } = await import('node:http');
  const { unlink } = await import('node:fs/promises');
  const { streamFile } = await import('./tv-server.js');
  const { createMediaCache } = await import('./media-cache.js');
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-ssd-'));
  const sourceFile = join(dir, 'episode.mp4');
  const payload = Buffer.from('0123456789abcdef'.repeat(64));
  await writeFile(sourceFile, payload);
  const st = await stat(sourceFile);
  const known = { size: st.size, mtimeMs: st.mtimeMs };
  const cache = await createMediaCache({
    directory: join(dir, 'cache'),
    blockBytes: 256,
    reserveBytes: 0,
    eligible: () => true,
  });
  await cache.keep([{ file: sourceFile, info: known }]);
  await cache.warm(sourceFile, known, { durationSeconds: 10 });
  // Simulate the slow/unmounted USB drive being absent for stat() while cached blocks live on SSD.
  await unlink(sourceFile);
  let remembered = null;
  const server = createServer((req, res) => {
    streamFile(req, res, sourceFile, cache, null, known, (f, info) => { remembered = { f, info }; })
      .catch(err => { res.statusCode = err.status || 500; res.end(err.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/media`, { headers: { Range: 'bytes=0-31' } });
    assert.equal(res.status, 206);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), payload.subarray(0, 32).toString());
    assert.equal(remembered, null, 'knownInfo skips stat(file) completely');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await cache.close();
  }
});

test('shared-tier baby shows half-watched in household history do not hijack the older child\'s Tube Home or Creators', async () => {
  const { parseYouTubeWatch } = await import('./youtube-watch.js');
  const index = parseYouTubeWatch(JSON.stringify({
    version: 1,
    generated: '2026-11-23T05:00:00Z',
    events: [],
    channels: {
      '@beckbroplays': { name: 'BeckBroPlays', verdict: 'unjudged', recent: { seconds: 30000, shorts: 0 } },
      '@fuzz': { name: 'Fuzz', verdict: 'cleared', recent: { seconds: 16000, shorts: 0 } },
    },
  }));
  const cat = [
    ...tubeCatalogue(),
    { src: 'Bing/e1.mp4', file: '/m/Bing/e1.mp4', title: 'Bing 1', channel: 'Bing', tier: 'shared', duration: 420 },
    { src: 'Play School/e1.mp4', file: '/m/Play School/e1.mp4', title: 'Play School 1', channel: 'Play School', tier: 'shared', duration: 1500 },
    { src: 'Numberblocks/e1.mp4', file: '/m/Numberblocks/e1.mp4', title: 'One', channel: 'Numberblocks', tier: 'shared', duration: 300 },
    { src: 'BeckBroPlays/c1 [abcDEF12345].mp4', file: '/m/BeckBroPlays/c1 [abcDEF12345].mp4', title: 'I Evolved My Tiny Car!', channel: 'BeckBroPlays', tier: 'older', duration: 900 },
    { src: 'Fuzz/f1 [xyzUVW67890].mp4', file: '/m/Fuzz/f1 [xyzUVW67890].mp4', title: '100 Days Underground', channel: 'Fuzz', tier: 'older', duration: 1200 },
  ];
  const dir = await mkdtemp(join(tmpdir(), 'onto-tv-tube-baby-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos: cat, history, storage, random: () => 0, youtubeWatch: () => index });
  // Simulate the youngest child leaving three shared-tier baby cartoons half-watched.
  library.progress({ src: 'Bing/e1.mp4', positionSeconds: 180, durationSeconds: 420, completed: false });
  library.progress({ src: 'Play School/e1.mp4', positionSeconds: 400, durationSeconds: 1500, completed: false });
  library.progress({ src: 'Numberblocks/e1.mp4', positionSeconds: 120, durationSeconds: 300, completed: false });
  library.progress({ src: 'Grian/e1.mp4', positionSeconds: 600, durationSeconds: 600, completed: true });

  const older = library.feed({ viewers: 'kid2,adult2,adult1' });
  const top3Creators = older.cards.slice(0, 3).map(card => card.creator);
  assert.equal(top3Creators.includes('Bing'), false, 'shared baby resume does not hijack top of older Tube grid');
  assert.equal(top3Creators.includes('Play School'), false);
  assert.equal(older.cards[0].creator, 'BeckBroPlays', 'top YouTube creator leads older Tube Home');
  assert.equal(older.cards.slice(0, 3).some(card => card.creator === 'Fuzz'), true, 'unjudged/cleared YouTube favourite also surfaces');
  assert.equal(older.chips.some(chip => chip.label === 'Bing' || chip.label === 'Play School'), false);
  const creators = library.creators({ viewers: 'kid2,adult2,adult1' }).creators.map(c => c.name);
  assert.equal(creators[0], 'BeckBroPlays');
  assert.equal(creators.includes('Bing'), false, 'household baby-show watch time does not put Bing in older Creators');

  const libView = library.feed({ viewers: 'kid2,adult2,adult1', chip: 'library' });
  assert.deepEqual(libView.cards.map(c => c.src), ['Grian/e1.mp4'], 'Tube Library shows older viewer\'s non-baby history');
});
