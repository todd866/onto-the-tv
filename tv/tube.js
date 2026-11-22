/* The tube layout (the older child's favourite): thumbnail grid, rail, search and autoplay. ES5, same as app.js. */
window.ontoTube = (function () {
  var host = null;
  var state = {
    view: 'home',
    rail: false,
    railIndex: 1,
    chip: 'all',
    cards: [],
    chips: [{ id: 'all', label: 'All' }],
    total: 0,
    feedKey: '',
    feedLoaded: false,
    feedFlight: false,
    gen: 0,
    query: '',
    suggestions: [],
    results: [],
    searchGen: 0,
    searchTimer: 0,
    creators: [],
    creatorId: '',
    creatorCards: [],
    creatorKey: '',
    creatorFlight: false,
    zone: 'home',
    keyRow: 0,
    keyCol: 0,
    sugIndex: 0,
    resRow: 0,
    resCol: 0,
    restoreSrc: '',
    jump: '',
    nextItem: null,
    nextItems: [],
    nextLeft: 0,
    nextTimer: 0,
    nextAsked: false,
    nextSrc: '',
    shelf: false,
    shelfIndex: 0
  };
  var RAIL = [
    { id: 'search', label: 'Search' },
    { id: 'home', label: 'Home' },
    { id: 'creators', label: 'Creators' },
    { id: 'library', label: 'Library' }
  ];
  var KEYS = [
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    ['h', 'i', 'j', 'k', 'l', 'm', 'n'],
    ['o', 'p', 'q', 'r', 's', 't', 'u'],
    ['v', 'w', 'x', 'y', 'z', '1', '2'],
    ['3', '4', '5', '6', '7', '8', '9'],
    ['0', 'space', 'del', 'clear']
  ];
  var ICONS = {
    search: '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="4"/><path d="M29 29 L40 40" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
    home: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" d="M6 22 L24 8 L42 22 V42 H30 V28 H18 V42 H6 Z"/></svg>',
    creators: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="currentColor" d="M16 8 L40 24 L16 40 Z"/></svg>',
    library: '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" d="M8 12 H40 M8 24 H40 M8 36 H40"/></svg>'
  };

  function mount(next) { host = next; }
  function active() { return !!(host && host.layout() === 'tube'); }
  function $(id) { return host.$(id); }

  function qs(extra) {
    var stored = host.viewers(), rating = host.rating(), parts = [], i;
    if (stored !== null) parts.push('viewers=' + host.q(stored));
    if (rating) parts.push('rating=' + host.q(rating));
    for (i = 0; i < extra.length; i++) parts.push(extra[i]);
    return parts.length ? ('?' + parts.join('&')) : '';
  }
  function audienceKey() { return String(host.viewers()) + '|' + String(host.rating()); }
  // Scroll only the element's own scrolling boxes, by as little as needed. The TV's Chromium 47 reads
  // scrollIntoView's options object as alignToTop = true: it snapped the row to the top and could move the
  // overflow-hidden player and page with it (22 Nov 2026).
  function reveal(el) {
    var parent = el && el.parentNode, box, area, style;
    while (parent && parent.nodeType === 1 && parent !== document.body) {
      style = window.getComputedStyle(parent);
      if (/(auto|scroll)/.test(style.overflowX + ' ' + style.overflowY) &&
          (parent.scrollHeight > parent.clientHeight + 2 || parent.scrollWidth > parent.clientWidth + 2)) {
        box = el.getBoundingClientRect();
        area = parent.getBoundingClientRect();
        if (box.top < area.top + 8) parent.scrollTop -= area.top + 8 - box.top;
        else if (box.bottom > area.bottom - 8) parent.scrollTop += box.bottom - area.bottom + 8;
        if (box.left < area.left + 8) parent.scrollLeft -= area.left + 8 - box.left;
        else if (box.right > area.right - 8) parent.scrollLeft += box.right - area.right + 8;
      }
      parent = parent.parentNode;
    }
  }
  function clearFocus() {
    var nodes = document.querySelectorAll('.focused'), i;
    for (i = 0; i < nodes.length; i++) nodes[i].classList.remove('focused');
  }
  function datum(card) {
    var pct;
    if (card.resume > 5 && card.duration > 0) {
      pct = Math.round(100 * card.resume / card.duration);
      if (pct < 1) pct = 1;
      if (pct > 99) pct = 99;
      return pct + '%';
    }
    if (!card.watched) return 'new';
    return '';
  }
  function meta(card) {
    var name = card.creator || card.show || '';
    var extra = datum(card);
    return extra ? (name + ' \u00b7 ' + extra) : name;
  }
  function cardButton(card, compact) {
    var button = document.createElement('button');
    var thumb = document.createElement('span');
    var img = document.createElement('img');
    var dur = document.createElement('span');
    var title = document.createElement('span');
    var line = document.createElement('span');
    var extra = datum(card);
    button.type = 'button';
    button.className = 'tube-card' + (compact ? ' compact' : '');
    button.tabIndex = -1;
    button._card = card;
    button.setAttribute('aria-label', (card.title || '') + (extra ? ', ' + extra : '') + ', ' + (card.creator || ''));
    thumb.className = 'tube-thumb';
    img.alt = '';
    thumb.appendChild(img);
    host.loadArt(img, host.artUrl(card.art));
    dur.className = 'tube-dur';
    dur.textContent = host.clock(card.duration || 0);
    thumb.appendChild(dur);
    if (card.resume > 5 && card.duration > 0) {
      var bar = document.createElement('span');
      var pct = Math.round(100 * card.resume / card.duration);
      if (pct < 1) pct = 1;
      if (pct > 99) pct = 99;
      bar.className = 'tube-resume';
      bar.style.width = pct + '%';
      thumb.appendChild(bar);
    }
    button.appendChild(thumb);
    title.className = 'tube-title';
    title.textContent = card.title || '';
    title.title = card.title || '';
    button.appendChild(title);
    line.className = 'tube-meta';
    line.textContent = meta(card);
    button.appendChild(line);
    button.addEventListener('click', function () {
      remember(card.src);
      host.playCard(card);
    });
    return button;
  }
  function remember(src) { state.restoreSrc = src; }
  function gridRows(holder, cards, columns) {
    var grid = document.createElement('div');
    var rows = [];
    var start, slice, i;
    grid.className = 'tube-grid cols-' + columns;
    for (i = 0; i < cards.length; i++) grid.appendChild(cardButton(cards[i], false));
    holder.appendChild(grid);
    for (start = 0; start < grid.children.length; start += columns) {
      slice = [];
      for (i = start; i < grid.children.length && i < start + columns; i++) slice.push(grid.children[i]);
      rows.push({ kind: 'grid', els: slice });
    }
    return rows;
  }
  function viewerRow() {
    var viewers = $('viewers');
    if (!viewers || !viewers.children.length) return null;
    return { kind: 'viewers', els: viewers.querySelectorAll('.viewer') };
  }
  function paintRail() {
    var rail = $('tube-rail'), i, btn, item;
    if (!rail) return;
    rail.hidden = false;
    rail.innerHTML = '';
    for (i = 0; i < RAIL.length; i++) {
      item = RAIL[i];
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tube-rail-btn' + (railView(item.id) ? ' on' : '');
      btn.setAttribute('aria-label', item.label);
      btn.innerHTML = '<span class="tube-rail-icon">' + ICONS[item.id] + '</span><span class="tube-rail-label">' + item.label + '</span>';
      btn.addEventListener('click', (function (index) {
        return function () { state.railIndex = index; activateRail(); };
      })(i));
      rail.appendChild(btn);
    }
  }
  function railView(id) {
    if (id === 'home') return state.view === 'home';
    return state.view === id;
  }
  function focusCard(src) {
    var rows = host.rows(), r, c, el;
    for (r = 0; r < rows.length; r++) {
      if (!rows[r] || rows[r].kind !== 'grid') continue;
      for (c = 0; c < rows[r].els.length; c++) {
        el = rows[r].els[c];
        if (el && el._card && el._card.src === src) {
          host.focusAt().row = r;
          host.focusAt().col = c;
          return true;
        }
      }
    }
    return false;
  }
  function finishPaint(rows) {
    var focus = host.focusAt();
    var keepRow = focus.row, keepCol = focus.col;
    host.setRows(rows);
    if (state.jump === 'start') {
      focus.row = 0;
      focus.col = 0;
      state.jump = '';
    } else if (state.jump === 'keys') {
      state.jump = '';
    } else if (state.restoreSrc && focusCard(state.restoreSrc)) {
      state.restoreSrc = '';
    } else {
      focus.row = keepRow;
      focus.col = keepCol;
    }
    if (state.rail) { markRail(); return; }
    if (state.view === 'search' && state.zone !== 'viewers') { markSearch(); return; }
    if (!rows.length) return;
    if (focus.row > rows.length - 1) focus.row = rows.length - 1;
    host.move(0, 0);
  }
  function libraryCards() {
    var cont = [], done = [], i, card;
    for (i = 0; i < state.cards.length; i++) {
      card = state.cards[i];
      if (card.resume > 5) cont.push(card);
      else if (card.watched) done.push(card);
    }
    return cont.concat(done);
  }
  function paintHome(holder, rows) {
    var chips = $('tube-chips'), list, i, btn, els = [];
    if (chips) {
      chips.hidden = false;
      chips.innerHTML = '';
      list = state.chips.length ? state.chips : [{ id: 'all', label: 'All' }];
      for (i = 0; i < list.length; i++) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tube-chip' + (list[i].id === state.chip ? ' on' : '');
        btn.tabIndex = -1;
        btn.textContent = list[i].label;
        btn._chip = list[i].id;
        btn.setAttribute('aria-pressed', list[i].id === state.chip ? 'true' : 'false');
        btn.addEventListener('click', (function (id) {
          return function () { selectChip(id); };
        })(list[i].id));
        chips.appendChild(btn);
        els.push(btn);
      }
      rows.push({ kind: 'chips', els: els });
    }
    rows.push.apply(rows, gridRows(holder, state.cards, 4));
  }
  function paintLibrary(holder, rows) {
    if ($('tube-chips')) { $('tube-chips').hidden = true; $('tube-chips').innerHTML = ''; }
    rows.push.apply(rows, gridRows(holder, libraryCards(), 4));
  }
  function paintCreators(holder, rows) {
    var strip = document.createElement('div');
    var els = [], i, btn, img, name, cards;
    if ($('tube-chips')) { $('tube-chips').hidden = true; $('tube-chips').innerHTML = ''; }
    strip.className = 'tube-avatars';
    for (i = 0; i < state.creators.length; i++) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tube-avatar-btn' + (state.creators[i].id === state.creatorId ? ' on' : '');
      btn.tabIndex = -1;
      btn._creator = state.creators[i].id;
      btn.setAttribute('aria-label', state.creators[i].label || state.creators[i].name);
      img = document.createElement('img');
      img.alt = '';
      img.className = 'tube-avatar';
      host.loadArt(img, host.artUrl(state.creators[i].art));
      name = document.createElement('span');
      name.className = 'tube-avatar-name';
      name.textContent = state.creators[i].label || state.creators[i].name;
      name.title = state.creators[i].label || state.creators[i].name;
      btn.appendChild(img);
      btn.appendChild(name);
      btn.addEventListener('click', (function (id) {
        return function () { pickCreator(id); };
      })(state.creators[i].id));
      strip.appendChild(btn);
      els.push(btn);
    }
    holder.appendChild(strip);
    if (els.length) rows.push({ kind: 'avatars', els: els });
    cards = state.creatorCards;
    rows.push.apply(rows, gridRows(holder, cards, 4));
  }
  function paintSearch(holder, rows) {
    var wrap = document.createElement('div');
    var keys = document.createElement('div');
    var query = document.createElement('div');
    var board = document.createElement('div');
    var sugg = document.createElement('div');
    var results = document.createElement('div');
    var r, c, key, btn, i;
    if ($('tube-chips')) { $('tube-chips').hidden = true; $('tube-chips').innerHTML = ''; }
    wrap.className = 'tube-search';
    keys.className = 'tube-keys';
    query.className = 'tube-query';
    query.id = 'tube-query';
    query.textContent = state.query;
    query.setAttribute('aria-label', 'Search');
    board.className = 'tube-board';
    for (r = 0; r < KEYS.length; r++) {
      for (c = 0; c < KEYS[r].length; c++) {
        key = KEYS[r][c];
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tube-key' + (key === 'space' || key === 'del' || key === 'clear' ? ' wide' : '');
        btn.tabIndex = -1;
        btn.setAttribute('data-key', key);
        btn.setAttribute('aria-label', key === 'del' ? 'Delete' : (key === 'space' ? 'Space' : key));
        btn.textContent = key === 'space' ? 'space' : (key === 'del' ? '\u232B' : key);
        btn.addEventListener('click', (function (value) {
          return function () { typeKey(value); };
        })(key));
        board.appendChild(btn);
      }
    }
    sugg.className = 'tube-suggest';
    sugg.id = 'tube-suggest';
    for (i = 0; i < state.suggestions.length; i++) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tube-suggestion';
      btn.tabIndex = -1;
      btn.textContent = state.suggestions[i];
      btn.addEventListener('click', (function (value) {
        return function () { state.query = value; typeKey(''); runSearch(); };
      })(state.suggestions[i]));
      sugg.appendChild(btn);
    }
    keys.appendChild(query);
    keys.appendChild(board);
    keys.appendChild(sugg);
    results.className = 'tube-results';
    results.id = 'tube-results';
    wrap.appendChild(keys);
    wrap.appendChild(results);
    holder.appendChild(wrap);
    fillResults(results);
    rows.push({ kind: 'search', els: [] });
  }
  function fillResults(results) {
    var grid, i;
    if (!results) results = $('tube-results');
    if (!results) return;
    results.innerHTML = '';
    grid = document.createElement('div');
    grid.className = 'tube-grid cols-3';
    for (i = 0; i < state.results.length; i++) grid.appendChild(cardButton(state.results[i], false));
    results.appendChild(grid);
  }
  function paint() {
    var holder, rows, viewers, feedChip;
    if (!active()) return;
    feedChip = state.view === 'library' ? 'all' : state.chip;
    if ((state.view === 'home' || state.view === 'library') && state.feedKey !== audienceKey() + '|' + feedChip) state.cards = [];
    document.body.classList.add('tube-on');
    if (state.rail) document.body.classList.add('tube-rail-open');
    else document.body.classList.remove('tube-rail-open');
    paintRail();
    holder = $('channels');
    if (!holder) return;
    holder.className = 'layout-tube';
    holder.innerHTML = '';
    rows = [];
    viewers = viewerRow();
    if (viewers) rows.push(viewers);
    if (state.view === 'home') paintHome(holder, rows);
    else if (state.view === 'library') paintLibrary(holder, rows);
    else if (state.view === 'creators') paintCreators(holder, rows);
    else if (state.view === 'search') paintSearch(holder, rows);
    finishPaint(rows);
    ensure();
  }
  function ensure() {
    if (state.view === 'home' || state.view === 'library') ensureFeed();
    else if (state.view === 'creators') ensureCreators();
  }
  function ensureFeed() {
    var chip = state.view === 'library' ? 'all' : state.chip;
    var want = audienceKey() + '|' + chip;
    var gen;
    if (state.feedKey === want && (state.feedLoaded || state.feedFlight)) return;
    state.cards = [];
    state.feedLoaded = false;
    state.feedKey = want;
    state.feedFlight = true;
    gen = ++state.gen;
    host.api('/api/feed' + qs(['chip=' + host.q(chip), 'offset=0', 'limit=24'])).then(function (body) {
      if (gen !== state.gen) return;
      state.feedFlight = false;
      state.feedLoaded = true;
      state.cards = body.cards || [];
      state.chips = (body.chips && body.chips.length) ? body.chips : [{ id: 'all', label: 'All' }];
      state.total = typeof body.total === 'number' ? body.total : state.cards.length;
      if (active() && (state.view === 'home' || state.view === 'library')) paint();
    }, function () {
      if (gen === state.gen) state.feedFlight = false;
    });
  }
  function nearEnd() {
    var rows, focus, gridRows, pos, i, gen, offset;
    if (!active() || state.view !== 'home' || state.feedFlight || !state.feedLoaded) return;
    if (state.cards.length >= state.total) return;
    rows = host.rows();
    focus = host.focusAt();
    gridRows = [];
    for (i = 0; i < rows.length; i++) if (rows[i].kind === 'grid') gridRows.push(i);
    pos = gridRows.indexOf(focus.row);
    if (pos < 0 || gridRows.length - pos > 2) return;
    gen = state.gen;
    offset = state.cards.length;
    state.feedFlight = true;
    host.api('/api/feed' + qs(['chip=' + host.q(state.chip), 'offset=' + offset, 'limit=24'])).then(function (body) {
      var extra;
      if (gen !== state.gen) return;
      state.feedFlight = false;
      extra = body.cards || [];
      if (!extra.length) { state.total = state.cards.length; return; }
      state.cards = state.cards.concat(extra);
      state.total = typeof body.total === 'number' ? body.total : state.cards.length;
      if (active() && state.view === 'home') paint();
    }, function () {
      if (gen === state.gen) state.feedFlight = false;
    });
  }
  function ensureCreators() {
    var want = audienceKey() + '|' + state.creatorId;
    var gen;
    if (state.creatorKey === want && !state.creatorFlight && state.creators.length) return;
    if (state.creatorFlight && state.creatorKey === want) return;
    state.creatorKey = want;
    state.creatorFlight = true;
    gen = ++state.gen;
    host.api('/api/creators' + qs(state.creatorId ? ['id=' + host.q(state.creatorId)] : [])).then(function (body) {
      if (gen !== state.gen) return;
      state.creatorFlight = false;
      state.creators = body.creators || [];
      if (!state.creatorId && state.creators.length) state.creatorId = state.creators[0].id;
      state.creatorCards = body.cards || [];
      if (!body.cards && state.creatorId) {
        state.creatorKey = '';
        ensureCreators();
        return;
      }
      if (active() && state.view === 'creators') paint();
    }, function () {
      if (gen === state.gen) state.creatorFlight = false;
    });
  }
  function selectChip(id) {
    if (state.chip === id) return;
    state.gen += 1;
    state.feedFlight = false;
    state.chip = id;
    state.feedKey = '';
    state.feedLoaded = false;
    state.feedFlight = false;
    state.cards = [];
    paint();
  }
  function pickCreator(id) {
    if (state.creatorId === id && state.creatorCards.length) return;
    state.creatorId = id;
    state.creatorKey = '';
    state.creatorCards = [];
    paint();
  }
  function show(view) {
    state.gen += 1;
    state.feedFlight = false;
    state.view = view;
    state.rail = false;
    state.zone = view === 'search' ? 'keys' : 'home';
    state.jump = view === 'search' ? 'keys' : 'start';
    if (view === 'search') { state.keyRow = 0; state.keyCol = 0; }
    if (view === 'library') state.chip = 'all';
    document.body.classList.remove('tube-rail-open');
    paint();
  }
  function openRail() {
    var i;
    state.rail = true;
    state.railIndex = 1;
    for (i = 0; i < RAIL.length; i++) if (railView(RAIL[i].id)) state.railIndex = i;
    document.body.classList.add('tube-rail-open');
    paintRail();
    markRail();
  }
  function closeRail() {
    state.rail = false;
    document.body.classList.remove('tube-rail-open');
    paintRail();
    if (state.view === 'search') markSearch();
    else host.move(0, 0);
  }
  function activateRail() {
    var item = RAIL[state.railIndex] || RAIL[1];
    show(item.id === 'home' ? 'home' : item.id);
  }
  function markRail() {
    var buttons = $('tube-rail') ? $('tube-rail').querySelectorAll('.tube-rail-btn') : [];
    var i;
    clearFocus();
    for (i = 0; i < buttons.length; i++) if (i === state.railIndex) buttons[i].classList.add('focused');
  }
  function railKey(code) {
    var KEY = host.KEY;
    if (code === KEY.UP) state.railIndex = (state.railIndex + RAIL.length - 1) % RAIL.length;
    else if (code === KEY.DOWN) state.railIndex = (state.railIndex + 1) % RAIL.length;
    else if (code === KEY.RIGHT) { closeRail(); return true; }
    else if (code === KEY.ENTER) { activateRail(); return true; }
    else return true;
    markRail();
    return true;
  }
  function markSearch() {
    var buttons = document.querySelectorAll('.tube-key');
    var suggestions = document.querySelectorAll('.tube-suggestion');
    var cards = document.querySelectorAll('#tube-results .tube-card');
    var index = 0, r, c, i, el;
    clearFocus();
    if (state.zone === 'keys') {
      for (r = 0; r < state.keyRow; r++) index += KEYS[r].length;
      index += state.keyCol;
      el = buttons[index];
      if (el) el.classList.add('focused');
    } else if (state.zone === 'suggestions') {
      el = suggestions[state.sugIndex];
      if (el) el.classList.add('focused');
    } else if (state.zone === 'results') {
      el = cards[state.resRow * 3 + state.resCol];
      if (el) {
        el.classList.add('focused');
        reveal(el);
      }
    }
    for (i = 0; i < buttons.length; i++) if (buttons[i] === document.activeElement && state.zone !== 'keys') buttons[i].blur();
  }
  function typeKey(key) {
    if (key === 'del') state.query = state.query.slice(0, -1);
    else if (key === 'clear') state.query = '';
    else if (key === 'space') state.query += state.query.length ? ' ' : '';
    else if (key) state.query += key;
    if (state.query.length > 40) state.query = state.query.slice(0, 40);
    if ($('tube-query')) $('tube-query').textContent = state.query;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, 200);
  }
  function runSearch() {
    var text = state.query;
    var gen = ++state.searchGen;
    if (!text) {
      state.results = [];
      state.suggestions = [];
      fillResults();
      paintSuggest();
      markSearch();
      return;
    }
    host.api('/api/search' + qs(['q=' + host.q(text)])).then(function (body) {
      if (gen !== state.searchGen || text !== state.query) return;
      state.results = body.cards || [];
      state.suggestions = body.suggestions || [];
      if (state.sugIndex >= state.suggestions.length) state.sugIndex = 0;
      if (state.resRow * 3 >= state.results.length) { state.resRow = 0; state.resCol = 0; }
      fillResults();
      paintSuggest();
      markSearch();
    }, function () {});
  }
  function paintSuggest() {
    var sugg = $('tube-suggest'), i, btn;
    if (!sugg) return;
    sugg.innerHTML = '';
    for (i = 0; i < state.suggestions.length; i++) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tube-suggestion';
      btn.tabIndex = -1;
      btn.textContent = state.suggestions[i];
      btn.addEventListener('click', (function (value) {
        return function () { state.query = value; if ($('tube-query')) $('tube-query').textContent = value; runSearch(); };
      })(state.suggestions[i]));
      sugg.appendChild(btn);
    }
  }
  function searchKey(code) {
    var KEY = host.KEY;
    var name = host.keyName(code);
    var row;
    if (state.zone === 'viewers') {
      if (name === 'down') { state.zone = 'keys'; markSearch(); return true; }
      return false;
    }
    if (state.zone === 'keys') {
      row = KEYS[state.keyRow];
      if (name === 'left') {
        if (state.keyCol === 0) { openRail(); return true; }
        state.keyCol -= 1;
      } else if (name === 'right') {
        if (state.keyCol >= row.length - 1) {
          if (state.results.length) { state.zone = 'results'; state.resRow = 0; state.resCol = 0; }
        } else state.keyCol += 1;
      } else if (name === 'up') {
        if (state.keyRow === 0) {
          state.zone = 'viewers';
          host.focusAt().row = 0;
          host.focusAt().col = 0;
          host.move(0, 0);
          return true;
        }
        state.keyRow -= 1;
        if (state.keyCol >= KEYS[state.keyRow].length) state.keyCol = KEYS[state.keyRow].length - 1;
      } else if (name === 'down') {
        if (state.keyRow >= KEYS.length - 1) {
          if (state.suggestions.length) { state.zone = 'suggestions'; state.sugIndex = 0; }
        } else {
          state.keyRow += 1;
          if (state.keyCol >= KEYS[state.keyRow].length) state.keyCol = KEYS[state.keyRow].length - 1;
        }
      } else if (name === 'ok' || code === KEY.ENTER) typeKey(KEYS[state.keyRow][state.keyCol]);
      markSearch();
      return true;
    }
    if (state.zone === 'suggestions') {
      if (name === 'up') {
        if (state.sugIndex === 0) state.zone = 'keys';
        else state.sugIndex -= 1;
      } else if (name === 'down') {
        if (state.sugIndex < state.suggestions.length - 1) state.sugIndex += 1;
      } else if (name === 'left') { openRail(); return true; }
      else if (name === 'right' && state.results.length) { state.zone = 'results'; state.resRow = 0; state.resCol = 0; }
      else if (name === 'ok' || code === KEY.ENTER) {
        state.query = state.suggestions[state.sugIndex] || state.query;
        if ($('tube-query')) $('tube-query').textContent = state.query;
        runSearch();
      }
      markSearch();
      return true;
    }
    if (state.zone === 'results') {
      var cols = resultCols(state.resRow);
      var count = state.results.length;
      var lastRow = Math.max(0, Math.ceil(count / 3) - 1);
      if (!count) { state.zone = 'keys'; markSearch(); return true; }
      if (name === 'left') {
        if (state.resCol === 0) { state.zone = 'keys'; state.keyCol = KEYS[state.keyRow].length - 1; }
        else state.resCol -= 1;
      } else if (name === 'right') {
        if (state.resCol < cols - 1) state.resCol += 1;
      } else if (name === 'up') {
        if (state.resRow === 0) state.zone = 'keys';
        else { state.resRow -= 1; if (state.resCol >= resultCols(state.resRow)) state.resCol = resultCols(state.resRow) - 1; }
      } else if (name === 'down') {
        if (state.resRow < lastRow) {
          state.resRow += 1;
          if (state.resCol >= resultCols(state.resRow)) state.resCol = resultCols(state.resRow) - 1;
        }
      } else if (name === 'ok' || code === KEY.ENTER) {
        var card = state.results[state.resRow * 3 + state.resCol];
        if (card) { remember(card.src); host.playCard(card); }
      }
      markSearch();
      return true;
    }
    return true;
  }
  function resultCols(row) {
    var left = state.results.length - row * 3;
    if (left >= 3) return 3;
    return left > 0 ? left : 0;
  }
  function digit(text) {
    if (!active() || state.view !== 'search' || state.zone === 'viewers' || state.rail) return false;
    typeKey(text);
    markSearch();
    return true;
  }
  function homeKey(code) {
    var KEY;
    if (!active() || !host) return false;
    KEY = host.KEY;
    if (code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE) {
      if (state.rail) { closeRail(); return true; }
      if (state.view !== 'home') { show('home'); return true; }
      return false;
    }
    if (state.rail) return railKey(code);
    if (state.view === 'search') return searchKey(code);
    if (code === KEY.ENTER) {
      var rowsNow = host.rows();
      var at = host.focusAt();
      var current = rowsNow[at.row];
      var el = current && current.els[at.col];
      if (el && el._chip) { selectChip(el._chip); return true; }
      if (el && el._creator) { pickCreator(el._creator); return true; }
      if (el && el._card) { remember(el._card.src); host.playCard(el._card); return true; }
      return false;
    }
    if (code === KEY.LEFT) {
      var rows = host.rows();
      var focus = host.focusAt();
      var row = rows[focus.row];
      // From the first column of any row, the viewers row included: an empty Library has only that row, and
      // without this the rail could not be reached with the arrows (22 Nov 2026).
      if (row && focus.col === 0) { openRail(); return true; }
    }
    return false;
  }
  function hideNext() {
    clearTimeout(state.nextTimer);
    state.nextTimer = 0;
    if ($('tube-next')) $('tube-next').hidden = true;
  }
  function askNext(done) {
    var play = host.playing();
    var src;
    if (!play || !play.item) return;
    src = play.item.src;
    if (state.nextAsked && state.nextSrc === src) { if (done) done(); return; }
    state.nextAsked = true;
    state.nextSrc = src;
    host.api('/api/related' + qs(['src=' + host.q(src), 'limit=12'])).then(function (body) {
      if (!host.playing() || !host.playing().item || host.playing().item.src !== src) return;
      state.nextItems = body.cards || [];
      state.nextItem = state.nextItems.length ? state.nextItems[0] : null;
      if (done) done();
    }, function () { if (done) done(); });
  }
  function setCount(n) {
    var num = $('tube-count-num');
    var ring = $('tube-count-ring');
    var length = 2 * Math.PI * 18;
    if (num) num.textContent = String(n);
    if (ring) {
      ring.setAttribute('stroke-dasharray', String(Math.round(length)));
      ring.setAttribute('stroke-dashoffset', String(Math.round(length * (1 - n / 5))));
    }
  }
  function paintNext() {
    var root = $('tube-next');
    var card = state.nextItem;
    var button, thumb, img, copy, title, who, ring;
    if (!root || !card) return;
    root.innerHTML = '';
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'tube-next-card focused';
    button.setAttribute('aria-label', (card.title || '') + ', ' + (card.creator || ''));
    thumb = document.createElement('span');
    thumb.className = 'tube-thumb';
    img = document.createElement('img');
    img.alt = '';
    host.loadArt(img, host.artUrl(card.art));
    thumb.appendChild(img);
    copy = document.createElement('span');
    copy.className = 'tube-next-copy';
    title = document.createElement('span');
    title.className = 'tube-title';
    title.textContent = card.title || '';
    who = document.createElement('span');
    who.className = 'tube-meta';
    who.textContent = card.creator || card.show || '';
    copy.appendChild(title);
    copy.appendChild(who);
    ring = document.createElement('span');
    ring.className = 'tube-count';
    ring.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="4"></circle><circle id="tube-count-ring" cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" transform="rotate(-90 24 24)"></circle></svg><span id="tube-count-num"></span>';
    button.appendChild(thumb);
    button.appendChild(copy);
    button.appendChild(ring);
    button.addEventListener('click', function () { playNext(); });
    root.appendChild(button);
    root.hidden = false;
    setCount(state.nextLeft);
  }
  function armNext() {
    var play;
    if (state.nextTimer || state.shelf || !state.nextItem) return;
    play = host.playing();
    if (!play || play.tubeHold) return;
    state.nextLeft = 5;
    paintNext();
    state.nextTimer = setTimeout(nextTick, 1000);
  }
  function nextTick() {
    var play = host.playing();
    if (!play || play.tubeHold || state.shelf) return;
    state.nextLeft -= 1;
    if (state.nextLeft <= 0) { playNext(); return; }
    setCount(state.nextLeft);
    state.nextTimer = setTimeout(nextTick, 1000);
  }
  function playNext() {
    var card = state.nextItem;
    hideNext();
    if (!card) return;
    host.save(true);
    host.watch('ended');
    host.playCard(card, true);
  }
  function dismissNext() {
    var play = host.playing();
    if (play) play.tubeHold = true;
    hideNext();
    if (host.showOsd) host.showOsd();
  }
  function onTime() {
    var play = host.playing();
    var duration, left, due;
    if (!play || play.mode !== 'tube' || play.tubeHold || play.resumePending || state.shelf) return;
    duration = host.mediaDuration() || (play.item && play.item.duration) || 0;
    left = duration - host.mediaTime();
    due = host.mediaEnded() || (duration > 0 && left <= 10 && left > 0);
    if (!due) return;
    if (!state.nextAsked || state.nextSrc !== play.item.src) askNext(function () { if (state.nextItem) armNext(); });
    else if (state.nextItem) armNext();
  }
  function onEnded() {
    var play = host.playing();
    if (play && play.tubeHold) { if (host.showOsd) host.showOsd(); return; }
    if (state.nextItem) { playNext(); return; }
    askNext(function () {
      var current = host.playing();
      if (state.nextItem && current && !current.tubeHold) playNext();
    });
  }
  function showShelf() {
    var root = $('tube-shelf');
    var row = document.createElement('div');
    var i;
    if (!root) return;
    state.shelf = true;
    hideNext();
    root.innerHTML = '';
    row.className = 'tube-shelf-row';
    for (i = 0; i < state.nextItems.length; i++) row.appendChild(cardButton(state.nextItems[i], true));
    root.appendChild(row);
    root.hidden = false;
    state.shelfIndex = 0;
    markShelf();
  }
  function markShelf() {
    var cards = document.querySelectorAll('#tube-shelf .tube-card');
    var i;
    for (i = 0; i < cards.length; i++) cards[i].classList.toggle('focused', i === state.shelfIndex);
    if (cards[state.shelfIndex]) reveal(cards[state.shelfIndex]);
  }
  function closeShelf() {
    state.shelf = false;
    if ($('tube-shelf')) { $('tube-shelf').hidden = true; $('tube-shelf').innerHTML = ''; }
    onTime();
  }
  function onDown() {
    if (!state.nextItems.length) {
      askNext(function () { if (state.nextItems.length) showShelf(); });
      return true;
    }
    showShelf();
    return true;
  }
  function onUp() {
    if (state.shelf) closeShelf();
    return true;
  }
  function moveShelf(delta) {
    var next = state.shelfIndex + delta;
    if (next < 0) next = 0;
    if (next > state.nextItems.length - 1) next = state.nextItems.length - 1;
    state.shelfIndex = next;
    markShelf();
  }
  function playShelf() {
    var card = state.nextItems[state.shelfIndex];
    if (!card) return;
    state.shelf = false;
    if ($('tube-shelf')) $('tube-shelf').hidden = true;
    host.playCard(card, false);
  }
  function playingKey(code) {
    var name, back, KEY;
    if (!host || !host.playing() || host.playing().mode !== 'tube') return false;
    KEY = host.KEY;
    name = host.keyName(code);
    back = code === KEY.BACK || code === KEY.ESC || code === KEY.BACKSPACE;
    if (state.shelf) {
      if (back || name === 'up') { closeShelf(); return true; }
      if (name === 'left' || name === 'right') { moveShelf(name === 'left' ? -1 : 1); return true; }
      if (name === 'ok') { playShelf(); return true; }
      if (name === 'down') return true;
    }
    if (state.nextTimer) {
      if (back) { dismissNext(); return true; }
      if (name === 'ok') { playNext(); return true; }
    }
    return false;
  }
  function onPlayStart() {
    hideNext();
    state.shelf = false;
    state.nextItem = null;
    state.nextItems = [];
    state.nextAsked = false;
    state.nextSrc = '';
    if ($('tube-shelf')) { $('tube-shelf').hidden = true; $('tube-shelf').innerHTML = ''; }
  }
  function onStop() {
    hideNext();
    state.shelf = false;
    if ($('tube-shelf')) { $('tube-shelf').hidden = true; $('tube-shelf').innerHTML = ''; }
  }
  function hideChrome() {
    document.body.classList.remove('tube-on');
    document.body.classList.remove('tube-rail-open');
    if ($('tube-rail')) $('tube-rail').hidden = true;
    if ($('tube-chips')) { $('tube-chips').hidden = true; $('tube-chips').innerHTML = ''; }
    onStop();
  }
  function advance() {
    if (state.nextItem) { playNext(); return true; }
    askNext(function () { if (state.nextItem) playNext(); });
    return true;
  }

  return {
    mount: mount,
    active: active,
    paint: paint,
    hideChrome: hideChrome,
    homeKey: homeKey,
    digit: digit,
    nearEnd: nearEnd,
    playingKey: playingKey,
    onTime: onTime,
    onEnded: onEnded,
    onDown: onDown,
    onUp: onUp,
    onPlayStart: onPlayStart,
    onStop: onStop,
    advance: advance,
    remember: remember
  };
}());
