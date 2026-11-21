// Fred: a voice assistant (an OpenAI "dot", ChatGPT underneath) can drive the TV through a remote MCP server.
// Ian, 21 Nov 2026: "set it up so the dot has a connector to onto the tv; that way my kid can talk to the AI
// and it'll do stuff". This is a small JSON-RPC (MCP, streamable HTTP, JSON responses) server, separate from the
// TV server, that only offers kid-safe controls. Every title it finds or plays comes from the TV server's own
// search for Jake's audience and rating, so Fred can never put on something Jake could not pick himself.
export const FRED_AUDIENCE = { viewers: 'jake,mum,dad', rating: 'PG' };
const PROTOCOL = '2025-06-18';

const TOOLS = [
  { name: 'whats_on', description: 'What is playing on the TV right now (show, title, channel), or that nothing is.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'find_videos', description: "Search the family TV library for videos Jake is allowed to watch. Returns up to 8 with a pick number.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, e.g. "hot wheels", "bluey christmas", "minecraft".' } }, required: ['query'], additionalProperties: false } },
  { name: 'play_video', description: 'Play a video on the TV: the best match for the query, or pick N from the last find_videos list.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, pick: { type: 'integer', minimum: 1, maximum: 8 } }, additionalProperties: false } },
  { name: 'change_channel', description: 'Tune the TV to a channel by name or number, e.g. "Christmas", "Bluey", "Trains", 5.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'], additionalProperties: false } },
  { name: 'list_channels', description: 'The TV channels Jake can watch, with numbers.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'pause', description: 'Pause the TV.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'resume', description: 'Resume playing.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'go_home', description: 'Stop playing and go back to the TV home screen.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

export function createFred({ tv, now = Date.now }) {
  let lastFound = [];
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  const minutes = s => (s ? Math.max(1, Math.round(s / 60)) + ' min' : '');
  async function session() {
    const d = await tv.get('/api/diagnostics');
    const last = Array.isArray(d?.events) ? d.events[d.events.length - 1] : null;
    if (!last || !last.session || (typeof last.ageMs === 'number' && last.ageMs > 90_000)) return null;
    return last.session;
  }
  async function command(body) {
    const s = await session();
    if (!s) return 'The TV looks switched off or asleep, so it could not hear that.';
    const r = await tv.post('/api/tv-command', { ...body, session: s });
    if (r?.error) return `The TV said: ${r.error}`;
    return '';
  }
  async function search(query) {
    const q = String(query || '').trim().slice(0, 80);
    if (!q) return [];
    const r = await tv.get(`/api/search?q=${encodeURIComponent(q)}&viewers=${encodeURIComponent(FRED_AUDIENCE.viewers)}&rating=${FRED_AUDIENCE.rating}`);
    return (Array.isArray(r?.cards) ? r.cards : []).slice(0, 8);
  }
  async function channels() {
    const r = await tv.get(`/api/home?viewers=${encodeURIComponent(FRED_AUDIENCE.viewers)}&rating=${FRED_AUDIENCE.rating}`);
    return (Array.isArray(r?.channels) ? r.channels : []).filter(c => c && c.id && !c.app);
  }
  const handlers = {
    async whats_on() {
      const n = await tv.get('/api/now-playing');
      if (!n?.src) return text('Nothing is playing right now.');
      const show = n.src.split('/')[0];
      const title = n.src.split('/').pop().replace(/\.[^.]+$/, '').replace(/\s*\[[^\]]+\]\s*$/, '');
      return text(`Playing ${title} (${show})${n.channel?.name ? ` on ${n.channel.name}` : ''}.`);
    },
    async find_videos({ query }) {
      lastFound = await search(query);
      if (!lastFound.length) return text(`Nothing found for "${query}".`);
      return text(lastFound.map((c, i) => `${i + 1}. ${c.title}${c.creator || c.show ? ` (${c.creator || c.show})` : ''}${c.duration ? `, ${minutes(c.duration)}` : ''}`).join('\n'));
    },
    async play_video({ query, pick }) {
      let card = null;
      if (pick && lastFound[pick - 1]) card = lastFound[pick - 1];
      else if (query) card = (await search(query))[0] || null;
      if (!card) return text(query ? `Nothing found for "${query}".` : 'Tell me what to play.', true);
      const problem = await command({ action: 'play', src: card.src, positionSeconds: card.resume || 0 });
      return problem ? text(problem, true) : text(`Playing ${card.title}.`);
    },
    async list_channels() {
      const list = await channels();
      return text(list.map(c => `${c.number} ${c.name}`).join('\n') || 'No channels.');
    },
    async change_channel({ channel }) {
      const want = String(channel || '').trim().toLowerCase();
      const list = await channels();
      const hit = list.find(c => String(c.number) === want) || list.find(c => c.name.toLowerCase() === want)
        || list.find(c => c.name.toLowerCase().includes(want) || want.includes(c.name.toLowerCase()));
      if (!hit) return text(`No channel called "${channel}". Channels: ${list.map(c => c.name).join(', ')}.`, true);
      const problem = await command({ action: 'tune', channel: hit.id });
      return problem ? text(problem, true) : text(`Changed to ${hit.number} ${hit.name}.`);
    },
    async pause() { const p = await command({ action: 'pause' }); return p ? text(p, true) : text('Paused.'); },
    async resume() { const p = await command({ action: 'resume' }); return p ? text(p, true) : text('Playing.'); },
    async go_home() { const p = await command({ action: 'home' }); return p ? text(p, true) : text('Back to the home screen.'); },
  };
  // One JSON-RPC message in, one response out (null for notifications).
  async function handle(message) {
    const { id, method, params } = message || {};
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} },
        serverInfo: { name: 'onto-the-tv', version: '1.0.0' },
        instructions: "Controls the family's TV for a 6-year-old (Jake). Find videos before playing when unsure; keep replies short and friendly." });
    }
    if (id === undefined || id === null) return null; // notifications (e.g. notifications/initialized)
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const fn = handlers[params?.name];
      if (!fn) return fail(-32602, `Unknown tool ${params?.name}`);
      try { return reply(await fn(params.arguments || {})); }
      catch (error) { return reply(text(`The TV did not answer (${error.message}).`, true)); }
    }
    return fail(-32601, `Method not found: ${method}`);
  }
  return { handle, tools: TOOLS };
}

// The TV server over localhost with its pairing token.
export function tvClient({ base = 'http://127.0.0.1:8686', token, fetchImpl = globalThis.fetch }) {
  const headers = { 'X-Onto-Token': token, 'Content-Type': 'application/json' };
  return {
    async get(path) { const r = await fetchImpl(base + path, { headers, signal: AbortSignal.timeout(8000) }); return r.json(); },
    async post(path, body) { const r = await fetchImpl(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); return r.json(); },
  };
}
