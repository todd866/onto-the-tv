import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuestInvites } from './guest-invites.js';
import { createGuestServer, phonePlayable } from './guest-server.js';

async function setup({ rating = 'M' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  const media = join(dir, 'media');
  await mkdir(join(media, 'Bluey'), { recursive: true });
  await mkdir(join(media, 'Mobland'), { recursive: true });
  const bytes = Buffer.alloc(4096, 7);
  for (const name of ['Bluey/a.mp4', 'Bluey/b.mp4', 'Mobland/Mobland S01E01.mp4', 'Mobland/Mobland S01E02.mkv']) await writeFile(join(media, name), bytes);
  const videos = [
    { src: 'Bluey/a.mp4', file: join(media, 'Bluey/a.mp4'), title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 },
    { src: 'Bluey/b.mp4', file: join(media, 'Bluey/b.mp4'), title: 'B', channel: 'Bluey', tier: 'shared', duration: 420 },
    { src: 'Mobland/Mobland S01E01.mp4', file: join(media, 'Mobland/Mobland S01E01.mp4'), title: 'Mobland S01E01', channel: 'Mobland', tier: 'grownup', duration: 2500 },
    { src: 'Mobland/Mobland S01E02.mkv', file: join(media, 'Mobland/Mobland S01E02.mkv'), title: 'Mobland S01E02', channel: 'Mobland', tier: 'grownup', duration: 2500 },
  ];
  const ui = join(dir, 'ui');
  await mkdir(ui);
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>guest</title>');
  const invites = await createGuestInvites(join(dir, 'guests.json'));
  const server = createGuestServer({ videos: () => videos, invites, dataDir: join(dir, 'guests'), uiRoot: ui, secureCookie: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { code } = await invites.invite('Dave', { rating, days: 7 });
  const close = () => new Promise(resolve => server.close(resolve));
  return { dir, invites, base, code, close };
}

async function signIn(base, code) {
  const response = await fetch(`${base}/w/${code}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  return cookie.split(';')[0];
}

const post = (base, path, cookie, body, headers = {}) => fetch(base + path, { method: 'POST',
  headers: { cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('phones get MP4 and QuickTime, not MKV', () => {
  assert.equal(phonePlayable({ file: '/m/a.mp4' }), true);
  assert.equal(phonePlayable({ file: '/m/a.M4V' }), true);
  assert.equal(phonePlayable({ file: '/m/a.mkv' }), false);
  assert.equal(phonePlayable({ file: '/m/a.avi' }), false);
});

test('nothing but static files without an invite; a bad invite is refused', async () => {
  const { base, close } = await setup();
  try {
    assert.equal((await fetch(`${base}/api/home`)).status, 401);
    assert.equal((await fetch(`${base}/media?src=Bluey%2Fa.mp4`)).status, 401);
    assert.equal((await fetch(`${base}/w/not-a-real-invite`, { redirect: 'manual' })).status, 403);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { await close(); }
});

test('an invite signs a guest in and stores only hashes', async () => {
  const { dir, base, code, close } = await setup();
  try {
    const cookie = await signIn(base, code);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.name, 'Dave');
    assert.equal(me.rating, 'M');
    const stored = await readFile(join(dir, 'guests.json'), 'utf8');
    assert.equal(stored.includes(code), false);
    assert.equal(stored.includes(cookie.split('=')[1]), false);
  } finally { await close(); }
});

test('the TV server\'s controls are not reachable from the guest app', async () => {
  const { base, code, close } = await setup();
  try {
    const cookie = await signIn(base, code);
    for (const path of ['/api/tv-command', '/api/diagnostics', '/api/game/state', '/api/console/launch', '/api/media-cache', '/api/progress-all', '/scene-thumb', '/uke/audio/x', '/api/tv-command?x=1'])
    {
      const status = (await post(base, path, cookie, {})).status;
      assert.ok(status === 404 || status === 405, `${path} → ${status}`);
      assert.equal((await fetch(base + path, { headers: { cookie } })).status, 404, `GET ${path}`);
    }
    assert.equal((await fetch(`${base}/../tv-server.js`, { headers: { cookie } })).status, 404);
  } finally { await close(); }
});

test('a guest streams only what was dealt to them, and MKV never', async () => {
  const { base, code, close } = await setup();
  try {
    const cookie = await signIn(base, code);
    // Not dealt yet: refused even though the file exists.
    assert.equal((await fetch(`${base}/media?src=${encodeURIComponent('Mobland/Mobland S01E01.mp4')}`, { headers: { cookie } })).status, 404);
    const home = await (await fetch(`${base}/api/home`, { headers: { cookie } })).json();
    const grownups = home.channels.find(channel => channel.id === 'grownups');
    assert.ok(grownups, 'Mum & Dad channel at an M ceiling');
    const item = await (await post(base, '/api/next', cookie, { channel: 'grownups' })).json();
    assert.equal(item.src, 'Mobland/Mobland S01E01.mp4');
    const media = await fetch(`${base}/media?src=${encodeURIComponent(item.src)}`, { headers: { cookie, range: 'bytes=0-99' } });
    assert.equal(media.status, 206);
    assert.equal((await media.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(`${base}/media?src=${encodeURIComponent('Mobland/Mobland S01E02.mkv')}`, { headers: { cookie } })).status, 404);
    // Finished streams free their slot: many sequential range reads all succeed.
    for (let i = 0; i < 8; i++) {
      const again = await fetch(`${base}/media?src=${encodeURIComponent(item.src)}`, { headers: { cookie, range: 'bytes=0-9' } });
      assert.equal(again.status, 206, `read ${i}`);
      await again.arrayBuffer();
    }
  } finally { await close(); }
});

test('a PG guest gets no grown-up channel and cannot ask for one', async () => {
  const { base, code, close } = await setup({ rating: 'PG' });
  try {
    const cookie = await signIn(base, code);
    const home = await (await fetch(`${base}/api/home`, { headers: { cookie } })).json();
    assert.deepEqual(home.channels.map(channel => channel.id), ['cartoons', 'bluey'], 'kids channels only');
    const response = await post(base, '/api/next', cookie, { channel: 'grownups' });
    assert.notEqual(response.status, 200);
  } finally { await close(); }
});

test('revoking a guest ends their session; cross-site posts are refused', async () => {
  const { invites, base, code, close } = await setup();
  try {
    const cookie = await signIn(base, code);
    assert.equal((await post(base, '/api/next', cookie, { channel: 'cartoons' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(base, '/api/next', cookie, { channel: 'cartoons' }, { origin: 'null' })).status, 403);
    assert.equal((await fetch(base + '/api/next', { method: 'POST', headers: { cookie, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    await invites.revoke('Dave');
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${base}/w/${code}`, { redirect: 'manual' })).status, 403);
  } finally { await close(); }
});

