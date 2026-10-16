import test from 'node:test';
import assert from 'node:assert/strict';
import { createReportCapture } from './report-capture.js';

test('capture freezes snapshot synchronously, starts screenshot immediately, and times out renderer', async () => {
  let current = { value: 'before', errors: [] };
  let screenshotStarted = false;
  let release;
  const rendered = new Promise(resolve => { release = resolve; });
  const writes = [];
  const capture = createReportCapture({ snapshot: () => current, timeoutMs: 10,
    renderer: () => rendered, capturePage: async () => { screenshotStarted = true; return Buffer.from('png'); },
    write: async (report, image) => { writes.push({ report, image }); return 'folder'; } });
  const pending = capture('button');
  assert.equal(screenshotStarted, true, 'screenshot is requested before yielding');
  current.value = 'after';
  await new Promise(resolve => setTimeout(resolve, 20));
  release({ channel: { current: 'late' } });
  await pending;
  assert.equal(screenshotStarted, true);
  assert.equal(writes[0].report.value, 'before');
  assert.deepEqual(writes[0].report.channel, { unavailable: true });
});

test('capture keeps a diagnosis when screenshot capture rejects', async () => {
  const writes = [];
  const capture = createReportCapture({ snapshot: () => ({ errors: [] }), renderer: async () => ({}),
    capturePage: () => { throw new Error('window gone'); }, write: async (...args) => { writes.push(args); } });
  await capture('key');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][1], { error: 'window gone' });
});
