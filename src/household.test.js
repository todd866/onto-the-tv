import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLE_HOUSEHOLD, HOUSEHOLD, ROLE, audienceOf, householdPath, loadHousehold, normaliseHousehold, publicHousehold } from './household.js';

test('tests never read the private household file', () => {
  assert.equal(householdPath({ NODE_TEST_CONTEXT: 'child' }), null);
  assert.equal(householdPath({ NODE_TEST_CONTEXT: 'child', ONTO_HOUSEHOLD: '/x/h.json' }), '/x/h.json');
  assert.match(householdPath({}), /\.config\/onto-the-tv\/household\.json$/);
  assert.equal(HOUSEHOLD.source, 'example');
  assert.deepEqual(HOUSEHOLD.viewers.map(viewer => viewer.id), EXAMPLE_HOUSEHOLD.viewers.map(viewer => viewer.id));
});

test('a private file supplies viewers, roles, profiles and network; bad parts fall back', () => {
  const raw = { viewers: [{ id: 'Pip', name: 'Pip', ceiling: 'G', role: 'youngest' }, { id: 'lee', name: 'Lee', ceiling: null, role: 'adultA' },
    { id: 'lee', name: 'Duplicate' }, { id: '../bad', name: 'Bad' }, { id: 'kim', name: 'Kim', ceiling: 'X', role: 'youngest' }],
    profiles: [{ id: 'pip', name: 'Pip', viewers: ['pip', 'nobody'], layout: 'pictures', theme: 'coral', desktopViewers: ['pip', 'lee'] }, { id: 'empty', viewers: ['nobody'] }],
    network: { homeOrigin: 'http://10.0.0.2:8686/path', tailnetOrigin: 'javascript:alert(1)', tvHost: '10.0.0.9' }, assistant: { age: 7 } };
  const loaded = loadHousehold({ env: { ONTO_HOUSEHOLD: '/h.json' }, read: () => JSON.stringify(raw) });
  assert.equal(loaded.source, 'private');
  assert.deepEqual(loaded.viewers, [{ id: 'pip', name: 'Pip', ceiling: 'G', role: 'youngest' }, { id: 'lee', name: 'Lee', ceiling: null, role: 'adultA' },
    { id: 'kim', name: 'Kim', ceiling: null, role: null }]);
  assert.deepEqual(loaded.profiles.map(profile => [profile.id, profile.viewers, profile.desktopViewers, profile.theme]), [['pip', ['pip'], ['pip', 'lee'], 'coral']]);
  assert.equal(loaded.network.homeOrigin, 'http://10.0.0.2:8686');
  assert.equal(loaded.network.tailnetOrigin, EXAMPLE_HOUSEHOLD.network.tailnetOrigin, 'not an http(s) origin');
  assert.equal(loaded.network.tvHost, '10.0.0.9');
  assert.equal(loaded.assistant.age, 7);
  const missing = loadHousehold({ env: { ONTO_HOUSEHOLD: '/none.json' }, read: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  assert.equal(missing.source, 'example');
  assert.equal(missing.problem, 'missing');
  assert.ok(normaliseHousehold({ viewers: [{ id: 'solo', name: 'Solo' }] }).profiles.some(profile => profile.id === 'all'));
});

test('roles name audiences; the pages get names and profiles but never the network', () => {
  assert.deepEqual(ROLE, { youngest: 'kid1', older: 'kid2', adultA: 'adult1', adultB: 'adult2' });
  assert.equal(audienceOf('older', 'adultB', 'adultA'), 'kid2,adult2,adult1');
  const page = publicHousehold();
  assert.equal('network' in page, false);
  assert.ok(!JSON.stringify(page).includes('192.168'));
  assert.equal(page.viewers.length, 4);
});
