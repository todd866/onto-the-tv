import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmbientPlayer } from './ambient-player.js';
import { createSession } from './session.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(buildOverride) {
  let listener, n = 0;
  let state = { status: 'playing', current: { path: '/Dino.mp4' }, upcoming: [{ path: '/Christmas.mp4' }] };
  const calls = [], cleaned = [], statuses = [];
  const emit = next => { state = next; listener?.(state); };
  const item = () => { const path = `/ambient-${++n}.mp4`; return { path, cleanup: async () => cleaned.push(path) }; };
  const session = {
    getState: () => state,
    onChange: fn => { listener = fn; fn(state); return () => { listener = null; }; },
    playOnly: async entries => {
      calls.push(['play', entries[0].path]);
      emit({ ...state, status: 'preparing' });
      emit({ status: 'playing', current: { path: entries[0].path }, upcoming: [] });
      return state;
    },
    queueNext: async (entry, expected) => {
      calls.push(['queue', entry.path, expected]);
      if (state.current?.path === expected) emit({ ...state, upcoming: [entry] });
      return state;
    },
  };
  const player = createAmbientPlayer({ session, build: buildOverride || (async () => item()), onStatus: s => statuses.push(s) });
  return { player, session, calls, cleaned, statuses, emit, item };
}

test('preparation leaves the movie and queue untouched; explicit start queues one rotation ahead', async () => {
  const wait = deferred();
  let first = true, f;
  f = fixture(async () => { if (first) { first = false; await wait.promise; } return f.item(); });
  const work = f.player.start({ weather: true });
  assert.deepEqual(f.calls, []);
  assert.equal(f.session.getState().current.path, '/Dino.mp4');
  assert.equal(f.session.getState().upcoming[0].path, '/Christmas.mp4');
  wait.resolve(); await work; await turn();
  assert.deepEqual(f.calls, [['play', '/ambient-1.mp4'], ['queue', '/ambient-2.mp4', '/ambient-1.mp4']]);
  assert.deepEqual(f.cleaned, []);
  f.emit({ status: 'playing', current: { path: '/ambient-2.mp4' }, upcoming: [] });
  await turn();
  assert.deepEqual(f.cleaned, ['/ambient-1.mp4']);
  assert.equal(f.calls.length, 3);
  f.emit({ ...f.session.getState() }); await turn();
  assert.equal(f.calls.length, 3);
  await f.player.close();
});

test('cancel during preparation never reclaims the TV and cleans the late result', async () => {
  const wait = deferred(); let f;
  f = fixture(async () => { await wait.promise; return f.item(); });
  const work = f.player.start({}); f.player.cancel(); wait.resolve();
  await work; await turn();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.cleaned, ['/ambient-1.mp4']);
  await f.player.close();
});

test('foreign playback and stop cancel lookahead and do not delete a still-served current file', async () => {
  let f, call = 0; const wait = deferred();
  f = fixture(async () => { if (++call === 2) await wait.promise; return f.item(); });
  await f.player.start({});
  f.player.cancel(); await turn();
  assert.deepEqual(f.cleaned, []);
  f.emit({ status: 'playing', current: { path: '/other.mp4' }, upcoming: [] });
  wait.resolve(); await turn(); await turn();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.cleaned.sort(), ['/ambient-1.mp4', '/ambient-2.mp4']);
  await f.player.close();
});

test('failed lookahead is surfaced once and does not retry on each poll', async () => {
  let f, call = 0;
  f = fixture(async () => { if (++call > 1) throw new Error('no forecast'); return f.item(); });
  await f.player.start({}); await turn();
  for (let i = 0; i < 5; i++) f.emit({ ...f.session.getState() });
  assert.equal(call, 2); assert.match(f.statuses.at(-1).error, /no forecast/);
  await f.player.close();
});

test('close waits for cancellation cleanup before returning', async () => {
  const wait = deferred(); let f;
  f = fixture(async () => { await wait.promise; return f.item(); });
  const work = f.player.start({});
  let closed = false; const closing = f.player.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false);
  wait.resolve(); await work; await closing;
  assert.deepEqual(f.cleaned, ['/ambient-1.mp4']); assert.deepEqual(f.calls, []);
});

test('real session stop or replacement wins over a delayed lookahead and never writes ambient history', async () => {
  for (const action of ['stop', 'replace']) {
    let ambient, buildCount = 0, uri = '', transport = 'STOPPED';
    const wait = deferred(), played = [], remembered = [], cleaned = [];
    const session = createSession({ pollMs:0, config:{ avTransportUrl:'http://example/control' },
      prepareMedia:async path=>({filePath:path,title:path,durationSeconds:300,cleanup:async()=>{}}),
      createServer:()=>({listen:async()=>{},serveFile:media=>({...media,url:`http://example${media.filePath}`}),clear(){},close:async()=>{}}),
      createRenderer:()=>({
        play:async item=>{uri=item.url;transport='PLAYING';played.push(item.sourcePath);},
        setNext:async()=>{},stop:async()=>{transport='STOPPED';uri='';},
        transportInfo:async()=>({state:transport}),positionInfo:async()=>({uri,positionSeconds:30,durationSeconds:300}),
      }),
      history:{get:()=>0,getPoints:()=>[],list:()=>[],flush:async()=>{},set:(path)=>{if(!ambient.owns(path)) remembered.push(path);}},
    });
    ambient = createAmbientPlayer({session,build:async()=>{
      const number=++buildCount;
      if(number===2) await wait.promise;
      return {path:`/ambient-${number}.mp4`,cleanup:async()=>cleaned.push(number)};
    }});
    try {
      await ambient.start({}); await session.tick();
      ambient.cancel();
      if(action==='stop') await session.stop(); else await session.playOnly(['/film.mp4']);
      wait.resolve(); await turn(); await turn();
      assert.equal(session.getState().upcoming.length,0);
      assert.deepEqual(played,action==='stop'?['/ambient-1.mp4']:['/ambient-1.mp4','/film.mp4']);
      assert.deepEqual(remembered,[]);
      assert.deepEqual(cleaned.sort(),[1,2]);
    } finally { await session.close(); await ambient.close(); }
  }
});
