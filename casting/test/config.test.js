import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, pickBindHost } from '../src/config.js';

test('portable defaults have no preselected TV and find binaries using PATH', () => {
  const config = loadConfig({});
  assert.equal(config.tvHost, '');
  assert.equal(config.avTransportUrl, '');
  assert.equal(config.ffmpeg, 'ffmpeg');
  assert.equal(config.ffprobe, 'ffprobe');
});
test('explicit saved settings override environment and support a custom TV endpoint', () => {
  const config = loadConfig({ SAMSUNG_TV_HOST: 'old.example', FFMPEG: '/tools/ffmpeg' }, {
    tvHost: 'tv.example', bindHost: '192.0.2.12', avTransportUrl: 'http://tv.example:123/control',
  });
  assert.equal(config.tvHost, 'tv.example');
  assert.equal(config.bindHost, '192.0.2.12');
  assert.equal(config.avTransportUrl, 'http://tv.example:123/control');
  assert.equal(config.ffmpeg, '/tools/ffmpeg');
  assert.equal(loadConfig({}, { tvHost: 'tv.example' }).avTransportUrl, 'http://tv.example:9197/upnp/control/AVTransport1');
});
test('requires an HTTP endpoint and a bare default hostname', () => {
  assert.throws(() => loadConfig({}, { tvHost: 'http://tv.example' }), /hostname/);
  assert.throws(() => loadConfig({}, { avTransportUrl: 'file:///etc/passwd' }), /HTTP/);
  assert.throws(() => loadConfig({}, { avTransportUrl: 'http://user:pass@tv.example' }), /credentials/);
});
test('bind selection prefers a physical interface and safely falls back to loopback', () => {
  assert.equal(pickBindHost(undefined, {}), '127.0.0.1');
  const interfaces = { utun0: [{ family: 'IPv4', address: '192.0.2.1', internal: false }], en1: [{ family: 'IPv4', address: '192.0.2.2', internal: false }] };
  assert.equal(pickBindHost(undefined, interfaces), '192.0.2.2');
  assert.equal(pickBindHost('192.0.2.1', interfaces), '192.0.2.1');
});
