import { randomUUID } from 'node:crypto';
const ACTIONS = new Set(['uke-open','uke-phone','uke-follow','uke-state','play','queue-next','pause','resume','seek','home','tune','back']);
const BARE = new Set(['pause','resume','home','back']);
function srcText(body) {
  const src = body && body.src;
  if (typeof src !== 'string' || src.length < 1 || src.length > 400 || src.includes('..') || src.includes('\\') || src.includes('\0') || src.startsWith('/') || /%2e%2e/i.test(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
  return src;
}
function playOf(body, allowSrc) {
  const src = srcText(body);
  if (!src) return null;
  let positionSeconds = null;
  if (body.positionSeconds != null) {
    if (typeof body.positionSeconds !== 'number' || !Number.isFinite(body.positionSeconds) || body.positionSeconds < 0 || body.positionSeconds > 86400) return null;
    positionSeconds = Math.round(body.positionSeconds);
  }
  if (typeof allowSrc === 'function' && !allowSrc(src)) return null;
  return { src, positionSeconds };
}
function shapeOf(body, allowSrc) {
  if (body.action === 'play') return playOf(body, allowSrc);
  if (body.action === 'queue-next') {
    const src = srcText(body);
    if (!src || (typeof allowSrc === 'function' && !allowSrc(src))) return null;
    return { src };
  }
  if (body.action === 'seek') {
    if (typeof body.seconds !== 'number' || !Number.isFinite(body.seconds) || body.seconds < 0 || body.seconds > 86400) return null;
    return { seconds: Math.round(body.seconds) };
  }
  if (body.action === 'tune') {
    const channel = body.channel;
    if (typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 999) return { channel };
    if (typeof channel === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(channel)) return { channel };
    return null;
  }
  if (BARE.has(body.action)) return {};
  return undefined;
}
export function createTvCommands({now=Date.now,allowSrc}={}) {
  const items=new Map();
  function prune() {for(const [id,item] of items) if(now()-item.createdAt>300000) items.delete(id);}
  function view(item) {
    const out={id:item.id,action:item.action,expiresAt:item.expiresAt};
    if(item.action==='play') {out.src=item.src;out.positionSeconds=item.positionSeconds;}
    else if(item.action==='queue-next') out.src=item.src;
    else if(item.action==='seek') out.seconds=item.seconds;
    else if(item.action==='tune') out.channel=item.channel;
    return out;
  }
  return {
    enqueue(body) {
      prune();
      if(!body || !ACTIONS.has(body.action) || typeof body.session!=='string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.session)) return {status:400,body:{error:'Invalid TV command.'}};
      const shaped=shapeOf(body,allowSrc);
      if(shaped===null) return {status:400,body:{error:'Invalid TV command.'}};
      if(items.size>=32) return {status:429,body:{error:'Command capacity reached.'}};
      if([...items.values()].some(x=>x.session===body.session&&!x.result&&x.expiresAt>now())) return {status:409,body:{error:'TV command already pending.'}};
      const item={id:randomUUID(),session:body.session,action:body.action,createdAt:now(),expiresAt:now()+60000,result:null};
      if(shaped && shaped.src!==undefined) item.src=shaped.src;
      if(shaped && shaped.positionSeconds!==undefined) item.positionSeconds=shaped.positionSeconds;
      if(shaped && shaped.seconds!==undefined) item.seconds=shaped.seconds;
      if(shaped && shaped.channel!==undefined) item.channel=shaped.channel;
      items.set(item.id,item);
      return {status:202,body:item};
    },
    next(session) {prune();const item=[...items.values()].find(x=>x.session===session&&!x.result&&x.expiresAt>now());return item?view(item):null;},
    ack(session,ack) {
      if(!ack || typeof ack.id!=='string') return;
      const item=items.get(ack.id);
      if(!item || item.session!==session || item.result || item.expiresAt<=now()) return;
      if(!['done','failed'].includes(ack.status)) return;
      item.result={status:ack.status,at:now()};
    },
    get(id) {prune();const item=items.get(id);return item?{...item,expired:!item.result&&item.expiresAt<=now()}:null;}
  };
}
