import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHomeOrigins, fetchTvHome, fetchTvShows, provesM2, TV_HOME_ORIGIN, TV_HOME_ORIGINS } from './tv-home-client.js';
import { whoamiProof } from './tv-server.js';
const LOCAL = [TV_HOME_ORIGIN];

test('home client preserves default vs explicitly empty audience and sends selections', async () => {
  const calls = [];
  const home = { ceiling: 'G', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:true})), channels: [] };
  const fetcher = async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => home }; };
  for (const viewers of [undefined, [], ['sam', 'jake'], ['mum', 'dad'], ['sam', 'sam']]) assert.deepEqual(await fetchTvHome(viewers, fetcher, null, LOCAL), { ...home, origin: TV_HOME_ORIGIN });
  assert.equal(calls[0][0].href, 'http://localhost:8686/api/home');
  assert.deepEqual(calls.slice(1).map(([url]) => url.searchParams.get('viewers')), ['', 'sam,jake', 'mum,dad', 'sam']);
  assert.ok(calls.every(([, options]) => options.signal instanceof AbortSignal && options.redirect === 'error'));
});
test('home client rejects invalid audience before making a request', async () => {
  for (const viewers of [null, 'sam', {}, ['unknown'], [null], Array(5).fill('sam')]) {
    await assert.rejects(fetchTvHome(viewers, () => assert.fail('must not fetch'), null, LOCAL), /Invalid viewers/);
  }
});
test('home client surfaces HTTP, malformed payload and network failures', async () => {
  await assert.rejects(fetchTvHome([], async () => ({ ok: false, status: 503 }), null, LOCAL), /503/);
  await assert.rejects(fetchTvHome([], async () => ({ ok: true, json: async () => ({}) }), null, LOCAL), /Invalid TV lineup/);
  await assert.rejects(fetchTvHome([], async () => { throw new Error('offline'); }, null, LOCAL), /offline/);
});

test('home client rejects malformed channel and viewer entries', async () => {
  const home = { ceiling: 'G', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:true})),
    channels: [{id:'cartoons',number:1,name:'Cartoons',now:{show:'Bluey',art:'/art?src=bluey'}}] };
  const fetcher = data => async () => ({ok:true,json:async()=>data});
  assert.deepEqual(await fetchTvHome(undefined,fetcher(home),null,LOCAL),{...home,origin:TV_HOME_ORIGIN});
  for(const data of [{...home,ceiling:'R'}, {...home,channels:[null]}, {...home,channels:[{...home.channels[0],number:'1'}]},
    {...home,viewers:[null]}, {...home,viewers:home.viewers.map(p=>({...p,id:'sam'}))}]) {
    await assert.rejects(fetchTvHome(undefined,fetcher(data),null,LOCAL),/Invalid TV lineup/);
  }
});

test('home client sends a valid rating override and rejects others before fetching', async () => {
  const calls = [];
  const home = { ceiling: 'M', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:true})), channels: [] };
  const fetcher = async url => { calls.push(url); return { ok: true, json: async () => home }; };
  await fetchTvHome(['sam'], fetcher, 'M');
  await fetchTvHome(['sam'], fetcher, null);
  assert.deepEqual(calls.map(url => url.searchParams.get('rating')), ['M', null]);
  for (const rating of ['R', 'm', 1, {}]) await assert.rejects(fetchTvHome(['sam'], () => assert.fail('must not fetch'), rating), /Invalid rating/);
});

test('the M2 is asked on the home network, then over the tailnet, then this Mac', async () => {
  assert.deepEqual(TV_HOME_ORIGINS, ['http://192.168.20.20:8686', 'https://iantodds-macbook-air.tail8cd07b.ts.net:8443', 'http://localhost:8686']);
  const home = { ceiling: 'M', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:id==='dad'})), channels: [] };
  const waits = new Map();
  const away = async (url, options) => { waits.set(url.origin, options.signal); if (url.origin === TV_HOME_ORIGINS[0]) throw new Error('timeout'); return { ok: true, json: async () => home }; };
  assert.equal((await fetchTvHome(['dad'], away)).origin, TV_HOME_ORIGINS[1], 'away from home, the tailnet');
  assert.ok(waits.get(TV_HOME_ORIGINS[0]) instanceof AbortSignal);
});
test('home client asks the M2 first and falls back to this Mac only when the M2 fails', async () => {
  const home = { ceiling: 'M', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:id==='dad'})), channels: [] };
  const asked = [];
  const m2Down = async url => { asked.push(url.origin); if (url.origin !== TV_HOME_ORIGIN) throw new Error('timeout'); return { ok: true, json: async () => home }; };
  // Both of the M2's addresses are tried before this Mac's own server.
  assert.equal((await fetchTvHome(['dad'], m2Down)).origin, TV_HOME_ORIGIN);
  assert.deepEqual(asked, TV_HOME_ORIGINS);
  asked.length = 0;
  const m2Up = async url => { asked.push(url.origin); return { ok: true, json: async () => home }; };
  assert.equal((await fetchTvHome(['dad'], m2Up)).origin, TV_HOME_ORIGINS[0]);
  assert.deepEqual(asked, [TV_HOME_ORIGINS[0]]);
  await assert.rejects(fetchTvHome(['dad'], async () => { throw new Error('offline'); }), /offline/);
});

