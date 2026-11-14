import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteLog } from './tv-remote-log.js';

test('remote presses are stored one per line, without content names', async () => {
  const written = [];
  const log = createRemoteLog({ file: '/x/remote-events.jsonl', now: () => 2000, append: async (file, text) => { written.push([file, text]); } });
  const result = await log.record({ session: 'tv-1', build: 'b1', events: [
    { t: 1000, p: 'player', k: 39, a: 'next', f: '', ms: 22 },
    { t: 1500, p: 'player', k: 13, a: 'open', f: '', ms: null, r: true },
  ] });
  assert.deepEqual(result, { ok: true, stored: 2 });
  const rows = written[0][1].trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].action, 'next'); assert.equal(rows[0].ms, 22); assert.equal(rows[0].key, 39);
  assert.equal(rows[1].repeat, true); assert.equal(rows[1].ms, null);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['action', 'at', 'build', 'focus', 'key', 'ms', 'page', 'receivedAt', 'repeat', 'session']);
});

test('malformed remote logs are refused', async () => {
  const log = createRemoteLog({ file: '/x', append: async () => { throw new Error('must not write'); } });
  const bad = [null, {}, { session: 'a b', events: [] }, { session: 's', events: [{ t: 1, p: 'player', k: 1, a: 'rm -rf', f: '' }] },
    { session: 's', events: [{ t: 1, p: 'elsewhere', k: 1, a: 'next', f: '' }] }, { session: 's', events: new Array(101).fill({ t: 1, p: 'home', k: 1, a: 'none', f: '' }) },
    { session: 's', events: [{ t: 1, p: 'home', k: 1, a: 'none', f: '', ms: -4 }] }];
  for (const body of bad) await assert.rejects(log.record(body), /Invalid/);
});
