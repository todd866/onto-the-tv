const test = require('node:test');
const assert = require('node:assert/strict');
const { keyFor, encodePath, readWeights, saveWeights, appendLog, durationWeight, inStream, learnedWeight, pickVideo, createPlayer } = require('../player.js');

const videos = [
  { src:'Example Show/A #? [12345678].mp4', channel:'Example Show', title:'<img src=x onerror=alert(1)>', tier:'shared' },
  { src:'Another Show/B.mp4', channel:'Another Show', title:'Episode B', tier:'shared' },
  { src:'Big/C.mp4', channel:'Big', title:'Episode C', tier:'big' },
];
class Element {
  constructor(tagName='DIV') { this.tagName=tagName; this.listeners={}; this.hidden=false; this.style={}; this.children=[]; this.textContent=''; this.disabled=false; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatch(name, event={}) { for (const callback of this.listeners[name] || []) callback(event); }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children=[]; }
  set innerHTML(_) { throw new Error('Unsafe innerHTML assignment'); }
}
function fixture(options={}) {
  const elements={};
  for (const id of ['smum','sdad','sboth','adultTools','adultTimeline','seek','elapsed','duration','rewind','forward','later','saved','closeSaved','savedPanel','savedRows','savedEmpty','vid','splash','panel','toast','statusText','status','retry','pause','skip','back','controls','panelTitle','weightRows','s2','s6','sgrown','smusic','sall','preferShort','switch','preferences','closePanel','fullscreen','reset']) elements[id]=new Element();
  if (options.profileFlow) for (const id of ['profiles','streams','pickerTitle','audienceSwitch','pmum','pdad','pboth','pgrown','p2','p6']) elements[id]=new Element();
  elements.panel.hidden=true; elements.savedPanel.hidden=true;
  const vid=elements.vid;
  Object.assign(vid,{paused:true,currentTime:0,duration:120,muted:false,playCount:0,readyState:0});
  vid.play=options.play || function () { this.playCount++; this.readyState=1; this.dispatch('loadedmetadata'); this.paused=false; this.dispatch('playing'); return Promise.resolve(); };
  vid.pause=function () { this.paused=true; this.dispatch('pause'); };
  vid.removeAttribute=function (name) { delete this[name]; };
  vid.load=function () { this.currentTime=0; this.duration=120; };
  const document=new Element();
  document.getElementById=id => elements[id];
  document.createElement=tag => new Element(tag.toUpperCase());
  document.documentElement={};
  const entries={};
  let clock=1000;
  const environment={parent:options.parent,ONTO_TASTE_TOKEN:options.exportToken,ONTO_AUDIENCES:options.audiences,location:{search:options.search || ''},setTimeout:()=>1,clearTimeout:()=>{},confirm:()=>true,random:options.random || (()=>0),
    now:options.now || (()=>clock++),addEventListener:(name,callback)=>{(window.listeners[name] ||= []).push(callback);},
    localStorage:options.storage || {getItem:key=>(key in entries ? entries[key] : null),setItem:(key,value)=>{entries[key]=value;}}};
  const window={listeners:{},dispatch(name,event={}){for (const callback of window.listeners[name] || []) callback(event);}};
  if (options.storageGetterThrows) Object.defineProperty(environment,'localStorage',{get(){throw Error('Blocked');}});
  const player=createPlayer(document,environment,options.videos || videos);
  return {player,elements,vid,document,environment,entries,window};
}

