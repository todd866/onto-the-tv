#!/usr/bin/env node
// Fred's MCP endpoint (see src/fred-mcp.js). Listens on 127.0.0.1 only; Tailscale Funnel publishes the path
// /fred to it. Requests must carry the secret path segment from ~/.config/onto-the-tv/fred-mcp.json
// ({"secret": "..."}), so the public URL is https://<host>.ts.net/fred/<secret>.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createFred, secretPathMatches, tvClient } from '../src/fred-mcp.js';

const config = JSON.parse(readFileSync(join(homedir(), '.config/onto-the-tv/fred-mcp.json'), 'utf8'));
const appData = join(homedir(), 'Library/Application Support/Onto the TV');
const token = readFileSync(join(appData, 'tv-server/pairing-token'), 'utf8').trim();
const port = Number(config.port || 8690);
if (!config.secret || String(config.secret).length < 24) throw new Error('fred-mcp: secret missing or too short');
const fred = createFred({ tv: tvClient({ token }) });
const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fred.local');
  const ok = secretPathMatches(url.pathname, config.secret);
  if (!ok) { res.writeHead(404).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) { res.writeHead(413).end(); return; } }
  let message;
  try { message = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
  const batch = Array.isArray(message) ? message : [message];
  const out = [];
  for (const m of batch) {
    const r = await fred.handle(m);
    if (m?.method === 'tools/call') log(`tool ${m.params?.name} ${JSON.stringify(m.params?.arguments || {}).slice(0, 120)}`);
    if (r) out.push(r);
  }
  if (!out.length) { res.writeHead(202).end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(Array.isArray(message) ? out : out[0]));
}).listen(port, '127.0.0.1', () => log(`fred-mcp on 127.0.0.1:${port}`));
