import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutube, parseDuration } from './youtube.js';

// A fake fetcher that answers YouTube Data API calls from a script of responses.
function fakeFetcher(script) {
  const calls = [];
  return {
    calls,
    fn: async (url) => {
      const u = new URL(url);
      calls.push(u.pathname + '?' + u.searchParams.toString());
      const key = u.pathname.split('/').pop();
      const id = u.searchParams.get('id');
      const playlistId = u.searchParams.get('playlistId');
      const q = u.searchParams.get('q');
      const pageToken = u.searchParams.get('pageToken');
      const entry =
        (key === 'channels' && script.channels) ||
        (key === 'playlistItems' && script.playlistItems?.(playlistId, pageToken)) ||
        (key === 'videos' && script.videos) ||
        (key === 'search' && script.search?.(q));
      if (!entry) return { ok: false, status: 404, statusText: 'no script', text: async () => 'no script' };
      return { ok: true, status: 200, json: async () => entry, text: async () => JSON.stringify(entry) };
    },
  };
}

test('parseDuration reads ISO 8601 into seconds', () => {
  assert.equal(parseDuration('PT5M30S'), 330);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration(null), 0);
});

test('listChannelUploads resolves a channel to its uploads playlist and enriches', async () => {
  const { fn, calls } = fakeFetcher({
    channels: { items: [{ id: 'UC_X', contentDetails: { relatedPlaylists: { uploads: 'UU_X' } } }] },
    playlistItems: () => ({ items: [
      { snippet: { title: 'Ep1', resourceId: { videoId: 'v1' }, channelTitle: 'Chan', channelId: 'UC_X', publishedAt: '2026-01-01T00:00:00Z' } },
      { snippet: { title: 'Ep2', resourceId: { videoId: 'v2' }, channelTitle: 'Chan', channelId: 'UC_X', publishedAt: '2026-02-01T00:00:00Z' } },
    ] }),
    videos: { items: [
      { id: 'v1', contentDetails: { duration: 'PT5M' }, statistics: { viewCount: '100' }, status: { license: 'creativeCommon' } },
      { id: 'v2', contentDetails: { duration: 'PT2H' }, statistics: { viewCount: '5' }, status: { license: 'youtube' } },
    ] },
  });
  const yt = createYoutube({ apiKey: 'test', fetcher: fn });
  const out = await yt.listChannelUploads('UC_X');
  assert.deepEqual(out.map(v => v.videoId), ['v1', 'v2']);
  assert.equal(out[0].durationSeconds, 300);
  assert.equal(out[0].viewCount, 100);
  assert.equal(out[0].license, 'creativeCommon');
  assert.equal(out[1].durationSeconds, 7200);
  assert.ok(calls.some(c => c.includes('/channels?')), 'should resolve channel first');
  assert.ok(calls.some(c => c.includes('/playlistItems?')), 'should list playlist items');
  assert.ok(calls.some(c => c.includes('/videos?')), 'should enrich via videos.list');
});

test('listPlaylistItems paginates with nextPageToken', async () => {
  const seen = [];
  const { fn } = fakeFetcher({
    playlistItems: (pid, page) => {
      seen.push(page || '1');
      if (!page) return { items: [{ snippet: { resourceId: { videoId: 'a' }, title: 'A', channelTitle: 'C' } }], nextPageToken: 'P2' };
      return { items: [{ snippet: { resourceId: { videoId: 'b' }, title: 'B', channelTitle: 'C' } }] };
    },
    videos: { items: [{ id: 'a', contentDetails: { duration: 'PT1M' }, statistics: {}, status: {} }, { id: 'b', contentDetails: { duration: 'PT2M' }, statistics: {}, status: {} }] },
  });
  const yt = createYoutube({ apiKey: 'test', fetcher: fn });
  const out = await yt.listPlaylistItems('PL1');
  assert.deepEqual(out.map(v => v.videoId), ['a', 'b']);
  assert.deepEqual(seen, ['1', 'P2']);
});

test('search returns enriched videos for a query', async () => {
  const { fn } = fakeFetcher({
    search: () => ({ items: [{ id: { videoId: 's1' }, snippet: { title: 'Found', channelId: 'UC9', channelTitle: 'Src', publishedAt: '2026-03-01T00:00:00Z' } }] }),
    videos: { items: [{ id: 's1', contentDetails: { duration: 'PT10M' }, statistics: { viewCount: '42' }, status: { license: 'youtube' } }] },
  });
  const yt = createYoutube({ apiKey: 'test', fetcher: fn });
  const out = await yt.search('peppa pig');
  assert.equal(out[0].videoId, 's1');
  assert.equal(out[0].title, 'Found');
  assert.equal(out[0].durationSeconds, 600);
  assert.equal(out[0].viewCount, 42);
});

test('createYoutube requires an api key', () => {
  assert.throws(() => createYoutube({}), /YOUTUBE_API_KEY is required/);
});

test('a non-ok response surfaces the API status and body', async () => {
  const fn = async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'quota exceeded', json: async () => ({}) });
  const yt = createYoutube({ apiKey: 'test', fetcher: fn });
  await assert.rejects(yt.search('x'), /403.*quota exceeded/);
});