// Find a show: the Channels tab asks the same server for the audience's shows.
const longEpisode = (src, title, extra = {}) => ({ src, title, show: 'Ms Rachel', kind: 'episode', art: `/art?src=${encodeURIComponent(src)}`,
  positionSeconds: 0, durationSeconds: 3600, completed: false, updatedAt: '', resume: 0, season: null, episode: null, ...extra });
// The whole library, as a server from before /api/shows answers.
const libraryPayload = () => ({ ceiling: 'G', upNext: [], collections: [], films: [], items: [],
  shows: [{ key: 'Ms Rachel', title: 'Ms Rachel', art: '/art?src=preschool%2FMs%20Rachel%2Fb.mp4', resume: 754, positionSeconds: 754, durationSeconds: 3600,
    episodes: [longEpisode('preschool/Ms Rachel/a.mp4', 'Animal Learning'), longEpisode('preschool/Ms Rachel/b.mp4', 'Best Baby Songs', { positionSeconds: 754.4, updatedAt: '2026-11-14T01:00:00Z' })] }] });
// The short listing.
const showsPayload = () => ({ ceiling: 'G', shows: [{ title: 'Ms Rachel', face: 1, episodes: [
  { src: 'preschool/Ms Rachel/a.mp4', title: 'Animal Learning', seconds: 3600 },
  { src: 'preschool/Ms Rachel/b.mp4', title: 'Best Baby Songs', seconds: 3600, at: 754, when: '2026-11-14T01:00:00Z' },
  { src: 'preschool/Ms Rachel/c.mp4', title: 'Colours', seconds: 600, at: 600, done: true, when: '2026-11-13T01:00:00Z' }] }] });
const wanted = [{ title: 'Ms Rachel', art: '/art?src=preschool%2FMs%20Rachel%2Fb.mp4', episodes: [
  { src: 'preschool/Ms Rachel/a.mp4', title: 'Animal Learning', art: '/art?src=preschool%2FMs%20Rachel%2Fa.mp4', minutes: 60, resume: 0, completed: false, updatedAt: '' },
  { src: 'preschool/Ms Rachel/b.mp4', title: 'Best Baby Songs', art: '/art?src=preschool%2FMs%20Rachel%2Fb.mp4', minutes: 60, resume: 754, completed: false, updatedAt: '2026-11-14T01:00:00Z' },
] }];

