// Remote telemetry: one line per remote press, so the controls can be judged on what people actually press and
// how long the TV took to answer (owner, 14 Nov 2026: "get this deployed and we'll collect telemetry on it").
// No content names: only the key, what it did, where focus was, and milliseconds from the press to the next frame.
import { appendFile } from 'node:fs/promises';

const ACTIONS = new Set(['none', 'tune', 'digit', 'seek', 'play', 'pause', 'stop', 'next', 'previous', 'close', 'back', 'focus',
  'open', 'activate', 'move', 'home-move', 'home-select', 'home-back', 'other']);
const FOCUS = new Set(['', 'transport', 'scrub', 'continue', 'options', 'home', 'prompt']);
const PAGES = new Set(['home', 'player']);
const word = value => typeof value === 'string' && value.length <= 64 && /^[A-Za-z0-9._-]*$/.test(value);
const whole = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

export function createRemoteLog({ file, now = () => Date.now(), append = appendFile }) {
  return {
    async record(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || !word(body.session) || !body.session || !word(body.build || '') ||
          !Array.isArray(body.events) || body.events.length > 100) throw Object.assign(new Error('Invalid remote log.'), { status: 400 });
      const lines = [];
      for (const e of body.events) {
        if (!e || typeof e !== 'object' || !ACTIONS.has(e.a) || !FOCUS.has(e.f || '') || !PAGES.has(e.p) || !whole(e.k, 70000) ||
            !(typeof e.t === 'number' && Number.isFinite(e.t) && e.t > 0) || !(e.ms == null || whole(e.ms, 60000)))
          throw Object.assign(new Error('Invalid remote event.'), { status: 400 });
        lines.push(JSON.stringify({ at: new Date(e.t).toISOString(), page: e.p, key: e.k, action: e.a, focus: e.f || '',
          ms: e.ms == null ? null : e.ms, repeat: e.r === true, session: body.session, build: body.build || '', receivedAt: new Date(now()).toISOString() }));
      }
      if (lines.length && file) await append(file, lines.join('\n') + '\n', { mode: 0o600 });
      return { ok: true, stored: lines.length };
    }
  };
}