test('an expired invite is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  let clock = Date.now();
  const invites = await createGuestInvites(join(dir, 'guests.json'), { now: () => clock });
  const { code } = await invites.invite('Sue', { days: 1 });
  assert.ok(await invites.redeem(code));
  clock += 2 * 86_400_000;
  assert.equal(await invites.redeem(code), null);
});

test('the invite command and the server see each other\'s changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  const server = await createGuestInvites(join(dir, 'guests.json'));
  const cli = await createGuestInvites(join(dir, 'guests.json'));
  const { code } = await cli.invite('Jo', { rating: 'PG' });
  const signed = await server.redeem(code);
  assert.equal(signed.guest.rating, 'PG');
  await cli.revoke('Jo');
  assert.equal(await server.session(signed.session), null);
});

// Regressions from the 2026-11-04 adversarial review (Codex).
import { connect } from 'node:net';

test('a malformed request target is a 400, not a crash', async () => {
  const { base, close } = await setup();
  try {
    const { port } = new URL(base);
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => socket.write('GET //%25 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${base}/`)).status, 200, 'still serving');
  } finally { await close(); }
});

test('lowering a guest\'s rating takes back what they were dealt', async () => {
  const { invites, base, code, close } = await setup();
  try {
    let cookie = await signIn(base, code);
    const item = await (await post(base, '/api/next', cookie, { channel: 'grownups' })).json();
    const url = `${base}/media?src=${encodeURIComponent(item.src)}`;
    assert.equal((await fetch(url, { headers: { cookie, range: 'bytes=0-9' } })).status, 206);
    const renewed = await invites.invite('Dave', { rating: 'PG' });
    assert.equal((await fetch(url, { headers: { cookie } })).status, 401, 'old session ended by the rating change');
    cookie = await signIn(base, renewed.code);
    assert.equal((await fetch(url, { headers: { cookie } })).status, 404, 'M title no longer streams at PG');
  } finally { await close(); }
});

test('a client that leaves early does not keep a stream slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  await writeFile(join(dir, 'a.mp4'), Buffer.alloc(4096));
  const videos = [{ src: 'Bluey/a.mp4', file: join(dir, 'a.mp4'), title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 }];
  const real = await createGuestInvites(join(dir, 'guests.json'));
  let slow = false;
  const invites = { ...real, session: async value => { if (slow) await new Promise(r => setTimeout(r, 80)); return real.session(value); }, redeem: real.redeem };
  const server = createGuestServer({ videos: () => videos, invites, dataDir: join(dir, 'g'), uiRoot: dir, secureCookie: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { code } = await real.invite('Kim', { rating: 'G' });
    const cookie = await signIn(base, code);
    await (await post(base, '/api/next', cookie, { channel: 'cartoons' })).json();
    slow = true;
    for (let i = 0; i < 4; i++) {
      const abort = new AbortController();
      const pending = fetch(`${base}/media?src=Bluey%2Fa.mp4`, { headers: { cookie }, signal: abort.signal }).catch(() => null);
      setTimeout(() => abort.abort(), 20);
      await pending;
      await new Promise(r => setTimeout(r, 120));
    }
    slow = false;
    assert.equal((await fetch(`${base}/media?src=Bluey%2Fa.mp4`, { headers: { cookie, range: 'bytes=0-9' } })).status, 206);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a sign-in racing a revoke never brings the guest back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  const server = await createGuestInvites(join(dir, 'guests.json'));
  const cli = await createGuestInvites(join(dir, 'guests.json'));
  const { code } = await cli.invite('Lee');
  const results = await Promise.all([...Array(10)].map((_, i) => (i === 5 ? cli.revoke('Lee') : server.redeem(code))));
  const after = (await cli.list()).find(guest => guest.id === 'lee');
  assert.equal(after.revoked, true);
  assert.equal(after.sessions, 0);
  for (const signed of results.filter(r => r && r.session)) assert.equal(await server.session(signed.session), null);
});

test('a client that leaves while the file is opening leaves no stream open', async () => {
  const { Readable } = await import('node:stream');
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  await writeFile(join(dir, 'a.mp4'), Buffer.alloc(4096));
  const videos = [{ src: 'Bluey/a.mp4', file: join(dir, 'a.mp4'), title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 }];
  const opened = [];
  const mediaCache = { stream: async () => {
    await new Promise(r => setTimeout(r, 80));
    const stream = new Readable({ read() {} });
    opened.push(stream);
    return stream;
  } };
  const invites = await createGuestInvites(join(dir, 'guests.json'));
  const server = createGuestServer({ videos: () => videos, invites, dataDir: join(dir, 'g'), uiRoot: dir, mediaCache, secureCookie: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { code } = await invites.invite('Kim', { rating: 'G' });
    const cookie = await signIn(base, code);
    await (await post(base, '/api/next', cookie, { channel: 'cartoons' })).json();
    const abort = new AbortController();
    const pending = fetch(`${base}/media?src=Bluey%2Fa.mp4`, { headers: { cookie }, signal: abort.signal }).then(r => r.body?.cancel(), () => null);
    setTimeout(() => abort.abort(), 20);
    await pending;
    await new Promise(r => setTimeout(r, 200));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].destroyed, true, 'stream opened after the client left is closed');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a change waits for another process holding the guests lock', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  const path = join(dir, 'guests.json');
  const invites = await createGuestInvites(path);
  const holder = spawn(process.execPath, ['-e',
    `const fs=require('fs');fs.openSync(${JSON.stringify(path + '.lock')},fs.constants.O_RDWR|fs.constants.O_CREAT|0x20|0x4);console.log('held');setTimeout(()=>{},300)`]);
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const started = Date.now();
  await invites.invite('Ash');
  assert.ok(Date.now() - started >= 150, 'waited for the other process');
  assert.equal((await invites.list()).length, 1);
});

test('a client that leaves while artwork is being made leaves no file open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  await writeFile(join(dir, 'a.mp4'), Buffer.alloc(4096));
  await writeFile(join(dir, 'a.jpg'), Buffer.alloc(64 * 1024, 1));
  const videos = [{ src: 'Bluey/a.mp4', file: join(dir, 'a.mp4'), title: 'A', channel: 'Bluey', tier: 'shared', duration: 420 }];
  let served = null;
  const artwork = { get: async () => { await new Promise(r => setTimeout(r, 80)); served = join(dir, 'a.jpg'); return served; } };
  const invites = await createGuestInvites(join(dir, 'guests.json'));
  const server = createGuestServer({ videos: () => videos, invites, dataDir: join(dir, 'g'), uiRoot: dir, artwork, secureCookie: false });
  const responses = [];
  server.on('request', (request, response) => responses.push(response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { code } = await invites.invite('Kim', { rating: 'G' });
    const cookie = await signIn(base, code);
    await (await fetch(`${base}/api/home`, { headers: { cookie } })).json();
    const abort = new AbortController();
    const pending = fetch(`${base}/art?src=Bluey%2Fa.mp4`, { headers: { cookie }, signal: abort.signal }).catch(() => null);
    setTimeout(() => abort.abort(), 20);
    await pending;
    await new Promise(r => setTimeout(r, 200));
    assert.ok(served, 'artwork was prepared');
    const last = responses.at(-1);
    assert.equal(last.headersSent, false, 'nothing was piped to the departed client');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the guest page is the TV interface in guest mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-guest-'));
  const videos = [];
  const invites = await createGuestInvites(join(dir, 'guests.json'));
  const tv = join(new URL('.', import.meta.url).pathname, '..', 'tv');
  const server = createGuestServer({ videos: () => videos, invites, dataDir: join(dir, 'g'), uiRoot: tv, secureCookie: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.match(page, /id="channels"/);
    assert.match(page, /id="osd-back"/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/fonts/Nunito-Bold.woff`)).status, 200);
    assert.match(await (await fetch(`${base}/config.js`)).text(), /"signedOut":true/);
    const { code } = await invites.invite('Robin', { rating: 'PG' });
    const cookie = await signIn(base, code);
    const config = await (await fetch(`${base}/config.js`, { headers: { cookie } })).text();
    assert.match(config, /"name":"Robin"/);
    assert.equal(config.includes('token'), false, 'no pairing token in guest config');
    assert.equal((await post(base, '/api/watch', cookie, { src: 'x' })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/scenes?src=x`, { headers: { cookie } })).json(), { cuts: [], thumbs: [], segments: [] });
    assert.equal((await fetch(`${base}/api/subs?src=x`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/subs?src=x&name=a.srt`, { headers: { cookie } })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
