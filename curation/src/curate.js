// The owner's algorithm. Decides which YouTube videos are worth a kid's time,
// replacing the YouTube Kids recommender. Pure: takes fetched video metadata and
// returns a ranked whitelist. No downloading — playback is streaming via the
// existing caster. The YouTube client is injected so this is testable without a key.
//
// Video shape (from the injected client):
//   { videoId, title, channelId, channelTitle, durationSeconds, viewCount,
//     license, publishedAt }
// A seed is one of: { channel: id }, { playlist: id }, { search: "terms" }.

export function defaultFilters(overrides = {}) {
  // The marathon dumps from the holiday logs were 1.5-2h compilations that wasted
  // draws. A duration cap is the single most effective anti-slop filter.
  return {
    maxDurationSeconds: overrides.maxDurationSeconds ?? 25 * 60,
    minDurationSeconds: overrides.minDurationSeconds ?? 60,
    minViewCount: overrides.minViewCount ?? 0,
    license: overrides.license ?? 'any',
    channelWhitelist: overrides.channelWhitelist ?? null,
    channelBlacklist: overrides.channelBlacklist ?? null,
    publishedAfter: overrides.publishedAfter ?? null,
    ...overrides,
  };
}

export function passesFilters(video, filters) {
  if (!video || typeof video.videoId !== 'string' || typeof video.durationSeconds !== 'number') return false;
  if (video.durationSeconds > filters.maxDurationSeconds) return false;
  if (video.durationSeconds < filters.minDurationSeconds) return false;
  if (filters.minViewCount && (video.viewCount || 0) < filters.minViewCount) return false;
  if (filters.license === 'creativeCommon' && video.license !== 'creativeCommon') return false;
  if (filters.channelWhitelist?.length && !filters.channelWhitelist.includes(video.channelId)) return false;
  if (filters.channelBlacklist?.includes(video.channelId)) return false;
  if (filters.publishedAfter && video.publishedAt && video.publishedAt < filters.publishedAfter) return false;
  return true;
}

// Default score: reward closeness to a target duration, reward recency, reward the
// owner's per-channel trust weight. All factors are 0..1 and multiplied, so a zero on
// any axis sinks the video. The owner can swap this whole function out.
export function scoreVideo(video, { targetSeconds = 5 * 60, channelTrust = {}, now = Date.now() } = {}) {
  const target = Math.max(1, targetSeconds);
  const durationFactor = Math.min(video.durationSeconds, target) / Math.max(video.durationSeconds, target);
  const ageDays = Math.max(0, (now - new Date(video.publishedAt || 0).getTime()) / 86_400_000);
  const recencyFactor = 1 / (1 + ageDays / 365);
  const trust = channelTrust[video.channelId];
  const trustFactor = trust == null ? 0.5 : Math.max(0, Math.min(1, trust));
  return durationFactor * recencyFactor * trustFactor;
}

export async function curate({ youtube, seeds = [], filters = defaultFilters(), ranking, exclude = [] }) {
  const excludeIds = new Set(exclude.map(String));
  const byId = new Map();
  for (const seed of seeds) {
    let batch = [];
    if (seed.channel) batch = await youtube.listChannelUploads(seed.channel);
    else if (seed.playlist) batch = await youtube.listPlaylistItems(seed.playlist);
    else if (seed.search) batch = await youtube.search(seed.search);
    for (const video of batch) {
      if (video?.videoId && !byId.has(video.videoId)) byId.set(video.videoId, video);
    }
  }
  const kept = [...byId.values()].filter(v => passesFilters(v, filters) && !excludeIds.has(v.videoId));
  const rank = ranking || (v => scoreVideo(v, ranking));
  return kept
    .map(v => ({ ...v, score: rank(v), url: `https://youtu.be/${v.videoId}` }))
    .sort((a, b) => b.score - a.score);
}
