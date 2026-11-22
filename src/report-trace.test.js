import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateTrace, shortArgs, traceRenderer } from './report-trace.js';

test('state trace emits only changes and five-second position buckets', () => {
  const entries = [], trace = createStateTrace((...args) => entries.push(args));
  const state = { status: 'playing', current: { path: '/a', positionSeconds: 1 } };
  trace(state);
  state.current.positionSeconds = 4; trace(state);
  assert.equal(entries.length, 1);
  state.current.positionSeconds = 5; trace(state);
  assert.deepEqual(entries.at(-1), ['state', { position: 5 }]);
  state.status = 'paused'; trace(state);
  assert.deepEqual(entries.at(-1), ['state', { status: 'paused' }]);
});

test('IPC summaries exclude object contents and bound strings and arrays', () => {
  assert.deepEqual(shortArgs([{ contents: 'private file', profiles: {} }, ['contents'], 'x'.repeat(300)]),
    [{ keys: ['contents', 'profiles'] }, { array: 1 }, 'x'.repeat(160)]);
});

test('UPnP tracing preserves results and failures, omits metadata', async () => {
  const entries = [];
  const error = new Error('UPnP 701');
  const renderer = traceRenderer({ async invoke(action) { if (action === 'Play') throw error; return '<ok/>'; } },
    (...args) => entries.push(args));
  assert.equal(await renderer.invoke('SetAVTransportURI', { CurrentURI: 'http://local/a', CurrentURIMetaData: 'file content' }), '<ok/>');
  assert.deepEqual(entries[0], ['upnp:request', { action: 'SetAVTransportURI', fields: { CurrentURI: 'http://local/a' } }]);
  await assert.rejects(renderer.invoke('Play', {}), error);
  assert.deepEqual(entries.at(-1), ['upnp:error', { action: 'Play', error: 'UPnP 701' }]);
});
