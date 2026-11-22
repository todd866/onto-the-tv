import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGameRelay } from './game-relay.js';

function harness() {
  let clock = 1000;
  const relay = createGameRelay({ now: () => clock, random: () => 0.123456 });
  const tv = relay.handle({ method: 'POST', path: '/api/game/session', tvAuthorized: true });
  return { relay, tv, get clock() { return clock; }, advance(ms) { clock += ms; } };
}
test('pairs one controller and relays bounded input events', () => {
  const h = harness();
  const joined = h.relay.handle({ method: 'POST', path: '/api/game/join', ip: 'tv', body: { code: h.tv.body.code } });
  assert.equal(joined.status, 200);
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/join', ip: 'tv', body: { code: h.tv.body.code } }).status, 409);
  const headers = { 'x-onto-controller': joined.body.controllerToken };
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/input', headers, body: { session: h.tv.body.session, action: 'digit3' } }).status, 200);
  const events = h.relay.handle({ method: 'GET', path: `/api/game/events?session=${h.tv.body.session}&after=0`, tvAuthorized: true });
  assert.deepEqual(events.body.events, [{ seq: 1, action: 'digit3' }]);
  assert.equal(events.body.controller, true);
});
test('rejects bad tokens, actions, excessive guesses and expires idle sessions', () => {
  const h = harness();
  assert.equal(h.relay.handle({ method: 'GET', path: `/api/game/events?session=${h.tv.body.session}`, tvAuthorized: false }).status, 403);
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/input', headers: { 'x-onto-controller': 'x' }, body: { session: h.tv.body.session, action: 'ok' } }).status, 403);
  const ip = 'guess'; for (let i = 0; i < 10; i++) h.relay.handle({ method: 'POST', path: '/api/game/join', ip, body: { code: '000000' } });
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/join', ip, body: { code: '000000' } }).status, 429);
  h.advance(5 * 60_000 + 1);
  assert.equal(h.relay.handle({ method: 'GET', path: `/api/game/events?session=${h.tv.body.session}`, tvAuthorized: true }).status, 403);
});
test('session close removes its controller', () => {
  const h = harness();
  assert.equal(h.relay.handle({ method: 'DELETE', path: `/api/game/session?session=${h.tv.body.session}`, tvAuthorized: true }).status, 200);
  assert.equal(h.relay.size(), 0);
});
test('bounds pairing clients and global attempts', () => {
  const relay = createGameRelay({ now: () => 1000, random: () => 0, maxGuessIps: 2, globalJoinLimit: 100 });
  assert.equal(relay.handle({ method: 'POST', path: '/api/game/join', ip: 'a', body: { code: '000000' } }).status, 404);
  assert.equal(relay.handle({ method: 'POST', path: '/api/game/join', ip: 'b', body: { code: '000000' } }).status, 404);
  assert.equal(relay.handle({ method: 'POST', path: '/api/game/join', ip: 'c', body: { code: '000000' } }).status, 429);
  const r = createGameRelay({ now: () => 1000, random: () => 0, globalJoinLimit: 2 });
  r.handle({ method: 'POST', path: '/api/game/join', ip: 'a', body: { code: '000000' } });
  r.handle({ method: 'POST', path: '/api/game/join', ip: 'b', body: { code: '000000' } });
  assert.equal(r.handle({ method: 'POST', path: '/api/game/join', ip: 'c', body: { code: '000000' } }).status, 429);
});
test('collision fallback and controller reconnect', () => {
  const h = harness();
  const second = h.relay.handle({ method: 'POST', path: '/api/game/session', tvAuthorized: true });
  assert.equal(second.status, 200); assert.notEqual(second.body.code, h.tv.body.code);
  const joined = h.relay.handle({ method: 'POST', path: '/api/game/join', ip: 'x', body: { code: h.tv.body.code } });
  const headers = { 'x-onto-controller': joined.body.controllerToken };
  assert.equal(h.relay.handle({ method: 'DELETE', path: `/api/game/controller?session=${h.tv.body.session}`, headers }).status, 200);
  const again = h.relay.handle({ method: 'POST', path: '/api/game/join', ip: 'x', body: { code: h.tv.body.code } });
  assert.equal(again.status, 200); assert.notEqual(again.body.controllerToken, joined.body.controllerToken);
});
test('rejects null and malformed bodies', () => {
  const h = harness();
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/join', body: null }).status, 400);
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/input', body: null }).status, 400);
  assert.equal(h.relay.handle({ method: 'POST', path: '/api/game/join', body: '{' }).status, 400);
});
