// Security behaviour of the TV server (port 8686): headers, error text, health, and (below) request auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createFileStorage, createTvLibrary, createTvServer } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';

const videos = [
  { src: 'Kids/Timmy Time.mp4', file: '/m/Kids/Timmy Time.mp4', title: 'Timmy', channel: 'Kids', tier: 'preschool', duration: 600 },
];

async function boot(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'onto-sec-'));
  const ui = join(dir, 'ui');
  await mkdir(ui);
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>tv</title>');
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = options.library || createTvLibrary({ videos, history, storage, random: () => 0 });
  const logs = [];
  const server = createTvServer({ library, history, storage, uiRoot: ui, token: 'secret', playNextFile: join(dir, 'play-next.json'),
    log: line => logs.push(line), ...options.server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, base, logs, server, library, close: () => new Promise(resolve => server.close(resolve)) };
}

test('every answer carries nosniff, no-referrer and a frame-ancestors policy', async () => {
  const { base, close } = await boot();
  try {
    const api = await fetch(`${base}/api/health`);
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(api.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(api.headers.get('content-security-policy'), "frame-ancestors 'none'");
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    // The TV page is framed by the Mac app and the installed TV app (file: pages) and by this server's pages.
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self' file:");
  } finally { await close(); }
});

test('a 500 says nothing about the failure; the log keeps the detail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-sec-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = { ...createTvLibrary({ videos, history, storage, random: () => 0 }), show() { throw new Error('ENOENT: /srv/private-library/thing'); } };
  const { base, logs, close } = await boot({ library });
  try {
    const response = await fetch(`${base}/api/show?name=x`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Something went wrong.' });
    assert.ok(logs.some(line => line.includes('/srv/private-library/thing')), 'detail is logged');
  } finally { await close(); }
});

// fetch() will not set Host; node:http will.
function rawStatus(base, path, headers) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname, port, path, headers }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
}

// Another device, as the server sees it behind `tailscale serve` (loopback socket, forwarded headers).
const remote = (extra = {}) => ({ 'X-Forwarded-For': '100.101.102.103', 'User-Agent': 'TestPhone/1.0', ...extra });

test('observe: a request from another device without a token goes through and is logged once', async () => {
  const { base, logs, close } = await boot({ server: { authMode: 'observe' } });
  try {
    assert.equal((await fetch(`${base}/api/home`, { headers: remote() })).status, 200);
    assert.equal((await fetch(`${base}/api/home?viewers=x`, { headers: remote() })).status, 200);
    const lines = logs.filter(line => line.startsWith('auth observe'));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^auth observe: would reject GET \/api\/home from 100\.101\.102\.103 \(via 127\.0\.0\.1\) ua="TestPhone\/1\.0" token=absent t=absent cookie=absent$/);
    // The query is never logged (it can carry the token).
    await fetch(`${base}/media?src=a.mp4&t=wrong-token-value`, { headers: remote() });
    assert.ok(!logs.join('\n').includes('wrong-token-value'));
    assert.ok(logs.some(line => /would reject GET \/media .* t=wrong/.test(line)));
  } finally { await close(); }
});

test('observe is the default, and the log cannot flood', async () => {
  const { base, logs, close } = await boot();
  try {
    await Promise.all([...Array(80)].map((_, i) => fetch(`${base}/api/home`, { headers: remote({ 'User-Agent': `Bot/${i}` }) })));
    assert.ok(logs.filter(line => line.startsWith('auth observe: would reject')).length <= 30);
  } finally { await close(); }
});

