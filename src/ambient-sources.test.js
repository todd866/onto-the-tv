import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_AMBIENT_OPTIONS, AMBIENT_LOCATIONS, createAmbientSources, validateAmbientOptions } from './ambient-sources.js';

const temporaryRoots = [];
test.after(async () => { await Promise.all(temporaryRoots.map(root => rm(root, { recursive: true, force: true }))); });

async function fixtureStore() {
  const root = await mkdtemp('/private/tmp/onto-ambient-');
  temporaryRoots.push(root);
  const run = '2026-09-27T000000Z';
  const dir = join(root, 'products', 'points', 'ecmwf_ifs', 'runs', run);
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, 'products', 'points', 'ecmwf_ifs', 'current.json'), JSON.stringify({ latest: run }));
  await writeFile(join(dir, 'cottesloe.json'), JSON.stringify({ run: '2026-09-27T00:00:00Z', time: Array.from({ length: 13 }, (_, i) => `2026-09-27T${String(i).padStart(2, '0')}:00`), hourly: { temperature_2m: Array.from({ length: 13 }, (_, i) => 17 + i), weather_code: Array(13).fill(2) } }));
  return root;
}

test('ambient options are conservative and whitelist paths, locations and pace', () => {
  assert.deepEqual(validateAmbientOptions({}), DEFAULT_AMBIENT_OPTIONS);
  assert.equal(validateAmbientOptions({ location: 'yssy', pace: 40, photoFolder: '/tmp/photos' }).location, 'yssy');
  assert.throws(() => validateAmbientOptions({ location: '../secret' }));
  assert.throws(() => validateAmbientOptions({ pace: 5 }));
  assert.throws(() => validateAmbientOptions({ photoFolder: 'relative' }));
  assert.equal(AMBIENT_LOCATIONS.length, 6);
});

test('weather reads Isobar current pointer and gives a compact forecast', async () => {
  const store = await fixtureStore();
  const result = await createAmbientSources({ store, now: () => Date.parse('2026-09-27T01:30:00Z') }).snapshot({ weather: true });
  assert.equal(result.issues.length, 0);
  assert.equal(result.slides[0].kind, 'weather');
  assert.match(result.slides[0].title, /18°/);
  assert.equal(result.slides[0].forecast.length, 4);
  assert.match(result.slides[0].footer, /Isobar/);
});

test('weather failures leave other ambient sources usable', async () => {
  const folder = await mkdtemp('/private/tmp/onto-photos-');
  temporaryRoots.push(folder);
  await writeFile(join(folder, 'one.png'), 'image');
  const result = await createAmbientSources({ store: join(folder, 'missing') }).snapshot({ weather: true, photos: true, photoFolder: folder });
  assert.equal(result.slides.filter(slide => slide.kind === 'photo').length, 1);
  assert.equal(result.issues.length, 1);
});

test('photos skip symlinks, unsupported files and nested paths beyond depth two', async () => {
  const folder = await mkdtemp('/private/tmp/onto-photos-');
  temporaryRoots.push(folder);
  await writeFile(join(folder, 'visible.jpg'), 'image');
  await writeFile(join(folder, 'bad.txt'), 'text');
  await mkdir(join(folder, 'nested', 'deeper'), { recursive: true });
  await writeFile(join(folder, 'nested', 'ok.webp'), 'image');
  await writeFile(join(folder, 'nested', 'deeper', 'too-deep.png'), 'image');
  await mkdir(join(folder, 'nested', 'deeper', 'deepest'), { recursive: true });
  await writeFile(join(folder, 'nested', 'deeper', 'deepest', 'excluded.png'), 'image');
  await symlink(join(folder, 'visible.jpg'), join(folder, 'linked.jpg'));
  const result = await createAmbientSources().snapshot({ weather: false, photos: true, photoFolder: folder });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.slides.map(slide => slide.title), ['Photo 1', 'Photo 2', 'Photo 3']);
  assert.match(result.slides[0].image, /^file:/);
});

