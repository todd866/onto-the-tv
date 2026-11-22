const ART_TRACK_TYPE = 'MUSIC_VIDEO_TYPE_ATV';
const classifications = new Map();

export function classifyYouTubeItem(response) {
  const videoId = response?.videoDetails?.videoId ?? null;
  const isArtTrack = response?.videoDetails?.musicVideoType === ART_TRACK_TYPE;
  if (videoId) rememberArtTrack(videoId, isArtTrack);
  return { videoId, isArtTrack };
}

export function rememberArtTrack(videoId, isArtTrack) {
  if (!videoId) return;
  const previous = classifications.get(videoId);
  if (previous === true && isArtTrack === false) return;
  classifications.set(videoId, Boolean(isArtTrack));
}

export function isKnownArtTrack(videoId) {
  return classifications.get(videoId) === true;
}

export function artTrackClassification(videoId) {
  return classifications.has(videoId) ? classifications.get(videoId) : undefined;
}

export { ART_TRACK_TYPE };