test('component URLs preserve spaces, Unicode, hashes and question marks',()=>{
  const path='Another Show/你好 #1? 100%.mp4';
  assert.equal(encodePath(path),'Another%20Show/%E4%BD%A0%E5%A5%BD%20%231%3F%20100%25.mp4');
  assert.equal(encodePath('../Shows/A.mp4'),'../Shows/A.mp4');
});
test('storage accepts only known finite numeric weights, clamps and forgives them',()=>{
  const data=JSON.stringify({[videos[0].src]:-99,[videos[1].src]:99,[videos[2].src]:'2',removed:3});
  const result=readWeights({getItem:()=>data},2,videos);
  assert.equal(Object.getPrototypeOf(result),null);
  assert.equal(result[videos[0].src],0.3625);
  assert.equal(result[videos[1].src],3.25);
  assert.equal(result[videos[2].src],undefined);
  assert.equal(result.removed,undefined);
  for (const raw of ['null','[]','"bad"','{broken']) assert.equal(Object.keys(readWeights({getItem:()=>raw},2,videos)).length,0);
  assert.equal(saveWeights({setItem(){throw Error('quota');}},2,{}),false);
});
test('completion outranks early skip and errors never teach a preference',()=>{
  assert.equal(learnedWeight(1,'skip',100,120),1.3);
  assert.equal(learnedWeight(1,'skip',30,120),0.7);
  assert.equal(learnedWeight(1,'skip',200,1000),1);
  assert.equal(learnedWeight(1,'error',120,120),1);
  assert.equal(learnedWeight(3.9,'ended',120,120),4);
  assert.equal(learnedWeight(0.15,'skip',10,120),0.15);
});
test('show-first picker does not favour a catalog with 90 episodes over one with one',()=>{
  const catalog=Array.from({length:91},(_,i)=>({src:`${i}.mp4`,channel:i<90?'Large':'Small'}));
  let seed=12345;
  const random=()=>((seed=(Math.imul(1664525,seed)+1013904223)>>>0)/4294967296);
  let small=0;
  for(let trial=0;trial<10000;trial++) if(pickVideo(catalog,catalog.map((_,i)=>i),{},-1,new Set(),[],random)===90) small++;
  assert.ok(small>4700 && small<5300,`Small catalog selected ${small}/10000 times`);
});
test('picker avoids immediate and short-history repeats, but permits a lone working file',()=>{
  const catalog=Array.from({length:8},(_,i)=>({src:`${i}.mp4`,channel:'Same'}));
  const pool=catalog.map((_,i)=>i);
  const selected=pickVideo(catalog,pool,{},7,new Set(),[3,4,5,6,7],()=>0);
  assert.equal(selected,0);
  assert.equal(pickVideo(catalog,[0,1],{},0,new Set(),[0],()=>0),1);
  assert.equal(pickVideo(catalog,[0,1],{},0,new Set([1]),[0],()=>0),0);
  assert.equal(pickVideo(catalog,pool,{},0,new Set(pool),[0],()=>0),-1);
});
test('successive media failures stop after each file once and do not upvote',()=>{
  const {player,vid,elements}=fixture();
  player.startStream(2);
  for(let count=0;count<2;count++) { vid.currentTime=120; vid.duration=120; vid.error={code:3}; vid.dispatch('error'); }
  assert.equal(player.state.cur,-1);
  assert.equal(player.state.failed.size,2);
  assert.equal(vid.playCount,2);
  assert.equal(Object.keys(player.state.weights).length,0);
  assert.equal(elements.status.hidden,false);
  assert.match(elements.statusText.textContent,/could not be played/);
  assert.equal(elements.skip.disabled,true);
  assert.equal(vid.paused,true);
  vid.dispatch('error');
  assert.equal(vid.playCount,2);
});
test('storage read, write and property-access failures do not prevent playback',()=>{
  for(const options of [{storage:{getItem(){throw Error('denied');},setItem(){throw Error('quota');}}},{storageGetterThrows:true}]) {
    const {player,vid}=fixture(options);
    assert.doesNotThrow(()=>player.startStream(2));
    vid.currentTime=20;
    assert.doesNotThrow(()=>player.next('skip'));
    assert.equal(vid.playCount,2);
  }
});
test('blocked playback has an actionable retry and retries the same video',async()=>{
  let calls=0;
  const {player,vid,elements}=fixture({play(){calls++; if(calls===1) return Promise.reject(Object.assign(Error('gesture'),{name:'NotAllowedError'})); this.paused=false; this.dispatch('playing'); return Promise.resolve();}});
  player.startStream(2);
  const current=player.state.cur;
  await Promise.resolve();
  assert.equal(elements.status.hidden,false);
  assert.equal(elements.retry.hidden,false);
  elements.retry.dispatch('click');
  await Promise.resolve();
  assert.equal(player.state.cur,current);
  assert.equal(elements.status.hidden,true);
  assert.equal(vid.paused,false);
});
test('stream switch resets session, errors, panels and ignores old playback rejections',async()=>{
  let reject;
  const {player,vid,elements}=fixture({play(){return new Promise((_,r)=>{reject=r;});}});
  player.startStream(2);
  player.showWeights();
  player.state.failed.add(1);
  player.switchStream();
  reject(Error('late rejection'));
  await Promise.resolve();
  assert.equal(player.state.cur,-1);
  assert.equal(player.state.stream,null);
  assert.equal(player.state.history.length,0);
  assert.equal(player.state.failed.size,0);
  assert.equal(elements.panel.hidden,true);
  assert.equal(elements.status.hidden,true);
  assert.equal(elements.controls.hidden,true);
  assert.equal(elements.splash.hidden,false);
  assert.equal(vid.src,undefined);
  player.startStream(6);
  assert.equal(player.state.pool.length,3);
  assert.equal(player.state.failed.size,0);
});
test('silent QA mutes, pause/resume and Space work, and rows contain literal text',()=>{
  const {player,vid,elements,document}=fixture({search:'?audioQa=silent'});
  assert.equal(vid.muted,true);
  player.startStream(2);
  elements.pause.dispatch('click');
  assert.equal(vid.paused,true);
  let prevented=false;
  document.dispatch('keydown',{key:' ',code:'Space',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(vid.paused,false);
  player.showWeights();
  assert.equal(elements.weightRows.children[0].children[1].textContent,videos[0].title);
  assert.equal(elements.panel.hidden,false);
});
test('streams retain separate v2 learned weights and empty playlists stop cleanly',()=>{
  const {player,vid,entries}=fixture();
  player.startStream(2); vid.currentTime=20; player.next('skip');
  assert.equal(JSON.parse(entries[keyFor(2)])[videos[0].src],0.7);
  player.switchStream(); player.startStream(6);
  assert.equal(player.state.weights[videos[0].src],undefined);
  const empty=fixture({videos:[videos[2]]});
  empty.player.startStream(2);
  assert.equal(empty.player.state.cur,-1);
  assert.match(empty.elements.statusText.textContent,/No episodes/);
});

test('stale media events from a previous or cleared source do not fail the new file',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const first=vid.src;
  player.next('skip');
  const second=player.state.cur;
  vid.error={code:3}; vid.currentSrc=first;
  vid.dispatch('error');
  assert.equal(player.state.cur,second);
  assert.equal(player.state.failed.size,0);
  vid.currentSrc=vid.src; vid.error=null;
  vid.dispatch('error');
  assert.equal(player.state.failed.size,0);
  player.switchStream(); vid.error={code:3};
  vid.dispatch('error');
  assert.equal(player.state.cur,-1);
});
test('choosing a channel stays in the app until full screen is requested',()=>{
  const {player,document,elements}=fixture();
  let calls=0;
  document.documentElement.requestFullscreen=()=>{calls++;return Promise.resolve();};
  player.startStream(2);
  assert.equal(calls,0);
  elements.fullscreen.dispatch('click');
  assert.equal(calls,1);
});

test('Back resumes skipped video and forward revisits existing future without a random pick',()=>{
  let picks=0;
  const {player,vid,elements}=fixture({random:()=>{picks++;return 0;}});
  player.startStream(2);
  assert.equal(elements.back.disabled,true);
  const first=player.state.cur;
  vid.currentTime=37;
  player.next('skip');
  const second=player.state.cur;
  vid.currentTime=12;
  const picksBefore=picks;
  assert.equal(elements.back.disabled,false);
  elements.back.dispatch('click');
  assert.equal(player.state.cur,first);
  assert.equal(vid.currentTime,37);
  assert.equal(elements.back.disabled,true);
  assert.equal(player.state.weights[videos[first].src],1);
  player.next('skip');
  assert.equal(player.state.cur,second);
  assert.equal(vid.currentTime,12);
  assert.equal(picks,picksBefore);
  assert.equal(player.state.navigation.length,2);
  assert.equal(player.state.weights[videos[first].src],0.7);
  player.back();
  assert.equal(player.state.weights[videos[first].src],1);
});

test('saved seek waits for matching metadata and rapid navigation keeps both captured positions',()=>{
  const {player,vid}=fixture({play(){this.paused=false;return Promise.resolve();}});
  const metadata=()=>{vid.readyState=1;vid.currentSrc=vid.src;vid.dispatch('loadedmetadata');vid.dispatch('playing');};
  player.startStream(2); metadata();
  vid.currentTime=42;
  player.next('skip'); metadata();
  vid.currentTime=18;
  const second=vid.src;
  player.back();
  // A queued event for the old B source must not seek the incoming A.
  vid.currentTime=0;vid.currentSrc=second;vid.readyState=1;
  vid.dispatch('loadedmetadata');
  assert.equal(vid.currentTime,0);
  assert.equal(player.state.pendingSeek.time,42);
  // Move forward before A's metadata; its saved42 seconds must survive.
  player.next('skip'); metadata();
  assert.equal(vid.currentTime,18);
  player.back();
  vid.currentTime=0;vid.readyState=0;vid.currentSrc=vid.src;
  vid.dispatch('loadedmetadata');
  assert.equal(vid.currentTime,0);
  metadata();
  assert.equal(vid.currentTime,42);
  assert.equal(player.state.pendingSeek,null);
});

test('undo replays later independent feedback with caps rather than restoring an old weight',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const src=videos[player.state.cur].src;
  player.state.weights[src]=3.5;
  vid.currentTime=20;player.next('skip'); // A1:3.5 ->2.45
  vid.currentTime=120;player.next('ended'); // B1 completion
  assert.equal(videos[player.state.cur].src,src);
  vid.currentTime=120;player.next('ended'); // A2:2.45 ->3.185
  assert.ok(Math.abs(player.state.weights[src]-3.185)<1e-10);
  player.back(); // A2 completion must remain
  player.back(); // B1 completion must remain
  player.back(); // Undo only A1 skip; A2 now caps3.5*1.3 at4
  assert.equal(player.state.weights[src],4);
  player.next('skip');player.back();
  assert.equal(player.state.weights[src],4);
});

