# The older child's profile: a "tube" layout that works like the Samsung YouTube app

Ian, 6 Nov 2026: "you gotta look at the youtube ux too, I can't yet drag him away from youtube … if you
can mimic the samsung youtube app more closely for his profile we'll have an easier time."
What keeps the older child on YouTube (Ian): **picking from thumbnails, up next/autoplay, specific creators, search**.
He watches the YouTube app on the Samsung with the TV remote, so his hands already know that layout.

Ian, 21 Nov 2026: the older child doesn't like the current UI — "it needs like a big selection of his videos that he can
easily go to that's more like the YouTube user interface"; "the YouTube app for Samsung is pretty good user
interface wise, and we should just copy that as much as possible." Build it now; one kid-friendly skin first,
variants afterwards.

**Mimic the layout and the remote behaviour, not the brand.** No YouTube name, logo, red play glyph or
wordmark anywhere; use the app's own colours for accents. The familiarity comes from the grid, the rail,
the focus behaviour and the autoplay countdown.

The sketch is the Samsung YouTube TV app (house rule: build it at its density, count rows).

## Home (1920×1080 safe area; 4 cards per row, ~2.3 rows visible)

```
┌──┬──────────────────────────────────────────────────────────────────────────┐
│🔍│ [All] [Bluey] [Lego] [RC cars] [Minecraft] [Octonauts] …      ← chip row │
│⌂ │ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│▶︎ │ │  thumb     │ │  thumb     │ │  thumb     │ │  thumb     │            │
│☰ │ │      12:04 │ │       7:31 │ │      22:10 │ │       3:58 │            │
│  │ │▔▔▔▔▔▔──────│ │            │ │            │ │            │  ← resume  │
│  │ └────────────┘ └────────────┘ └────────────┘ └────────────┘    bar      │
│  │ Title line one  Title line…   Title line…    Title line…               │
│  │ title line two                                                         │
│  │ Creator · new   Creator       Creator ·45%   Creator                   │
│  │ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│  │ │  thumb     │ │  …                                                    │
└──┴──────────────────────────────────────────────────────────────────────────┘
 rail: 🔍 Search, ⌂ Home, ▶︎ Creators (his "subscriptions"), ☰ Library (continue watching + recent)
```

- **Rows per card: 3** (thumb, ≤2-line title, one meta line `Creator · datum`). The datum is one of
  `new` (never watched), `NN%` (part-watched), or nothing. No other text, no section headers on Home.
- Thumbnail: 16:9, duration badge bottom-right (dark chip, white mono digits), resume bar along the
  bottom edge (accent colour) when part-watched. Use the existing `/art?src=` image.
- **Focus** (remote D-pad): focused card scales ~1.08 with a 4px white outline; the title of the
  focused card may show both lines, others clamp to 2. Focus never lands on nothing. Moving left from
  column 1 opens the rail (icons + labels expand); right closes it. Up from row 1 goes to the chips.
- Chips: `All` + his top creators/shows (by his watch time, from the taste/learned weights), max ~8.
  Selecting a chip filters the grid in place; focus stays on the chip row.
- Feed order: continue-watching first (part-watched, resume > 5 s), then unwatched from his favourite
  creators, then the rest of his audience-allowed catalogue by learned weight; dedupe series to at most
  2 adjacent cards from the same show. Infinite-ish: load more rows as focus nears the end.
- Back on Home with nothing to close → the normal profile/exit behaviour.

## Playing

