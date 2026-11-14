import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStorage, createTvLibrary, createTvServer } from './tv-server.js';
import { loadPlaybackHistory } from './playback-history.js';
import { parseTvArgs, runTv, sendToTv } from './tv-remote.js';
import { fileURLToPath } from 'node:url';

const videos = [
  { src: 'Kids/Timmy Time.mp4', file: '/m/Kids/Timmy Time.mp4', title: 'Timmy', channel: 'Kids', tier: 'preschool', duration: 600 },
];

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'onto-remote-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos, history, storage, random: () => 0 });
  const file = join(dir, 'play-next.json');
  const server = createTvServer({ library, history, storage, uiRoot: dir, token: 'secret', playNextFile: file });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', 'X-Onto-Token': 'secret' };
  return { base, headers, file, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the live interface manifest needs the token; fonts do not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-live-'));
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos, history, storage, random: () => 0 });
  const uiRoot = fileURLToPath(new URL('../tv', import.meta.url));
  const server = createTvServer({ library, history, storage, uiRoot, token: 'secret', playNextFile: join(dir, 'play-next.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/tv-live`)).status, 403);
    const reply = await fetch(`${base}/api/tv-live`, { headers: { 'X-Onto-Token': 'secret' } });
    assert.equal(reply.status, 200);
    const page = await reply.json();
    assert.match(page.build, /^live-/);
    assert.ok(page.scripts.includes('app.js') && typeof page.body === 'string');
    // A cross-origin page (the installed app) may fetch a font without the token, and nothing else.
    assert.equal((await fetch(`${base}/fonts/Nunito-Bold.woff`, { headers: { Origin: 'file://' } })).status, 200);
    assert.equal((await fetch(`${base}/api/home`, { headers: { Origin: 'file://' } })).status, 403);
    assert.equal((await fetch(`${base}/app.js`, { headers: { Origin: 'file://' } })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('play-next and now-playing are token-gated and keep the queue on disk', async () => {
  const { base, headers, file, close } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/play-next`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"src":"Kids/Timmy Time.mp4"}' })).status, 403);
    assert.equal((await fetch(`${base}/api/now-playing`)).status, 403);
    assert.equal((await fetch(`${base}/api/play-next`, { method: 'POST', headers, body: '{"src":"../secret.mp4"}' })).status, 400);
    const added = await fetch(`${base}/api/play-next`, { method: 'POST', headers, body: JSON.stringify({ src: 'Kids/Timmy Time.mp4' }) });
    assert.equal(added.status, 200);
    assert.deepEqual(await added.json(), { items: ['Kids/Timmy Time.mp4'] });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).items, ['Kids/Timmy Time.mp4']);
    assert.deepEqual(await (await fetch(`${base}/api/play-next`, { headers })).json(), { items: ['Kids/Timmy Time.mp4'] });
    const consumed = await fetch(`${base}/api/play-next`, { method: 'POST', headers, body: JSON.stringify({ src: 'Kids/Timmy Time.mp4', consume: true }) });
    assert.deepEqual(await consumed.json(), { items: [] });

    assert.deepEqual(await (await fetch(`${base}/api/now-playing`, { headers })).json(), { src: null, position: 0, channel: null, profile: null });
    const posted = await fetch(`${base}/api/now-playing`, { method: 'POST', headers, body: JSON.stringify({
      src: 'Kids/Timmy Time.mp4', position: 84.2, channel: { id: 'christmas', number: 5, name: 'Christmas' }, profile: 'all',
    }) });
    assert.equal(posted.status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/now-playing`, { headers })).json(), {
      src: 'Kids/Timmy Time.mp4', position: 84, channel: { id: 'christmas', number: 5, name: 'Christmas' }, profile: 'all',
    });
    assert.equal((await fetch(`${base}/api/now-playing`, { method: 'POST', headers, body: '{"src":"http://evil/a.mp4","position":1}' })).status, 400);
  } finally { await close(); }
});

const beat = (base, headers, extra = {}) => fetch(`${base}/api/diagnostics`, { method: 'POST', headers, body: JSON.stringify({
  session: 'tv-1', event: 'heartbeat', build: 'test', page: 'player', engine: 'video', position: 3, duration: 10, paused: false, hidden: false, state: 'playing', ...extra,
}) }).then(response => response.json());

test('the tv cli reads now-playing and sends allowlisted actions', async () => {
  const { base, headers, close } = await boot();
  const remote = args => runTv({ ...parseTvArgs(['--url', base, '--token', 'secret', ...args]), timeoutMs: 1500, pollMs: 30 });
  try {
    assert.equal(parseTvArgs(['sideways']).code, 2);
    assert.equal(parseTvArgs(['seek', '-3']).code, 2);
    assert.equal(parseTvArgs(['play', 'Kids/a.mp4', '1455']).positionSeconds, 1455);
    assert.equal(parseTvArgs(['play', 'Kids/a.mp4']).positionSeconds, null);
    assert.equal((await remote(['now'])).line, 'idle');
    assert.equal((await fetch(`${base}/api/now-playing`, { method: 'POST', headers, body: JSON.stringify({
      src: 'Kids/Timmy Time.mp4', position: 84, channel: { id: 'christmas', number: 5, name: 'Christmas' }, profile: 'all',
    }) })).status, 200);
    assert.equal((await remote(['now'])).line, 'Kids/Timmy Time.mp4  84s  5 Christmas  all');
    assert.equal((await remote(['next', 'Kids/Timmy Time.mp4'])).line, 'no tv');
    assert.deepEqual(await (await fetch(`${base}/api/play-next`, { headers })).json(), { items: ['Kids/Timmy Time.mp4'] });
    await beat(base, headers);
    const pending = remote(['pause']);
    let command = null;
    for (let i = 0; i < 40 && !command; i++) {
      command = (await beat(base, headers)).command;
      if (!command) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(command.action, 'pause');
    await beat(base, headers, { commandAck: { id: command.id, status: 'done' } });
    assert.equal((await pending).line, 'pause done');
    const seek = parseTvArgs(['seek', '12.2']);
    assert.equal(seek.seconds, 12);
    const tune = parseTvArgs(['tune', '5']);
    assert.equal(tune.channel, 5);
  } finally { await close(); }
});

test('a queued command is acknowledged on the diagnostics poll', async () => {
  const { base, headers, close } = await boot();
  try {
    const queued = await fetch(`${base}/api/tv-command`, { method: 'POST', headers, body: JSON.stringify({ session: 'tv-1', action: 'pause' }) });
    assert.equal(queued.status, 202);
    const id = (await queued.json()).id;
    const poll = await fetch(`${base}/api/diagnostics`, { method: 'POST', headers, body: JSON.stringify({
      session: 'tv-1', event: 'heartbeat', build: 'test', page: 'player', engine: 'video', position: 3, duration: 10, paused: false, hidden: false, state: 'playing',
    }) });
    const body = await poll.json();
    assert.equal(body.command.action, 'pause');
    assert.equal(body.command.id, id);
    const ack = await fetch(`${base}/api/diagnostics`, { method: 'POST', headers, body: JSON.stringify({
      session: 'tv-1', event: 'heartbeat', build: 'test', page: 'player', engine: 'video', position: 3, duration: 10, paused: true, hidden: false, state: 'paused',
      commandAck: { id, status: 'done' },
    }) });
    assert.equal((await ack.json()).command, null);
    assert.equal((await (await fetch(`${base}/api/tv-command?id=${id}`, { headers })).json()).result.status, 'done');
  } finally { await close(); }
});

// Play on TV from the Mac app's Channels tab (15 Nov 2026): the switch said TV and did nothing there.
test('the Mac app tunes the TV to a channel or plays a named episode, and says why when it cannot', async () => {
  const { base, headers, close } = await boot();
  const send = (action, value, seconds) => sendToTv({ origin: base + '/', action, value, seconds, token: 'secret', timeoutMs: 1500, pollMs: 30 });
  const answer = async status => {
    let command = null;
    for (let i = 0; i < 60 && !command; i++) { command = (await beat(base, headers)).command; if (!command) await new Promise(resolve => setTimeout(resolve, 30)); }
    await beat(base, headers, { commandAck: { id: command.id, status } });
    return command;
  };
  try {
    await assert.rejects(send('tune', 'littleones'), /TV is not on Onto the TV/);
    await assert.rejects(sendToTv({ origin: base, action: 'tune', value: 'littleones', token: '' }), /not paired/);
    await assert.rejects(send('tune', '../etc'), /Unknown TV command/);
    await assert.rejects(send('launch', 'x'), /Unknown TV command/);
    await beat(base, headers);
    const tuning = send('tune', 'littleones');
    const tuned = await answer('done');
    assert.deepEqual([tuned.action, tuned.channel], ['tune', 'littleones']);
    assert.equal(await tuning, true);
    const playing = send('play', 'Kids/Timmy Time.mp4', 84.4);
    const played = await answer('done');
    assert.deepEqual([played.action, played.src, played.positionSeconds], ['play', 'Kids/Timmy Time.mp4', 84]);
    assert.equal(await playing, true);
    // The TV has no such channel for who is watching there.
    const refused = send('tune', 'kidsongs');
    refused.catch(() => {});
    await answer('failed');
    await assert.rejects(refused, /did not take it/);
    await assert.rejects(sendToTv({ origin: base, action: 'tune', value: 'littleones', token: 'wrong' }), /Pair this TV first/);
  } finally { await close(); }
});
