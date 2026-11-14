const VERBS = new Set(['now', 'play', 'next', 'pause', 'resume', 'seek', 'tune', 'back', 'reload']);

export function parseTvArgs(argv) {
  const rest = [];
  let url = process.env.ONTO_TV_URL || 'http://127.0.0.1:8686';
  let token = process.env.ONTO_TV_TOKEN || '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') url = argv[++i] || url;
    else if (argv[i] === '--token') token = argv[++i] || token;
    else rest.push(argv[i]);
  }
  const command = rest[0] || '';
  if (!VERBS.has(command)) return { ok: false, line: 'now | play <src> [seconds] | next <src> | pause | resume | seek <s> | tune <ch> | back | reload', code: 2 };
  if ((command === 'play' || command === 'next') && !rest[1]) return { ok: false, line: command + ' needs a src', code: 2 };
  if (command === 'seek' && !(Number(rest[1]) >= 0)) return { ok: false, line: 'seek needs seconds', code: 2 };
  if (command === 'tune' && !rest[1]) return { ok: false, line: 'tune needs a channel', code: 2 };
  const channel = command === 'tune' ? (/^\d+$/.test(rest[1]) ? Number(rest[1]) : rest[1]) : null;
  return {
    ok: true, command, url: url.replace(/\/$/, ''), token, code: 0,
    src: command === 'play' || command === 'next' ? rest[1] : '',
    seconds: command === 'seek' ? Math.round(Number(rest[1])) : null,
    positionSeconds: command === 'play' && Number(rest[2]) >= 0 && rest[2] !== undefined ? Math.round(Number(rest[2])) : null,
    channel,
  };
}

function lineOf(now) {
  if (!now || !now.src) return 'idle';
  const channel = now.channel;
  const where = channel ? [channel.number, channel.name].filter(part => part != null && part !== '').join(' ') : '';
  return [now.src, `${now.position}s`, where, now.profile || ''].filter(Boolean).join('  ');
}

async function request(base, token, path, body, fetchImpl) {
  const response = await fetchImpl(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Onto-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
  return payload;
}

async function sessionOf(base, token, fetchImpl) {
  const snapshot = await request(base, token, '/api/diagnostics', null, fetchImpl);
  const sessions = (snapshot.sessions || []).slice().sort((a, b) => a.ageMs - b.ageMs);
  const live = sessions.find(item => !item.stale) || sessions[0];
  return live ? live.session : '';
}

export async function runTv(options) {
  const parsed = options.command ? options : parseTvArgs(options.argv || []);
  if (parsed.ok === false) return parsed;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const pollMs = options.pollMs ?? 200;
  const base = parsed.url;
  const token = parsed.token;
  if (!token) return { ok: false, code: 1, line: 'no token' };
  try {
    if (parsed.command === 'now') {
      const now = await request(base, token, '/api/now-playing', null, fetchImpl);
      return { ok: true, code: 0, line: lineOf(now), now };
    }
    if (parsed.command === 'next') {
      await request(base, token, '/api/play-next', { src: parsed.src }, fetchImpl);
    }
    const session = await sessionOf(base, token, fetchImpl);
    if (!session) return { ok: false, code: 1, line: 'no tv' };
    const body = { session, action: parsed.command === 'next' ? 'queue-next' : parsed.command };
    if (parsed.command === 'play' || parsed.command === 'next') body.src = parsed.src;
    if (parsed.command === 'play' && parsed.positionSeconds != null) body.positionSeconds = parsed.positionSeconds;
    if (parsed.command === 'seek') body.seconds = parsed.seconds;
    if (parsed.command === 'tune') body.channel = parsed.channel;
    const queued = await request(base, token, '/api/tv-command', body, fetchImpl);
    const deadline = Date.now() + timeoutMs;
    let item = queued;
    while (Date.now() < deadline) {
      item = await request(base, token, '/api/tv-command?id=' + encodeURIComponent(queued.id), null, fetchImpl);
      if (item.result) return { ok: item.result.status === 'done', code: item.result.status === 'done' ? 0 : 1, line: `${body.action} ${item.result.status}`, id: queued.id };
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return { ok: false, code: 1, line: `${body.action} waiting`, id: queued.id };
  } catch (error) {
    return { ok: false, code: 1, line: error.message || 'tv remote failed' };
  }
}