test('a completed episode restarts on Back without a second completion upvote',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const first=player.state.cur,src=videos[first].src;
  vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
  player.back();
  assert.equal(player.state.cur,first);
  assert.equal(vid.currentTime,0);
  vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
});

test('undo handles repeated early skips and floor clipping precisely',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const src=videos[player.state.cur].src;
  player.state.weights[src]=0.2;
  vid.currentTime=20;player.next('skip'); // A1 clipped to0.15
  vid.currentTime=200;vid.duration=1000;player.next('skip'); // B neutral
  vid.currentTime=20;player.next('skip'); // A2 already atfloor, event must still be recorded
  player.back(); // Undo A2 (no-op originally)
  player.next('skip'); // confirms A2 skip once again
  player.back();player.back();player.back(); // cancel A2 again, then cancel A1
  assert.equal(player.state.weights[src],0.2);
});

test('history traversal skips broken files in either direction and stops when all fail',()=>{
  const {player,vid,elements}=fixture();
  player.startStream(6); // A
  player.next('skip'); // B
  player.next('skip'); // C
  const last=player.state.cur;
  player.back(); // B
  const broken=player.state.cur;
  vid.error={code:3};vid.currentSrc=vid.src;vid.dispatch('error'); // continue back to A
  assert.notEqual(player.state.cur,broken);
  assert.equal(player.state.navIndex,0);
  assert.equal(player.state.weights[videos[player.state.cur].src],1);
  assert.equal(elements.back.disabled,true);
  player.next('skip'); // bypass broken B to existing C
  assert.equal(player.state.cur,last);
  assert.equal(player.state.navigation.length,3);
  for(let count=0;count<3 && player.state.cur>=0;count++) {
    vid.error={code:3};vid.currentSrc=vid.src;vid.dispatch('error');
  }
  assert.equal(player.state.cur,-1);
  assert.equal(player.state.failed.size,3);
  assert.equal(elements.back.disabled,true);
  assert.equal(elements.skip.disabled,true);
});

