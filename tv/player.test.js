import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function extras() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('./player.js', import.meta.url), 'utf8'), { window });
  return window.ontoPlayerExtras;
}

test('a serial episode formats as Next · S1E9 · title', () => {
  const api = extras();
  assert.equal(api.upNextLabel({ title: 'MobLand S01E09 The Sign', show: 'MobLand' }), 'Next · S1E9 · The Sign');
  assert.equal(api.upNextLabel({ title: 'S3 E1 · Cactus Hour', show: 'Bluey' }), 'Next · S3E1 · Cactus Hour');
  assert.equal(api.upNextLabel({ title: 'Series 2 Episode 4 Dinner', show: 'Come Dine With Me' }), 'Next · S2E4 · Dinner');
  assert.equal(api.upNextLabel({ title: 'MobLand S01E09', show: 'MobLand' }), 'Next · S1E9');
});

test('films and one-offs do not get a countdown label', () => {
  const api = extras();
  const film = { src: 'Films/Weapons (2025).mp4', title: 'Weapons (2025)', show: 'Films' };
  const episode = { src: 'MobLand/MobLand S01E08.mp4', title: 'MobLand S01E08', show: 'MobLand' };
  const nextEp = { src: 'MobLand/MobLand S01E09.mp4', title: 'MobLand S01E09 The Sign', show: 'MobLand' };
  const other = { src: 'Other/Pilot.mp4', title: 'Pilot', show: 'Other' };
  assert.equal(api.upNextLabel(film), '');
  assert.equal(api.offerUpNext(film, nextEp), '');
  assert.equal(api.offerUpNext(episode, film), '');
  assert.equal(api.offerUpNext(episode, other), '');
  assert.equal(api.offerUpNext(episode, episode), '');
  assert.equal(api.offerUpNext(episode, nextEp), 'Next · S1E9 · The Sign');
});

test('up next is due in the last 10 seconds or in the credits, and counts 10 seconds to play', () => {
  const api = extras();
  assert.equal(api.upNextDue(100, 1000, []), false);
  assert.equal(api.upNextDue(990, 1000, []), true);
  assert.equal(api.upNextDue(100, 1000, [{ start: 80, end: 200, kind: 'credits' }]), true);
  assert.equal(api.upNextDue(50, 1000, [{ start: 0, end: 30, kind: 'intro' }]), false);
  const card = api.upNext();
  assert.equal(card.read(), 0);
  card.arm();
  assert.equal(card.read(), 10);
  assert.equal(card.active(), true);
  for (let i = 0; i < 9; i++) assert.equal(card.tick(), 'show');
  assert.equal(card.read(), 1);
  assert.equal(card.tick(), 'play');
  assert.equal(card.read(), 0);
  assert.equal(card.active(), false);
});

test('OK plays the next episode now and Back cancels the countdown', () => {
  const api = extras();
  const card = api.upNext();
  assert.equal(card.ok(), '');
  card.arm();
  assert.equal(card.ok(), 'play');
  assert.equal(card.active(), false);
  card.arm();
  assert.equal(card.read(), 10);
  assert.equal(card.back(), 'cancel');
  assert.equal(card.active(), false);
  assert.equal(card.arm(), false, 'cancel holds for this episode');
  card.reset();
  assert.equal(card.arm(), true);
});

test('left and right seek 10 seconds, and a hold seeks 30', () => {
  const api = extras();
  const seek = api.seek();
  assert.equal(seek.tap(100, 1000, 1), 110);
  assert.equal(seek.tap(100, 1000, 1), 120);
  assert.equal(seek.tap(100, 1000, -1), 110);
  assert.equal(seek.hold(110, 1000, 1), 140);
  assert.equal(seek.tap(0, 1000, -1), 0);
  assert.equal(seek.hold(990, 1000, 1), 999);
  seek.clear();
  assert.equal(seek.tap(40, 1000, -1), 30);
});

test('a saved position offers Resume and Start over, with Resume first', () => {
  const api = extras();
  assert.equal(api.resumeOffer(0), false);
  assert.equal(api.resumeOffer(5), false);
  assert.equal(api.resumeOffer(6), true);
  assert.equal(api.resumeOffer(200), true);
  assert.equal(api.resumeLabel(200), 'Resume 3:20');
  assert.deepEqual(api.resumeMove(0, 1), 1);
  assert.deepEqual(api.resumeMove(1, 1), 0);
  assert.deepEqual(api.resumeMove(0, -1), 1);
  assert.equal(api.resumeAction(0), 'resume');
  assert.equal(api.resumeAction(1), 'start');
});

test('scene data shows one skip chip for the intro or the credits', () => {
  const api = extras();
  const segments = [
    { start: 0, end: 40, kind: 'intro' },
    { start: 50, end: 70, kind: 'ad' },
    { start: 800, end: 900, kind: 'credits' },
  ];
  const intro = api.skipChip(10, segments);
  assert.equal(intro.label, 'Skip intro');
  assert.equal(intro.end, 40);
  assert.equal(api.skipChip(55, segments), null);
  const credits = api.skipChip(810, segments);
  assert.equal(credits.label, 'Skip credits');
  assert.equal(credits.end, 900);
  assert.equal(api.skipChip(10, []), null);
});

test('a failed stream keeps a Retry line and moves on after 5 seconds', () => {
  const api = extras();
  const line = api.errorLine();
  assert.equal(line.read(), 5);
  assert.equal(line.text(), 'next in 5s');
  assert.equal(line.tick(true), 'wait');
  assert.equal(line.text(), 'next in 4s');
  assert.equal(line.retry(), 'retry');
  line.arm();
  assert.equal(line.read(), 5);
  for (let i = 0; i < 4; i++) assert.equal(line.tick(true), 'wait');
  assert.equal(line.tick(true), 'next');
  assert.equal(line.text(), 'next in 0s');
  line.arm();
  for (let i = 0; i < 5; i++) line.tick(false);
  assert.equal(line.tick(false), 'stay');
});
