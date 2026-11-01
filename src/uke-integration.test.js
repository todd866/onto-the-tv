import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createTvServer, createTvLibrary } from './tv-server.js';
import { createUkeHandler } from '../../uke/tools/onto-handler.mjs';
import { createConfiguredUkeHandler } from './uke-handler.js';
import { loadPlaybackHistory } from './playback-history.js';
import { createFileStorage } from './tv-server.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

test('Onto server mounts Uke after origin and home-host checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'onto-uke-'));
  const uke = await mkdtemp(join(tmpdir(), 'onto-uke-root-'));
  await mkdir(join(uke, 'app'), { recursive: true }); await mkdir(join(uke, 'songs'));
  await writeFile(join(uke, 'app', 'index.html'), 'uke');
  await writeFile(join(uke, 'songs', 'demo.json'), JSON.stringify({ id: 'demo', title: 'Demo', artist: 'Test', audio: 'sample.m4a' }));
  await writeFile(join(dir,'sample.m4a'),'0123456789');
  const history = await loadPlaybackHistory(join(dir, 'history.json'));
  const storage = await createFileStorage(join(dir, 'taste.json'));
  const library = createTvLibrary({ videos: [], history, storage });
  const server = createTvServer({ library, history, storage, uiRoot: dir, token:'test-uke-token', ukeHandler: createUkeHandler({ root: uke, audioRoot: dir }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/uke/`)).status, 200);
    assert.equal(await (await fetch(`${base}/uke/`)).text(), 'uke');
    assert.equal((await fetch(`${base}/uke/`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    const audio=await fetch(`${base}/uke/audio/sample.m4a?t=test-uke-token`,{headers:{Origin:'null',Range:'bytes=2-4'}});
    assert.equal(audio.status,206);assert.equal(await audio.text(),'234');
    assert.equal((await fetch(`${base}/uke/audio/sample.m4a`,{headers:{Origin:'null'}})).status,403);
    assert.equal((await fetch(`${base}/uke/songs/index.json?t=test-uke-token`,{headers:{Origin:'null'}})).status,403);
    assert.equal((await fetch(`${base}/uke/songs/index.json`,{headers:{Origin:'null','X-Onto-Token':'test-uke-token'}})).status,200);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir,{recursive:true,force:true}); await rm(uke,{recursive:true,force:true}); }
});

test('missing optional Uke installation leaves ordinary routes alone',async()=>{
 const handler=createConfiguredUkeHandler({root:'/nonexistent-uke-fixture'});
 assert.equal(await handler({url:'/api/home'},{}),false);
 let status,body;const response={writeHead:s=>{status=s;},end:s=>{body=s;}};
 assert.equal(await handler({url:'/uke/'},response),true);
 assert.equal(status,503);assert.match(body,/unavailable/);
});

test('configured Uke forwards TV authorization and keeps phone bearer separate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'onto-uke-phone-'));
 const history=await loadPlaybackHistory(join(dir,'history.json'));
 const storage=await createFileStorage(join(dir,'taste.json'));
 const library=createTvLibrary({videos:[],history,storage});
 const server=createTvServer({library,history,storage,uiRoot:dir,token:'phone-fixture-token'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(route,body,headers={})=>fetch(`${base}/uke/practice/${route}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 try {
  assert.equal((await post('session',{}, {Origin:'null'})).status,403);
  assert.equal((await post('session',{})).status,403);
  const created=await post('session',{}, {Origin:'null','X-Onto-Token':'phone-fixture-token'});
  assert.equal(created.status,201);const session=await created.json();
  const paired=await post('pair',{code:session.code});assert.equal(paired.status,200);const phone=await paired.json();
  assert.equal((await post('event',{id:session.id,phoneToken:phone.phoneToken,sequence:1,capturedAt:Date.now(),strength:1,confidence:.9,intervalMs:500})).status,202);
  assert.equal((await post('poll',{id:session.id,viewerToken:session.viewerToken,after:0},{Origin:'null','X-Onto-Token':'phone-fixture-token'})).status,200);
  assert.equal((await post('stop',{id:session.id,viewerToken:session.viewerToken},{Origin:'null','X-Onto-Token':'phone-fixture-token'})).status,200);
 } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