test('navigation keeps 50 entries and folds retired learning without losing it',()=>{
  const {player,vid,elements}=fixture();
  player.startStream(2);
  for(let i=0;i<60;i++) {vid.currentTime=20;player.next('skip');}
  assert.equal(player.state.navigation.length,50);
  assert.equal(player.state.navIndex,49);
  assert.ok([...player.state.feedback.values()].reduce((count,ledger)=>count+ledger.events.length,0)<=50);
  for(let i=0;i<49;i++) player.back();
  assert.equal(player.state.navIndex,0);
  assert.equal(elements.back.disabled,true);
  // Eleven retired skips keep both videos disliked after undoing retained ones.
  assert.ok(player.state.weights[videos[0].src]<0.2);
  assert.ok(player.state.weights[videos[1].src]<0.2);
  const count=vid.playCount;
  player.back();
  assert.equal(vid.playCount,count);
});

test('Left/Right and S navigate while Space pauses; stream switch clears buttons and history',()=>{
  const {player,vid,elements,document}=fixture();
  const key=name=>{
    let prevented=false;
    document.dispatch('keydown',{key:name,preventDefault(){prevented=true;}});
    assert.equal(prevented,true);
  };
  player.startStream(2);vid.currentTime=23;
  key('ArrowRight');
  const second=player.state.cur;
  key('ArrowLeft');
  assert.equal(vid.currentTime,23);
  key('s');
  assert.equal(player.state.cur,second);
  key(' ');
  assert.equal(vid.paused,true);
  player.switchStream();
  assert.equal(player.state.navigation.length,0);
  assert.equal(player.state.navIndex,-1);
  assert.equal(player.state.feedback.size,0);
  assert.equal(elements.back.disabled,true);
  player.startStream(6);
  assert.equal(player.state.navigation.length,1);
  assert.equal(elements.back.disabled,true);
});

