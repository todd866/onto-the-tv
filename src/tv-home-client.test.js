import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTvHome } from './tv-home-client.js';

test('home client preserves default vs explicitly empty audience and sends selections', async () => {
  const calls = [];
  const home = { ceiling: 'G', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:true})), channels: [] };
  const fetcher = async (url, options) => { calls.push([url, options]); return { ok: true, json: async () => home }; };
  for (const viewers of [undefined, [], ['sam', 'jake'], ['mum', 'dad'], ['sam', 'sam']]) assert.equal(await fetchTvHome(viewers, fetcher), home);
  assert.equal(calls[0][0].href, 'http://localhost:8686/api/home');
  assert.deepEqual(calls.slice(1).map(([url]) => url.searchParams.get('viewers')), ['', 'sam,jake', 'mum,dad', 'sam']);
  assert.ok(calls.every(([, options]) => options.signal instanceof AbortSignal && options.redirect === 'error'));
});
test('home client rejects invalid audience before making a request', async () => {
  for (const viewers of [null, 'sam', {}, ['unknown'], [null], Array(5).fill('sam')]) {
    await assert.rejects(fetchTvHome(viewers, () => assert.fail('must not fetch')), /Invalid viewers/);
  }
});
test('home client surfaces HTTP, malformed payload and network failures', async () => {
  await assert.rejects(fetchTvHome([], async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(fetchTvHome([], async () => ({ ok: true, json: async () => ({}) })), /Invalid TV lineup/);
  await assert.rejects(fetchTvHome([], async () => { throw new Error('offline'); }), /offline/);
});

test('home client rejects malformed channel and viewer entries', async () => {
  const home = { ceiling: 'G', viewers: ['sam','jake','mum','dad'].map(id => ({id,name:id,on:true})),
    channels: [{id:'cartoons',number:1,name:'Cartoons',now:{show:'Bluey',art:'/art?src=bluey'}}] };
  const fetcher = data => async () => ({ok:true,json:async()=>data});
  assert.deepEqual(await fetchTvHome(undefined,fetcher(home)),home);
  for(const data of [{...home,ceiling:'R'}, {...home,channels:[null]}, {...home,channels:[{...home.channels[0],number:'1'}]},
    {...home,viewers:[null]}, {...home,viewers:home.viewers.map(p=>({...p,id:'sam'}))}]) {
    await assert.rejects(fetchTvHome(undefined,fetcher(data)),/Invalid TV lineup/);
  }
});
