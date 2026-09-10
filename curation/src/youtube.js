// YouTube Data API v3 client for the curation layer. Thin wrapper over the official
// API: resolves a channel (handle or ID) to its uploads playlist, paginates playlist
// items, runs a search, and enriches every result with duration / view count / license
// via videos.list. The fetcher is injectable so tests run without a key or network.
//
// API key: pass { apiKey } to createYoutube. Get one at console.cloud.google.com
// (YouTube Data API v3, free 10k units/day). Never commit a key; load from env.

const VIDEOS_BATCH = 50; // videos.list accepts up to 50 ids per call.

export function parseDuration(iso) {
  if (typeof iso !== 'string') return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

function toVideo(raw, enriched = {}) {
  const snip = raw.snippet || {};
  return {
    videoId: raw.videoId || raw.id || raw.snippet?.resourceId?.videoId || raw.id?.videoId,
    title: snip.title || '',
    channelId: snip.channelId || '',
    channelTitle: snip.channelTitle || snip.videoOwnerChannelTitle || '',
    publishedAt: snip.publishedAt || '',
    durationSeconds: enriched.durationSeconds ?? 0,
    viewCount: enriched.viewCount ?? 0,
    license: enriched.license || 'youtube',
  };
}

export function createYoutube({ apiKey, fetcher = fetch } = {}) {
  if (!apiKey) throw new Error('YOUTUBE_API_KEY is required (YouTube Data API v3).');

  async function getJson(pathname, params) {
    const url = new URL('https://www.googleapis.com/youtube/v3/' + pathname);
    for (const [k, v] of Object.entries({ ...params, key: apiKey })) url.searchParams.set(k, String(v));
    const res = await fetcher(url.href, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`YouTube API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    }
    return res.json();
  }

  // Enrich a list of partial videos (from search/playlistItems) with duration, views, license.
  async function enrich(partials) {
    const ids = partials.map(v => v.videoId).filter(Boolean);
    const out = new Map();
    for (let i = 0; i < ids.length; i += VIDEOS_BATCH) {
      const batch = ids.slice(i, i + VIDEOS_BATCH);
      if (!batch.length) continue;
      const data = await getJson('videos', {
        part: 'snippet,contentDetails,statistics,status', id: batch.join(','),
      });
      for (const item of data.items || []) {
        out.set(item.id, {
          durationSeconds: parseDuration(item.contentDetails?.duration),
          viewCount: Number(item.statistics?.viewCount) || 0,
          license: item.status?.license || 'youtube',
        });
      }
    }
    return partials.map(v => toVideo(v, out.get(v.videoId) || {}));
  }

  async function resolveUploadsPlaylist(channel) {
    // Accepts a channel ID (UC...), a handle (@name), or a bare handle.
    const params = { part: 'contentDetails', maxResults: 1 };
    if (channel.startsWith('UC') && channel.length === 24) params.id = channel;
    else params.forHandle = channel.replace(/^@/, '');
    const data = await getJson('channels', params);
    const id = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!id) throw new Error(`No uploads playlist for channel ${channel}`);
    return id;
  }

  async function listPlaylistItems(playlistId) {
    const partials = [];
    let pageToken = '';
    do {
      const params = { part: 'snippet', maxResults: 50, playlistId };
      if (pageToken) params.pageToken = pageToken;
      const data = await getJson('playlistItems', params);
      for (const item of data.items || []) {
        const vid = item.snippet?.resourceId?.videoId;
        if (vid) partials.push({ videoId: vid, snippet: item.snippet });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return enrich(partials);
  }

  return {
    async listChannelUploads(channel) {
      return listPlaylistItems(await resolveUploadsPlaylist(channel));
    },
    listPlaylistItems,
    async search(query, { max = 50 } = {}) {
      const data = await getJson('search', { part: 'snippet', type: 'video', maxResults: max, q: query });
      const partials = (data.items || []).map(item => ({
        videoId: item.id?.videoId, snippet: item.snippet,
      })).filter(p => p.videoId);
      return enrich(partials);
    },
  };
}
