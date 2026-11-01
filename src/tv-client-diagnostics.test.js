import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../tv/diagnostics.js', import.meta.url), 'utf8');
function harness({ broken = false } = {}) {
  const requests = [], events = {}, timers = [];
  const window = { ONTO_CONFIG: { token: 'private-token', servers: ['http://mac:8686'], build: 'test-1' },
    addEventListener(name, callback) { events[name] = callback; } };
  function XMLHttpRequest() {
    if (broken) throw Error('network unavailable');
    this.open = () => {};
    this.setRequestHeader = () => {};
    this.send = body => requests.push({ body: JSON.parse(body), request: this });
  }
  vm.runInNewContext(source, { window, document: { hidden: false }, location: { protocol: 'http:', origin: 'http://mac:8686' }, XMLHttpRequest,
    setInterval(callback) { timers.push(callback); } });
  return { window, events, timers, requests };
}
test('diagnostics captures startup and sanitized failures without leaking content', () => {
  const h = harness();
  assert.equal(h.requests[0].body.event, 'startup');
  h.requests[0].request.status = 200;
  h.requests[0].request.onloadend();
  h.events.error({ target: h.window, message: '/private/movie.mp4?token=secret' });
  assert.equal(h.requests[1].body.errorCode, 'runtime');
  assert.ok(!JSON.stringify(h.requests).includes('movie'));
  assert.ok(!JSON.stringify(h.requests).includes('private-token'));
});
test('only one request in flight; pending events stay bounded during an outage', () => {
  const h = harness();
  for (let n = 0; n < 100; n++) h.window.ontoDiagnostics.emit('playing', { position: n });
  assert.equal(h.requests.length, 1);
  for (let n = 0; n < h.requests.length; n++) {
    h.requests[n].request.status = 200;
    h.requests[n].request.onloadend();
  }
  assert.equal(h.requests.length, 33);
  assert.equal(h.requests.at(-1).body.position, 99);
});
test('failed telemetry and faulty samplers cannot throw into playback', () => {
  const h = harness({ broken: true });
  assert.doesNotThrow(() => h.window.ontoDiagnostics.emit('play_request'));
  h.window.ontoDiagnostics.sample(() => { throw Error('no player yet'); });
  assert.doesNotThrow(() => h.timers[0]());
});

test('controller evidence survives subsequent heartbeats without device data loss', () => {
  const h = harness();
  const controller = {supported:true,count:1,devices:[{index:0,id:'USB Gamepad',mapping:'unknown',buttons:12,axes:4}],lastInput:'button-0',error:'none'};
  h.requests[0].request.status=200;h.requests[0].request.onloadend();
  h.window.ontoDiagnostics.emit('controller',{controller});
  h.requests[1].request.status=200;h.requests[1].request.onloadend();
  h.timers[0]();
  assert.deepEqual(h.requests.at(-1).body.controller,controller);
});
