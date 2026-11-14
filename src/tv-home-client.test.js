import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTvHome, fetchTvShows, TV_HOME_ORIGIN, TV_HOME_ORIGINS } from './tv-home-client.js';
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

test('home client asks the M2 first and falls back to this Mac only when the M2 fails', async () => {
  const home = { ceiling: 'M', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:id==='dad'})), channels: [] };
  const asked = [];
  const m2Down = async url => { asked.push(url.origin); if (url.origin !== TV_HOME_ORIGIN) throw new Error('timeout'); return { ok: true, json: async () => home }; };
  assert.equal((await fetchTvHome(['dad'], m2Down)).origin, TV_HOME_ORIGIN);
  assert.deepEqual(asked, TV_HOME_ORIGINS);
  asked.length = 0;
  const m2Up = async url => { asked.push(url.origin); return { ok: true, json: async () => home }; };
  assert.equal((await fetchTvHome(['dad'], m2Up)).origin, TV_HOME_ORIGINS[0]);
  assert.deepEqual(asked, [TV_HOME_ORIGINS[0]]);
  await assert.rejects(fetchTvHome(['dad'], async () => { throw new Error('offline'); }), /offline/);
});

// Find a show: the Channels tab asks the same server for the audience's shows.
const episode = (src, title, extra = {}) => ({ src, title, show: 'Ms Rachel', kind: 'episode', art: `/art?src=${encodeURIComponent(src)}`,
  positionSeconds: 0, durationSeconds: 3600, completed: false, updatedAt: '', resume: 0, season: null, episode: null, ...extra });
const libraryPayload = () => ({ ceiling: 'G', upNext: [], collections: [], films: [], items: [],
  shows: [{ key: 'Ms Rachel', title: 'Ms Rachel', art: '/art?src=a', resume: 0, positionSeconds: 0, durationSeconds: 3600,
    episodes: [episode('preschool/Ms Rachel/a.mp4', 'Animal Learning'), episode('preschool/Ms Rachel/b.mp4', 'Best Baby Songs', { positionSeconds: 754.4, updatedAt: '2026-11-14T01:00:00Z' })] }] });

test('shows client asks /api/library for the audience and keeps only what a card needs', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => libraryPayload() }; };
  const result = await fetchTvShows(['sam', 'mum', 'dad'], fetcher, 'G', LOCAL);
  assert.equal(calls[0][0].href, 'http://localhost:8686/api/library?rating=G&viewers=sam%2Cmum%2Cdad');
  assert.ok(calls[0][1].signal instanceof AbortSignal && calls[0][1].redirect === 'error');
  assert.deepEqual(result, { origin: TV_HOME_ORIGIN, shows: [{ title: 'Ms Rachel', art: '/art?src=a', episodes: [
    { src: 'preschool/Ms Rachel/a.mp4', title: 'Animal Learning', art: '/art?src=preschool%2FMs%20Rachel%2Fa.mp4', minutes: 60, resume: 0, completed: false, updatedAt: '' },
    { src: 'preschool/Ms Rachel/b.mp4', title: 'Best Baby Songs', art: '/art?src=preschool%2FMs%20Rachel%2Fb.mp4', minutes: 60, resume: 754, completed: false, updatedAt: '2026-11-14T01:00:00Z' },
  ] }] });
});
test('shows client falls back to the next server, and rejects a bad audience or payload', async () => {
  const fetcher = async url => { if (url.origin !== TV_HOME_ORIGIN) throw new Error('unreachable'); return { ok: true, json: async () => libraryPayload() }; };
  assert.equal((await fetchTvShows(['dad'], fetcher, null, TV_HOME_ORIGINS)).origin, TV_HOME_ORIGIN);
  await assert.rejects(fetchTvShows(['nobody'], () => assert.fail('must not fetch'), null, LOCAL), /Invalid viewers/);
  await assert.rejects(fetchTvShows(['dad'], () => assert.fail('must not fetch'), 'R', LOCAL), /Invalid rating/);
  await assert.rejects(fetchTvShows(['dad'], async () => ({ ok: false, status: 502 }), null, LOCAL), /502/);
  await assert.rejects(fetchTvShows(['dad'], async () => ({ ok: true, json: async () => ({ shows: 'x' }) }), null, LOCAL), /Invalid TV library/);
});
test('shows client drops entries a card could not play or draw', async () => {
  const data = libraryPayload();
  data.shows.push(null, { title: 'No episodes', art: '/art?src=x', episodes: [] }, { title: 7, episodes: [episode('x.mp4', 'X')] },
    { title: 'Outside art', art: 'https://evil.example/a.jpg', episodes: [episode('y.mp4', 'Y', { art: 'javascript:1' }), { src: '', title: 'blank' }, { src: 5 }] });
  const { shows } = await fetchTvShows(['dad'], async () => ({ ok: true, json: async () => data }), null, LOCAL);
  assert.deepEqual(shows.map(show => [show.title, show.art, show.episodes.map(item => [item.src, item.art])]),
    [['Ms Rachel', '/art?src=a', [['preschool/Ms Rachel/a.mp4', '/art?src=preschool%2FMs%20Rachel%2Fa.mp4'], ['preschool/Ms Rachel/b.mp4', '/art?src=preschool%2FMs%20Rachel%2Fb.mp4']]],
      ['Outside art', '', [['y.mp4', '']]]]);
});
