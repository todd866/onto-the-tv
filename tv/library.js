/* Library: Up next, collections, shows, films, and a D-pad keyboard. ES5 for Tizen 3. */
(function () {
  'use strict';
  if (window.ONTO_CONFIG && window.ONTO_CONFIG.guest) return;

  var GLYPH = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><path d="M24 16h152v78H24z"/><path d="M24 55h152"/><path d="M64 16v39M108 55v39M148 16v39"/></svg>';
  var MODES = [
    ['home', 'Home'],
    ['shows', 'Shows'],
    ['films', 'Films'],
    ['all', 'Everything'],
    ['search', 'Search']
  ];
  var KEYS = [
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
    ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'],
    ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'del'],
    ['space', 'clear']
  ];

  window.ontoAppGlyphs = window.ontoAppGlyphs || {};
  window.ontoAppGlyphs.library = GLYPH;
  window.ontoLibraryCard = function (last) {
    return { id: 'library', number: last + 4, name: 'Library', app: 'library' };
  };

  var options = document.getElementById('options');
  if (options) {
    var opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'opt';
    opt.setAttribute('data-opt', 'library');
    opt.innerHTML = '<span class="glyph" aria-hidden="true">' + GLYPH + '</span><span class="k">Library</span>';
    options.appendChild(opt);
  }

  var root = null;
  var openFlag = false;
  var suspended = false;
  var origin = 'home';
  var view = 'home';
  var previousView = 'home';
  var payload = null;
  var query = '';
  var openShow = null;
  var loadToken = 0;
  var rows = [];
  var resultEls = [];
  var cursor = { area: 'main', row: 0, col: 0 };
  var keyAnchor = { row: 1, col: 0 };

  function clock(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor(s / 60) % 60;
    var r = s % 60;
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    if (h > 0) return h + ':' + pad(m) + ':' + pad(r);
    return m + ':' + pad(r);
  }

  function artUrl(path) {
    if (!path) return '';
    if (window.ontoArtUrl) return window.ontoArtUrl(path);
    return path;
  }

  function loadArt(img, url) {
    if (!img || !url) return;
    var image = new Image();
    image.onload = function () {
      var apply = function () { if (img.parentNode) img.src = url; };
      if (image.decode) image.decode().then(apply, apply);
      else apply();
    };
    image.onerror = function () { img.style.visibility = 'hidden'; };
    image.src = url;
  }

  function ensure() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'library';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Library');
    var modes = document.createElement('div');
    modes.id = 'library-modes';
    var body = document.createElement('div');
    body.id = 'library-body';
    root.appendChild(modes);
    root.appendChild(body);
    root.addEventListener('click', onClick);
    document.body.appendChild(root);
  }

  function modeIndex(id) {
    var i;
    for (i = 0; i < MODES.length; i++) if (MODES[i][0] === id) return i;
    return 0;
  }

  function reveal(el) {
    var parent = el && el.parentNode;
    while (parent && parent !== root) {
      if (parent.scrollHeight > parent.clientHeight + 2 || parent.scrollWidth > parent.clientWidth + 2) {
        var box = el.getBoundingClientRect();
        var area = parent.getBoundingClientRect();
        if (box.top < area.top + 8) parent.scrollTop -= area.top + 8 - box.top;
        if (box.bottom > area.bottom - 8) parent.scrollTop += box.bottom - area.bottom + 8;
        if (box.left < area.left + 8) parent.scrollLeft -= area.left + 8 - box.left;
        if (box.right > area.right - 8) parent.scrollLeft += box.right - area.right + 8;
      }
      parent = parent.parentNode;
    }
  }

  function applyFocus() {
    if (!root) return;
    var nodes = root.querySelectorAll('.focused');
    var i, el, list;
    for (i = 0; i < nodes.length; i++) nodes[i].classList.remove('focused');
    if (cursor.area === 'results') {
      if (!resultEls.length) { cursor.area = 'main'; cursor.row = keyAnchor.row; cursor.col = keyAnchor.col; }
      else {
        if (cursor.row < 0) cursor.row = 0;
        if (cursor.row > resultEls.length - 1) cursor.row = resultEls.length - 1;
        el = resultEls[cursor.row];
      }
    }
    if (cursor.area !== 'results') {
      if (!rows.length) return;
      if (cursor.row < 0) cursor.row = 0;
      if (cursor.row > rows.length - 1) cursor.row = rows.length - 1;
      list = rows[cursor.row];
      if (!list || !list.length) return;
      if (cursor.col < 0) cursor.col = 0;
      if (cursor.col > list.length - 1) cursor.col = list.length - 1;
      el = list[cursor.col];
    }
    if (!el) return;
    el.classList.add('focused');
    try { el.focus(); } catch (e) {}
    reveal(el);
  }

  function current() {
    if (cursor.area === 'results') return resultEls[cursor.row];
    var row = rows[cursor.row];
    return row && row[cursor.col];
  }

  function focusOn(el) {
    var r, c;
    for (r = 0; r < rows.length; r++) {
      for (c = 0; c < rows[r].length; c++) if (rows[r][c] === el) {
        cursor = { area: 'main', row: r, col: c };
        return true;
      }
    }
    for (r = 0; r < resultEls.length; r++) if (resultEls[r] === el) {
      cursor = { area: 'results', row: r, col: 0 };
      return true;
    }
    return false;
  }

  function onClick(event) {
    var el = event.target;
    while (el && el !== root) {
      if (el._mode || el._key || el._item || el._show) break;
      el = el.parentNode;
    }
    if (!el || el === root) return;
    if (!focusOn(el)) return;
    activate();
  }

  function makeCard(item) {
    var button = document.createElement('button');
    var art, img, copy, title, meta, gauge, fill, time, label;
    button.type = 'button';
    button.className = 'lib-card';
    button.tabIndex = -1;
    button._item = item;
    art = document.createElement('span');
    art.className = 'lib-artbox';
    img = document.createElement('img');
    img.className = 'lib-art';
    img.alt = '';
    art.appendChild(img);
    if (item.art) loadArt(img, artUrl(item.art));
    copy = document.createElement('span');
    copy.className = 'lib-copy';
    title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = item.title || item.show || '';
    copy.appendChild(title);
    if (item.resume) {
      meta = document.createElement('span');
      meta.className = 'lib-meta';
      gauge = document.createElement('span');
      gauge.className = 'lib-gauge';
      gauge.setAttribute('aria-hidden', 'true');
      fill = document.createElement('i');
      fill.style.width = (item.durationSeconds ? Math.min(100, 100 * item.resume / item.durationSeconds) : 0) + '%';
      gauge.appendChild(fill);
      time = document.createElement('span');
      time.className = 'lib-time';
      time.textContent = clock(item.resume);
      meta.appendChild(gauge);
      meta.appendChild(time);
      copy.appendChild(meta);
    }
    button.appendChild(art);
    button.appendChild(copy);
    label = item.title || item.show || '';
    if (item.show && item.title && item.show !== item.title) label = item.show + ', ' + item.title;
    if (item.resume) label += ', resume ' + clock(item.resume);
    button.setAttribute('aria-label', label);
    button.title = label;
    return button;
  }

  function makeShowCard(show) {
    var card = makeCard({
      title: show.title,
      show: show.title,
      art: show.art,
      resume: show.resume,
      durationSeconds: show.durationSeconds
    });
    var count = (show.episodes || []).length;
    var label = show.title || '';
    card._item = null;
    card._show = show;
    if (count) label += ', ' + count + (count === 1 ? ' episode' : ' episodes');
    if (show.resume) label += ', resume ' + clock(show.resume);
    card.setAttribute('aria-label', label);
    card.title = label;
    return card;
  }

  function makeEpisode(ep, gap) {
    var button = document.createElement('button');
    var s, e, t, time, gauge, fill, label;
    button.type = 'button';
    button.className = 'lib-ep' + (gap ? ' lib-season-start' : '');
    button.tabIndex = -1;
    button._item = ep;
    s = document.createElement('span');
    s.className = 'lib-ep-s';
    s.textContent = ep.season ? 'S' + ep.season : '';
    e = document.createElement('span');
    e.className = 'lib-ep-e';
    e.textContent = ep.episode ? 'E' + ep.episode : '';
    t = document.createElement('span');
    t.className = 'lib-ep-title';
    t.textContent = ep.title || '';
    time = document.createElement('span');
    time.className = 'lib-time';
    time.textContent = ep.resume ? clock(ep.resume) : '';
    gauge = document.createElement('span');
    gauge.className = 'lib-gauge';
    gauge.setAttribute('aria-hidden', 'true');
    if (!ep.resume) gauge.style.visibility = 'hidden';
    fill = document.createElement('i');
    fill.style.width = (ep.durationSeconds ? Math.min(100, 100 * (ep.resume || 0) / ep.durationSeconds) : 0) + '%';
    gauge.appendChild(fill);
    button.appendChild(s);
    button.appendChild(e);
    button.appendChild(t);
    button.appendChild(gauge);
    button.appendChild(time);
    label = (s.textContent + ' ' + e.textContent + ' ' + (ep.title || '')).replace(/ +/g, ' ').replace(/^ /, '');
    if (ep.resume) label += ', resume ' + clock(ep.resume);
    button.setAttribute('aria-label', label);
    button.title = ep.title || '';
    return button;
  }

  function columns() {
    var width = window.innerWidth || 1920;
    if (width < 700) return 1;
    if (width < 1100) return 2;
    if (width < 1600) return 3;
    return 4;
  }

  function addStrip(body, title, items) {
    var row, name, scroller, focusables, i, card;
    if (!items || !items.length) return;
    row = document.createElement('div');
    row.className = 'lib-strip';
    name = document.createElement('div');
    name.className = 'lib-strip-name';
    name.textContent = title;
    scroller = document.createElement('div');
    scroller.className = 'lib-scroller';
    focusables = [];
    for (i = 0; i < items.length; i++) {
      card = makeCard(items[i]);
      scroller.appendChild(card);
      focusables.push(card);
    }
    row.appendChild(name);
    row.appendChild(scroller);
    body.appendChild(row);
    rows.push(focusables);
  }

  function addGrid(body, cards) {
    var n = columns(), i, c, line, focusables;
    for (i = 0; i < cards.length; i += n) {
      line = document.createElement('div');
      line.className = 'lib-grid-row';
      focusables = [];
      for (c = i; c < cards.length && c < i + n; c++) {
        line.appendChild(cards[c]);
        focusables.push(cards[c]);
      }
      body.appendChild(line);
      rows.push(focusables);
    }
  }

  function showCards() {
    var list = [], shows = (payload && payload.shows) || [], i;
    for (i = 0; i < shows.length; i++) list.push(makeShowCard(shows[i]));
    return list;
  }

  function filmCards() {
    var list = [], films = (payload && payload.films) || [], i;
    for (i = 0; i < films.length; i++) list.push(makeCard(films[i]));
    return list;
  }

  function matches(item, needle) {
    var hay = ((item.title || '') + ' ' + (item.show || '')).toLowerCase();
    return hay.indexOf(needle) >= 0;
  }

  function paintSearch(body) {
    var q = document.createElement('div');
    var wrap = document.createElement('div');
    var keys = document.createElement('div');
    var results = document.createElement('div');
    var found, needle, items, r, i, line, button, focusables, hit;
    q.className = 'lib-q';
    q.textContent = query;
    body.appendChild(q);
    wrap.className = 'lib-search';
    keys.className = 'lib-keys';
    for (r = 0; r < KEYS.length; r++) {
      line = document.createElement('div');
      focusables = [];
      for (i = 0; i < KEYS[r].length; i++) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'lib-key' + (KEYS[r][i] === 'space' || KEYS[r][i] === 'clear' ? ' lib-key-wide' : '');
        button.tabIndex = -1;
        button._key = KEYS[r][i];
        button.textContent = KEYS[r][i] === 'space' ? 'Space' : KEYS[r][i] === 'del' ? 'Del' : KEYS[r][i] === 'clear' ? 'Clear' : KEYS[r][i];
        button.setAttribute('aria-label', button.textContent);
        line.appendChild(button);
        focusables.push(button);
      }
      keys.appendChild(line);
      rows.push(focusables);
    }
    results.className = 'lib-results';
    resultEls = [];
    needle = String(query || '').toLowerCase();
    items = (payload && payload.items) || [];
    found = [];
    if (needle) {
      for (i = 0; i < items.length; i++) if (matches(items[i], needle)) found.push(items[i]);
    }
    for (i = 0; i < found.length; i++) {
      hit = makeEpisode(found[i], false);
      results.appendChild(hit);
      resultEls.push(hit);
    }
    wrap.appendChild(keys);
    wrap.appendChild(results);
    body.appendChild(wrap);
  }

  function paintEpisodes(body) {
    var eps = (openShow && openShow.episodes) || [];
    var i, last = null, button;
    for (i = 0; i < eps.length; i++) {
      button = makeEpisode(eps[i], last !== null && eps[i].season !== last);
      last = eps[i].season;
      body.appendChild(button);
      rows.push([button]);
    }
  }

  function paint() {
    var modes, body, i, button, modeRow, selected;
    ensure();
    rows = [];
    resultEls = [];
    modes = document.getElementById('library-modes');
    body = document.getElementById('library-body');
    modes.innerHTML = '';
    body.innerHTML = '';
    if (view === 'search') root.classList.add('is-search');
    else root.classList.remove('is-search');
    modeRow = [];
    selected = view === 'episodes' ? previousView : view;
    for (i = 0; i < MODES.length; i++) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'lib-mode' + (MODES[i][0] === selected ? ' on' : '');
      button.tabIndex = -1;
      button._mode = MODES[i][0];
      button.textContent = MODES[i][1];
      button.setAttribute('aria-pressed', MODES[i][0] === selected ? 'true' : 'false');
      modes.appendChild(button);
      modeRow.push(button);
    }
    rows.push(modeRow);
    if (!payload) { applyFocus(); return; }
    if (payload.error) {
      button = document.createElement('div');
      button.className = 'lib-offline';
      button.textContent = 'Offline';
      body.appendChild(button);
      applyFocus();
      return;
    }
    if (view === 'home') {
      addStrip(body, 'Up next', payload.upNext || []);
      var collections = payload.collections || [];
      for (i = 0; i < collections.length; i++) addStrip(body, collections[i].title, collections[i].items || []);
    } else if (view === 'shows') addGrid(body, showCards());
    else if (view === 'films') addGrid(body, filmCards());
    else if (view === 'all') addGrid(body, showCards().concat(filmCards()));
    else if (view === 'episodes') paintEpisodes(body);
    else if (view === 'search') paintSearch(body);
    applyFocus();
  }

  function activate() {
    var el = current();
    var at, eps, i;
    if (!el) return;
    if (el._mode) {
      if (el._mode === 'search') {
        view = 'search';
        cursor = { area: 'main', row: 1, col: 0 };
      } else {
        view = el._mode;
        openShow = null;
        cursor = { area: 'main', row: 0, col: modeIndex(el._mode) };
      }
      paint();
      return;
    }
    if (el._key) {
      if (el._key === 'del') query = query.slice(0, query.length - 1);
      else if (el._key === 'clear') query = '';
      else if (el._key === 'space') query += ' ';
      else query += el._key;
      paint();
      return;
    }
    if (el._show) {
      openShow = el._show;
      previousView = view === 'episodes' ? previousView : view;
      view = 'episodes';
      at = 0;
      eps = openShow.episodes || [];
      for (i = 0; i < eps.length; i++) if (eps[i].resume) { at = i; break; }
      cursor = { area: 'main', row: 1 + at, col: 0 };
      paint();
      return;
    }
    if (el._item && el._item.src) playItem(el._item);
  }

  function move(dRow, dCol) {
    var row;
    if (cursor.area === 'results') {
      if (dCol < 0 || (dRow < 0 && cursor.row === 0)) {
        cursor.area = 'main';
        cursor.row = keyAnchor.row || 1;
        cursor.col = keyAnchor.col || 0;
      } else if (dRow) cursor.row += dRow;
      applyFocus();
      return;
    }
    if (!rows.length) return;
    row = rows[cursor.row] || [];
    if (dCol > 0 && cursor.col >= row.length - 1 && resultEls.length && view === 'search' && cursor.row > 0) {
      keyAnchor = { row: cursor.row, col: cursor.col };
      cursor.area = 'results';
      cursor.row = 0;
      applyFocus();
      return;
    }
    if (dRow) cursor.row += dRow;
    if (dCol) cursor.col += dCol;
    applyFocus();
  }

  function playItem(item) {
    if (!item || !item.src || !window.ontoPlayLibrary) return;
    origin = 'home';
    suspended = true;
    openFlag = false;
    if (root) root.hidden = true;
    window.ontoPlayLibrary(item);
  }

  function close() {
    var from = origin;
    suspended = false;
    openFlag = false;
    if (root) root.hidden = true;
    if (window.ontoLibraryClosed) window.ontoLibraryClosed(from);
  }

  function open(opts) {
    var path, request;
    origin = opts && opts.from ? opts.from : 'home';
    suspended = false;
    openFlag = true;
    view = 'home';
    previousView = 'home';
    query = '';
    openShow = null;
    cursor = { area: 'main', row: 0, col: 0 };
    payload = null;
    ensure();
    root.hidden = false;
    paint();
    if (!window.ontoLibraryApi) {
      payload = { error: true };
      paint();
      return;
    }
    path = window.ontoLibraryQuery ? window.ontoLibraryQuery() : '/api/library';
    request = ++loadToken;
    window.ontoLibraryApi(path).then(function (body) {
      if (request !== loadToken || !openFlag) return;
      payload = body || {};
      paint();
    }, function () {
      if (request !== loadToken || !openFlag) return;
      payload = { error: true };
      paint();
    });
  }

  window.ontoLibrary = {
    isOpen: function () { return openFlag && !suspended; },
    suspended: function () { return suspended; },
    abandon: function () {
      suspended = false;
      openFlag = false;
      if (root) root.hidden = true;
    },
    resume: function () {
      if (!suspended) return false;
      suspended = false;
      openFlag = true;
      ensure();
      root.hidden = false;
      paint();
      return true;
    },
    open: open,
    close: close,
    key: function (code) {
      if (code === 10009 || code === 27 || code === 8) {
        if (view === 'episodes') {
          view = previousView || 'shows';
          openShow = null;
          cursor = { area: 'main', row: 0, col: modeIndex(view) };
          paint();
          return;
        }
        close();
        return;
      }
      if (code === 13) { activate(); return; }
      if (code === 37) move(0, -1);
      else if (code === 39) move(0, 1);
      else if (code === 38) move(-1, 0);
      else if (code === 40) move(1, 0);
    }
  };
}());
