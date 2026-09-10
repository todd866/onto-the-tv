const MAX_LEVEL = 41;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

function isH264(codec) {
  return /^(h264|avc1)/i.test(codec || '');
}

function isAac(codec) {
  return /^(aac|mp4a)/i.test(codec || '');
}

function isMp3(codec) {
  return /^(mp3|mpga)/i.test(codec || '');
}

function numericLevel(level) {
  if (level == null || level === '') return null;
  const raw = String(level);
  if (raw.includes('.')) return Math.round(Number(raw) * 10);
  return Number(raw);
}

export function isSamsungCompatible(info = {}) {
  const hasVideo = Boolean(info.videoCodec);
  const hasAudio = Boolean(info.audioCodec);

  if (!hasVideo && !hasAudio) return false;

  if (hasVideo) {
    if (!isH264(info.videoCodec)) return false;
    if ((info.width || 0) > MAX_WIDTH || (info.height || 0) > MAX_HEIGHT) return false;
    const level = numericLevel(info.videoLevel);
    if (level != null && level > MAX_LEVEL) return false;
    const container = (info.container || '').toLowerCase();
    if (container && !['mp4', 'm4v', 'mov', 'qt'].includes(container)) return false;
  }

  if (hasAudio) {
    if (hasVideo) {
      if (!isAac(info.audioCodec)) return false;
    } else if (!isAac(info.audioCodec) && !isMp3(info.audioCodec)) {
      return false;
    }
  }

  return true;
}

export function decidePipeline({ source, compatible, hasVideo, isArtTrack } = {}) {
  if (isArtTrack) {
    return { action: 'audio', container: 'm4a', audio: 'aac' };
  }
  if (compatible) {
    return { action: 'serve' };
  }
  if (hasVideo === false) {
    return { action: 'transcode', container: 'm4a', audio: 'aac' };
  }
  return { action: 'transcode', container: 'mp4', video: 'h264', audio: 'aac' };
}
