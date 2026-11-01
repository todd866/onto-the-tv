import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function makePad(mapping='standard') { return { connected: true, id: 'Retro Stick\nsecret', mapping, axes: [0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) }; }
function harness(pad) {
  const listeners = {}, events = [], telemetry = [], pads = pad ? [pad] : []; let id = 1, now = 0, timers = [];
  const doc = { hidden: false, activeElement: null, addEventListener(t, f) { (listeners['d' + t] ||= []).push(f); }, createEvent() { return { initEvent(t) { this.type = t; } }; }, dispatchEvent(e) { events.push({ type: e.type, code: e.keyCode, repeat: !!e.repeat }); } };
  const win = { setTimeout(fn, ms) { const item = { id: id++, fn, due: now + (ms || 0) }; timers.push(item); timers.sort((a, b) => a.due - b.due); return item.id; }, clearTimeout(x) { timers = timers.filter(t => t.id !== x); }, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, ontoDiagnostics: { emit(t, b) { telemetry.push({ t, b }); } } };
  const nav = { getGamepads: () => pads }; const context = { window: win, document: doc, navigator: nav, Date: { now: () => now }, JSON, Math, String, Number, Object, Array };
  vm.runInNewContext(fs.readFileSync(new URL('../tv/gamepad.js', import.meta.url), 'utf8'), context);
  return { win, doc, nav, pads, events, telemetry, advance(ms) { now += ms; while (timers[0] && timers[0].due <= now) timers.shift().fn(); }, fire(t, v) { (listeners[t] || []).concat(listeners['d' + t] || []).forEach(f => f(v || {})); } };
}


test('arrows repeat; A, B, Start are edges only; both analog axes work', () => {
 const g=makePad(),h=harness(g);h.advance(1);
 g.buttons[15].pressed=true;h.advance(100);h.advance(500);assert.ok(h.events.some(e=>e.code===39&&e.repeat));
 g.buttons[15].pressed=false;g.axes[1]=-.8;h.advance(100);assert.ok(h.events.some(e=>e.code===38));
 g.axes[1]=0;g.buttons[0].pressed=true;g.buttons[1].pressed=true;g.buttons[9].pressed=true;h.advance(100);h.advance(600);
 for(const code of [13,10009,10252])assert.equal(h.events.filter(e=>e.code===code&&e.type==='keydown').length,1);
});
test('unknown mapping input and sparse indices are observable, bounded to four devices',()=>{
 const g=makePad(''),h=harness();h.pads[3]=g;for(let i=4;i<9;i++)h.pads[i]=makePad('');g.buttons[0].pressed=true;h.advance(1);
 const c=h.telemetry.at(-1).b.controller;assert.equal(c.count,4);assert.equal(c.devices[0].index,3);assert.equal(c.lastInput,'button-0');assert.equal(h.events.length,0);
});
test('background input releases and held controls must return neutral before resuming',()=>{
 const g=makePad(),h=harness(g);h.advance(1);g.buttons[0].pressed=true;h.advance(100);h.fire('blur');assert.equal(h.events.at(-1).type,'keyup');
 const n=h.events.length;h.fire('focus');h.advance(100);assert.equal(h.events.length,n);g.buttons[0].pressed=false;h.advance(100);g.buttons[0].pressed=true;h.advance(100);assert.equal(h.events.length,n+1);
 h.doc.hidden=true;h.fire('visibilitychange');assert.equal(h.events.at(-1).type,'keyup');
});
test('own Uke frame keeps navigation; RC owns analog and receives Back once',()=>{
 const g=makePad(),h=harness(g);h.advance(1);h.doc.activeElement={tagName:'IFRAME',id:'onto-uke'};h.fire('blur');g.buttons[0].pressed=true;h.advance(100);assert.ok(h.events.some(e=>e.code===13));
 g.buttons[0].pressed=false;let back=0;h.win.ontoCouch={isOpen:()=>true,key:()=>back++};h.advance(100);g.axes[0]=1;h.advance(100);assert.equal(h.events.filter(e=>e.code===39).length,0);g.buttons[1].pressed=true;h.advance(100);h.advance(600);assert.equal(back,1);
});
test('disconnect, missing API and read failure are explicit without stale controls',()=>{
 const g=makePad(),h=harness(g);h.advance(1);g.buttons[0].pressed=true;h.advance(100);g.connected=false;h.advance(100);assert.equal(h.events.at(-1).type,'keyup');assert.equal(h.win.ontoGamepad.sample().count,0);
 h.nav.getGamepads=()=>{throw Error('no');};h.advance(100);assert.equal(h.telemetry.at(-1).b.controller.error,'read-failed');delete h.nav.getGamepads;h.advance(100);assert.equal(h.telemetry.at(-1).b.controller.error,'unavailable');
});

test('missing connected property remains visible and poll age exposes a stopped reader',()=>{
 const g=makePad(),h=harness(g);delete g.connected;h.advance(1);
 assert.equal(h.win.ontoGamepad.sample().count,1);
 assert.equal(h.win.ontoGamepad.sample().poll.raw[0].connected,'undefined');
 h.fire('blur');h.advance(6000);const p=h.win.ontoGamepad.sample().poll;
 assert.equal(p.stopped,true);assert.equal(p.ageMs,6000);
 h.fire('gamepadconnected');h.fire('gamepaddisconnected');
 assert.equal(h.win.ontoGamepad.sample().poll.connects,1);assert.equal(h.win.ontoGamepad.sample().poll.disconnects,1);
 h.fire('focus');h.advance(1);assert.equal(h.win.ontoGamepad.sample().poll.ageMs,0);
});

test('array-like legacy axes and buttons pass neutral gating',()=>{
 const g=makePad(),h=harness(g);g.axes={0:0,1:0,length:2};g.buttons={0:{pressed:false},length:1};
 h.advance(1);g.buttons[0].pressed=true;h.advance(100);assert.ok(h.events.some(e=>e.code===13));
});