test('preference reset is not undone by navigating older history',()=>{
  const {player,vid,elements}=fixture();
  player.startStream(2);vid.currentTime=20;player.next('skip');
  elements.reset.dispatch('click');
  player.back();player.next('skip');
  assert.equal(Object.keys(player.state.weights).length,0);
  assert.equal(player.state.feedback.size,0);
});

test('stale play rejection during Back cannot interrupt forward playback',async()=>{
  let reject;
  const {player,vid,elements}=fixture();
  player.startStream(2);vid.currentTime=24;player.next('skip');
  const normalPlay=vid.play;
  vid.play=()=>new Promise((_,rejectPromise)=>{reject=rejectPromise;});
  player.back();
  vid.play=normalPlay;
  player.next('skip');
  reject(Error('old back request rejected'));
  await Promise.resolve();
  assert.equal(elements.status.hidden,true);
  assert.equal(vid.paused,false);
});


test('Back keeps an earned80-percent completion reward from Skip',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const src=videos[player.state.cur].src;
  vid.currentTime=100;player.next('skip');
  assert.equal(player.state.weights[src],1.3);
  player.back();
  assert.equal(player.state.weights[src],1.3);
  vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
});

test('cancelled skip can earn completion, while repeated Back/Forward never compounds penalties',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const src=videos[player.state.cur].src;
  vid.currentTime=20;player.next('skip');
  for(let i=0;i<100;i++) {
    player.back();
    assert.equal(player.state.weights[src],1);
    player.next('skip');
    assert.equal(player.state.weights[src],0.7);
  }
  assert.ok([...player.state.feedback.values()].reduce((count,ledger)=>count+ledger.events.length,0)<=2);
  player.back();
  vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
  player.back();vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
});

test('a completed replay later resumes newly captured progress instead of restarting forever',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  vid.currentTime=120;player.next('ended');
  player.back();
  assert.equal(vid.currentTime,0);
  vid.currentTime=30;player.next('skip');
  player.back();
  assert.equal(vid.currentTime,30);
});

test('rapid forward while a restored seek is pending grades the captured watch time',()=>{
  const {player,vid}=fixture();
  player.startStream(2);vid.currentTime=20;player.next('skip');
  const src=videos[player.state.cur].src;
  vid.currentTime=18;player.back();
  const normalPlay=vid.play;
  vid.play=function(){this.currentTime=0;this.readyState=0;return Promise.resolve();};
  player.next('skip');
  assert.equal(player.state.pendingSeek.time,18);
  player.next('skip');
  assert.equal(player.state.weights[src],0.7);
  vid.play=normalPlay;
});

test('skipping before playback then returning can earn one completion reward',()=>{
  const {player,vid}=fixture({play(){this.readyState=0;return Promise.resolve();}});
  player.startStream(2);
  const src=videos[player.state.cur].src;
  player.next('skip');
  assert.equal(player.state.navigation[0].graded,false);
  player.back();
  vid.readyState=1;vid.dispatch('loadedmetadata');
  vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
  player.back();vid.readyState=1;vid.dispatch('loadedmetadata');
  vid.currentTime=120;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
});

test('a neutral partial watch can earn its first reward after Back and completion',()=>{
  const {player,vid}=fixture();
  player.startStream(2);
  const src=videos[player.state.cur].src;
  vid.currentTime=200;vid.duration=1000;player.next('skip');
  assert.equal(player.state.navigation[0].graded,false);
  player.back();
  vid.currentTime=1000;vid.duration=1000;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
  player.back();vid.currentTime=1000;vid.duration=1000;player.next('ended');
  assert.equal(player.state.weights[src],1.3);
});

