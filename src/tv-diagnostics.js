const EVENTS = new Set(['startup', 'connected', 'rendered', 'play_request', 'playing', 'pause', 'ended', 'play_error', 'script_error', 'heartbeat', 'offline', 'game_open', 'game_state', 'game_input', 'game_close', 'controller', 'uke_state']);
const PAGES = new Set(['home', 'player', 'setup', 'games']);
const ENGINES = new Set(['video', 'avplay']);
const STATES = new Set(['starting', 'connecting', 'ready', 'loading', 'playing', 'paused', 'buffering', 'error', 'offline']);
const ERRORS = new Set(['runtime', 'unhandled', 'network', 'media', 'resource']);

export const DIAGNOSTICS_LIMITS = Object.freeze({ maxSessions: 32, maxEvents: 128, ttlMs: 24 * 60 * 60_000, staleMs: 45_000 });

export class DiagnosticsValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const safe = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 64 || !/^[A-Za-z0-9._-]+$/.test(value))
    throw new DiagnosticsValidationError(`Invalid ${name}.`);
  return value;
};
const choice = (value, set, name, optional = false) => {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !set.has(value)) throw new DiagnosticsValidationError(`Invalid ${name}.`);
  return value;
};
const number = (value, name, optional = true) => {
  if (value == null && optional) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 31536000) throw new DiagnosticsValidationError(`Invalid ${name}.`);
  return value;
};

function controller(value) {
  if (value == null) return null;
  const bounded = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if (typeof value !== 'object' || typeof value.supported !== 'boolean' || !bounded(value.count, 4) ||
      !Array.isArray(value.devices) || value.devices.length > 4 || value.devices.length !== value.count)
    throw new DiagnosticsValidationError('Invalid controller.');
  const devices = value.devices.map(d => {
    if (!d || !bounded(d.index, 15) || !bounded(d.buttons, 64) || !bounded(d.axes, 32) ||
        typeof d.id !== 'string' || d.id.length > 128 || /[^\x20-\x7e]/.test(d.id))
      throw new DiagnosticsValidationError('Invalid controller device.');
    return { index: d.index, id: d.id, mapping: choice(d.mapping, new Set(['standard', 'unknown']), 'mapping'), buttons: d.buttons, axes: d.axes };
  });
  const lastInput = value.lastInput || 'none';
  if (typeof lastInput !== 'string' || lastInput.length > 32 || !/^[a-z0-9-]+$/.test(lastInput))
    throw new DiagnosticsValidationError('Invalid controller input.');
  let poll;
  if (value.poll !== undefined) {
    const p=value.poll;
    if (!p || !(p.ageMs===null || bounded(p.ageMs,86400000)) || typeof p.stopped!=='boolean' ||
        typeof p.hidden!=='boolean' || !(p.focused===null || typeof p.focused==='boolean') ||
        !bounded(p.slots,16) || !bounded(p.connects,65535) || !bounded(p.disconnects,65535) ||
        !Array.isArray(p.raw) || p.raw.length>16) throw new DiagnosticsValidationError('Invalid controller poll.');
    poll={ageMs:p.ageMs,stopped:p.stopped,hidden:p.hidden,focused:p.focused,slots:p.slots,connects:p.connects,disconnects:p.disconnects,
      raw:p.raw.map(d=>{if(!d || !bounded(d.index,15)) throw new DiagnosticsValidationError('Invalid raw controller.');
        return {index:d.index,connected:choice(d.connected,new Set(['true','false','undefined','other']),'connection')};})};
  }
  return { supported: value.supported, count: value.count, devices, lastInput, ...(poll ? {poll} : {}),
    error: choice(value.error || 'none', new Set(['none', 'unavailable', 'read-failed']), 'controller error') };
}

