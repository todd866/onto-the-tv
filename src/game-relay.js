import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const ACTIONS = new Set(['up', 'down', 'left', 'right', 'ok', ...Array.from({ length: 10 }, (_, n) => `digit${n}`)]);
const CODE_RE = /^\d{6}$/;
const MAX_SESSIONS = 4;
const TTL_MS = 5 * 60_000;
const EVENT_LIMIT = 64;
const MAX_GUESS_IPS = 128;
const GLOBAL_JOIN_LIMIT = 120;

const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const token = () => randomBytes(24).toString('hex');
const bodyOf = body => typeof body === 'string' ? JSON.parse(body || '{}') : body;
const fail = (status, error) => ({ status, body: { error } });

export function createGameRelay({ now = () => Date.now(), random = null, maxGuessIps = MAX_GUESS_IPS, globalJoinLimit = GLOBAL_JOIN_LIMIT } = {}) {
  const sessions = new Map();
  const guesses = new Map();
  const joinAttempts = [];

  function prune(at = now()) {
    for (const [id, session] of sessions) if (at - session.lastPoll > TTL_MS) sessions.delete(id);
    for (const [ip, list] of guesses) {
      const recent = list.filter(t => at - t < 60_000);
      if (recent.length) guesses.set(ip, recent); else guesses.delete(ip);
    }
    while (joinAttempts.length && at - joinAttempts[0] >= 60_000) joinAttempts.shift();
  }
  function session(id) { prune(); return sessions.get(id); }
  function tvAuth(input) { return input.tvAuthorized === true; }
  function create() {
    prune();
    if (sessions.size >= MAX_SESSIONS) return fail(429, 'Too many game sessions.');
    const used = new Set([...sessions.values()].map(s => s.code));
    let code = '';
    for (let tries = 0; tries < 20 && !code; tries++) {
      const n = random ? Math.floor(Math.max(0, Math.min(0.999999, random())) * 1_000_000) : randomInt(1_000_000);
      const candidate = String(n).padStart(6, '0');
      if (!used.has(candidate)) code = candidate;
    }
    if (!code) for (let n = 0; n < 1_000_000; n++) {
      const candidate = String(n).padStart(6, '0');
      if (!used.has(candidate)) { code = candidate; break; }
    }
    const id = token();
    sessions.set(id, { id, code, controllerToken: null, createdAt: now(), lastPoll: now(), events: [], nextSeq: 1 });
    return { status: 200, body: { session: id, code, expiresInMs: TTL_MS } };
  }
  function authSession(input, controller = false) {
    const s = session(input.session);
    if (!s) return null;
    if (controller ? !equal(input.headers?.['x-onto-controller'], s.controllerToken) : !tvAuth(input)) return null;
    return s;
  }
  function join(input) {
    prune();
    const ip = typeof input.ip === 'string' && input.ip ? input.ip : 'unknown';
    if (!guesses.has(ip) && guesses.size >= maxGuessIps) return fail(429, 'Too many pairing clients.');
    if (joinAttempts.length >= globalJoinLimit) return fail(429, 'Too many pairing attempts.');
    const list = guesses.get(ip) || [];
    if (list.filter(t => now() - t < 60_000).length >= 10) return fail(429, 'Too many pairing attempts.');
    const at = now(); list.push(at); guesses.set(ip, list); joinAttempts.push(at);
    let parsed; try { parsed = bodyOf(input.body); } catch { return fail(400, 'Invalid request.'); }
    const code = parsed && parsed.code;
    if (typeof code !== 'string' || !CODE_RE.test(code)) return fail(400, 'Enter the six digit code.');
    const s = [...sessions.values()].find(item => item.code === code);
    if (!s) return fail(404, 'Pairing code not found.');
    if (s.controllerToken) return fail(409, 'A controller is already connected.');
    s.controllerToken = token();
    return { status: 200, body: { session: s.id, controllerToken: s.controllerToken } };
  }
  function handle(input = {}) {
    prune();
    const method = input.method || 'GET';
    const url = new URL(input.path || '/', 'http://game.local');
    if (url.pathname === '/api/game/session') {
      if (method === 'POST') return tvAuth(input) ? create() : fail(403, 'TV pairing required.');
      const s = authSession({ ...input, session: url.searchParams.get('session') });
      if (method === 'GET') return s ? { status: 200, body: { alive: true, controller: !!s.controllerToken } } : fail(404, 'Game session not found.');
      if (method === 'DELETE') { if (!s) return fail(403, 'TV pairing required.'); sessions.delete(s.id); return { status: 200, body: { ok: true } }; }
      return fail(405, 'Method not allowed.');
    }
    if (url.pathname === '/api/game/events' && method === 'GET') {
      const s = authSession({ ...input, session: url.searchParams.get('session') });
      if (!s) return fail(403, 'TV pairing required.');
      s.lastPoll = now();
      const after = Number(url.searchParams.get('after') || 0);
      return { status: 200, body: { events: s.events.filter(event => event.seq > after), next: s.nextSeq - 1, controller: !!s.controllerToken } };
    }
    if (url.pathname === '/api/game/join' && method === 'POST') return join(input);
    if (url.pathname === '/api/game/input' && method === 'POST') {
      let parsed; try { parsed = bodyOf(input.body); } catch { return fail(400, 'Invalid request.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'Invalid request.');
      const s = authSession({ ...input, session: parsed && parsed.session }, true);
      if (!s) return fail(403, 'Controller not paired.');
      if (!parsed || typeof parsed.action !== 'string' || !ACTIONS.has(parsed.action)) return fail(400, 'Unsupported game action.');
      const at = now();
      s.inputTimes = (s.inputTimes || []).filter(t => at - t < 1000);
      if (s.inputTimes.length >= 20) return fail(429, 'Controller is sending too quickly.');
      s.inputTimes.push(at);
      const event = { seq: s.nextSeq++, action: parsed.action };
      s.events.push(event); while (s.events.length > EVENT_LIMIT) s.events.shift();
      return { status: 200, body: { ok: true, seq: event.seq } };
    }
    if (url.pathname === '/api/game/controller' && method === 'GET') {
      const s = authSession({ ...input, session: url.searchParams.get('session') }, true);
      return s ? { status: 200, body: { alive: true } } : fail(403, 'Controller not paired.');
    }
    if (url.pathname === '/api/game/controller' && method === 'DELETE') {
      const s = authSession({ ...input, session: url.searchParams.get('session') }, true);
      if (!s) return fail(403, 'Controller not paired.');
      s.controllerToken = null; s.inputTimes = [];
      return { status: 200, body: { ok: true } };
    }
    return fail(404, 'Not found.');
  }
  return { handle, prune, size: () => sessions.size };
}

export { ACTIONS };