test('streams are explicit tiers, never an accidental superset',()=>{
  const {player}=fixture();
  player.startStream(2);
  assert.deepEqual(player.state.pool,[0,1]);            // shared only; 'big' excluded
  player.switchStream(); player.startStream(6);
  assert.deepEqual(player.state.pool,[0,1,2]);          // shared + big
  player.switchStream(); player.startStream('all');
  assert.deepEqual(player.state.pool,[0,1,2]);
  assert.equal(inStream({tier:'preschool'},6),false);   // a toddler show never reaches Big Kids
  assert.equal(inStream({tier:'older'},2),false);
  assert.equal(inStream({tier:'older'},6),false);
  assert.equal(inStream({tier:'older'},'all'),true);
  assert.equal(inStream({tier:'nonsense'},'all'),false);
  assert.equal(inStream({tier:'grownup'},6),false);
  assert.equal(inStream({tier:'grownup'},'grown'),true);    // an unclassified tier reaches no stream
});
test('duration weighting leaves short episodes alone and tames compilations',()=>{
  assert.equal(durationWeight({duration:420},true),1);
  assert.equal(durationWeight({duration:900},true),1);
  assert.equal(durationWeight({duration:3600},true),0.25);
  assert.equal(durationWeight({duration:14400},true),0.0625);
  assert.equal(durationWeight({duration:900000},true),0.05);  // floor: still reachable
  assert.equal(durationWeight({duration:14400},false),1);     // toggle off restores equality
  assert.equal(durationWeight({},true),1);
  assert.equal(durationWeight({duration:'x'},true),1);
});
test('the picker prefers short episodes until the long-drive toggle is turned off',()=>{
  const pool=[
    {src:'Short/1.mp4',channel:'Short',title:'1',tier:'shared',duration:420},
    {src:'Short/2.mp4',channel:'Short',title:'2',tier:'shared',duration:420},
    {src:'Long/1.mp4',channel:'Long',title:'1',tier:'shared',duration:14400},
    {src:'Long/2.mp4',channel:'Long',title:'2',tier:'shared',duration:14400},
  ];
  let seed=1; const random=()=>{seed=(seed*1103515245+12345)%2147483648; return seed/2147483648;};
  const share=preferShort=>{
    let long=0; const runs=20000;
    for (let i=0;i<runs;i++) if (pickVideo(pool,[0,1,2,3],{},-1,new Set(),[],random,preferShort)>=2) long++;
    return long/runs;
  };
  const biased=share(true), even=share(false);
  assert.ok(biased<0.12,`long share with bias ${biased}`);
  assert.ok(even>0.4 && even<0.6,`long share without bias ${even}`);
});
test('every visit is logged with the position reached, including tab close',()=>{
  const {player,vid,entries,window}=fixture();
  player.startStream(2);
  vid.currentTime=42; player.next('skip');
  vid.currentTime=90; player.back();
  vid.currentTime=12; player.switchStream();
  const log=JSON.parse(entries['kidshuffle.log.v1']);
  assert.deepEqual(log.map(e=>[e.v,e.w,e.p,e.d,e.r,e.s]),[
    ['Example Show/A #? [12345678].mp4',42,0,120,'skip',2],
    ['Another Show/B.mp4',90,0,120,'back',2],
    ['Example Show/A #? [12345678].mp4',12,42,120,'switch',2],   // resumed at 42, so 12 is a fresh visit
  ]);
  assert.ok(log.every(e=>Number.isFinite(e.t)));
  const second=fixture();
  second.player.startStream(2); second.vid.currentTime=7;
  second.window.dispatch('pagehide');
  assert.equal(JSON.parse(second.entries['kidshuffle.log.v1'])[0].r,'hide');
});
test('a partial watch that teaches the learner nothing is still recorded',()=>{
  const {player,vid,entries}=fixture();
  player.startStream(2);
  vid.duration=7200; vid.currentTime=5400;   // 75%: no reward, no penalty
  player.next('skip');
  assert.equal(JSON.parse(entries[keyFor(2)])['Example Show/A #? [12345678].mp4'],undefined);
  assert.deepEqual(JSON.parse(entries['kidshuffle.log.v1']).map(e=>[e.w,e.d,e.r]),[[5400,7200,'skip']]);
});
test('one visit logs once and an unwatched video logs nothing',()=>{
  const {player,vid,entries}=fixture();
  player.startStream(2);
  vid.currentTime=30; player.next('skip'); player.back(); player.next('skip');
  const seen=JSON.parse(entries['kidshuffle.log.v1']);
  assert.equal(seen.length,3);
  const quiet=fixture({play(){ return Promise.resolve(); }});   // never reaches 'playing'
  quiet.player.startStream(2);
  quiet.player.next('skip');
  assert.equal(quiet.entries['kidshuffle.log.v1'],undefined);
});
test('the log keeps another writer entries and is capped without losing the newest',()=>{
  const shared={}; const store={getItem:k=>(k in shared?shared[k]:null),setItem:(k,v)=>{shared[k]=v;}};
  assert.equal(appendLog(store,{v:'first'}),true);
  assert.equal(appendLog(store,{v:'second'}),true);
  assert.deepEqual(JSON.parse(shared['kidshuffle.log.v1']).map(e=>e.v),['first','second']);
  shared['kidshuffle.log.v1']=JSON.stringify(Array.from({length:3000},(_,i)=>({v:'old'+i})));
  appendLog(store,{v:'newest'});
  const log=JSON.parse(shared['kidshuffle.log.v1']);
  assert.equal(log.length,3000);
  assert.equal(log[log.length-1].v,'newest');
  assert.equal(log[0].v,'old1');
  assert.equal(appendLog({getItem:()=>'not json',setItem(){}},{v:'x'}),true);
  assert.equal(appendLog({getItem:()=>null,setItem(){throw Error('quota');}},{v:'x'}),false);
});
test('saving learning merges instead of replacing another tab entries',()=>{
  const shared={}; const store={getItem:k=>(k in shared?shared[k]:null),setItem:(k,v)=>{shared[k]=v;}};
  const {player,vid}=fixture({storage:store});
  player.startStream('all');
  vid.currentTime=20; player.next('skip');
  const other=JSON.parse(shared[keyFor('all')]); other['Big/C.mp4']=0.42;
  saveWeights(store,'all',other);                       // a second tab records a video this one has not touched
  vid.currentTime=20; player.next('skip');
  const stored=JSON.parse(shared[keyFor('all')]);
  assert.equal(stored['Big/C.mp4'],0.42);
  assert.equal(stored['Example Show/A #? [12345678].mp4'],0.7);
  assert.equal(stored['Another Show/B.mp4'],0.7);
});
test('reset still clears the whole record despite merging saves',()=>{
  const shared={}; const store={getItem:k=>(k in shared?shared[k]:null),setItem:(k,v)=>{shared[k]=v;}};
  const {player,vid,elements}=fixture({storage:store});
  player.startStream('all');
  vid.currentTime=20; player.next('skip');
  const other=JSON.parse(shared[keyFor('all')]); other['Big/C.mp4']=0.42;
  saveWeights(store,'all',other);
  elements.reset.dispatch('click');
  assert.deepEqual(JSON.parse(shared[keyFor('all')]),{});
});
test('the short-episode choice persists and survives a storage refusal',()=>{
  const {player,entries,elements}=fixture();
  player.startStream(2);
  assert.equal(player.state.preferShort,true);
  elements.preferShort.checked=false; elements.preferShort.dispatch('change');
  assert.equal(player.state.preferShort,false);
  assert.equal(entries['kidshuffle.preferShort.v1'],'0');
  const reopened=fixture({storage:{getItem:k=>(k in entries?entries[k]:null),setItem(){}}});
  assert.equal(reopened.player.state.preferShort,false);
  const blocked=fixture({storage:{getItem(){throw Error('denied');},setItem(){throw Error('quota');}}});
  assert.equal(blocked.player.state.preferShort,true);
  assert.doesNotThrow(()=>blocked.player.setPreferShort(false));
});
test('the preferences panel names all three streams',()=>{
  const {player,elements}=fixture();
  for (const [stream,label] of [[2,'Little Kids 2+'],[6,'Big Kids 6+'],['all','Everything']]) {
    player.switchStream(); player.startStream(stream); player.showWeights();
    assert.match(elements.panelTitle.textContent,new RegExp(label.replace('+','\\+')));
    player.showWeights();
  }
});

