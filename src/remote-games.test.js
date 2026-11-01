import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../tv/remote-games.js', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports });
const gamesFactory = module.exports({}, {});

test('number grid stays bounded and scores only matching targets', () => {
  const game = gamesFactory.createNumberModel(2);
  assert.equal(game.snapshot().values.length, 9);
  assert.equal(game.choose(0).correct, false);
  const targetIndex = game.snapshot().values.indexOf(game.snapshot().target);
  assert.equal(game.choose(targetIndex).correct, true);
  assert.equal(game.score[0], 1); assert.equal(game.score[1], 0);
  assert.equal(game.choose(targetIndex).ok, false, 'used cells cannot score twice');
  assert.equal(game.choose(-1).ok, false);
  assert.equal(game.choose(9).ok, false);
});

test('memory match has six pairs, bounded selection and cooperative turn score', () => {
  const game = gamesFactory.createMemoryModel(2);
  assert.equal(game.snapshot().cards.length, 12);
  assert.equal(game.choose(0).waiting, true);
  const first = game.snapshot().cards[0];
  const mate = game.snapshot().cards.indexOf(first, 1);
  assert.equal(game.choose(mate).pair, true);
  assert.equal(game.score[0], 1); assert.equal(game.score[1], 0);
  assert.equal(game.choose(0).ok, false, 'matched cards cannot be selected again');
  assert.equal(game.choose(99).ok, false);
});

test('browser bundle exposes an instantiated controller API', () => {
  const win = { document: {} };
  vm.runInNewContext(source, { window: win, document: win.document });
  assert.equal(typeof win.ontoGames.open, 'function');
  assert.equal(typeof win.ontoGames.handleKey, 'function');
  assert.equal(win.ontoGames.handleKey(13), false, 'hidden controller does not consume keys');
});


test('number targets remain solvable across rounds and wrong answers preserve the turn', () => {
  const game = gamesFactory.createNumberModel(2);
  for (let n = 0; n < 100; n++) {
    const snap = game.snapshot();
    const index = snap.values.findIndex((v,i) => v === snap.target && !snap.used[i]);
    assert.ok(index >= 0);
    const wrong = snap.values.findIndex((v,i) => v !== snap.target && !snap.used[i]);
    if (wrong >= 0) { game.choose(wrong); assert.equal(game.turn, snap.turn); assert.equal(game.target, snap.target); }
    assert.equal(game.choose(index).correct, true);
  }
  assert.equal(game.score[0] + game.score[1], 100);
});
