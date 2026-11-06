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

test('up and down never tune, on the overlay or off it; channel keys do', () => {
  const map = remote();
  const states = [
    { overlay: 'hidden', focus: '', repeat: false },
    open(''),
    open('transport'),
    open('continue'),
  ];
  for (const state of states) {
    assert.notEqual(map.decide(state, map.KEY.UP).type, 'tune', 'up ' + state.focus);
    assert.notEqual(map.decide(state, map.KEY.DOWN).type, 'tune', 'down ' + state.focus);
    assert.notEqual(map.decide(state, map.KEY.INFO).type, 'tune');
    assert.deepEqual(plain(map.decide(state, map.KEY.CH_UP)), { type: 'tune', direction: 1 });
    assert.deepEqual(plain(map.decide(state, map.KEY.CH_DOWN)), { type: 'tune', direction: -1 });
    assert.equal(map.decide({ ...state, repeat: true }, map.KEY.CH_UP).type, 'none');
  }
});

test('up shows the overlay then focuses transport; down shows continue', () => {
  const map = remote();
  const hidden = { overlay: 'hidden', focus: '', repeat: false };
  assert.deepEqual(plain(map.decide(hidden, map.KEY.UP)), { type: 'show' });
  assert.deepEqual(plain(map.decide(hidden, map.KEY.DOWN)), { type: 'show' });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.UP)), { type: 'focus', row: 'transport' });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.DOWN)), { type: 'focus', row: 'continue' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.UP)), { type: 'focus', row: 'transport' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.DOWN)), { type: 'focus', row: 'continue' });
  assert.equal(map.decide({ ...hidden, repeat: true }, map.KEY.UP).type, 'none');
});

test('left and right seek 10 seconds, a hold seeks faster, and focus moves only on the overlay', () => {
  const map = remote();
  const hidden = { overlay: 'hidden', focus: '', repeat: false };
  assert.deepEqual(plain(map.decide(hidden, map.KEY.LEFT)), { type: 'seek', seconds: -10 });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.RIGHT)), { type: 'seek', seconds: 10 });
  assert.deepEqual(plain(map.decide({ ...open(''), repeat: true }, map.KEY.RIGHT)), { type: 'seek', seconds: 30 });
  assert.deepEqual(plain(map.decide({ ...hidden, repeat: true }, map.KEY.LEFT)), { type: 'seek', seconds: -30 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.LEFT)), { type: 'move', row: 'transport', delta: -1 });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.RIGHT)), { type: 'move', row: 'continue', delta: 1 });
  assert.equal(map.decide({ ...open('transport'), repeat: true }, map.KEY.RIGHT).type, 'none');
});

test('ok plays or activates, media keys seek or stop, back closes the overlay before undo, digits stay numbers', () => {
  const map = remote();
  const hidden = { overlay: 'hidden', focus: '', repeat: false };
  assert.deepEqual(plain(map.decide(hidden, map.KEY.ENTER)), { type: 'play-pause' });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.PLAYPAUSE)), { type: 'play-pause' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.ENTER)), { type: 'activate' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.SPACE)), { type: 'activate' });
  assert.deepEqual(plain(map.decide(hidden, map.KEY.PLAY)), { type: 'play' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.PAUSE)), { type: 'pause' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.STOP)), { type: 'stop' });
  assert.deepEqual(plain(map.decide(hidden, map.KEY.FF)), { type: 'seek', seconds: 30 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.RW)), { type: 'seek', seconds: -30 });
  assert.deepEqual(plain(map.decide(hidden, map.KEY.NEXT)), { type: 'next' });
  assert.deepEqual(plain(map.decide(hidden, map.KEY.PREV)), { type: 'previous' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.BACK)), { type: 'close' });
  assert.deepEqual(plain(map.decide(open(''), map.KEY.ESC)), { type: 'close' });
  assert.deepEqual(plain(map.decide(hidden, map.KEY.BACKSPACE)), { type: 'back' });
  assert.deepEqual(plain(map.decide(hidden, 49)), { type: 'digit', digit: 1 });
  assert.deepEqual(plain(map.decide(open('transport'), 48)), { type: 'digit', digit: 0 });
  assert.equal(map.decide(hidden, 999).type, 'none');
});
