import test from 'node:test';
import assert from 'node:assert/strict';
import { createFred, FRED_AUDIENCE } from './fred-mcp.js';

function fakeTv({ sessionAge = 1000 } = {}) {
  const posts = [], gets = [];
  return {
    posts, gets,
    async get(path) {
      gets.push(path);
      if (path.startsWith('/api/diagnostics')) return { events: [{ session: 'tv-abc', ageMs: sessionAge }] };
      if (path.startsWith('/api/search')) return { cards: [{ src: 'Hot Wheels/a.mp4', title: 'Hot Wheels Mega Jump', creator: 'Hot Wheels', duration: 600, resume: 0 }, { src: 'Track Time/b.mp4', title: 'Track Time 14F', creator: 'Track Time', duration: 900 }] };
      if (path.startsWith('/api/home')) return { channels: [{ id: 'christmas', number: 5, name: 'Christmas' }, { id: 'trains', number: 9, name: 'Trains, Planes & Cars' }, { id: 'games', number: 40, name: 'Games', app: true }] };
      if (path.startsWith('/api/now-playing')) return { src: 'Bluey/Series 1 Keepy Uppy [x].mp4', channel: { name: 'Bluey' } };
      return {};
    },
    async post(path, body) { posts.push({ path, body }); return { id: 'c1' }; },
  };
}
const call = (fred, name, args = {}) => fred.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });

test('fred speaks MCP: initialize, tools/list, notifications get no reply, unknown methods fail', async () => {
  const fred = createFred({ tv: fakeTv() });
  const init = await fred.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'onto-the-tv');
  assert.ok(init.result.capabilities.tools);
  assert.equal(await fred.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await fred.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.result.tools.some(t => t.name === 'play_video'));
  assert.equal((await fred.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
});

test('fred searches only Jake\'s audience and plays through a TV command on the live session', async () => {
  const tv = fakeTv();
  const fred = createFred({ tv });
  const found = await call(fred, 'find_videos', { query: 'hot wheels' });
  assert.match(found.result.content[0].text, /1\. Hot Wheels Mega Jump/);
  assert.ok(tv.gets.some(p => p.includes(`viewers=${encodeURIComponent(FRED_AUDIENCE.viewers)}`) && p.includes('rating=PG')));
  const played = await call(fred, 'play_video', { pick: 2 });
  assert.equal(played.result.content[0].text, 'Playing Track Time 14F.');
  assert.deepEqual(tv.posts.at(-1), { path: '/api/tv-command', body: { action: 'play', src: 'Track Time/b.mp4', positionSeconds: 0, session: 'tv-abc' } });
});

test('fred changes channel by name or number and never offers app tiles', async () => {
  const tv = fakeTv();
  const fred = createFred({ tv });
  assert.equal((await call(fred, 'change_channel', { channel: 'christmas' })).result.content[0].text, 'Changed to 5 Christmas.');
  assert.equal(tv.posts.at(-1).body.channel, 'christmas');
  assert.equal((await call(fred, 'change_channel', { channel: '9' })).result.content[0].text, 'Changed to 9 Trains, Planes & Cars.');
  assert.doesNotMatch((await call(fred, 'list_channels')).result.content[0].text, /Games/);
  assert.equal((await call(fred, 'change_channel', { channel: 'zzz' })).result.isError, true);
});

test('fred says when the TV is off instead of pretending', async () => {
  const fred = createFred({ tv: fakeTv({ sessionAge: 600_000 }) });
  const r = await call(fred, 'pause');
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /switched off/);
  assert.match((await call(fred, 'whats_on')).result.content[0].text, /Keepy Uppy/);
});
