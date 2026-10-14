import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileOpenBatcher } from './file-open-batch.js';

function fixture(open, options = {}) {
  let nextId = 0;
  const timers = new Map();
  const batcher = createFileOpenBatcher(open, {
    ...options,
    setTimeoutImpl(callback, delay) { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeoutImpl(id) { timers.delete(id); },
  });
  return {
    batcher, timers,
    async fire() {
      const active = [...timers.values()]; timers.clear();
      for (const { callback } of active) callback();
      // Allow the open callback and any async rejection handler to settle.
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('a Finder burst opens one ordered batch and a later selection opens separately', async () => {
  const opened = [];
  const f = fixture(paths => opened.push(paths));
  f.batcher.add('/A.mp4');
  f.batcher.add('/B.mp4');
  f.batcher.add('/C.mp4');
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 100);
  assert.deepEqual(opened, []);
  await f.fire();
  assert.deepEqual(opened, [['/A.mp4', '/B.mp4', '/C.mp4']]);
  f.batcher.add('/D.mp4');
  await f.fire();
  assert.deepEqual(opened, [['/A.mp4', '/B.mp4', '/C.mp4'], ['/D.mp4']]);
});

test('duplicate files retain first occurrence order and each arrival resets the timer', async () => {
  const opened = [];
  const f = fixture(paths => opened.push(paths), { delayMs: 25 });
  f.batcher.add('/B.mp4');
  const firstTimer = [...f.timers.keys()][0];
  f.batcher.add('/A.mp4');
  f.batcher.add('/B.mp4');
  assert.equal(f.timers.has(firstTimer), false);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 25);
  await f.fire();
  assert.deepEqual(opened, [['/B.mp4', '/A.mp4']]);
});

test('explicit flush returns the callback result and empty flush does not reopen files', async () => {
  const opened = [];
  const f = fixture(async paths => { opened.push(paths); return 'opened'; });
  f.batcher.add('/A.mp4');
  assert.equal(await f.batcher.flush(), 'opened');
  assert.equal(f.timers.size, 0);
  assert.equal(await f.batcher.flush(), undefined);
  await f.fire();
  assert.deepEqual(opened, [['/A.mp4']]);
});

test('cancel discards pending files without a callback and allows a fresh batch', async () => {
  const opened = [];
  const f = fixture(paths => opened.push(paths));
  f.batcher.add('/A.mp4'); f.batcher.add('/B.mp4');
  f.batcher.cancel();
  assert.equal(f.timers.size, 0);
  await f.fire(); await f.batcher.flush();
  assert.deepEqual(opened, []);
  f.batcher.add('/C.mp4'); await f.fire();
  assert.deepEqual(opened, [['/C.mp4']]);
});

test('timer-triggered async failures reach onError and the batch is not retried', async () => {
  const failure = new Error('TV is unavailable');
  const errors = [];
  let calls = 0;
  const f = fixture(async () => { calls++; throw failure; }, { onError: error => errors.push(error) });
  f.batcher.add('/A.mp4'); await f.fire();
  assert.deepEqual(errors, [failure]);
  assert.equal(calls, 1);
  await f.batcher.flush();
  assert.equal(calls, 1);
});

test('explicit flush rejects to its caller, including a synchronous callback failure', async () => {
  const failure = new Error('Could not open file');
  const errors = [];
  const f = fixture(() => { throw failure; }, { onError: error => errors.push(error) });
  f.batcher.add('/A.mp4');
  await assert.rejects(f.batcher.flush(), error => error === failure);
  assert.deepEqual(errors, []);
  assert.equal(f.timers.size, 0);
});

test('a callback can start another batch without losing or repeating either selection', async () => {
  const opened = [];
  const f = fixture(paths => {
    opened.push(paths);
    if (paths[0] === '/A.mp4') f.batcher.add('/B.mp4');
  });
  f.batcher.add('/A.mp4'); await f.fire();
  assert.deepEqual(opened, [['/A.mp4']]);
  assert.equal(f.timers.size, 1);
  await f.fire();
  assert.deepEqual(opened, [['/A.mp4'], ['/B.mp4']]);
});
