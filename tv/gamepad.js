/* Gamepad navigation and bounded local diagnostics, compatible with the TV runtime. */
(function (win, doc) {
  'use strict';
  var timer, stopped = false, gated = true, held = {}, repeats = {}, devices = [], lastInput = 'none';
  var lastShape = '', lastReport = 0, error = 'none', previousId = '', wasCouch = false;
  var lastPoll = null, slots = 0, raw = [], connects = 0, disconnects = 0;
  var codes = {left:37, up:38, right:39, down:40, a:13, back:10009, start:10252};
  function emitKey(name, down, repeat) {
    var event = doc.createEvent('Event'); event.initEvent(down ? 'keydown' : 'keyup', true, true);
    try {
      Object.defineProperty(event, 'keyCode', {value:codes[name]});
      Object.defineProperty(event, 'which', {value:codes[name]});
      Object.defineProperty(event, 'repeat', {value:!!repeat});
    } catch (e) {
      try { event.keyCode=codes[name]; event.which=codes[name]; event.repeat=!!repeat; } catch (ignored) { return; }
    }
    doc.dispatchEvent(event);
  }
  function release() {
    Object.keys(held).forEach(function (name) { if (held[name]) emitKey(name, false); });
    held = {}; repeats = {};
  }
  function sample() {
    return {supported:typeof navigator.getGamepads === 'function', count:devices.length, devices:devices,
      lastInput:lastInput, error:error, poll:{ageMs:lastPoll === null ? null : Math.min(86400000, Math.max(0, Date.now()-lastPoll)),
      stopped:stopped, hidden:!!doc.hidden, focused:typeof doc.hasFocus === 'function' ? !!doc.hasFocus() : null,
      slots:slots, raw:raw, connects:connects, disconnects:disconnects}};
  }
  function report() {
    var shape = JSON.stringify(devices) + error, now = Date.now();
    if (shape === lastShape && now - lastReport < 5000) return;
    lastShape = shape; lastReport = now;
    if (win.ontoDiagnostics) win.ontoDiagnostics.emit('controller', {controller:sample()});
  }
  function pressed(g, n) { return !!(g.buttons && g.buttons[n] && g.buttons[n].pressed); }
  function axis(g, n) { return Number(g.axes && g.axes[n]) || 0; }
  function neutral(g) {
    var i;
    for (i=0;i<Math.min(64,(g.buttons || []).length);i++) if (pressed(g,i)) return false;
    for (i=0;i<Math.min(32,(g.axes || []).length);i++) if (Math.abs(axis(g,i))>.25) return false;
    return true;
  }
  function typing() {
    var e = doc.activeElement;
    return e && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.isContentEditable);
  }
  function ownFrame() {
    var e = doc.activeElement;
    return e && e.tagName === 'IFRAME' && (e.id === 'onto-uke' || e.id === 'onto-couch');
  }
  function tick() {
    timer = null;
    var pads = [], selected = null;
    error = typeof navigator.getGamepads === 'function' ? 'none' : 'unavailable';
    try { if (error === 'none') pads = navigator.getGamepads() || []; } catch (e) {error = 'read-failed';}
    lastPoll = Date.now(); slots = Math.min(16, pads.length || 0); raw = [];
    devices = [];
    for (var i = 0; i < pads.length && i < 16 && devices.length < 4; i++) {
      var g = pads[i]; if (!g) continue;
      raw.push({index:i, connected:g.connected === true ? 'true' : g.connected === false ? 'false' : typeof g.connected === 'undefined' ? 'undefined' : 'other'});
      if (g.connected === false) continue;
      devices.push({index:i, id:String(g.id || '').replace(/[^\x20-\x7e]/g, '').slice(0,128),
        mapping:g.mapping === 'standard' ? 'standard' : 'unknown',
        buttons:Math.min(64,(g.buttons || []).length), axes:Math.min(32,(g.axes || []).length)});
      if (!selected || (selected.mapping !== 'standard' && g.mapping === 'standard')) selected = g;
      for (var b=0; b<Math.min(64,(g.buttons || []).length); b++) if (pressed(g,b)) {lastInput='button-'+b;break;}
      if (b === Math.min(64,(g.buttons || []).length)) {
        for (var a=0;a<Math.min(32,(g.axes || []).length);a++) if (Math.abs(axis(g,a))>.25) {lastInput='axis-'+a;break;}
      }
    }
    report();
    var identity = selected ? selected.id + ':' + selected.index : '';
    if (identity !== previousId) {release();gated=true;previousId=identity;}
    var couch = !!(win.ontoCouch && win.ontoCouch.isOpen());
    if (couch !== wasCouch) {release();gated=true;wasCouch=couch;}
    if (stopped || doc.hidden || typing() || !selected || selected.mapping !== 'standard') {release();gated=true;}
    else if (gated) {if (neutral(selected)) gated=false;}
    else {
      var values = couch ? {back:pressed(selected,1)} : {
        left:pressed(selected,14)||axis(selected,0)<-.5, right:pressed(selected,15)||axis(selected,0)>.5,
        up:pressed(selected,12)||axis(selected,1)<-.5, down:pressed(selected,13)||axis(selected,1)>.5,
        a:pressed(selected,0),back:pressed(selected,1),start:pressed(selected,9)};
      Object.keys(codes).forEach(function (name) {
        var down=!!values[name], now=Date.now();
        if (down !== !!held[name]) {
          held[name]=down; repeats[name]=now+450;
          if (couch && name==='back') {if(down) win.ontoCouch.key(10009,true);}
          else emitKey(name,down,false);
        } else if (down && !couch && /^(left|right|up|down)$/.test(name) && now>=repeats[name]) {
          emitKey(name,true,true);repeats[name]=now+160;
        }
      });
    }
    timer=win.setTimeout(tick,100);
  }
  function stop() {stopped=true;gated=true;release();if(timer) win.clearTimeout(timer);timer=null;}
  function start() {stopped=false;gated=true;if(!timer) timer=win.setTimeout(tick,0);}
  win.addEventListener('blur',function () {if(!ownFrame()) stop();});
  win.addEventListener('focus',start);
  doc.addEventListener('visibilitychange',function () {if(doc.hidden) stop();else start();});
  win.addEventListener('gamepadconnected',function () {connects=Math.min(65535,connects+1);});
  win.addEventListener('gamepaddisconnected',function () {disconnects=Math.min(65535,disconnects+1);release();gated=true;});
  win.addEventListener('pagehide',function () {stop();if(timer) win.clearTimeout(timer);});
  win.ontoGamepad={sample:sample,start:start,stop:stop};
  timer=win.setTimeout(tick,0);
}(window,document));
