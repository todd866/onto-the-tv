import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function remote() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('./remote-map.js', import.meta.url), 'utf8'), { window });
  return window.ontoRemoteMap;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

const open = focus => ({ overlay: 'open', focus, repeat: false });

const watching = { overlay: 'hidden', focus: '', repeat: false };

test('watching: up/down change channel, left/right are previous/next, and none of them seek', () => {
  const map = remote();
  for (const state of [watching, open('')]) {
    assert.deepEqual(plain(map.decide(state, map.KEY.UP)), { type: 'tune', direction: 1 });
    assert.deepEqual(plain(map.decide(state, map.KEY.DOWN)), { type: 'tune', direction: -1 });
    assert.deepEqual(plain(map.decide(state, map.KEY.RIGHT)), { type: 'next' });
    assert.deepEqual(plain(map.decide(state, map.KEY.LEFT)), { type: 'previous' });
    assert.deepEqual(plain(map.decide(state, map.KEY.CH_UP)), { type: 'tune', direction: 1 });
    assert.deepEqual(plain(map.decide(state, map.KEY.CH_DOWN)), { type: 'tune', direction: -1 });
    // A held key never machine-guns through channels or shows.
    for (const key of [map.KEY.UP, map.KEY.DOWN, map.KEY.LEFT, map.KEY.RIGHT, map.KEY.CH_UP])
      assert.equal(map.decide({ ...state, repeat: true }, key).type, 'none');
  }
});

test('ok opens the controls; inside them the arrows navigate', () => {
  const map = remote();
  assert.deepEqual(plain(map.decide(watching, map.KEY.ENTER)), { type: 'open' });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.PLAYPAUSE)), { type: 'open' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.LEFT)), { type: 'move', row: 'transport', delta: -1 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.RIGHT)), { type: 'move', row: 'transport', delta: 1 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.ENTER)), { type: 'activate' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.UP)), { type: 'focus', row: 'scrub' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.DOWN)), { type: 'close' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.BACK)), { type: 'close' });
  assert.equal(map.decide({ ...open('transport'), repeat: true }, map.KEY.RIGHT).type, 'none');
  // Inside the controls up/down never change channel.
  for (const focus of ['transport', 'scrub', 'continue']) {
    assert.notEqual(map.decide(open(focus), map.KEY.UP).type, 'tune');
    assert.notEqual(map.decide(open(focus), map.KEY.DOWN).type, 'tune');
  }
});

test('seeking lives on the progress line only', () => {
  const map = remote();
  assert.deepEqual(plain(map.decide(open('scrub'), map.KEY.RIGHT)), { type: 'seek', seconds: 10 });
  assert.deepEqual(plain(map.decide(open('scrub'), map.KEY.LEFT)), { type: 'seek', seconds: -10 });
  assert.deepEqual(plain(map.decide({ ...open('scrub'), repeat: true }, map.KEY.RIGHT)), { type: 'seek', seconds: 30 });
  assert.deepEqual(plain(map.decide(open('scrub'), map.KEY.DOWN)), { type: 'focus', row: 'transport' });
  assert.deepEqual(plain(map.decide(open('scrub'), map.KEY.UP)), { type: 'focus', row: 'continue' });
  assert.deepEqual(plain(map.decide(open('scrub'), map.KEY.ENTER)), { type: 'open' });
  assert.deepEqual(plain(map.decide(open('scrub'), map.KEY.BACK)), { type: 'close' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.DOWN)), { type: 'focus', row: 'scrub' });
  assert.equal(map.decide(open('continue'), map.KEY.UP).type, 'none');
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.RIGHT)), { type: 'move', row: 'continue', delta: 1 });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.SPACE)), { type: 'activate' });
});

test('media keys, back and digits', () => {
  const map = remote();
  assert.deepEqual(plain(map.decide(watching, map.KEY.PLAY)), { type: 'play' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.PAUSE)), { type: 'pause' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.STOP)), { type: 'stop' });
  assert.deepEqual(plain(map.decide(watching, map.KEY.FF)), { type: 'seek', seconds: 30 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.RW)), { type: 'seek', seconds: -30 });
  assert.deepEqual(plain(map.decide(watching, map.KEY.NEXT)), { type: 'next' });
  assert.deepEqual(plain(map.decide(watching, map.KEY.PREV)), { type: 'previous' });
  assert.deepEqual(plain(map.decide(watching, map.KEY.INFO)), { type: 'focus', row: 'transport', fresh: true });
  // With nothing focused Back leaves at once, even while the bar is still fading after a skip.
  assert.deepEqual(plain(map.decide(watching, map.KEY.BACKSPACE)), { type: 'back' });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.ESC)), { type: 'back' });
  assert.deepEqual(plain(map.decide(watching, 49)), { type: 'digit', digit: 1 });
  assert.deepEqual(plain(map.decide(open('transport'), 48)), { type: 'digit', digit: 0 });
  assert.equal(map.decide(watching, 999).type, 'none');
});
