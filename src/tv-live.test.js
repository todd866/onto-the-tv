import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSamsungRemote, keyMessage, remoteUrl } from './samsung-remote.js';
import { createLiveTv, tuneKeys } from './tv-live.js';

// A TV that accepts (or refuses) the connection and records the keys it is sent.
function fakeTv({ refuse = false } = {}) {
  const tv = { urls: [], keys: [] };
  tv.WebSocket = class {
    constructor(url) {
      tv.urls.push(url);
      setImmediate(() => this.onmessage({ data: JSON.stringify({ event: refuse ? 'ms.channel.unauthorized' : 'ms.channel.connect' }) }));
    }
    send(message) { tv.keys.push(JSON.parse(message).params.DataOfCmd); }
    close() {}
  };
  return tv;
}
const noWait = () => Promise.resolve();

test('the remote names itself to the TV and sends key clicks', () => {
  assert.equal(remoteUrl('192.168.20.14', 'Onto the TV'),
    'ws://192.168.20.14:8001/api/v2/channels/samsung.remote.control?name=T250byB0aGUgVFY%3D');
  assert.deepEqual(JSON.parse(keyMessage('KEY_VOLUP')).params,
    { Cmd: 'Click', DataOfCmd: 'KEY_VOLUP', Option: 'false', TypeOfRemote: 'SendRemoteKey' });
});

test('keys go in order over one connection', async () => {
  const tv = fakeTv();
  const remote = createSamsungRemote({ host: '192.168.20.14', WebSocket: tv.WebSocket, wait: noWait });
  await Promise.all([remote.press('KEY_2', 'KEY_2'), remote.press('KEY_ENTER')]);
  assert.deepEqual(tv.keys, ['KEY_2', 'KEY_2', 'KEY_ENTER']);
  assert.equal(tv.urls.length, 1);
});

test('a TV that refuses says how to fix it, and the next press tries again', async () => {
  const tv = fakeTv({ refuse: true });
  const remote = createSamsungRemote({ host: 'tv', WebSocket: tv.WebSocket, wait: noWait });
  await assert.rejects(remote.press('KEY_MUTE'), /Allow it on the TV/);
  await assert.rejects(remote.press('KEY_MUTE'), /Allow it on the TV/);
  assert.equal(tv.urls.length, 2);
});

test('tuning switches to the tuner once, then just dials', async () => {
  assert.deepEqual(tuneKeys('22'), ['KEY_2', 'KEY_2', 'KEY_ENTER']);
  assert.throws(() => tuneKeys('ABC'), /Not a channel number/);
  const tv = fakeTv();
  const live = createLiveTv({ remote: createSamsungRemote({ host: 'tv', WebSocket: tv.WebSocket, wait: noWait }), macInput: 'KEY_HDMI2' });
  await live.tune('22');
  await live.tune(3);
  assert.deepEqual(tv.keys, ['KEY_TV', 'KEY_2', 'KEY_2', 'KEY_ENTER', 'KEY_3', 'KEY_ENTER']);
  assert.equal(live.showing, '3');
  assert.equal(await live.leave(), true);
  assert.equal(tv.keys.at(-1), 'KEY_HDMI2');
  assert.equal(await live.leave(), false, 'already on the Mac');
});

test('while live TV shows, channel keys pass to the TV; volume always does', async () => {
  const tv = fakeTv();
  const live = createLiveTv({ remote: createSamsungRemote({ host: 'tv', WebSocket: tv.WebSocket, wait: noWait }) });
  assert.equal(live.relay('ArrowUp'), false, 'on the Mac, arrows drive the home screen');
  assert.equal(live.relay('AudioVolumeUp'), true);
  await live.tune('2');
  assert.equal(live.relay('ArrowUp'), true);
  assert.equal(live.relay('7'), true);
  assert.equal(live.relay('ArrowLeft'), false);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tv.keys.filter(key => !/KEY_(TV|2|ENTER)$/.test(key)), ['KEY_VOLUP', 'KEY_CHUP', 'KEY_7']);
});
