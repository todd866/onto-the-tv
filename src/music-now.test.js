import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNowWriter, nowDoc, nowHost, storeRemote } from './music-now.js';

const song = { src: 'music/Tame Impala/Tame Impala - The Less I Know The Better (Official Video) [sBzrzS1Ag_g].mp4',
  tier: 'music', duration: 219.4 };

test('nowDoc: music videos only, with the bus contract fields', () => {
  assert.equal(nowDoc({ item: { src: 'Bluey/a.mp4', tier: 'shared' }, listener: 'ian', host: 'm2' }), null);
  assert.equal(nowDoc({ item: song, listener: '', host: 'm2' }), null);
  const doc = nowDoc({ item: song, listener: 'ian', host: 'm2', position: 12.6, at: '2026-11-21T00:00:00.000Z', sha: 'abc' });
  assert.deepEqual(doc, { listener: 'ian', surface: 'tv', host: 'm2', at: '2026-11-21T00:00:00.000Z', sha: 'abc',
    key: 'youtube:sBzrzS1Ag_g', title: doc.title, artist: doc.artist, position: 13, duration: 219 });
  assert.match(doc.artist, /Tame Impala/);
  assert.match(doc.title, /Less I Know/);
});

test('nowHost maps the M2 Air to m2 and keeps names bus-safe', () => {
  assert.equal(nowHost('iantodds-MacBook-Air.local'), 'm2');
  assert.equal(nowHost('Lounge Box.local'), 'lounge-box');
});

test('storeRemote reads the remote and survives a missing or broken file', () => {
  assert.equal(storeRemote('/x', () => true, () => '{"remote":"r:bucket/"}'), 'r:bucket');
  assert.equal(storeRemote('/x', () => false), '');
  assert.equal(storeRemote('/x', () => true, () => '{'), '');
});

function fakeSpawn(calls) {
  return (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: body => { calls.push({ cmd, args, body: JSON.parse(body) }); setImmediate(() => child.emit('close', 0)); } };
    child.kill = () => {};
    return child;
  };
}

test('writer: rcat to the listener bus, throttled per song, off without a listener', async () => {
  const calls = [];
  let t = 1_000_000;
  const report = createNowWriter({ listener: 'ian', remote: 'r:b', host: 'm2', run: fakeSpawn(calls), exists: () => true, now: () => t });
  assert.equal(report({ item: song, position: 1 }), true);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls[0].args, ['rcat', 'r:b/music/now/ian/tv-m2.json']);
  t += 5_000;
  assert.equal(report({ item: song, position: 6 }), false); // inside 10 s
  t += 6_000;
  assert.equal(report({ item: song, position: 12 }), true);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 2);
  assert.equal(report({ item: { src: 'Bluey/a.mp4', tier: 'shared' } }), false);
  const off = createNowWriter({ listener: '', remote: 'r:b', run: fakeSpawn(calls), exists: () => true });
  assert.equal(off({ item: song }), false);
});