- OK on a card plays it full-screen from its resume point (existing player and `/api/progress`).
- **Up next / autoplay:** in the last 10 s, a bottom-right card shows the next video (thumb, title,
  creator) with a circular countdown `5…1`; OK plays it now, Back cancels and stays on the ended video.
  Next = same creator/series next episode if any, else the best related item (same creator → same
  channel/category → learned weight). Autoplay chains (the older child's YouTube habit) but obey the existing
  bedtime/rating rules.
- **Down during playback** shows a one-row shelf of related cards over the bottom third (YouTube's
  "more videos" row); Back hides it. Left/Right on the timeline still seek as now.
- Back from the player returns to the grid with focus on the card that was playing.

## Search (rail 🔍)

```
┌──┬────────────────────────┬────────────────────────────────────────────┐
│🔍│ [ rc car_            ] │ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│⌂ │ a b c d e f g          │ │ thumb    │ │ thumb    │ │ thumb    │     │
│▶︎ │ h i j k l m n          │ └──────────┘ └──────────┘ └──────────┘     │
│☰ │ o p q r s t u          │ Title…        Title…        Title…          │
│  │ v w x y z 1 2 …        │ Creator       Creator       Creator         │
│  │ [space] [⌫] [clear]    │ …results update as he types                 │
│  │ suggestions:           │                                            │
│  │  rc car jump           │                                            │
│  │  rc odyssey            │                                            │
└──┴────────────────────────┴────────────────────────────────────────────┘
```

- On-screen letter grid (D-pad typing, like the Samsung app), results grid updates live (debounced).
- Matches title, show/series and creator over the **audience-allowed** catalogue only (same
  `allowed()` rules as `/api/next`). Suggestions = matching creator/show names.
- If the TV exposes voice search via the remote mic, accept it; otherwise skip (no stub UI).

## Creators (rail ▶︎)

A row of round creator avatars (first video's art cropped round, name under) across the top; below,
that creator's videos newest-first in the same 4-up card grid. These are his "subscriptions": the
YouTube feeds and shows he watches most, plus any Ian adds.

## Kid-friendly graphics (Ian, 6 Nov: "it's gotta have kid-friendly graphics")

Same layout and remote behaviour as above; the *skin* is for a young child, not a grown-up's YouTube:
- Chunky, rounded cards (large corner radius), thick colourful focus ring with a small bounce on focus,
  bright saturated palette on a softer background (not black), big friendly rounded type.
- Rail icons as simple illustrated, rounded glyphs (magnifier, house, star/face for Creators, toy box
  for Library) with the label always visible when the rail is open.
- Creator avatars as big circles with a coloured ring per creator; chips as coloured, rounded tabs.
- Up-next countdown as a filling coloured ring around the next thumbnail; playful but not noisy.
- Stays readable from the couch: high contrast, no text on busy art, no animation that delays a key press.

Process (house rule 6a): render **3 skin variants** of the same Home + focused card + up-next screens side
by side (1920×1080 each), pick none yourself; Ian chooses, then apply the chosen skin everywhere in the
`tube` layout (Home, rail, chips, search, creators, player overlays).

## Server

New endpoints on the TV server, all filtered by the same audience/rating rules as `/api/next`
(`allowed(src, viewers, rating)`), all returning cards `{src, title, show|creator, duration, art,
resume, watched}`:
- `GET /api/feed?viewers=&rating=&chip=&offset=&limit=` → ranked cards for Home (order above) +
  `chips: [{id,label}]`.
- `GET /api/related?src=&viewers=&rating=&limit=` → up-next list; `[0]` is the autoplay pick.
- `GET /api/search?q=&viewers=&rating=` → cards + `suggestions`.
- `GET /api/creators?viewers=&rating=` → creators with an avatar art src and counts.
Reuse the existing catalogue, taste/learned-weight and progress code; no new data stores.

## Scope

- New layout id `tube` for the **older child's** profile (make it his default; it stays selectable in the
  layout picker for other profiles). The youngest keeps `pictures`. The grown-ups and Everyone are unchanged.
- Works on the Samsung Tizen 3 app (ES5 bundle via Babel 7, see the TV install notes) and the desktop
  `ui/` parity per `docs/native-parity.md` where that surface has profiles.
- Instant UI: every key press answers within a frame; fetch in the background and reconcile.
- No truncation surprises: titles clamp to 2 lines with the full title shown when focused.

## Done means

1. Server tests for the four endpoints (audience filtering: a title not allowed for the older child never appears
   in feed, related, search or creators).
2. Headless renders (1920×1080) of Home, focused card, rail open, search with results, up-next
   countdown, related shelf — checked for card rows, clamping, alignment.
3. D-pad journey test: Home → card → play → up next autoplay → Back → focus restored → search "rc" →
   play result.
4. TV install only with Ian's go-ahead (`ONTO_TV_APPROVED=1`), never 21:00–07:00.
