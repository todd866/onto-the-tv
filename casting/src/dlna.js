const PROFILES = {
  'video/x-mkv': 'DLNA.ORG_PN=MATROSKA',
  'video/x-matroska': 'DLNA.ORG_PN=MATROSKA',
  'video/mpeg': 'DLNA.ORG_PN=MPEG1',
  'video/vnd.dlna.mpeg-tts': 'DLNA.ORG_PN=MPEG1',
  'video/mp4': 'DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5',
  'video/quicktime': 'DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5',
  'audio/mpeg': 'DLNA.ORG_PN=MP3',
  'audio/mp4': 'DLNA.ORG_PN=AAC_ISO_320',
  'audio/aac': 'DLNA.ORG_PN=AAC_ISO_320',
  'image/jpeg': 'DLNA.ORG_PN=JPEG_LRG',
  'image/png': 'DLNA.ORG_PN=PNG_LRG',
};

const STREAMING_FLAGS = '01700000000000000000000000000000';

export function buildContentFeatures({ mimeType, seekable = true, transcoded = false } = {}) {
  const parts = [];
  if (mimeType && PROFILES[mimeType]) parts.push(PROFILES[mimeType]);
  parts.push(`DLNA.ORG_OP=${seekable ? '01' : '00'}`);
  parts.push(`DLNA.ORG_CI=${transcoded ? '1' : '0'}`);
  parts.push(`DLNA.ORG_FLAGS=${STREAMING_FLAGS}`);
  return parts.join(';');
}

export function secondsToClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((n) => String(n).padStart(2, '0')).join(':');
}

export function parseClock(value) {
  if (!value || value === 'NOT_IMPLEMENTED') return null;
  const parts = String(value).split(':');
  if (parts.length !== 3) return null;
  const [hours, minutes, seconds] = parts.map(Number);
  if ([hours, minutes, seconds].some((n) => Number.isNaN(n))) return null;
  return hours * 3600 + minutes * 60 + Math.round(seconds);
}

export function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return 'video/mpeg';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

export function upnpClassForMime(mimeType) {
  const kind = (mimeType || '').split('/')[0];
  if (kind === 'audio') return 'object.item.audioItem.musicTrack';
  if (kind === 'image') return 'object.item.imageItem.photo';
  return 'object.item.videoItem.movie';
}
