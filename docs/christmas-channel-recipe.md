# The ultimate Christmas channel: a recipe

How this repo builds a household Christmas channel that is safe for a 2-year-old,
still has Die Hard for the adults, spans a century of Christmas media, and gets
smarter every year. Everything below is the method; no personal data or
credentials ship with the repo.

## 1. One channel, two doors

Define the channel in `src/tv-server.js` (`TV_CHANNELS`, audience `all`) and give
it two admission paths:

- **Family door** — `inStream(item, 'christmas')` in `shuffler/player.js`: a
  seasonal-word regex (`christmas|xmas|santa|noël|grinch|scrooge|…`) over
  family-tier items, plus an explicit allowlist for festive films whose titles
  carry no seasonal word (Elf, Klaus, The Polar Express…).
- **Adult door** — `inChristmasAdult(item)`: grown-up films enter **only by
  reviewed title**, never because a seasonal word appears in the name. A
  Christmas word in an adult title must never pull it into a family channel.

The server's rating ceiling (`ratingAllowed`, driven by who is watching) hides
the adult door whenever a child's ceiling is in force. Children and guests can
never reach Bad Santa; adults get it automatically. Because every suggestion row
and the play-next queue derive from the same pool function, the gating
propagates everywhere without extra work.

## 2. The slate: cast the household, not a genre

Drive acquisition from a slate file — one JSON entry per title with `title`,
`year`, `area` (`grown-ups` / `christmas` shared / `family-films`), `for` (who it
is for) and expected `minutes`. Build the slate from century-spanning lists
(Wikipedia's *List of Christmas films* works; IMDb is bot-walled), then read it
as a per-person gap list: something for every viewer, every era, and every tier
from preschool specials to adult black comedy.

## 3. Acquisition, per medium

- **Films** — a torrent client with a WebUI API (qBittorrent) behind a VPN.
  Assert the bind interface before adding anything, cap the download rate,
  stage into a runtime folder (never straight into the library), and **rank
  torrents to prefer unrated/extended/director's cuts** over theatrical — the
  theatrical cut is the censored product. Verify with ffprobe (codec, duration
  within ±900 s to admit longer cuts).
- **TV specials** — `yt-dlp` over search, with a junk filter
  (`review|reaction|ranking|facts|explained|recap|essay|compilation`), per-video
  duration resolution against the special's real runtime, and pinned video IDs
  once a good copy is found. Classic pre-1970 specials are heavily faked on
  YouTube; the Internet Archive is often the better source (search
  `advancedsearch.php`, check `metadata/<id>` for real file durations).
- **Slow-vs-stalled**: a torrent crawling at 100 KB/s with healthy seeds is
  slow, not broken. Only intervene when seeds drop to zero.

## 4. Review before publish — always frame-check the actual video

Never trust a filename. Extract a still from the middle of the file and look at
it before publishing. The fakes we caught in one evening:

- a "full special" that was a **screen recording of its Wikipedia article**;
- two uploads of a 1977 stop-motion special that were **cel animation** (wrong
  film entirely);
- **speed/pitch-tampered evade copies** — detectable because duration is ~2×
  the real runtime.

Contact sheets (ffmpeg `select=not(mod(n,300)),tile=4x2`) for films, single
mid-file stills for specials. Quarantine rejects, re-source, review again.
Publish = copy into the library area only after the frame passes; family films
require the review flag, adult areas publish on staging.

## 5. The knowledge map: know more than you own

Embed a canon, not just the library. Two stages:

1. **Meta harvest** — for every canon entry (films, specials, songs, books,
   series) fetch a Wikipedia summary + Wikidata genres into
   `meta/<slug>.json`. Rate-limits are by IP and clear with paced retries;
   wrong-title 404s usually mean the parenthetical disambiguator is wrong.
2. **Embed** — `tools/show-embed/embed.py` turns each entry into one local
   vector (BAAI/bge-small-en-v1.5, incremental by text hash) and `export`
   writes the neighbour graph. Everything you know about Christmas — including
   things you never download — becomes a map the suggestion engine can walk.

## 6. Ops notes

- A library area with zero files makes the channel invisible in the app —
  publish a first tranche before announcing anything.
- The server must be restarted to pick up channel-code changes
  (`launchctl kickstart -k gui/501/com.onto-the-tv.server`).
- Rerun `npm run refresh` after every publish; the channel count updates
  immediately.
- Keep a wishlist doc section per season: published / torrenting / next /
  rejected-with-reasons. Next year's run starts from it.
