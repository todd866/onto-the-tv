import { networkInterfaces } from 'node:os';

export const DEFAULTS = { tvHost: '', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp' };

export function loadConfig(env = process.env, argv = {}) {
  const tvHost = String(argv.tvHost ?? env.SAMSUNG_TV_HOST ?? '').trim();
  const bindHost = String(argv.bindHost || argv.bind || env.SAMSUNG_CAST_BIND || pickBindHost());
  let avTransportUrl = String(argv.avTransportUrl || env.SAMSUNG_TV_AVTRANSPORT || '').trim();
  if (!avTransportUrl && tvHost) {
    if (!/^[a-zA-Z0-9.-]+$/.test(tvHost)) throw new Error('Enter a TV hostname or IPv4 address without a port.');
    avTransportUrl = `http://${tvHost}:9197/upnp/control/AVTransport1`;
  }
  if (avTransportUrl) {
    const url = new URL(avTransportUrl);
    if (url.protocol !== 'http:' || url.username || url.password || url.hash) {
      throw new Error('The TV control URL must be an HTTP address without credentials.');
    }
  }
  return {
    tvHost, bindHost, avTransportUrl,
    ffmpeg: argv.ffmpeg || env.FFMPEG || DEFAULTS.ffmpeg,
    ffprobe: argv.ffprobe || env.FFPROBE || DEFAULTS.ffprobe,
    ytdlp: argv.ytdlp || env.YTDLP || DEFAULTS.ytdlp,
    force: Boolean(argv.force), dryRun: Boolean(argv.dryRun),
  };
}

export function pickBindHost(preferred, nets = networkInterfaces()) {
  const addresses = Object.entries(nets).flatMap(([name, list]) => (list || [])
    .filter((item) => (item.family === 'IPv4' || item.family === 4) && !item.internal)
    .map((item) => ({ name, address: item.address })));
  if (preferred && addresses.some((item) => item.address === preferred)) return preferred;
  // Prefer physical Wi-Fi/Ethernet interfaces over VPN and container interfaces.
  return addresses.find((item) => /^(en|eth|wl)/.test(item.name))?.address
    || addresses[0]?.address || '127.0.0.1';
}
