# Profiles, themes and a fuller lineup — design

Status: draft, 4 Nov 2026. Approved direction: the concept sheet (who's watching, Ian's
"now on" home, Fran's guide home, Sam's picture home). Builds on the channel split shipped
the same day (`0e593ff`).

## Why

Ian: "I want an app that people want to use." The home is channel-first and works, but it is
the same screen for everyone, labelled with folder names, and it feels like a file browser with
pictures. A household TV should feel like *your* TV when you sit down: your colour, your
channels first, what's on now and how long is left, and words a person would say out loud.

## Goals

1. **Profiles.** Ian, Fran, Jake, Sam and Everyone. Each has an avatar, a colour theme, a
   default rating (Ian M, Fran M, Jake PG, Sam G, Everyone = youngest in the room, today G),
   a lineup ordered by that profile's own viewing, and one personal channel ("For Ian",
   "For Fran"). Taste learning stays per person (Ian = the `grown` key, Fran = `mum`,
   Everyone/adult pairs = `both`).
2. **Who's watching?** screen at launch (TV, Mac, phone). One press picks a profile. The
   TV keeps its watershed: after 20:00 it opens on the last adult profile, before 05:00 too.
3. **Rating switch** stays on every home (G / PG / M), defaulting to the profile's rating,
   overriding either way until the profile changes. No password.
4. **Layouts, chosen per profile** (Ian: "each picks their own"):
   - *Now on*: a large panel for the focused channel (art, show, season/episode, time-left
     bar, next), then the lineup as tiles with a progress bar each. Ian's default.
   - *Guide*: a now/next grid, one row per channel, with the same panel on top. Fran's default.
   - *Pictures*: big character tiles, one short word each, no small text. Sam and Jake.
5. **Labels people say.** Channel names in plain words; cards show the show name (no folder
   years, no "Official"), the episode title when known, minutes left, and what's next.
6. **Themes.** One palette per profile applied to TV, Mac app and phone app alike
   (Ian navy/amber, Fran plum/rose, Jake deep blue/lime, Sam sunny yellow/coral,
   Everyone teal/gold). Contrast checked in each.
7. **A fuller lineup.** Channels informed by the household's YouTube history and by what
   Australian free-to-air runs (research in progress; see "Lineup" below).

8. **Familiar first** (Ian: "We'll draw people in with familiar shows"). Each profile's own
   channel and the "now on" pick on every card favour that person's known favourites; other
   shows stay on as low-weight discoveries, never removed and never top billing. Fran:
   Come Dine With Me, Friends, The Big Bang Theory, British reality. Ian: live music sessions,
   dark crime-comedy, aviation.

## Non-goals

- No Continue Watching or Browse rows on the home (standing rule in `docs/tv-home-redesign.md`).
  "Now on" is a channel's live pick, not a resume list.
- No passwords or PINs on profiles or ratings.
- No camera-based who's-watching yet (long-term idea; the profile choice is the manual layer it
  would drive).
- No new paid services; content still comes through the existing acquisition and rotation jobs.

## Anti-goals (would make it a failure even if it works)

- Text-heavy cards, small type on the TV (< 28 px), squashed art — the reason Codex's item-first
  UI was rejected.
- Truncated titles without a way to read them.
- Kids landing on grown-up channels because a profile or override leaked across sessions.
- Turning the TV on or off, or installing on it, without Ian's say-so.

## Constraints

- The Samsung app bundles `tv/`: ES5, Chromium 47 (no CSS gap, no custom properties, no
  arrow functions). Install only from the M5, only when Ian approves.
- The server (`src/tv-server.js`) owns lineups, ratings and picks; clients only display.
- Guests on the public link keep their invite's ceiling; profile and rating overrides never
  reach the guest server.
- Render with real library data and *look at the images* before calling any UI done.

## Decided (Ian)

- Profiles for Ian and Fran separately; each picks their own layout.
- Rating switch defaults to the profile and stays selectable.
- Many more channels; better labels; themed.

## Calls I made (check these)

- Everyone = youngest in the room (G today), so a mixed room is safe by default.
- Profile names Ian and Fran replace "Mum" and "Dad" on screen; ids stay `mum`/`dad` so
  existing taste data carries over.
- Episode titles and "minutes left" come from the staged pick and its duration; "next" is the
  channel's following pick, staged ahead.

## Lineup

To be filled from the YouTube history deep-dive and the free-to-air research.

## Left to the builder

Exact palettes and focus styles, avatar art (initials vs icons), guide row height and paging,
how the Mac app presents the profile picker (window vs sheet).
