import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHORT_SECONDS, createYouTubeWatchReader, creatorChannels, lovedOnYouTube, parseYouTubeWatch, youtubeIdOf } from './youtube-watch.js';

const ledger = (channels, events) => JSON.stringify({ version: 1, generated: '2026-11-22T05:00:00Z', channels, events });

test('a malformed or foreign file is no ledger at all', () => {
  assert.equal(parseYouTubeWatch(''), null);
  assert.equal(parseYouTubeWatch('{"version":2,"channels":{},"events":[]}'), null);
  assert.equal(parseYouTubeWatch('{"version":1,"channels":[],"events":{}}'), null);
  assert.ok(parseYouTubeWatch(ledger({}, [])));
});

test('channels carry recent time with Shorts counted, and an unknown verdict reads as unjudged', () => {
  const index = parseYouTubeWatch(ledger({
    '@maker': { name: 'The Maker', verdict: 'good', events: 9, seconds: 5000, shorts: 4, recent: { seconds: 1200, shorts: 2 }, last: '2026-11-20' },
    '@odd': { name: 'Odd', verdict: 'banana', events: -3 },
  }, []));
  assert.equal(index.channels.get('@maker').recentSeconds, 1200 + 2 * SHORT_SECONDS);
  assert.equal(index.channels.get('@maker').seconds, 5000 + 4 * SHORT_SECONDS);
  assert.equal(index.channels.get('@odd').verdict, 'unjudged');
  assert.equal(index.channels.get('@odd').events, 0);
});

test('a file joins its channel by the YouTube id in its name, whatever the folder is called', () => {
  assert.equal(youtubeIdOf({ file: '/m/kids/Some Folder/A title [abcDEF12345].mp4' }), 'abcDEF12345');
  assert.equal(youtubeIdOf({ file: '/m/Bluey/S01E01.mp4' }), null);
  const index = parseYouTubeWatch(ledger(
    { '@maker': { name: 'The Maker', verdict: 'good' }, '@other': { name: 'Other' } },
    [{ date: '2026-11-20', id: 'abcDEF12345', channel: '@maker', pct: 40 }]));
  const rows = creatorChannels(index, [{ file: '/m/kids/Some Folder/A title [abcDEF12345].mp4' }], 'Some Folder');
  assert.deepEqual(rows.map(row => row.key), ['@maker']);
});

test('a name joins only when it is exact and belongs to one channel', () => {
  const index = parseYouTubeWatch(ledger({
    '@maker': { name: 'The Maker' }, '@twin1': { name: 'Twin' }, '@twin2': { name: 'twin!' },
  }, []));
  assert.deepEqual(creatorChannels(index, [{ file: '/m/x/a.mp4' }], 'the maker').map(row => row.key), ['@maker']);
  assert.deepEqual(creatorChannels(index, [{ file: '/m/x/a.mp4' }], 'The Maker Extra'), [], 'a longer name is a different creator');
  assert.deepEqual(creatorChannels(index, [{ file: '/m/x/a.mp4' }], 'Twin'), [], 'two channels with one name: no join');
});

test('a video watched through, or on two days, counts as loved', () => {
  const index = parseYouTubeWatch(ledger({ '@maker': { name: 'The Maker' } }, [
    { date: '2026-11-20', id: 'aaaaaaaaaaa', channel: '@maker', pct: 95 },
    { date: '2026-11-20', id: 'bbbbbbbbbbb', channel: '@maker', pct: 30 },
    { date: '2026-11-21', id: 'bbbbbbbbbbb', channel: '@maker', pct: 35 },
    { date: '2026-11-21', id: 'ccccccccccc', channel: '@maker', pct: 20 },
  ]));
  assert.equal(lovedOnYouTube(index, { file: '/m/a [aaaaaaaaaaa].mp4' }), true);
  assert.equal(lovedOnYouTube(index, { file: '/m/b [bbbbbbbbbbb].mp4' }), true);
  assert.equal(lovedOnYouTube(index, { file: '/m/c [ccccccccccc].mp4' }), false);
  assert.equal(lovedOnYouTube(index, { file: '/m/plain.mp4' }), false);
});

test('the reader reloads a changed file, at most once a minute, and survives a missing one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-yt-watch-'));
  const file = join(dir, 'youtube-watch.json');
  let clock = 0;
  const read = createYouTubeWatchReader({ file, now: () => clock });
  assert.equal(read(), null, 'no file yet');
  await writeFile(file, ledger({ '@maker': { name: 'The Maker' } }, []));
  assert.equal(read(), null, 'not looked at again inside the minute');
  clock += 61_000;
  assert.equal(read().channels.size, 1);
  await writeFile(file, 'not json at all');
  clock += 61_000;
  assert.equal(read(), null, 'a broken file is no ledger');
});
