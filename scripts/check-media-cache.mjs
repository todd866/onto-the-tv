// Silent M2 acceptance: actual external media through the same HTTP/cache code.
import {mkdtemp,readFile,stat,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createMediaCache} from '../src/media-cache.js';
import {createFileStorage,createTvLibrary,createTvServer} from '../src/tv-server.js';
import {loadPlaybackHistory} from '../src/playback-history.js';
const file=process.argv[2],directory=process.argv[3];
if(!file?.startsWith('/Volumes/')||!directory)throw Error('Provide an existing external media file and internal cache directory');
const info=await stat(file),temp=await mkdtemp(join(tmpdir(),'onto-cache-live-'));
const options={directory};let cache,server;
const hash=b=>createHash('sha256').update(b).digest('hex');
try {
 cache=await createMediaCache(options);
 const warmStart=performance.now();await cache.warm(file,info,{durationSeconds:600});const warmMs=performance.now()-warmStart;
 await cache.close();cache=await createMediaCache(options); // disk persistence, not RAM
 const history=await loadPlaybackHistory(join(temp,'history.json')),storage=await createFileStorage(join(temp,'taste.json'));
 const library=createTvLibrary({videos:[{src:'acceptance.mp4',file,title:'Acceptance',channel:'Test',tier:'shared',duration:600}],history,storage});
 server=createTvServer({library,history,storage,mediaCache:cache,token:'temporary-acceptance',uiRoot:temp});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const ranges=[[0,65535],[4*1024**2-100,4*1024**2+100],[Math.floor(info.size/2),Math.min(info.size-1,Math.floor(info.size/2)+65535)],[Math.max(0,info.size-65536),info.size-1]];
 const checks=[];
 for(const [start,end] of ranges){
  const began=performance.now();const response=await fetch(base+'/media?src=acceptance.mp4',{headers:{Range:`bytes=${start}-${end}`}});const bytes=Buffer.from(await response.arrayBuffer());const ms=performance.now()-began;
  const h=await open(file,'r'),expected=Buffer.alloc(end-start+1);try{let offset=0;while(offset<expected.length){const {bytesRead}=await h.read(expected,offset,expected.length-offset,start+offset);if(!bytesRead)throw Error('Unexpected EOF');offset+=bytesRead;}}finally{await h.close();}
  if(response.status!==206||!bytes.equals(expected))throw Error('Range bytes mismatch');checks.push({start,end,status:response.status,sha256:hash(bytes),milliseconds:Math.round(ms*10)/10});
 }
 console.log(JSON.stringify({file,size:info.size,warmMilliseconds:Math.round(warmMs),checks,stats:cache.stats(),complete:true},null,2));
} finally {if(server)await new Promise(r=>server.close(r));if(cache)await cache.close();await rm(temp,{recursive:true,force:true});}
