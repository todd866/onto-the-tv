import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatchEventStore } from './watch-events.js';
import { createTvServer } from './tv-server.js';
import { writeFile } from 'node:fs/promises';

const event = (overrides = {}) => ({ src: 'Bluey/a.mp4', channel: '2', audience: '2', sessionId: 'session_1234', sequence: 0, reason: 'start', watchedSeconds: 0, ...overrides });

test('deduplicates session sequence and persists valid events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-events-')), file = join(dir, 'events.jsonl');
  const store = await createWatchEventStore({ file, knownSources: new Set(['Bluey/a.mp4']) });
  assert.equal(store.record(event()).accepted, true);
  assert.equal(store.record(event()).duplicate, true);
  store.record(event({ sequence: 1, reason: 'progress', watchedSeconds: 15 }));
  await store.flush();
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2);
  const restarted = await createWatchEventStore({ file, knownSources: new Set(['Bluey/a.mp4']) });
  assert.equal(restarted.record(event()).duplicate, true);
  assert.equal(restarted.record(event({ sequence: 3, reason: 'pause', watchedSeconds: 15 })).accepted, true);
  assert.equal(restarted.record(event({ sequence: 2, reason: 'pause', watchedSeconds: 15 })).outOfOrder, true);
});

test('rejects unknown source, fake channel, backwards time and implausible interval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-validation-'));
  const store = await createWatchEventStore({ file: join(dir, 'watch.jsonl'), knownSources: new Set(['Bluey/a.mp4']) });
  assert.throws(() => store.record(event({ src: 'fake.mp4' })), /Unknown video/);
  assert.throws(() => store.record(event({ channel: 'child' })), /Invalid channel/);
  store.record(event({ sequence: 2, watchedSeconds: 20 }));
  assert.throws(() => store.record(event({ sequence: 3, watchedSeconds: 10 })), /cumulative/);
  assert.throws(() => store.record(event({ sequence: 4, watchedSeconds: 141 })), /implausible/);
});

test('authenticated HTTP endpoint records a real event', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-http-')), ui = join(dir, 'index.html');
  await writeFile(ui, 'ok');
  const events = await createWatchEventStore({ file: join(dir, 'watch.jsonl'), knownSources: new Set(['Bluey/a.mp4']) });
  const history = { flush: async () => {}, has: () => false, get: () => 0, list: () => [] };
  const storage = { flush: async () => {} };
  const library = { home: () => ({ channels: [] }), show: () => [], next: () => ({}), progress: () => false, file: () => '/tmp/x', video: () => ({ file: '/tmp/x' }) };
  const server = createTvServer({ library, history, storage, watchEvents: events, uiRoot: dir, token: 'pair-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/watch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Onto-Token': 'pair-token' }, body: JSON.stringify(event()) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('concurrent flush acknowledgements include their own records and failed appends can retry', async () => {
  const dir=await mkdtemp(join(tmpdir(),'watch-durable-')),file=join(dir,'store','events.jsonl');
  const store=await createWatchEventStore({file,knownSources:new Set(['Bluey/a.mp4'])});
  store.record(event());const first=store.flush();
  store.record(event({sequence:1,reason:'progress',watchedSeconds:20}));const second=store.flush();
  await Promise.all([first,second]);
  assert.equal((await readFile(file,'utf8')).trim().split('\n').length,2);
  const fs=await import('node:fs/promises');const blocked=join(dir,'blocked');await fs.writeFile(blocked,'file not folder');
  const retry=await createWatchEventStore({file:join(dir,'future','events.jsonl'),knownSources:new Set(['Bluey/a.mp4'])});
  await fs.rename(blocked,join(dir,'future'));
  retry.record(event());await assert.rejects(retry.flush());
  await fs.unlink(join(dir,'future'));await retry.flush();
  assert.equal((await readFile(join(dir,'future','events.jsonl'),'utf8')).trim().split('\n').length,1);
});
test('restart preserves session binding and ordering; every video has its own session',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'watch-order-')),file=join(dir,'events.jsonl'),knownSources=new Set(['Bluey/a.mp4','Other/b.mp4']);
 let s=await createWatchEventStore({file,knownSources});s.record(event());s.record(event({sequence:3,reason:'progress',watchedSeconds:30}));await s.flush();
 s=await createWatchEventStore({file,knownSources});assert.equal(s.record(event({sequence:2,watchedSeconds:20})).outOfOrder,true);
 assert.throws(()=>s.record(event({sequence:4,src:'Other/b.mp4',watchedSeconds:31})),/changed/);
 assert.equal(s.record(event({sessionId:'session_second',src:'Other/b.mp4'})).accepted,true);
 assert.equal(s.record(event({sequence:4,watchedSeconds:35})).accepted,true);
 await s.flush();
});
