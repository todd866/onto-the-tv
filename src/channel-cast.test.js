import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { playOnTv, queueOnTv, tvNotice, srcForPath, recordLocalHistory } from './channel-cast.js';

const catalogue = Object.assign(Object.create(null), {
  'Family/one.mp4': '/videos/shows/one.mp4',
  'Music/two.mp4': '/videos/music/two.mp4',
});

describe('srcForPath', () => {
  it('maps a library file back to the episode the player named', () => {
    assert.equal(srcForPath(catalogue, '/videos/shows/one.mp4'), 'Family/one.mp4');
    assert.equal(srcForPath(catalogue, '/missing.mp4'), '');
    assert.equal(srcForPath(catalogue, ''), '');
  });
});

describe('playOnTv', () => {
  it('sends only the named episode, from where the laptop had reached', async () => {
    const calls = [];
    const session = { playOnly: async (items) => { calls.push(items); return { status: 'playing' }; } };
    await playOnTv(session, catalogue, 'Family/one.mp4', 42);
    assert.deepEqual(calls, [[{ path: '/videos/shows/one.mp4', startSeconds: 42 }]]);
  });

  it('refuses a src that is not in this library', () => {
    const session = { playOnly: async () => assert.fail('must not send a foreign file') };
    assert.throws(() => playOnTv(session, catalogue, '/etc/passwd', 0), /not in this library/i);
    assert.throws(() => playOnTv(session, null, 'Family/one.mp4', 0), /not in this library/i);
  });
});

describe('queueOnTv', () => {
  it('returns true only when the session accepted the matching lookahead', async () => {
    const calls = [];
    const session = {
      queueNext: async (...args) => {
        calls.push(args);
        return { current: { path: '/videos/shows/one.mp4' }, upcoming: [{ path: '/videos/music/two.mp4' }] };
      },
    };
    assert.equal(await queueOnTv(session, catalogue, 'Music/two.mp4', 'Family/one.mp4'), true);
    assert.deepEqual(calls, [[{ path: '/videos/music/two.mp4', startSeconds: 0 }, '/videos/shows/one.mp4']]);
  });

  it('returns false when the session rejects a stale or missing queue', async () => {
    const session = { queueNext: async () => ({ current: null, upcoming: [] }) };
    assert.equal(await queueOnTv(session, catalogue, 'Music/two.mp4', 'Family/one.mp4'), false);
  });
});

describe('tvNotice', () => {
  it('tells the player the catalogue src, not the Mac path', () => {
    const notice = tvNotice(catalogue, {
      status: 'playing',
      current: { path: '/videos/shows/one.mp4', positionSeconds: 12, durationSeconds: 400 },
    });
    assert.deepEqual(notice, {
      type: 'onto:tv',
      tv: { path: 'Family/one.mp4', positionSeconds: 12, durationSeconds: 400, status: 'playing' },
    });
  });

  it('forwards a native transition using catalogue source names', () => {
    const notice = tvNotice(catalogue, {
      status: 'playing',
      current: { path: '/videos/music/two.mp4', positionSeconds: 0, durationSeconds: 400 },
      transition: {
        fromPath: '/videos/shows/one.mp4', toPath: '/videos/music/two.mp4',
        positionSeconds: 390, durationSeconds: 400, completed: true,
      },
    });
    assert.deepEqual(notice.tv.transition, {
      fromPath: 'Family/one.mp4', toPath: 'Music/two.mp4',
      positionSeconds: 390, durationSeconds: 400, completed: true,
    });
  });

  it('asks the channel for the next episode when the file finished', () => {
    const notice = tvNotice(catalogue, { status: 'finished', current: null, error: null });
    assert.equal(notice.type, 'onto:tv');
    assert.equal(notice.tv.status, 'finished');
  });

  it('returns the channel to the laptop when the remote stops or the TV errors', () => {
    const stopped = tvNotice(catalogue, { status: 'idle', current: null, error: null });
    assert.equal(stopped.type, 'onto:cast-off');
    const failed = tvNotice(catalogue, { status: 'idle', current: null, error: 'Choose a TV in Settings before sending a video.' });
    assert.match(failed.reason, /TV/);
  });

  it('does not treat preparing the next file as the TV going idle', () => {
    assert.equal(tvNotice(catalogue, { status: 'preparing', current: null }), null);
  });
});


it('keeps optimistic cast progress away from confirmed file history', async () => {
  const calls = [];
  const history = { set: (...args) => calls.push(args), flush: async () => calls.push('flush') };
  const input = { src:'Family/one.mp4', positionSeconds:300, durationSeconds:600, completed:false };
  assert.equal(await recordLocalHistory(history, catalogue, input, { casting:true }), false);
  assert.deepEqual(calls, []);
  assert.equal(await recordLocalHistory(history, catalogue, input), true);
  assert.deepEqual(calls, [['/videos/shows/one.mp4', { positionSeconds:300, durationSeconds:600, completed:false, reset:false }], 'flush']);
});

it('records explicit local seeks to zero and rejects invalid or foreign history', async () => {
  const calls = [];
  const history = { set: (...args) => calls.push(args), flush: async () => {} };
  const input = { src:'Family/one.mp4', positionSeconds:0, durationSeconds:600, completed:false, reset:true };
  await recordLocalHistory(history, catalogue, input);
  assert.equal(calls[0][1].reset, true);
  for (const positionSeconds of [NaN, Infinity, -1]) {
    assert.equal(await recordLocalHistory(history, catalogue, { ...input, positionSeconds }), false);
  }
  await assert.rejects(recordLocalHistory(history, catalogue, { ...input, src:'/foreign.mp4' }), /not in this library/i);
  assert.equal(calls.length, 1);
});
