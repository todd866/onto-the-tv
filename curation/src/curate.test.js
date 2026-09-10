import test from 'node:test';
import assert from 'node:assert/strict';
import { curate, passesFilters, scoreVideo, defaultFilters } from './curate.js';

function vid(over = {}) {
  return {
    videoId: over.videoId || 'v1', title: over.title || 'T', channelId: over.channelId || 'c1',
    channelTitle: over.channelTitle || 'Chan', durationSeconds: over.durationSeconds ?? 300,
    viewCount: over.viewCount ?? 1000, license: over.license || 'youtube',
    publishedAt: over.publishedAt || '2026-01-01T00:00:00Z', ...over,
  };
}

function fakeYoutube(bySeed) {
  return {
    listChannelUploads: async id => bySeed[`channel:${id}`] || [],
    listPlaylistItems: async id => bySeed[`playlist:${id}`] || [],
    search: async q => bySeed[`search:${q}`] || [],
  };
}

test('duration cap drops the 2-hour marathon dumps that wasted holiday draws', async () => {
  const youtube = fakeYoutube({ 'channel:c1': [
    vid({ videoId: 'short', durationSeconds: 600 }),
    vid({ videoId: 'dump', durationSeconds: 2 * 60 * 60, title: 'Peppa 3-hour mega comp' }),
    vid({ videoId: 'tiny', durationSeconds: 30 }),
  ] });
  const result = await curate({ youtube, seeds: [{ channel: 'c1' }] });
  assert.deepEqual(result.map(r => r.videoId), ['short']);
  assert.ok(!result.some(r => r.videoId === 'dump'), 'marathon dump must be excluded');
});

test('channel whitelist admits only trusted seeds', async () => {
  const youtube = fakeYoutube({ 'channel:good': [vid({ videoId: 'g', channelId: 'good' })],
    'channel:bad': [vid({ videoId: 'b', channelId: 'bad' })] });
  const result = await curate({ youtube, seeds: [{ channel: 'good' }, { channel: 'bad' }],
    filters: defaultFilters({ channelWhitelist: ['good'] }) });
  assert.deepEqual(result.map(r => r.videoId), ['g']);
});

test('creativeCommon filter excludes standard-licensed videos', async () => {
  const youtube = fakeYoutube({ 'channel:c1': [
    vid({ videoId: 'cc', license: 'creativeCommon' }), vid({ videoId: 'std', license: 'youtube' }),
  ] });
  const result = await curate({ youtube, seeds: [{ channel: 'c1' }],
    filters: defaultFilters({ license: 'creativeCommon' }) });
  assert.deepEqual(result.map(r => r.videoId), ['cc']);
});

test('dedupes the same video appearing under channel uploads and a playlist', async () => {
  const same = vid({ videoId: 'dup' });
  const youtube = fakeYoutube({ 'channel:c1': [same], 'playlist:p1': [same] });
  const result = await curate({ youtube, seeds: [{ channel: 'c1' }, { playlist: 'p1' }] });
  assert.equal(result.length, 1);
});

test('exclude drops already-rejected videos so the algorithm learns from the taste log', async () => {
  const youtube = fakeYoutube({ 'channel:c1': [vid({ videoId: 'liked' }), vid({ videoId: 'rejected' })] });
  const result = await curate({ youtube, seeds: [{ channel: 'c1' }], exclude: ['rejected'] });
  assert.deepEqual(result.map(r => r.videoId), ['liked']);
});

test('ranking is the owners: a trusted channel outranks an unknown one, all else equal', () => {
  const a = vid({ videoId: 'a', channelId: 'trusted', publishedAt: '2026-01-01T00:00:00Z' });
  const b = vid({ videoId: 'b', channelId: 'unknown', publishedAt: '2026-01-01T00:00:00Z' });
  const sa = scoreVideo(a, { channelTrust: { trusted: 1 }, now: Date.parse('2026-01-02T00:00:00Z') });
  const sb = scoreVideo(b, { channelTrust: {}, now: Date.parse('2026-01-02T00:00:00Z') });
  assert.ok(sa > sb, `trusted (${sa}) must outrank unknown (${sb})`);
});

test('a custom ranking function replaces the default entirely', async () => {
  const youtube = fakeYoutube({ 'channel:c1': [vid({ videoId: 'x', viewCount: 5 }), vid({ videoId: 'y', viewCount: 50 })] });
  const result = await curate({ youtube, seeds: [{ channel: 'c1' }], ranking: v => v.viewCount });
  assert.deepEqual(result.map(r => r.videoId), ['y', 'x']);
});

test('output carries a ready-to-cast youtu.be url', async () => {
  const youtube = fakeYoutube({ 'channel:c1': [vid({ videoId: 'abc123' })] });
  const result = await curate({ youtube, seeds: [{ channel: 'c1' }] });
  assert.equal(result[0].url, 'https://youtu.be/abc123');
});
