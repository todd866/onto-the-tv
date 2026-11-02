import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const REASONS = new Set(['start', 'progress', 'pause', 'resume', 'skip', 'ended', 'stop', 'error']);
const CHANNELS = new Set(['2', '6', 'christmas', 'movies', 'grown', 'music', 'all', 'cartoons', 'sitcoms', 'comedy', 'docs', 'scifi', 'classic', 'bbc', 'standup', 'hophop', 'd50', 'd60', 'd70', 'd80', 'd90', 'sports']);

function finite(value, name, max = 86400) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

export async function createWatchEventStore({ file, knownSources = new Set(), maxEvents = 20000 } = {}) {
  const seen = new Set(), sessions = new Map(), pending = [];
  let writes = Promise.resolve();
  let events = 0;
  try {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).slice(-maxEvents);
    for (const line of lines) {
      try { const event = JSON.parse(line); if (event?.sessionId && Number.isInteger(event.sequence)) { seen.add(`${event.sessionId}:${event.sequence}`); sessions.set(event.sessionId, event); events++; } } catch {}
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  function validate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid watch event.'), { status: 400 });
    const src = String(input.src || '');
    if (!knownSources.has(src)) throw Object.assign(new Error('Unknown video.'), { status: 404 });
    const channel = String(input.channel || '');
    if (!CHANNELS.has(channel)) throw Object.assign(new Error('Invalid channel.'), { status: 400 });
    const audience = String(input.audience || channel);
    if (!CHANNELS.has(audience)) throw Object.assign(new Error('Invalid audience.'), { status: 400 });
    const sessionId = String(input.sessionId || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw Object.assign(new Error('Invalid session.'), { status: 400 });
    if (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 10000000) throw Object.assign(new Error('Invalid sequence.'), { status: 400 });
    if (!REASONS.has(input.reason)) throw Object.assign(new Error('Invalid watch reason.'), { status: 400 });
    const receivedAt = new Date().toISOString();
    const observedAt = input.observedAt || receivedAt;
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs) || observedMs > Date.now() + 60000 || observedMs < Date.now() - 14 * 86400000) throw Object.assign(new Error('Invalid observation time.'), {status:400});
    const watchedSeconds = finite(input.watchedSeconds ?? 0, 'watched seconds');
    const durationSeconds = input.durationSeconds == null ? undefined : finite(input.durationSeconds, 'duration seconds');
    return { src, audience, channel, sessionId, sequence: input.sequence, reason: input.reason, watchedSeconds, ...(durationSeconds === undefined ? {} : { durationSeconds }), observedAt, receivedAt };
  }
  return {
    record(input) {
      const event = validate(input), key = `${event.sessionId}:${event.sequence}`;
      if (seen.has(key)) return { accepted: false, duplicate: true, event };
      const previous = sessions.get(event.sessionId);
      if (previous && (event.src !== previous.src || event.channel !== previous.channel || event.audience !== previous.audience)) throw Object.assign(new Error('Session video changed.'), { status: 400 });
      if (previous && event.sequence <= previous.sequence) return { accepted: false, outOfOrder: true, duplicate: false, event };
      if (previous && event.watchedSeconds < previous.watchedSeconds) throw Object.assign(new Error('Watched seconds must be cumulative.'), { status: 400 });
      if (event.watchedSeconds - (previous?.watchedSeconds || 0) > Math.max(120, previous ? (Date.parse(event.observedAt) - Date.parse(previous.observedAt || previous.receivedAt)) / 1000 + 5 : 0)) throw Object.assign(new Error('Watched interval is implausible.'), { status: 400 });
      seen.add(key); sessions.set(event.sessionId, event); pending.push(event); events++;
      return { accepted: true, duplicate: false, event };
    },
    flush() {
      // Each caller queues its own drain, so an event added during an append
      // is durable before that caller receives an acknowledgement.
      writes = writes.catch(() => {}).then(async () => {
        if (!pending.length) return;
        const batch = pending.slice();
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, batch.map(event => JSON.stringify(event) + '\n').join(''), { mode: 0o600 });
        pending.splice(0, batch.length);
      });
      return writes;
    },
    get size() { return events; },
  };
}
