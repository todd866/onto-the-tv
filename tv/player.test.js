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

test('netflix tap steps 10/30/60/300 from an anchor, and a hold seeks 30', () => {
  const api = extras();
  assert.deepEqual([0, 1, 2, 3].map(api.seekTapStepSize), [10, 30, 60, 300]);
  const seek = api.seek();
  assert.equal(seek.tap(100, 1000, 1), 110);
  assert.equal(seek.tap(100, 1000, 1), 140);
  assert.equal(seek.tap(100, 1000, 1), 200);
  assert.equal(seek.tap(100, 1000, -1), 190);
  assert.equal(seek.hold(110, 1000, 1), 120);
  assert.equal(seek.hold(110, 1000, 1, 4), 140);
  seek.clear();
  assert.equal(seek.tap(0, 1000, -1), 0);
  assert.equal(seek.hold(990, 1000, 1), 995);
  seek.clear();
  assert.equal(seek.tap(40, 1000, -1), 30);
  seek.clear();
  assert.equal(seek.tap(100, 1000, 1, 1000), 110);
  assert.equal(seek.tap(100, 1000, 1, 1200), 140);
  assert.equal(seek.tap(100, 1000, 1, 3000), 110, 'a 1.5 s pause restarts the burst');
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

test('AVPlay seeks never block a key: async, one in flight, quick taps collapse to the latest target', () => {
  const calls = [];
  const avplay = {
    seekTo(ms, ok, fail) { calls.push({ ms, ok, fail }); },
    open() {}, close() {}, stop() {}, setDisplayRect() {}, setListener() {}, prepareAsync() {}, play() {}, pause() {},
  };
  const window = { webapis: { avplay } };
  vm.runInNewContext(readFileSync(new URL('./player.js', import.meta.url), 'utf8'), { window, webapis: window.webapis, setTimeout, clearTimeout, Date });
  const media = window.ontoPlayer({ hidden: false, addEventListener() {} }, { hidden: true });
  assert.equal(media.engine, 'avplay');
  media.seek(10);
  assert.equal(calls.length, 1, 'the first tap seeks at once');
  assert.equal(typeof calls[0].ok, 'function', 'with callbacks, so the TV seeks asynchronously');
  assert.equal(media.time(), 10, 'the bar shows the target straight away');
  media.seek(40);
  media.seek(100);
  assert.equal(calls.length, 1, 'taps during a seek wait');
  assert.equal(media.time(), 100);
  calls[0].ok();
  assert.equal(calls.length, 2, 'then only the latest target is sent');
  assert.equal(calls[1].ms, 100000);
  calls[1].fail();
  media.seek(5);
  assert.equal(calls.length, 3, 'a failed seek does not wedge the next one');
});

test('AVPlay caches getTotalTrackInfo per prepared stream and clears on reload/stop', () => {
  let trackCalls = 0;
  let prepOk = null;
  let isPrepared = false;
  const avplay = {
    getTotalTrackInfo() {
      trackCalls += 1;
      return isPrepared ? [{ index: 1, type: 'AUDIO', extra_info: '{"language":"eng"}' }] : [];
    },
    getDuration() { return 60000; },
    seekTo(ms, ok) { if (ok) ok(); },
    open() {}, close() {}, stop() {}, setDisplayRect() {}, setListener() {},
    prepareAsync(ok) { prepOk = ok; },
    play() {}, pause() {},
  };
  const window = { webapis: { avplay } };
  vm.runInNewContext(readFileSync(new URL('./player.js', import.meta.url), 'utf8'), { window, webapis: window.webapis, setTimeout, clearTimeout, Date });
  const media = window.ontoPlayer({ hidden: false, addEventListener() {} }, { hidden: true });
  try {
    media.load('http://tv.test/a.mp4', 0);
    assert.equal(media.tracks().audio.length, 0, 'before prepare completes an empty list is not cached');
    isPrepared = true;
    prepOk();
    assert.equal(media.tracks().audio.length, 1);
    const afterFirst = trackCalls;
    media.tracks();
    media.tracks();
    assert.equal(trackCalls, afterFirst, 'repeated OSD updates do not re-cross Tizen getTotalTrackInfo IPC');
    media.stop();
    isPrepared = false;
    media.tracks();
    assert.equal(trackCalls, afterFirst + 1, 'stop invalidates cached tracks');
  } finally {
    media.stop();
  }
});

test('AVPlay enables 4K UHD on UHD panels, preserves aspect ratio, and suspends/restores decoder', () => {
  const events = [];
  const avplay = {
    open(u) { events.push(['open', u]); },
    close() {}, stop() {},
    setStreamingProperty(k, v) { events.push(['prop', k, v]); },
    setDisplayRect() {},
    setDisplayMethod(m) {
      if (m === 'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO') throw new Error('unsupported enum');
      events.push(['aspect', m]);
    },
    setTimeoutForBuffering(s) { events.push(['buf', s]); },
    setListener() {},
    prepareAsync() {},
    play() {}, pause() {},
    suspend() { events.push(['suspend']); },
    restore(u, ms, auto) { events.push(['restore', u, ms, auto]); },
  };
  const window = { webapis: { avplay, productinfo: { isUdPanelSupported: () => true } } };
  vm.runInNewContext(readFileSync(new URL('./player.js', import.meta.url), 'utf8'), { window, webapis: window.webapis, setTimeout, clearTimeout, Date });
  const media = window.ontoPlayer({ hidden: false, addEventListener() {} }, { hidden: true });
  try {
    media.load('http://tv.test/uhd.mkv', 42);
    assert.deepEqual(events.slice(0, 4), [
      ['open', 'http://tv.test/uhd.mkv'],
      ['prop', 'SET_MODE_4K', 'TRUE'],
      ['aspect', 'PLAYER_DISPLAY_MODE_LETTER_BOX'],
      ['buf', 4],
    ]);
    media.suspend();
    assert.equal(media.paused(), true);
    media.restore('http://tv.test/uhd.mkv', 42, false);
    assert.deepEqual(events.slice(4), [
      ['suspend'],
      ['restore', 'http://tv.test/uhd.mkv', 42000, false],
    ]);
  } finally {
    media.stop();
  }
});

test('AVPlay emits embedded subtitle cues via onsubtitlechange and parseVtt/activeCue render WebVTT sidecars', () => {
  let listener = null;
  const avplay = {
    open() {}, close() {}, stop() {}, setDisplayRect() {},
    setListener(l) { listener = l; },
    prepareAsync() {}, play() {}, pause() {},
    setSilentSubtitle() {}, setSelectTrack() {},
  };
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const window = { webapis: { avplay } };
  vm.runInNewContext(readFileSync(new URL('./player.js', import.meta.url), 'utf8'), {
    window, webapis: window.webapis, setTimeout: fakeSetTimeout, clearTimeout() {}, Date,
  });
  const media = window.ontoPlayer({ hidden: false, addEventListener() {} }, { hidden: true });
  const seen = [];
  media.on('subtitle', () => seen.push(media.subtitle()));
  media.load('http://tv.test/ep.mkv', 0);
  listener.onsubtitlechange(2500, '<i>Hello</i><br>there');
  assert.equal(media.subtitle(), 'Hello\nthere');
  assert.equal(seen.at(-1), 'Hello\nthere');
  timers.at(-1).fn();
  assert.equal(media.subtitle(), '', 'cue clears after duration');

  const api = extras();
  const cues = api.parseVtt('WEBVTT\n\n1\n00:00:05.000 --> 00:00:08.500 align:middle\n<v Speaker>First &amp; line\n\n01:02:03.250 --> 01:02:06.000\nLater cue\n');
  assert.equal(cues.length, 2);
  assert.equal(api.activeCue(cues, 4.9), '');
  assert.equal(api.activeCue(cues, 6.2), 'First & line');
  assert.equal(api.activeCue(cues, 8.5), '');
  assert.equal(api.activeCue(cues, 3724.0), 'Later cue');
});
