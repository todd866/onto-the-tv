const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeId(input) {
  if (!input) return null;
  const text = String(input).trim();
  if (ID_RE.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname) && url.hostname !== 'youtu.be') return null;
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return ID_RE.test(id) ? id : null;
  }
  if (url.searchParams.get('v') && ID_RE.test(url.searchParams.get('v'))) {
    return url.searchParams.get('v');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && ID_RE.test(parts[1])) {
    return parts[1];
  }
  return null;
}

function isAvc(format) {
  return /^(avc1|avc3|h264)/i.test(format?.vcodec || '');
}

function isAac(format) {
  return /^(mp4a|aac)/i.test(format?.acodec || '');
}

function hasVideo(format) {
  return format?.vcodec && format.vcodec !== 'none';
}

function hasAudio(format) {
  return format?.acodec && format.acodec !== 'none';
}

export function pickYtDlpFormat(formats = []) {
  const progressive = formats
    .filter((format) => isAvc(format) && isAac(format) && format.ext === 'mp4' && (format.height || 0) <= 1080)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (progressive[0]) return progressive[0];

  const videos = formats
    .filter((format) => hasVideo(format) && !hasAudio(format) && isAvc(format) && (format.height || 0) <= 1080)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const audios = formats.filter((format) => hasAudio(format) && !hasVideo(format) && isAac(format));
  if (videos[0] && audios[0]) {
    return { format_id: `${videos[0].format_id}+${audios[0].format_id}`, merge: true, video: videos[0], audio: audios[0] };
  }
  return formats[0] || null;
}