test('shows client asks for the short listing and gives each card what it draws and plays', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push([url, options]); return { ok: true, status: 200, json: async () => showsPayload() }; };
  const result = await fetchTvShows(['sam', 'mum', 'dad'], fetcher, 'G', LOCAL);
  assert.deepEqual(calls.map(([url]) => url.href), ['http://localhost:8686/api/shows?rating=G&viewers=sam%2Cmum%2Cdad']);
  assert.ok(calls[0][1].signal instanceof AbortSignal && calls[0][1].redirect === 'error');
  assert.equal(result.origin, TV_HOME_ORIGIN);
  assert.deepEqual(result.shows[0].episodes.slice(0, 2), wanted[0].episodes);
  assert.equal(result.shows[0].art, wanted[0].art, 'the show wears the episode left part-way');
  assert.deepEqual(result.shows[0].episodes[2], { src: 'preschool/Ms Rachel/c.mp4', title: 'Colours', art: '/art?src=preschool%2FMs%20Rachel%2Fc.mp4', minutes: 10, resume: 0, completed: true, updatedAt: '2026-11-13T01:00:00Z' });
});
test('a server from before the short listing is asked for its whole library, with the same result', async () => {
  const asked = [];
  const fetcher = async url => { asked.push(url.pathname); return url.pathname === '/api/shows' ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => libraryPayload() }; };
  assert.deepEqual(await fetchTvShows(['sam', 'mum', 'dad'], fetcher, null, LOCAL), { origin: TV_HOME_ORIGIN, shows: wanted });
  assert.deepEqual(asked, ['/api/shows', '/api/library']);
});
test('shows client falls back to the next server, and rejects a bad audience or payload', async () => {
  const fetcher = async url => { if (url.origin !== TV_HOME_ORIGIN) throw new Error('unreachable'); return { ok: true, status: 200, json: async () => showsPayload() }; };
  assert.equal((await fetchTvShows(['dad'], fetcher, null, TV_HOME_ORIGINS)).origin, TV_HOME_ORIGIN);
  await assert.rejects(fetchTvShows(['nobody'], () => assert.fail('must not fetch'), null, LOCAL), /Invalid viewers/);
  await assert.rejects(fetchTvShows(['dad'], () => assert.fail('must not fetch'), 'R', LOCAL), /Invalid rating/);
  await assert.rejects(fetchTvShows(['dad'], async () => ({ ok: false, status: 502 }), null, LOCAL), /502/);
  await assert.rejects(fetchTvShows(['dad'], async () => ({ ok: true, status: 200, json: async () => ({ shows: 'x' }) }), null, LOCAL), /Invalid TV library/);
});
test('shows client drops what a card could not play, and never takes a picture address from the server', async () => {
  const data = libraryPayload();
  data.shows.push(null, { title: 'No episodes', art: '/art?src=x', episodes: [] }, { title: 7, episodes: [longEpisode('x.mp4', 'X')] },
    { title: 'Outside art', art: 'https://evil.example/a.jpg', episodes: [longEpisode('y.mp4', 'Y', { art: 'javascript:1' }), { src: '', title: 'blank' }, { src: 5 }] });
  const { shows } = await fetchTvShows(['dad'], async () => ({ ok: true, status: 200, json: async () => data }), null, LOCAL);
  assert.deepEqual(shows.map(show => [show.title, show.art, show.episodes.map(item => [item.src, item.art])]),
    [['Ms Rachel', '/art?src=preschool%2FMs%20Rachel%2Fb.mp4', [['preschool/Ms Rachel/a.mp4', '/art?src=preschool%2FMs%20Rachel%2Fa.mp4'], ['preschool/Ms Rachel/b.mp4', '/art?src=preschool%2FMs%20Rachel%2Fb.mp4']]],
      ['Outside art', '/art?src=y.mp4', [['y.mp4', '/art?src=y.mp4']]]]);
});

// Security review, 15 Nov 2026: plain http to 192.168.20.20 proves nothing, and that address exists on other
// networks. The home address is used only after the server there proves it holds the pairing token.
test('the home address is used only after the server there proves it holds the pairing token', async () => {
  const token = 'pairing-secret';
  const m2 = async url => {
    if (url.pathname !== '/api/whoami') throw new Error('unexpected');
    return { ok: true, json: async () => ({ proof: whoamiProof(token, url.searchParams.get('n')) }) };
  };
  assert.equal(await provesM2(token, m2), true);
  // A stranger at the same address cannot answer without the token, and the token is never sent.
  const sent = [];
  const stranger = async (url, options) => { sent.push([url.href, JSON.stringify(options.headers || {})]); return { ok: true, json: async () => ({ proof: whoamiProof('another-token', url.searchParams.get('n')) }) }; };
  assert.equal(await provesM2(token, stranger), false);
  assert.ok(sent.every(([href, headers]) => !href.includes(token) && !headers.includes(token)));
  assert.equal(await provesM2(token, async () => ({ ok: true, json: async () => ({ proof: 'x' }) })), false);
  assert.equal(await provesM2(token, async () => { throw new Error('no route'); }), false);
  assert.equal(await provesM2('', m2), false, 'an unpaired Mac never uses the home address');
});

test('the origins list keeps the home address only while it is proved, and looks again later', async () => {
  let clock = 0, home = true, asked = 0;
  const fetcher = async url => { asked++; if (!home) throw new Error('away'); return { ok: true, json: async () => ({ proof: whoamiProof('t', url.searchParams.get('n')) }) }; };
  const origins = createHomeOrigins({ token: async () => 't', fetcher, now: () => clock });
  assert.deepEqual(await origins(), TV_HOME_ORIGINS);
  assert.deepEqual(await origins(), TV_HOME_ORIGINS);
  assert.equal(asked, 1, 'proof is remembered');
  home = false; clock += 6 * 60_000;
  assert.deepEqual(await origins(), TV_HOME_ORIGINS.slice(1), 'away from home: tailnet, then this Mac');
  home = true; clock += 30_000;
  assert.deepEqual(await origins(), TV_HOME_ORIGINS.slice(1), 'a failure is remembered for a minute');
  clock += 40_000;
  assert.deepEqual(await origins(), TV_HOME_ORIGINS);
});
