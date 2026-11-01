/* Embedded LAN race. No browser launch; remote events stay within this frame. */
(function (win, doc) {
  'use strict';
  var frame = null, timer = null, origin = '';
  function close() {
    if (timer) clearTimeout(timer); timer = null;
    if (frame) { frame.src = 'about:blank'; frame.parentNode.removeChild(frame); frame = null; }
  }
  function key(code, pressed) {
    if (!frame) return false;
    if (code === 10009 || code === 27) { close(); return true; }
    frame.contentWindow.postMessage({ type: 'onto-couch-key', keyCode: code, pressed: pressed !== false }, '*');
    return true;
  }
  function open() {
    if (frame) return;
    var address = (win.ONTO_CONFIG && win.ONTO_CONFIG.couchServer) || 'http://192.168.20.20:8690';
    var link = doc.createElement('a'); link.href = address; origin = link.protocol + '//' + link.host;
    frame = doc.createElement('iframe'); frame.id = 'onto-couch'; frame.title = 'RC race';
    frame.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;border:0;background:#081018;z-index:10000';
    frame.src = win.ONTO_CONFIG && win.ONTO_CONFIG.couchToken ? 'rc-couch.html?tv=1' : address + '/rc/couch.html?tv=1'; doc.body.appendChild(frame);
    frame.onload = function () { if (frame) frame.focus(); };
  }
  win.addEventListener('message', function (event) {
    if (frame && event.source === frame.contentWindow && event.data && event.data.type === 'onto-couch-exit') close();
  });
  doc.addEventListener('keyup', function (event) { if (frame) key(event.keyCode, false); });
  win.ontoCouch = { open: open, close: close, key: key, isOpen: function () { return !!frame; } };
}(window, document));