const adultVideos = videos.map(video => ({...video,tier:'grownup'}));
test('Later is neutral, restores the saved position and survives a new player', () => {
  const f = fixture({videos:adultVideos});
  f.player.startStream('dad'); const original=f.player.state.cur;
  f.vid.currentTime=37; f.player.later();
  assert.notEqual(f.player.state.cur,original);
  assert.equal(f.player.state.weights[adultVideos[original].src],undefined);
  f.player.resumeSaved(original); assert.equal(f.vid.currentTime,37);
  const other=fixture({videos:adultVideos,storage:f.environment.localStorage});
  other.player.startStream('dad'); assert.notEqual(other.player.state.cur,original); other.player.resumeSaved(original);
  assert.equal(other.vid.currentTime,37);
});
test('Mum, Dad and Both keep independent feedback and bookmarks', () => {
  const f=fixture({videos:adultVideos,audiences:true});
  f.player.startStream('mum'); const original=f.player.state.cur;
  f.vid.currentTime=30; f.player.later();
  f.player.startStream('dad'); assert.equal(f.vid.currentTime,0);
  f.player.next('skip');
  assert.equal(JSON.parse(f.entries[keyFor('dad')])[adultVideos[original].src],0.7);
  assert.equal(JSON.parse(f.entries[keyFor('mum')])[adultVideos[original].src],undefined);
  const dad=f.entries[keyFor('dad')];
  f.player.startStream('both'); f.player.next('skip');
  assert.equal(f.entries[keyFor('dad')],dad);
  f.player.startStream('mum'); f.player.resumeSaved(original); assert.equal(f.vid.currentTime,30);
});
test('Both favours overlap, while joint choices can develop separately', () => {
  const {togetherWeight}=require('../player.js');
  assert.equal(togetherWeight(2,2),2);
  assert.ok(togetherWeight(4,0.15)<0.3);
  assert.equal(togetherWeight(1,1),1);
  assert.equal(togetherWeight(2,1),togetherWeight(1,2));
  assert.ok(togetherWeight(1,1,1.3)>1);
});
test('Seeking preserves pause and does not turn scrubbed progress into a preference', () => {
  const f=fixture({videos:adultVideos}); f.player.startStream('grown');
  const original=f.player.state.cur; f.vid.pause(); f.player.seekTo(90);
  assert.equal(f.vid.currentTime,90); assert.equal(f.vid.paused,true);
  f.player.next('skip'); assert.equal(f.player.state.weights[adultVideos[original].src],undefined);
  f.player.seekTo(-10); assert.equal(f.vid.currentTime,0);
  f.player.seekTo(999); assert.equal(f.vid.currentTime,120);
});
test('Deferring every episode stops without a dislike and leaves Saved usable', () => {
  const f=fixture({videos:adultVideos});f.player.startStream('dad');
  for (let i=0;i<adultVideos.length;i++) f.player.later();
  assert.equal(f.player.state.cur,-1); assert.deepEqual(Object.keys(f.player.state.weights),[]);
  f.player.showSaved(); assert.equal(f.elements.savedRows.children.length,adultVideos.length);
});

