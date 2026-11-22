/* The installed TV app's loader. ES5: the TV's Chromium 47.
   It builds the page from the server's copy of the interface (GET /api/tv-live, then its stylesheets and scripts),
   so a change to the interface reaches the TV without a reinstall. If no server answers in time it builds the
   page from the copy packaged at install (window.ONTO_LOCAL), so the app always starts.
   A live script that fails to load reloads the app once on the packaged copy. */
(function () {
  'use strict';
  var config = window.ONTO_CONFIG || {}, local = window.ONTO_LOCAL || null, servers = config.servers || [];
  var WAIT_MS = 2500, started = false;
  var skipLive = false;
  try { skipLive = window.sessionStorage.getItem('onto.live.off') === '1'; window.sessionStorage.removeItem('onto.live.off'); } catch (e) {}

  function build(page, base, live) {
    var head = document.head || document.getElementsByTagName('head')[0], i, link, stamp;
    if (started || !page) return;
    started = true;
    stamp = live ? '?v=' + encodeURIComponent(page.build || '') : '';
    for (i = 0; i < page.styles.length; i++) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      if (page.styles[i].id) link.id = page.styles[i].id;
      link.href = base + page.styles[i].href + stamp;
      head.appendChild(link);
    }
    document.body.innerHTML = page.body;
    if (live) { config.packagedBuild = config.build; config.build = page.build; config.live = base; }
    (function next(index) {
      var script;
      if (index >= page.scripts.length) return;
      script = document.createElement('script');
      script.src = base + page.scripts[index] + stamp;
      script.onload = function () { next(index + 1); };
      script.onerror = function () {
        if (!live) { next(index + 1); return; }
        try { window.sessionStorage.setItem('onto.live.off', '1'); } catch (e) {}
        location.reload();
      };
      document.body.appendChild(script);
    }(0));
  }
  function useLocal() { build(local, '', false); }
  function ask(index) {
    var request, base, timer, settled = false;
    if (started) return;
    if (index >= servers.length) { useLocal(); return; }
    base = String(servers[index]).replace(/\/$/, '');
    function fail() { if (settled) return; settled = true; clearTimeout(timer); try { request.abort(); } catch (e) {} ask(index + 1); }
    try {
      request = new XMLHttpRequest();
      request.open('GET', base + '/api/tv-live', true);
      request.setRequestHeader('X-Onto-Token', config.token || '');
      request.onload = function () {
        var page = null;
        if (settled) return;
        if (request.status === 200) { try { page = JSON.parse(request.responseText); } catch (e) { page = null; } }
        if (!page || !page.body || !page.scripts || !page.scripts.length || !page.styles) { fail(); return; }
        settled = true;
        clearTimeout(timer);
        build(page, base + '/', true);
      };
      request.onerror = fail;
      timer = setTimeout(fail, WAIT_MS);
      request.send();
    } catch (e) { fail(); }
  }
  if (skipLive || !servers.length || !config.token || !local) useLocal();
  else ask(0);
}());
