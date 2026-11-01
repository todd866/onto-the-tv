import { randomUUID } from 'node:crypto';
const ACTIONS = new Set(['uke-open','uke-phone','uke-follow','uke-state']);
export function createTvCommands({now=Date.now}={}) {
  const items=new Map();
  function prune() {for(const [id,item] of items) if(now()-item.createdAt>300000) items.delete(id);}
  return {
    enqueue(body) {
      prune();
      if(!body || !ACTIONS.has(body.action) || typeof body.session!=='string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.session)) return {status:400,body:{error:'Invalid TV command.'}};
      if(items.size>=32) return {status:429,body:{error:'Command capacity reached.'}};
      if([...items.values()].some(x=>x.session===body.session&&!x.result&&x.expiresAt>now())) return {status:409,body:{error:'TV command already pending.'}};
      const item={id:randomUUID(),session:body.session,action:body.action,createdAt:now(),expiresAt:now()+60000,result:null};items.set(item.id,item);
      return {status:202,body:item};
    },
    next(session) {prune();const item=[...items.values()].find(x=>x.session===session&&!x.result&&x.expiresAt>now());return item?{id:item.id,action:item.action,expiresAt:item.expiresAt}:null;},
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
