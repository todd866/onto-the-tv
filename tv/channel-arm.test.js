import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function arm() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('./channel-arm.js', import.meta.url), 'utf8'), { window });
  return window.ontoChannelArm.create();
}

const movies = { id: 'movies', number: 2, name: 'Music' };
const christmas = { id: 'christmas', number: 5, name: 'Christmas' };

test('a channel press previews and commits 1.5s later, or on OK', () => {
  const pending = arm();
  const preview = pending.press(movies, 1000);
  assert.equal(preview.type, 'preview');
  assert.equal(preview.target.id, 'movies');
  assert.equal(preview.commitAt, 2500);
  assert.equal(pending.tick(2499).type, 'wait');
  assert.equal(pending.tick(2500).type, 'commit');
  assert.equal(pending.tick(2500).type, 'none');

  const quick = arm();
  quick.press(movies, 0);
  assert.equal(quick.ok().type, 'commit');
  assert.equal(quick.ok().type, 'none');
});

test('the same press again cancels, and a different target replaces the preview', () => {
  const pending = arm();
  pending.press(movies, 0);
  assert.equal(pending.press(movies, 400).type, 'cancel');
  assert.equal(pending.tick(2000).type, 'none');
  assert.equal(pending.ok().type, 'none');

  pending.press(movies, 0);
  const replaced = pending.press(christmas, 400);
  assert.equal(replaced.type, 'preview');
  assert.equal(replaced.target.id, 'christmas');
  assert.equal(replaced.commitAt, 1900);
  assert.equal(pending.tick(1600).type, 'wait');
  const committed = pending.tick(1900);
  assert.equal(committed.type, 'commit');
  assert.equal(committed.target.id, 'christmas');
});