test('photos stop after 200 visited entries, even when entries are not images', async () => {
  const folder = await mkdtemp('/private/tmp/onto-photos-limit-');
  temporaryRoots.push(folder);
  for (let i = 0; i < 200; i += 1) await writeFile(join(folder, `entry-${String(i).padStart(3, '0')}.txt`), 'x');
  await writeFile(join(folder, 'zzz-photo.jpg'), 'image');
  const result = await createAmbientSources().snapshot({ weather: false, photos: true, photoFolder: folder });
  assert.equal(result.slides.length, 0);
  assert.match(result.issues[0], /Photos unavailable/);
});

test('news is opted out by default, bounded to recent headlines, and caches last good feed', async () => {
  let calls = 0;
  let time = Date.parse('2026-09-27T02:00:00Z');
  const fetchImpl = async () => { calls += 1; return { ok: true, text: async () => `<rss><item><title>Fresh &amp; kind</title><pubDate>Sat, 27 Sep 2026 01:00:00 GMT</pubDate><description>ignore this</description></item><item><title>Too old</title><pubDate>Sat, 20 Sep 2026 01:00:00 GMT</pubDate></item></rss>` }; };
  const source = createAmbientSources({ fetchImpl, now: () => time });
  assert.equal((await source.snapshot()).slides.some(slide => slide.kind === 'news'), false);
  const first = await source.snapshot({ weather: false, news: true });
  assert.equal(first.slides.length, 1);
  assert.equal(first.slides[0].title, 'Fresh & kind');
  time += 60 * 1000;
  const second = await source.snapshot({ weather: false, news: true });
  assert.equal(second.slides.length, 1);
  assert.equal(calls, 1);
});

test('news timeout or failure reports an issue without inventing content', async () => {
  const result = await createAmbientSources({ fetchImpl: async () => { throw new Error('offline'); } }).snapshot({ weather: false, news: true });
  assert.deepEqual(result.slides, []);
  assert.match(result.issues[0], /News unavailable/);
});

test('news dedupes concurrent fetches, decodes hex entities, and keeps bounded stale cache', async () => {
  let calls = 0;
  let time = Date.parse('2026-09-27T02:00:00Z');
  let release;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, text: async () => '<rss><item><title>&#x46;resh</title><pubDate>Sat, 27 Sep 2026 01:00:00 GMT</pubDate></item></rss>' };
    if (release) await release;
    throw new Error('offline');
  };
  const source = createAmbientSources({ fetchImpl, now: () => time });
  const [first, second] = await Promise.all([
    source.snapshot({ weather: false, news: true }),
    source.snapshot({ weather: false, news: true }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.slides[0].title, 'Fresh');
  assert.equal(second.slides[0].title, 'Fresh');
  time += 16 * 60 * 1000;
  const stale = await source.snapshot({ weather: false, news: true });
  assert.equal(stale.slides.length, 1);
  assert.match(stale.slides[0].footer, /stale/);
  time += 49 * 60 * 60 * 1000;
  const expired = await source.snapshot({ weather: false, news: true });
  assert.deepEqual(expired.slides, []);
  assert.match(expired.issues[0], /News unavailable/);
  void release;
});

test('expired weather and missing weather codes are unavailable or explicitly unknown', async () => {
  const store = await fixtureStore();
  const runDir = join(store, 'products', 'points', 'ecmwf_ifs', 'runs', '2026-09-27T000000Z');
  await writeFile(join(runDir, 'cottesloe.json'), JSON.stringify({ run: '2026-09-25T00:00:00Z', time: ['2026-09-25T00:00'], hourly: { temperature_2m: [17], weather_code: [null] } }));
  const result = await createAmbientSources({ store, now: () => Date.parse('2026-09-27T02:00:00Z') }).snapshot({ weather: true });
  assert.deepEqual(result.slides, []);
  assert.match(result.issues[0], /Weather unavailable/);
});

test('oversized news response is rejected before rendering', async () => {
  const result = await createAmbientSources({ fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(1024 * 1024 + 1) }) }).snapshot({ weather: false, news: true });
  assert.deepEqual(result.slides, []);
  assert.match(result.issues[0], /News unavailable/);
});
