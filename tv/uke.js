/* Uke player wrapper. Keeps the Samsung/Tizen remote in the parent shell. */
(function (win, doc) {
  'use strict';
  var frame = null, origin = '', onClose = null, lastState = null, statusTimer = null;
  var bridge = {phase:'closed', origin:'none'};
  function trace(phase, seenOrigin, detail) { bridge={phase:phase,origin:seenOrigin === 'null' ? 'null' : seenOrigin === 'file://' ? 'file' : seenOrigin ? 'other' : 'none'}; if(detail && phase==='error') {bridge.errorName=detail.errorName;bridge.line=detail.line;bridge.column=detail.column;} if(win.ontoDiagnostics) win.ontoDiagnostics.emit('uke_state',{uke:{bridge:bridge}}); }
  function post(message) { if(frame) frame.contentWindow.postMessage(message,origin === 'null' ? '*' : origin); }
  function close() {
    if (!frame) return;
    if(statusTimer) clearInterval(statusTimer); statusTimer=null; lastState=null;
    frame.src = 'about:blank';
    if (frame.parentNode) frame.parentNode.removeChild(frame);
    frame = null; origin = ''; win.ONTO_UKE_CONFIG = null; var done = onClose; onClose = null; if (done) done();
  }
  function key(code) {
    if (!frame) return false;
    if ([37, 38, 39, 40, 8, 13, 27, 10009, 10252, 10233, 10232, 415, 19, 413].indexOf(code) < 0) return false;
    frame.contentWindow.postMessage({ type: 'onto:uke:key', code: code }, origin === 'null' ? '*' : origin);
    return true;
  }
  function open(server, closed) {
    if (frame) return;
    onClose = closed;
    var link = doc.createElement('a'); link.href = server;
    origin = link.protocol + '//' + link.host;
    frame = doc.createElement('iframe'); frame.id = 'onto-uke'; frame.title = 'Uke player';
    frame.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0;background:#000;z-index:10000';
    win.ONTO_UKE_CONFIG = { server: server, token: win.ONTO_CONFIG && win.ONTO_CONFIG.token || '' };
    var packaged = location.protocol !== 'http:' && location.protocol !== 'https:';
    if (packaged) origin = location.protocol === 'file:' ? 'null' : location.origin;
    var parentOrigin = packaged ? origin : location.origin;
    frame.src = packaged ? './uke/index.html?tv=1&onto=1&parentOrigin=' + encodeURIComponent(parentOrigin)
      : server.replace(/\/$/, '') + '/uke/?tv=1&onto=1&parentOrigin=' + encodeURIComponent(parentOrigin);
    doc.body.appendChild(frame); trace('created');
    frame.onload = function () {
      if (frame) frame.focus(); trace('loaded');
      if(statusTimer) clearInterval(statusTimer);
      statusTimer=setInterval(function () {post({type:'uke:practice-status'});},5000);
    };
  }
  win.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow) return;
    if(event.data && event.data.type==='uke:probe') { trace(event.data.phase==='error'?'error':'boot',event.origin,event.data); return; }
    if(event.data && event.data.type==='uke:ready') trace('ready',event.origin);
    var localFile = location.protocol === 'file:' && (origin === 'null' || origin === 'file://') && (event.origin === 'null' || event.origin === 'file://');
    if(event.origin !== origin && !localFile) return;
    if (event.data && event.data.type === 'uke:practice-status' && event.data.status) {
      lastState=event.data.status; lastState.bridge=bridge;
      if(win.ontoDiagnostics) win.ontoDiagnostics.emit('uke_state',{uke:lastState});
    }
    if (event.data && event.data.type === 'uke:exit') close();
  });
  function command(action) {
    return new Promise(function (resolve,reject) {
      if(!frame) return reject(Error('Uke closed'));
      var target=frame, started=Date.now(), sent=false;
      function check() {
        if(frame!==target || Date.now()-started>12000) return reject(Error('Uke not ready'));
        if(!sent) {
          if(action==='uke-phone') post({type:'uke:practice-open'});
          if(action==='uke-follow') post({type:'uke:practice-follow',enabled:true,division:1});
          sent=true;
        }
        post({type:'uke:practice-status'});
        if(lastState && (action!=='uke-phone'||lastState.active) && (action!=='uke-follow'||lastState.following)) return resolve(lastState);
        // Retry the idempotent open/follow until the embedded page is loaded.
        sent=false;setTimeout(check,500);
      }
      lastState=null;check();
    });
  }
  win.ontoUke = { command:command, open: open, close: close, key: key, isOpen: function () { return !!frame; } };
}(window, document));
