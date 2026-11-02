import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function nav() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('./nav.js', import.meta.url), 'utf8'), { window });
  return window.ontoNav;
}

function tap(machine, state, key, time, ad) {
  const down = machine.step(state, { type: 'down', key, time });
  return machine.step(down.state, { type: 'up', key, time: time + 40, ad: !!ad });
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('a short press is a tap and a 600 ms press is a hold, including Tizen repeats', () => {
  const machine = nav();
  const tapped = tap(machine, machine.initial(), 'ok', 1000);
  assert.deepEqual(plain(tapped.actions), [{ type: 'tap', key: 'ok' }]);

  let held = machine.step(machine.initial(), { type: 'down', key: 'right', time: 0 });
  held = machine.step(held.state, { type: 'down', key: 'right', time: 100 });
  held = machine.step(held.state, { type: 'down', key: 'right', time: 599 });
  assert.deepEqual(plain(held.actions), []);
  assert.equal(held.state.down.at, 0);
  held = machine.step(held.state, { type: 'tick', time: 600 });
  assert.deepEqual(plain(held.actions), [{ type: 'hold', key: 'right' }]);
  const up = machine.step(held.state, { type: 'up', key: 'right', time: 900 });
  assert.deepEqual(plain(up.actions), []);

  const late = machine.step(machine.initial(), { type: 'down', key: 'up', time: 0 });
  const released = machine.step(late.state, { type: 'up', key: 'up', time: 600 });
  assert.deepEqual(plain(released.actions), [{ type: 'hold', key: 'up' }]);
});

test('scene taps queue and commit 700 ms after the last one', () => {
  const machine = nav();
  let state = machine.initial();
  let step = tap(machine, state, 'right', 0);
  assert.deepEqual(plain(step.actions), [{ type: 'queue', delta: 1 }]);
  assert.equal(step.wakeAt, 740);
  step = tap(machine, step.state, 'right', 200);
  step = tap(machine, step.state, 'right', 400);
  step = tap(machine, step.state, 'right', 600);
  step = tap(machine, step.state, 'right', 800);
  assert.equal(step.state.pending, 5);
  assert.equal(step.wakeAt, 1540);
  const early = machine.step(step.state, { type: 'tick', time: 1539 });
  assert.deepEqual(plain(early.actions), []);
  const commit = machine.step(early.state, { type: 'tick', time: 1540 });
  assert.deepEqual(plain(commit.actions), [{ type: 'commit', delta: 5 }]);
  assert.equal(commit.state.pending, 0);

  const cancel = tap(machine, tap(machine, machine.initial(), 'right', 0).state, 'left', 100);
  const none = machine.step(cancel.state, { type: 'tick', time: cancel.wakeAt });
  assert.deepEqual(plain(none.actions), []);
});

test('holding cancels a queued jump, and an ad break takes the play and right taps', () => {
  const machine = nav();
  let step = tap(machine, machine.initial(), 'right', 0);
  step = machine.step(step.state, { type: 'down', key: 'left', time: 100 });
  step = machine.step(step.state, { type: 'tick', time: 700 });
  assert.deepEqual(plain(step.actions), [{ type: 'hold', key: 'left' }]);
  assert.equal(step.state.pending, 0);

  const skip = tap(machine, machine.initial(), 'right', 0, true);
  assert.deepEqual(plain(skip.actions), [{ type: 'skip-break' }]);
  const play = tap(machine, machine.initial(), 'play', 0, true);
  assert.deepEqual(plain(play.actions), [{ type: 'skip-break' }]);
  let hold = machine.step(machine.initial(), { type: 'down', key: 'play', time: 0, ad: true });
  hold = machine.step(hold.state, { type: 'tick', time: 600 });
  assert.deepEqual(plain(hold.actions), [{ type: 'hold', key: 'play' }]);
});

test('scene jumps restart the current scene, then step, and fall back to 60 s', () => {
  const machine = nav();
  assert.equal(machine.sceneTarget(50, 1000, [30, 90], -1), 30);
  assert.equal(machine.sceneTarget(33, 1000, [30, 90], -1), 0);
  assert.equal(machine.sceneTarget(33.1, 1000, [30, 90], -1), 30);
  assert.equal(machine.sceneTarget(50, 1000, [30, 90], -2), 0);
  assert.equal(machine.sceneTarget(40, 1000, [30, 90, 150], 2), 150);
  assert.equal(machine.sceneTarget(40, 1000, [30, 90, 150], 5), 150);
  assert.equal(machine.sceneTarget(10, 1000, [], 1), 70);
  assert.equal(machine.sceneTarget(10, 1000, [], -1), 0);
  assert.equal(machine.sceneTarget(90, 100, [], 1), 99);
  assert.equal(machine.segmentAt(8, [{ start: 0, end: 8, kind: 'intro' }]), null);
  assert.equal(machine.segmentAt(0, [{ start: 0, end: 8, kind: 'intro' }]).kind, 'intro');
});
