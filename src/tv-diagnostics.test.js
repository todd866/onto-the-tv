import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsStore } from './tv-diagnostics.js';

const payload = (session = 's1', event = 'playing') => ({ session, event, build: 'dev-1', page: 'player', engine: 'video', position: 3, duration: 10, paused: false, hidden: false, state: 'playing' });

test('diagnostics validates bounded schema and removes server identity', () => {
  const store = createDiagnosticsStore({ now: () => 1000 });
  const result = store.record({ ...payload(), server: 'http://evil/path?secret=yes' });
  assert.equal(result.server, undefined);
  assert.throws(() => store.record({ ...payload(), session: 'not safe!' }), /session/);
  assert.throws(() => store.record({ ...payload(), page: 'other' }), /page/);
  assert.throws(() => store.record({ ...payload(), position: -1 }), /position/);
});

test('heartbeats update a session without flooding the event ring and stale is explicit', () => {
  let clock = 1000;
  const store = createDiagnosticsStore({ now: () => clock, staleMs: 45_000 });
  store.record(payload('s1', 'playing'));
  clock += 10_000;
  store.record({ ...payload('s1', 'heartbeat'), state: 'playing' });
  assert.equal(store.snapshot().events.length, 1);
  assert.equal(store.snapshot().sessions[0].ageMs, 0);
  clock += 45_001;
  assert.equal(store.snapshot().sessions[0].stale, true);
});

test('session and event capacities stay bounded', () => {
  const store = createDiagnosticsStore({ now: () => 1000, maxSessions: 2, maxEvents: 3 });
  for (let i = 0; i < 4; i++) store.record(payload(`s${i}`, 'playing'));
  const snapshot = store.snapshot();
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.events.length, 3);
  assert.deepEqual(snapshot.sessions.map(item => item.session), ['s2', 's3']);
});

test('sessions and events expire rather than surviving indefinitely', () => {
  let now = 0;
  const store = createDiagnosticsStore({ now: () => now, ttlMs: 100 });
  store.record(payload());
  now = 101;
  assert.deepEqual(store.size(), { sessions: 1, events: 1 });
  assert.equal(store.snapshot().sessions.length, 0);
  assert.equal(store.snapshot().events.length, 0);
});


test('controller evidence is bounded and strips unapproved device fields', () => {
  const store = createDiagnosticsStore();
  const controller = {supported:true,count:1,devices:[{index:0,id:'USB Gamepad',mapping:'unknown',buttons:12,axes:4,secret:'drop'}],lastInput:'button-0',error:'none'};
  const out = store.record({...payload(),event:'controller',controller});
  assert.equal(out.controller.devices[0].secret,undefined);
  assert.equal(out.controller.devices[0].mapping,'unknown');
  assert.equal(out.controller.lastInput,'button-0');
  assert.throws(()=>store.record({...payload(),controller:{...controller,count:5}}), /controller/);
  assert.throws(()=>store.record({...payload(),controller:{...controller,devices:[{...controller.devices[0],id:'x'.repeat(129)}]}}), /controller/);
  assert.throws(()=>store.record({...payload(),controller:{...controller,lastInput:'raw secret text'}}), /controller/);
});
