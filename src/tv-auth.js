// Who may ask the TV server (8686) for anything beyond its static interface.
//
// Every API, media, picture and subtitle request that does not come from this Mac itself must carry the
// pairing token: the X-Onto-Token header, `?t=` on the file-type URLs an <img>, <video> or AVPlay cannot
// add a header to, or the pairing cookie a browser gets once from /pair.html. Static interface files
// (tv/, fonts), CORS preflights, the server's identity proof, the bare health answer and the game relay
// (six-digit code, then per-session token) stay open.
//
// The gate runs in one of two modes (ONTO_AUTH_MODE or --auth-mode, default observe):
//   observe  lets the request through and logs one compact line per kind of would-be rejection
//   enforce  answers 401 (nothing offered) or 403 (a wrong token or cookie)
import { createHmac, timingSafeEqual } from 'node:crypto';

export const AUTH_MODES = ['observe', 'enforce'];
export const PAIR_COOKIE = 'onto_pair';
// <video>, <img>, CSS backgrounds and AVPlay cannot send a header.
export const FILE_TOKEN_PATHS = new Set(['/media', '/art', '/subs', '/scene-thumb', '/channel-art']);
const OPEN_API = new Set(['/api/whoami', '/api/health', '/api/pair']);

export function authMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return AUTH_MODES.includes(mode) ? mode : 'observe';
}

/** The cookie holds an HMAC of the token, never the token itself. */
export function pairCookieValue(token) {
  return token ? createHmac('sha256', token).update('onto-pair-cookie:v1').digest('base64url') : '';
}

function same(offered, expected) {
  if (!expected || typeof offered !== 'string' || !offered) return false;
  const a = Buffer.from(offered), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) {
      try { return decodeURIComponent(part.slice(at + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
/**
 * A request from this Mac itself: a loopback socket that no proxy forwarded. `tailscale serve` (the
 * tailnet's HTTPS on :8443) connects from loopback too, so a forwarding header or a tailnet Host name
 * means the request came from another device.
 */
export function isLocalRequest(request) {
  if (!LOOPBACK.test(String(request.socket?.remoteAddress || ''))) return false;
  const h = request.headers || {};
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-forwarded-proto'] || h.forwarded || h['x-real-ip']) return false;
  if (Object.keys(h).some(name => name.startsWith('tailscale-'))) return false;
  const host = String(h.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Paths that never need the token: OPTIONS, static interface files, and the open API routes above. */
export function isOpenPath(method, path) {
  if (method === 'OPTIONS') return true;
  if (OPEN_API.has(path)) return true;
  if (path.startsWith('/api/game/')) return true;  // the relay checks its own code and session tokens
  if (path.startsWith('/api/')) return false;
  if (FILE_TOKEN_PATHS.has(path)) return false;
  if (path.startsWith('/uke/audio/')) return false;
  return true;  // the interface itself (tv/), fonts, and the uke app's pages (which check their own controls)
}

/**
 * createAuthGate({ token, mode, log }) → check(request, url) returning null to go on, or
 * { status, error } to refuse. In observe mode it never refuses; it logs instead.
 */
export function createAuthGate({ token, mode = 'observe', log = () => {}, now = Date.now,
  repeatMs = 10 * 60_000, perMinute = 30, maxKeys = 500 } = {}) {
  const enforce = authMode(mode) === 'enforce';
  const cookieValue = pairCookieValue(token);
  const seen = new Map();
  let windowStart = 0, inWindow = 0, dropped = 0;

  function credential(request, url, path) {
    const header = request.headers['x-onto-token'];
    const query = FILE_TOKEN_PATHS.has(path) || path.startsWith('/uke/audio/') ? url.searchParams.get('t') : null;
    const cookie = readCookie(request.headers.cookie, PAIR_COOKIE);
    if (same(header, token) || same(query, token) || same(cookie, cookieValue)) return { ok: true };
    return { ok: false, offered: { header: header ? 'wrong' : 'absent', query: query ? 'wrong' : 'absent', cookie: cookie ? 'wrong' : 'absent' } };
  }

  function note(request, path, offered) {
    const at = now();
    let address = String(request.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    // Behind `tailscale serve` every device arrives from loopback: name the forwarded client instead.
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45);
    if (LOOPBACK.test(address) && forwarded) address = `${forwarded} (via ${address})`;
    else if (LOOPBACK.test(address) && Object.keys(request.headers || {}).some(name => name.startsWith('tailscale-'))) address = `tailnet (via ${address})`;
    const agent = String(request.headers['user-agent'] || '-').replace(/[\u0000-\u001f"]+/g, ' ').slice(0, 80);
    const creds = `token=${offered.header} t=${offered.query} cookie=${offered.cookie}`;
    const key = `${request.method} ${path} ${address} ${agent} ${creds}`;
    const last = seen.get(key);
    if (last && at - last < repeatMs) return;
    if (at - windowStart >= 60_000) {
      if (dropped) log(`auth ${enforce ? 'enforce' : 'observe'}: ${dropped} more would-be rejections not logged in the last minute`);
      windowStart = at; inWindow = 0; dropped = 0;
    }
    if (inWindow >= perMinute) { dropped++; return; }
    inWindow++;
    seen.delete(key);
    seen.set(key, at);
    while (seen.size > maxKeys) seen.delete(seen.keys().next().value);
    // Path only: the query can carry the token.
    log(`auth ${enforce ? 'enforce: rejected' : 'observe: would reject'} ${request.method} ${path} from ${address} ua="${agent}" ${creds}`);
  }

  function check(request, url) {
    const path = url.pathname;
    if (isOpenPath(request.method, path) || isLocalRequest(request)) return null;
    const result = credential(request, url, path);
    if (result.ok) return null;
    note(request, path, result.offered);
    if (!enforce) return null;
    const wrong = Object.values(result.offered).includes('wrong');
    return wrong ? { status: 403, error: 'Pair this device first.' } : { status: 401, error: 'Pair this device first.' };
  }

  return { check, enforce, cookieValue };
}

/** One pairing attempt per address per few seconds, and a small budget per minute. */
export function createPairLimiter({ now = Date.now, perMinute = 5 } = {}) {
  const tries = new Map();
  return address => {
    const at = now(), key = String(address || '');
    const list = (tries.get(key) || []).filter(when => at - when < 60_000);
    if (list.length >= perMinute) { tries.set(key, list); return false; }
    list.push(at);
    tries.set(key, list);
    if (tries.size > 1000) tries.delete(tries.keys().next().value);
    return true;
  };
}
