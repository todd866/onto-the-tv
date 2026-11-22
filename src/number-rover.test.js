import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const roverPath = join(dirname(fileURLToPath(import.meta.url)), '../tv/number-rover.js');
const module = { exports: {} };
vm.runInNewContext(readFileSync(roverPath, 'utf8'), {
  module,
  exports: module.exports,
  globalThis: {},
  window: undefined,
  self: undefined,
  document: undefined,
  Math,
  Date,
  parseInt,
  parseFloat,
  String,
  Array,
  Object
}, { filename: roverPath });
const { createNumberRoverModel, KEY, canSumTarget, parseLevel, LEVELS } = module.exports;

function move(model, code) {
  model.dispatchKey(code);
  return model.getState();
}

test('every level target is solvable from its pickups', () => {
  for (let i = 0; i < LEVELS.length; i++) {
    const lvl = parseLevel(i);
    const values = lvl.pickups.map((p) => p.value);
    assert.equal(canSumTarget(values, lvl.target), true, `level ${i + 1}`);
  }
});

test('movement stays inside floors and does not pass walls', () => {
  const model = createNumberRoverModel(7);
  const start = model.getState().player;
  move(model, KEY.UP);
  assert.deepEqual(model.getState().player, start);
  move(model, KEY.LEFT);
  assert.deepEqual(model.getState().player, start);
  move(model, KEY.RIGHT);
  assert.notDeepEqual(model.getState().player, start);
  const after = model.getState().player;
  move(model, KEY.RIGHT);
  move(model, KEY.RIGHT);
  move(model, KEY.RIGHT);
  move(model, KEY.RIGHT);
  move(model, KEY.RIGHT);
  assert.equal(after.x + 5, model.getState().player.x);
  assert.equal(after.y, model.getState().player.y);
});

test('numpad 2/4/6/8 moves like arrows', () => {
  const model = createNumberRoverModel(3);
  const a = model.getState().player;
  move(model, KEY.N6);
  assert.equal(model.getState().player.x, a.x + 1);
  move(model, KEY.N4);
  assert.equal(model.getState().player.x, a.x);
  move(model, KEY.N8);
  assert.equal(model.getState().player.y, a.y);
});

test('monster collision costs a heart and resets the sum', () => {
  const model = createNumberRoverModel(7);
  assert.equal(model.getState().hearts, 3);
  for (let i = 0; i < 4; i++) move(model, KEY.DOWN);
  const st = model.getState();
  assert.equal(st.hearts, 2);
  assert.equal(st.currentSum, 0);
  assert.ok(st.pickups.every((p) => !p.taken));
});

test('retry restores the level without changing score', () => {
  const model = createNumberRoverModel(5);
  move(model, KEY.RIGHT);
  move(model, KEY.RIGHT);
  const mid = model.getState();
  model.retry();
  const again = model.getState();
  assert.equal(again.player.x, 1);
  assert.equal(again.player.y, 1);
  assert.equal(again.score, mid.score);
  assert.equal(again.currentSum, 0);
});

test('pick rejects sums above the goal and choices that make it unsolvable', () => {
  const model = createNumberRoverModel(7);
  // The tempting 1 cannot be combined with the remaining 2 and 3 to make 5.
  for (const key of [KEY.RIGHT, KEY.RIGHT, KEY.RIGHT, KEY.ENTER]) move(model, key);
  assert.equal(model.getState().currentSum, 0);
  assert.equal(model.getState().message, 'Try another number');
  for (const key of [KEY.LEFT, KEY.DOWN, KEY.DOWN, KEY.ENTER, KEY.DOWN, KEY.DOWN, KEY.RIGHT, KEY.ENTER]) move(model, key);
  assert.equal(model.getState().currentSum, 5);
  for (const key of [KEY.UP,KEY.UP,KEY.UP,KEY.UP,KEY.ENTER]) move(model,key);
  assert.equal(model.getState().currentSum, 5);
});

test('level 1 win with goal sum on the exit tile', () => {
  const model = createNumberRoverModel(7);
  const steps = [
    KEY.RIGHT, KEY.RIGHT, KEY.DOWN, KEY.DOWN, KEY.ENTER,
    KEY.DOWN, KEY.DOWN, KEY.RIGHT, KEY.ENTER,
    KEY.UP, KEY.UP, KEY.UP, KEY.UP,
    KEY.RIGHT, KEY.RIGHT, KEY.RIGHT, KEY.RIGHT
  ];
  for (let i = 0; i < steps.length; i++) move(model, steps[i]);
  const st = model.getState();
  assert.equal(st.level, 2);
  assert.equal(st.currentSum, 0);
  assert.equal(st.phase, 'playing');
  assert.ok(st.score > 0);
});

test('dispatch close is signaled for back keys', () => {
  const model = createNumberRoverModel(1);
  assert.equal(model.dispatchKey(KEY.BACK).type, 'close');
});
