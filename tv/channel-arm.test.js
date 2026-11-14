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

test('a channel press previews and commits a moment later, or on OK', () => {
  const pending = arm();
  const D = pending.delay;
  const preview = pending.press(movies, 1000);
  assert.equal(preview.type, 'preview');
  assert.equal(preview.target.id, 'movies');
  assert.ok(D <= 500, 'a channel change must not feel slow');
  assert.equal(preview.commitAt, 1000 + D);
  assert.equal(pending.tick(999 + D).type, 'wait');
  assert.equal(pending.tick(1000 + D).type, 'commit');
  assert.equal(pending.tick(1000 + D).type, 'none');
  assert.equal(pending.target(), null);

  const quick = arm();
  quick.press(movies, 0);
  assert.equal(quick.ok().type, 'commit');
  assert.equal(quick.ok().type, 'none');
});

test('the same press again cancels, and a different target replaces the preview', () => {
  const pending = arm();
  const D = pending.delay;
  pending.press(movies, 0);
  assert.equal(pending.target().id, 'movies');
  assert.equal(pending.press(movies, 100).type, 'cancel');
  assert.equal(pending.tick(2000).type, 'none');
  assert.equal(pending.ok().type, 'none');

  pending.press(movies, 0);
  const replaced = pending.press(christmas, 100);
  assert.equal(replaced.type, 'preview');
  assert.equal(replaced.target.id, 'christmas');
  assert.equal(replaced.commitAt, 100 + D);
  assert.equal(pending.tick(99 + D).type, 'wait');
  const committed = pending.tick(100 + D);
  assert.equal(committed.type, 'commit');
  assert.equal(committed.target.id, 'christmas');
});
