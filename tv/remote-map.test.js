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

test('watching: Up shows the controls; Left/Right tap-seek; channels change on the CH keys alone', () => {
  const map = remote();
  for (const state of [watching, open('')]) {
    assert.deepEqual(plain(map.decide(state, map.KEY.UP)), { type: 'focus', row: 'transport', fresh: true });
    assert.equal(map.decide({ ...state, repeat: true }, map.KEY.UP).type, 'none');
    assert.deepEqual(plain(map.decide(state, map.KEY.RIGHT)), { type: 'tap-seek', direction: 1, held: false });
    assert.deepEqual(plain(map.decide({ ...state, repeat: true }, map.KEY.RIGHT)), { type: 'tap-seek', direction: 1, held: true });
    assert.deepEqual(plain(map.decide(state, map.KEY.LEFT)), { type: 'tap-seek', direction: -1, held: false });
    // Down opens the tray of directions: tiles to choose from, nothing changed until OK.
    assert.deepEqual(plain(map.decide(state, map.KEY.DOWN)), { type: 'directions' });
    assert.equal(map.decide({ ...state, repeat: true }, map.KEY.DOWN).type, 'none');
    assert.deepEqual(plain(map.decide(state, map.KEY.CH_UP)), { type: 'tune', direction: 1 });
    assert.deepEqual(plain(map.decide(state, map.KEY.CH_DOWN)), { type: 'tune', direction: -1 });
    assert.equal(map.decide({ ...state, repeat: true }, map.KEY.CH_UP).type, 'none');
  }
});

test('no arrow press in any focus state does anything but move focus', () => {
  const map = remote();
  const allowed = ['focus', 'move', 'close', 'none', 'directions', 'tap-seek'];
  for (const focus of ['', 'transport', 'continue', 'seek'])
    for (const repeat of [false, true])
      for (const key of [map.KEY.UP, map.KEY.DOWN, map.KEY.LEFT, map.KEY.RIGHT])
        assert.ok(allowed.includes(map.decide({ overlay: 'open', focus, repeat }, key).type), `${focus || 'watching'} ${key}`);
});

test('in the controls the arrows navigate and OK presses', () => {
  const map = remote();
  assert.deepEqual(plain(map.decide(watching, map.KEY.ENTER)), { type: 'open' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.RIGHT)), { type: 'move', row: 'transport', delta: 1 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.LEFT)), { type: 'move', row: 'transport', delta: -1 });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.ENTER)), { type: 'activate' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.UP)), { type: 'focus', row: 'continue' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.DOWN)), { type: 'close' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.DOWN)), { type: 'focus', row: 'transport' });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.RIGHT)), { type: 'move', row: 'continue', delta: 1 });
  assert.deepEqual(plain(map.decide(open('continue'), map.KEY.ENTER)), { type: 'activate' });
  assert.deepEqual(plain(map.decide(open('transport'), map.KEY.BACK)), { type: 'close' });
  assert.deepEqual(plain(map.decide(watching, map.KEY.BACK)), { type: 'back' });
});

test('seeking is on the rewind and forward keys only', () => {
  const map = remote();
  for (const focus of ['', 'transport', 'continue', 'seek']) {
    assert.deepEqual(plain(map.decide(open(focus), map.KEY.FF)), { type: 'scrub', direction: 1, held: false });
    assert.deepEqual(plain(map.decide(open(focus), map.KEY.RW)), { type: 'scrub', direction: -1, held: false });
    assert.deepEqual(plain(map.decide({ ...open(focus), repeat: true }, map.KEY.FF)), { type: 'scrub', direction: 1, held: true });
  }
  // In seek mode OK or play goes there, RETURN goes back, and the arrows do nothing.
  for (const key of [map.KEY.ENTER, map.KEY.PLAY, map.KEY.PAUSE, map.KEY.PLAYPAUSE])
    assert.deepEqual(plain(map.decide(open('seek'), key)), { type: 'scrub-commit' });
  assert.deepEqual(plain(map.decide(open('seek'), map.KEY.BACK)), { type: 'scrub-cancel' });
  for (const key of [map.KEY.UP, map.KEY.DOWN, map.KEY.LEFT, map.KEY.RIGHT])
    assert.equal(map.decide(open('seek'), key).type, 'none');
});

test('every other key does what is printed on it, once per press', () => {
  const map = remote();
  const expected = [
    [map.KEY.GREEN, { type: 'like' }], [map.KEY.RED, { type: 'previous' }], [map.KEY.BLUE, { type: 'next' }],
    [map.KEY.TOOLS, { type: 'options' }], [map.KEY.SUBT, { type: 'subs' }],
    [map.KEY.GUIDE, { type: 'home' }], [map.KEY.CH_LIST, { type: 'home' }], [map.KEY.PRE_CH, { type: 'last' }],
    [map.KEY.PLAY, { type: 'play' }], [map.KEY.PAUSE, { type: 'pause' }], [map.KEY.STOP, { type: 'stop' }],
    [53, { type: 'digit', digit: 5 }],
  ];
  for (const focus of ['', 'transport', 'continue']) {
    for (const [key, action] of expected) {
      assert.deepEqual(plain(map.decide(open(focus), key)), action, `${focus} ${key}`);
      assert.equal(map.decide({ ...open(focus), repeat: true }, key).type, 'none', `${focus} ${key} held`);
    }
  }
  assert.equal(map.decide(watching, map.KEY.YELLOW).type, 'none');
});

test('missing repeat is inferred until keyup or lifecycle reset', () => {
  const map = remote(), keys = map.pressedKeys();
  for (const code of [map.KEY.LEFT, map.KEY.RIGHT, map.KEY.FF, map.KEY.RW]) {
    assert.equal(map.decide({ repeat: keys.down(code) }, code).held, false);
    for (let i = 0; i < 5; i++)
      assert.equal(map.decide({ repeat: keys.down(code) }, code).held, true);
    keys.up(code);
    assert.equal(keys.down(code), false);
    keys.clear();
    assert.equal(keys.down(code), false);
    keys.clear();
  }
});
