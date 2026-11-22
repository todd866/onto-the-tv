import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function back() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('./watch-back.js', import.meta.url), 'utf8'), { window });
  return window.ontoWatchBack.create();
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function show(src, showName, position, at) {
  return { src, title: showName, show: showName, art: '/art?src=' + src, positionSeconds: position, duration: 600, channel: { id: 'christmas', number: 5, name: 'Christmas' }, mode: 'channel', leftAt: at };
}

test('back within 60s restores the previous show, then the one before it', () => {
  const history = back();
  history.leave('kid1', show('timmy.mp4', 'Timmy Time', 84, 0), 1000);
  assert.equal(history.chip('kid1', 1000).show, 'Timmy Time');
  history.leave('kid1', show('music.mp4', 'Common', 12, 0), 2000);
  assert.equal(history.chip('kid1', 5000).show, 'Common');
  const music = history.undo('kid1', 5000);
  assert.equal(music.src, 'music.mp4');
  assert.equal(music.positionSeconds, 12);
  assert.equal(history.chip('kid1', 5000).show, 'Timmy Time');
  const timmy = history.undo('kid1', 5000);
  assert.equal(timmy.src, 'timmy.mp4');
  assert.equal(timmy.positionSeconds, 84);
  assert.equal(history.chip('kid1', 3000), null);
  assert.equal(history.undo('kid1', 3000), null);
});

test('the back chip expires 60s after the change and the stack keeps the last 5', () => {
  const history = back();
  history.leave('kid1', show('timmy.mp4', 'Timmy Time', 10, 0), 0);
  assert.equal(history.chip('kid1', 60000), null);
  assert.equal(history.undo('kid1', 60000), null);
  for (let i = 1; i <= 6; i++) history.leave('kid1', show('s' + i + '.mp4', 'Show ' + i, i, 0), i * 1000);
  const restored = [];
  for (let n = 0; n < 6; n++) {
    const entry = history.undo('kid1', 7000);
    if (entry) restored.push(entry.src);
  }
  assert.deepEqual(restored, ['s6.mp4', 's5.mp4', 's4.mp4', 's3.mp4', 's2.mp4']);
});

test('continue is the last 6 shows for that profile, newest first, with the saved position', () => {
  const history = back();
  history.note('kid1', show('old.mp4', 'Old', 1, 0));
  for (let i = 1; i <= 6; i++) history.note('kid1', show('s' + i + '.mp4', 'Show ' + i, i * 10, 0));
  history.note('ian', show('dad.mp4', 'Dad Show', 50, 0));
  history.note('kid1', show('s3.mp4', 'Show 3', 99, 0));
  const youngest = history.continueList('kid1');
  assert.equal(youngest.length, 6);
  assert.equal(youngest[0].src, 's3.mp4');
  assert.equal(youngest[0].positionSeconds, 99);
  assert.deepEqual(plain(youngest.map(item => item.src)), ['s3.mp4', 's6.mp4', 's5.mp4', 's4.mp4', 's2.mp4', 's1.mp4']);
  assert.deepEqual(plain(history.continueList('ian').map(item => item.src)), ['dad.mp4']);
  const again = back();
  again.load(history.save());
  assert.equal(again.continueList('kid1')[0].positionSeconds, 99);
});