test('Taste export requires the app capability and filters damaged saved data', () => {
  const sent=[], parent={postMessage:data=>sent.push(data)};
  const f=fixture({videos:adultVideos,parent,exportToken:'test-capability'});
  f.entries['onto.adult.v1.mum']=JSON.stringify({[adultVideos[0].src]:{time:10,saved:true},bad:{time:-1}});
  f.entries[keyFor('dad')]=JSON.stringify({[adultVideos[0].src]:9,unknown:2});
  assert.equal(sent.length,0);
  f.window.dispatch('message',{source:parent,data:{type:'onto:export',token:'wrong'}});
  assert.equal(sent.length,0);
  f.window.dispatch('message',{source:parent,data:{type:'onto:export',token:'test-capability'}});
  assert.equal(sent.length,1);
  assert.equal(sent[0].profiles.mum.bookmarks[adultVideos[0].src].updated,0);
  assert.equal(sent[0].profiles.dad.weights[adultVideos[0].src],4);
  assert.equal(sent[0].profiles.dad.weights.unknown,undefined);
});

test('Audience selection opens channels without playing and scopes subsequent choices', () => {
  const f=fixture({videos:[...adultVideos,{src:'Music/a.mp4',title:'Music',tier:'music'}],profileFlow:true,audiences:true});
  f.player.chooseAudience('dad');
  assert.equal(f.vid.playCount,0);
  assert.equal(f.elements.profiles.hidden,true);
  assert.equal(f.elements.streams.hidden,false);
  assert.equal(f.elements.sgrown.hidden,false);
  f.player.chooseChannel('music');
  assert.equal(f.player.state.stream,'dad.music');
  assert.equal(f.player.state.pool.length,1);
  f.player.next('skip');
  assert.ok(f.entries[keyFor('dad')]);
  assert.equal(f.entries[keyFor('mum')],undefined);
  f.player.switchStream();
  f.player.chooseChannel('grown');
  assert.equal(f.player.state.stream,'dad');
  const reopened=fixture({videos:adultVideos,profileFlow:true,audiences:true,storage:f.environment.localStorage});
  assert.equal(reopened.elements.profiles.hidden,true);
  assert.equal(reopened.vid.playCount,0);
});
test('Kids get their age group and music, without the adult or Everything channels', () => {
  const f=fixture({profileFlow:true,audiences:true});
  f.player.chooseAudience('2');
  assert.equal(f.elements.s2.hidden,false);
  assert.equal(f.elements.s6.hidden,true);
  assert.equal(f.elements.sgrown.hidden,true);
  assert.equal(f.elements.sall.hidden,true);
  assert.equal(f.elements.smum.hidden,true);
  f.player.chooseChannel("all"); assert.equal(f.vid.playCount,0);
});
