/* Pair a browser with this server once: the code buys an HttpOnly cookie (src/tv-auth.js). ES5. */
(function () {
  'use strict';
  var form = document.getElementById('pair-form'), input = document.getElementById('pair-code'), status = document.getElementById('pair-status');
  // Where to go after pairing: only a path on this server, never another site. Browsers read a backslash as a
  // slash ("/\\evil.com" is "//evil.com"), so backslashes and control characters are refused outright.
  function safeNext(search) {
    var match = /[?&]next=([^&]*)/.exec(search || ''), value = '/';
    if (match) { try { value = decodeURIComponent(match[1]); } catch (e) { return '/'; } }
    if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
    if (value.charAt(0) !== '/' || value.charAt(1) === '/') return '/';
    return value.indexOf('/pair.html') === 0 ? '/' : value;
  }
  window.ontoPairNext = safeNext;
  if (!form) return;
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    status.textContent = 'Pairing…';
    fetch('/api/pair', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input.value }) }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || ('Server error ' + response.status));
        status.textContent = 'Paired.';
        location.replace(safeNext(location.search));
      });
    }).catch(function (error) { status.textContent = error.message; input.select(); });
  });
}());
