import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTvHome, TV_HOME_ORIGIN, TV_HOME_ORIGINS } from './tv-home-client.js';
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
