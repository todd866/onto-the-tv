import {test} from 'node:test';import assert from 'node:assert/strict';import {createTvCommands} from './tv-commands.js';
test('commands target one session, expire and accept matching acknowledgements only',()=>{let at=0;const q=createTvCommands({now:()=>at});assert.equal(q.enqueue({session:'s',action:'eval'}).status,400);const a=q.enqueue({session:'s',action:'uke-phone'});assert.equal(a.status,202);assert.equal(q.next('other'),null);assert.equal(q.enqueue({session:'s',action:'uke-state'}).status,409);q.ack('other',{id:a.body.id,status:'done'});assert.ok(q.next('s'));q.ack('s',{id:a.body.id,status:'done'});assert.equal(q.next('s'),null);assert.equal(q.get(a.body.id).result.status,'done');const b=q.enqueue({session:'s',action:'uke-open'});at=60001;assert.equal(q.next('s'),null);q.ack('s',{id:b.body.id,status:'done'});assert.equal(q.get(b.body.id).expired,true);});
test('playback actions are allowlisted and keep only their own fields', () => {
  let at = 0;
  const allowed = new Set(['Kids/Timmy Time.mp4']);
  const q = createTvCommands({ now: () => at, allowSrc: src => allowed.has(src) });
  for (const action of ['up', 'down', 'channel', 'eval', 'queue']) assert.equal(q.enqueue({ session: 's', action }).status, 400, action);
  assert.equal(q.enqueue({ session: 's', action: 'queue-next' }).status, 400);
  assert.equal(q.enqueue({ session: 's', action: 'queue-next', src: 'http://evil/a.mp4' }).status, 400);
  assert.equal(q.enqueue({ session: 's', action: 'queue-next', src: '../secret.mp4' }).status, 400);
  assert.equal(q.enqueue({ session: 's', action: 'seek' }).status, 400);
  assert.equal(q.enqueue({ session: 's', action: 'seek', seconds: -5 }).status, 400);
  assert.equal(q.enqueue({ session: 's', action: 'tune', channel: { id: 'x' } }).status, 400);
  assert.equal(q.enqueue({ session: 's', action: 'tune', channel: '' }).status, 400);

  const next = q.enqueue({ session: 's', action: 'queue-next', src: 'Kids/Timmy Time.mp4' });
  assert.equal(next.status, 202);
  assert.deepEqual(
    { action: q.next('s').action, src: q.next('s').src, positionSeconds: q.next('s').positionSeconds },
    { action: 'queue-next', src: 'Kids/Timmy Time.mp4', positionSeconds: undefined },
  );
  q.ack('s', { id: next.body.id, status: 'done' });

  const paused = q.enqueue({ session: 's', action: 'pause' });
  assert.equal(paused.status, 202);
  assert.equal(q.next('s').action, 'pause');
  assert.equal(q.next('s').src, undefined);
  assert.equal(q.next('s').seconds, undefined);
  q.ack('s', { id: paused.body.id, status: 'done' });

  for (const action of ['resume', 'home', 'back']) {
    const item = q.enqueue({ session: 's', action });
    assert.equal(item.status, 202, action);
    assert.equal(q.next('s').action, action);
    assert.equal(Object.hasOwn(q.next('s'), 'src'), false, action);
    q.ack('s', { id: item.body.id, status: 'done' });
  }

  const seek = q.enqueue({ session: 's', action: 'seek', seconds: 12.8 });
  assert.equal(seek.status, 202);
  assert.equal(q.next('s').action, 'seek');
  assert.equal(q.next('s').seconds, 13);
  q.ack('s', { id: seek.body.id, status: 'done' });

  const byNumber = q.enqueue({ session: 's', action: 'tune', channel: 5 });
  assert.equal(byNumber.status, 202);
  assert.equal(q.next('s').channel, 5);
  q.ack('s', { id: byNumber.body.id, status: 'done' });
  const byId = q.enqueue({ session: 's', action: 'tune', channel: 'christmas' });
  assert.equal(byId.status, 202);
  assert.equal(q.next('s').channel, 'christmas');
});

test('play is on the allowlist and carries only a library source and optional position',()=>{let at=0;const allowed=new Set(['Kids/Timmy Time.mp4']);const q=createTvCommands({now:()=>at,allowSrc:src=>allowed.has(src)});assert.equal(q.enqueue({session:'s',action:'play'}).status,400);assert.equal(q.enqueue({session:'s',action:'play',src:'../secret.mp4'}).status,400);assert.equal(q.enqueue({session:'s',action:'play',src:'http://evil/a.mp4'}).status,400);assert.equal(q.enqueue({session:'s',action:'play',src:'Other/nope.mp4'}).status,400);assert.equal(q.enqueue({session:'s',action:'play',src:'Kids/Timmy Time.mp4',positionSeconds:-1}).status,400);const play=q.enqueue({session:'s',action:'play',src:'Kids/Timmy Time.mp4',positionSeconds:84.2});assert.equal(play.status,202);assert.equal(q.next('s').src,'Kids/Timmy Time.mp4');assert.equal(q.next('s').positionSeconds,84);assert.equal(q.next('s').action,'play');const again=createTvCommands({now:()=>at,allowSrc:src=>allowed.has(src)});const bare=again.enqueue({session:'s',action:'play',src:'Kids/Timmy Time.mp4'});assert.equal(again.next('s').positionSeconds,null);assert.equal(bare.status,202);});