test('enforce: no token is 401, a wrong one 403; header, ?t= on files and the pairing cookie pass', async () => {
  const { base, logs, close } = await boot({ server: { authMode: 'enforce' } });
  try {
    assert.equal((await fetch(`${base}/api/home`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/api/library`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/api/shows`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/api/progress`, { method: 'POST', headers: remote({ 'Content-Type': 'application/json' }), body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/media?src=Kids%2FTimmy%20Time.mp4`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/art?src=Kids%2FTimmy%20Time.mp4`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/channel-art?c=x&f=a.jpg`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/api/home`, { headers: remote({ 'X-Onto-Token': 'nope' }) })).status, 403);
    assert.ok(logs.some(line => line.startsWith('auth enforce: rejected GET /api/home')));
    assert.equal((await fetch(`${base}/api/home`, { headers: remote({ 'X-Onto-Token': 'secret' }) })).status, 200);
    // ?t= is for files only: <video>, <img> and AVPlay cannot send a header.
    assert.equal((await fetch(`${base}/api/home?t=secret`, { headers: remote() })).status, 401);
    assert.equal((await fetch(`${base}/media?src=Kids%2FTimmy%20Time.mp4&t=secret`, { headers: remote() })).status, 404, 'past the gate (the file is offline)');
    assert.equal((await fetch(`${base}/channel-art?c=x&f=a.jpg&t=secret`, { headers: remote() })).status, 404, 'past the gate');
    // Pairing a browser: a wrong code is refused; the right one sets an HttpOnly, SameSite=Strict HMAC cookie.
    const pair = token => fetch(`${base}/api/pair`, { method: 'POST', headers: remote({ 'Content-Type': 'application/json' }), body: JSON.stringify({ token }) });
    assert.equal((await pair('guess')).status, 403);
    const paired = await pair('secret');
    assert.equal(paired.status, 200);
    const setCookie = paired.headers.get('set-cookie');
    assert.match(setCookie, /^onto_pair=[A-Za-z0-9_-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    assert.ok(!setCookie.includes('secret'), 'the cookie is not the token');
    const cookie = setCookie.split(';')[0];
    assert.equal((await fetch(`${base}/api/home`, { headers: remote({ cookie }) })).status, 200);
    assert.equal((await fetch(`${base}/media?src=Kids%2FTimmy%20Time.mp4`, { headers: remote({ cookie }) })).status, 404, 'cookie opens media too');
    assert.equal((await fetch(`${base}/api/home`, { headers: remote({ cookie: 'onto_pair=forged' }) })).status, 403);
    assert.deepEqual(await (await fetch(`${base}/api/pair`, { headers: remote({ cookie }) })).json(), { paired: true });
  } finally { await close(); }
});

test('enforce: pairing over the tailnet HTTPS marks the cookie Secure; guesses are rate-limited', async () => {
  const { base, close } = await boot({ server: { authMode: 'enforce' } });
  try {
    const pair = (token, extra = {}) => fetch(`${base}/api/pair`, { method: 'POST', headers: remote({ 'Content-Type': 'application/json', ...extra }), body: JSON.stringify({ token }) });
    const secure = await pair('secret', { 'X-Forwarded-Proto': 'https' });
    assert.match(secure.headers.get('set-cookie'), /; Secure$/);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await pair('guess')).status);
    assert.equal(statuses.at(-1), 429);
  } finally { await close(); }
});

test('enforce: this Mac itself, static files, preflights, health, whoami and the game relay stay open', async () => {
  const { base, close } = await boot({ server: { authMode: 'enforce' } });
  try {
    assert.equal((await fetch(`${base}/api/home`)).status, 200, 'loopback, not forwarded');
    assert.equal(await rawStatus(base, '/api/home', { Host: 'tv.example.ts.net' }), 401, 'a tailnet Host name is not this Mac');
    assert.equal((await fetch(`${base}/api/home`, { headers: { 'Tailscale-User-Login': 'someone@example.com' } })).status, 401, 'a tailscale serve header is not this Mac');
    assert.equal((await fetch(`${base}/`, { headers: remote() })).status, 200);
    assert.equal((await fetch(`${base}/api/health`, { headers: remote() })).status, 200);
    assert.equal((await fetch(`${base}/api/whoami?n=${'a'.repeat(32)}`, { headers: remote() })).status, 200);
    assert.equal((await fetch(`${base}/api/home`, { method: 'OPTIONS', headers: remote({ Origin: 'file://' }) })).status, 204);
    assert.notEqual((await fetch(`${base}/api/game/join`, { method: 'POST', headers: remote({ 'Content-Type': 'application/json' }), body: '{"code":"000000"}' })).status, 401);
  } finally { await close(); }
});

test('the household reaches pages only through the gated /api/household', async () => {
  const { base, close } = await boot({ server: { authMode: 'enforce' } });
  try {
    assert.equal((await fetch(`${base}/api/household`, { headers: remote() })).status, 401);
    const body = await (await fetch(`${base}/api/household`, { headers: remote({ 'X-Onto-Token': 'secret' }) })).json();
    assert.ok(Array.isArray(body.viewers) && Array.isArray(body.profiles));
    assert.equal('network' in body, false);
  } finally { await close(); }
});