function uke(value) {
  if(value==null) return null;
  if(typeof value!=='object' || Array.isArray(value)) throw new DiagnosticsValidationError('Invalid Uke state.');
  const out={};
  if(value.bridge && ['closed','created','loaded','boot','ready','error'].includes(value.bridge.phase) && ['none','null','file','other'].includes(value.bridge.origin)) out.bridge={phase:value.bridge.phase,origin:value.bridge.origin};
  for(const key of ['active','following','stale']) if(typeof value[key]==='boolean') out[key]=value[key];
  if(out.bridge && value.bridge) {
    const b=value.bridge;
    if(['TypeError','ReferenceError','SyntaxError','RangeError','Error','unknown'].includes(b.errorName)) out.bridge.errorName=b.errorName;
    for(const k of ['line','column']) if(Number.isInteger(b[k])&&b[k]>=0&&b[k]<=1000000) out.bridge[k]=b[k];
  }
  for(const key of ['division','pulsesPerMinute','lastEventAt','lastSequence','eventAgeMs','currentBeat']) {
    if(value[key]===null) out[key]=null;
    else if(typeof value[key]==='number' && Number.isFinite(value[key]) && value[key]>=0 && value[key]<=1e14) out[key]=value[key];
  }
  if(typeof value.code==='string' && /^[A-Za-z0-9-]{0,16}$/.test(value.code)) out.code=value.code;
  if(typeof value.address==='string' && value.address.length<=200) {
    try {const u=new URL(value.address); if(u.protocol==='http:' && !u.username && !u.password && !u.search && !u.hash && /^(192\.168\.|10\.|127\.|localhost$)/.test(u.hostname)) out.address=u.href;} catch {}
  }
  out.error=!!value.error;
  out.latency=null;
  if(value.latency && typeof value.latency==='object') {
    out.latency={};for(const key of ['median','p95','max','samples','uncertaintyMs']) {
      const n=value.latency[key];if(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<1e9) out.latency[key]=n;
    }
  }
  return out;
}

function sanitize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DiagnosticsValidationError('Invalid diagnostics payload.');
  const event = choice(input.event, EVENTS, 'event');
  const result = {
    session: safe(input.session, 'session'), event, build: safe(input.build, 'build'),
    page: choice(input.page, PAGES, 'page'), engine: choice(input.engine, ENGINES, 'engine'),
    position: number(input.position, 'position'), duration: number(input.duration, 'duration'),
    paused: input.paused == null ? null : input.paused, hidden: input.hidden == null ? null : input.hidden,
    state: choice(input.state, STATES, 'state'),
    game: choice(input.game, new Set(['menu', 'numbers', 'memory', 'rover']), 'game', true),
    input: choice(input.input, new Set(['arrows', 'ok', 'number', 'back', 'laptop']), 'input', true),
    errorCode: choice(input.errorCode, ERRORS, 'errorCode', true),
    controller: controller(input.controller),
    uke: uke(input.uke),
  };
  if (result.paused !== null && typeof result.paused !== 'boolean') throw new DiagnosticsValidationError('Invalid paused.');
  if (result.hidden !== null && typeof result.hidden !== 'boolean') throw new DiagnosticsValidationError('Invalid hidden.');
  // `server` is intentionally ignored: the HTTP request is the authoritative server identity.
  return result;
}

export function createDiagnosticsStore(options = {}) {
  const limits = { ...DIAGNOSTICS_LIMITS, ...options };
  const now = options.now || (() => Date.now());
  const sessions = new Map();
  const events = [];

  function prune(at = now()) {
    const cutoff = at - limits.ttlMs;
    for (const [id, item] of sessions) if (item.receivedAt < cutoff) sessions.delete(id);
    while (events.length && events[0].receivedAt < cutoff) events.shift();
  }
  function record(input) {
    const item = sanitize(input);
    const receivedAt = now();
    prune(receivedAt);
    const latest = { ...item, receivedAt };
    sessions.delete(item.session);
    sessions.set(item.session, latest);
    while (sessions.size > limits.maxSessions) sessions.delete(sessions.keys().next().value);
    if (item.event !== 'heartbeat') {
      events.push(latest);
      while (events.length > limits.maxEvents) events.shift();
    }
    return latest;
  }
  function snapshot() {
    const at = now(); prune(at);
    const view = item => ({ ...item, ageMs: Math.max(0, at - item.receivedAt), stale: at - item.receivedAt > limits.staleMs });
    return { generatedAt: at, staleAfterMs: limits.staleMs, sessions: [...sessions.values()].map(view), events: events.map(view) };
  }
  return { record, snapshot, limits, size: () => ({ sessions: sessions.size, events: events.length }) };
}
