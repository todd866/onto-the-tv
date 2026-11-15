# Native app ↔ TV web parity

## Surfaces

- **TV web UI** (`tv/`): big-screen UI served by tv-server on port 8686,
  with viewer ceilings, watershed defaults and scene navigation.
- **Native Mac app** (`src/main.js` → `ui/`): compact desktop control surface
  with Channels / Library / Screensaver / TV / History modes.

## Shared channel behaviour

Channels reads `/api/home` through a narrowly scoped Electron IPC handler: from the M2
(the TV box, the whole library) at its tailnet https address, falling back to this
Mac's own server on `http://localhost:8686`. Channel numbers, names, now-playing picks and the rating ceiling come
from the server. Empty or disallowed channels stay hidden; numbers are never
renumbered. This uses the running TV server's catalogue, independently of whether
the native app has a generated local shuffler file.

The viewer toggles send the same `viewers` selection as the TV: Sam limits the
lineup to G, Jake to PG, and adults allow the whole catalogue (displayed as M by
the server). An empty selection yields no channels. Changing viewers immediately
clears the previous lineup and stops playback. Late responses cannot restore an
older audience's channels. Failures show a warning symbol with details in its
tooltip and a Refresh control.

A channel card opens the existing TV player in the native window with an explicit,
session-only viewer selection. Its next-show and channel-change requests retain
that selection. Back, leaving Channels, or changing viewers closes the player.
This replaces the separate generated shuffler iframe in Channels. Library and TV
mode retain their existing local-file casting controls.

The pressed channel's own card (picture, number, name, show) fills the stage in the
frame of the click and lifts when the player reports a picture. A refused or
unanswered tune stays on that card with Retry; the reason is in its tooltip. The
TV-scale home is never shown inside the native window: the player page hides it
there and reports `onto:desktop-hello`, `-loading` (the server named an episode), `-playing`
(its clock has moved) and `-error` to the app, each carrying the number of the tune it was
opened for. The card waits out a slow start: only half a minute without a picture shows the
player as it is. Once the
picture is up, keys go to the player, so Space pauses.

**Find a show** (the field in the Channels row) names a show instead of taking what a
channel has on: on 15 Nov 2026 the only way to play Ms Rachel from this Mac was to
hope Little Ones had her staged, and this Mac's own Library tab holds none of the
M2's library. The field lists the current audience's shows from the same server
(`/api/library`, trimmed in `tv-home-client.js`), filters them as each letter lands,
and shows them as the same cards in the current layout; Enter plays the first. A show
opens on the episode last left part-way, else the first unfinished one, and the rest of
the show follows it (`play`, `title`, `show`, `at` in the player's address, then
`onto:desktop-queue`). A new audience never sees the previous audience's results.
The TV reaches named shows through its Library tile (on-screen keyboard search); since 15 Nov an episode picked there also plays the rest of the show after it, as on the Mac.

**Play on** (Mac | TV in the toolbar) applies to Channels too (15 Nov 2026; before, it did
nothing there). On TV, a card does not open the player here: the lounge TV's own app is told
to tune that channel (`tune <id>`), or for a found show to play the episode it opens on
(`play <src>`), through the same command queue as `npm run tv` (`sendToTv` in
`src/tv-remote.js`, token from this Mac's `tv-server/pairing-token`, which is the M2's). The
card wears the switch's TV mark once the TV has taken it. A TV that is not on Onto the TV, or
that has no such channel for who is watching there, says so in the status line and the card is
left as it was. It never wakes the TV: nothing is sent unless its app is on and answering.
This path is tested against a simulated TV session only; it had not been run against the
lounge TV when written.

Channel pictures are made ahead of the cards asking: each `/api/home` starts its lineup's
pictures (then the next picks'), and the server readies every profile's lineup at start-up
and after a reload (`createArtWarmer`, one picture at a time behind any viewer's request).

Behind the M2's https address the page's Origin is `https://<host>`; tv-server
counts the same host on either scheme as same-origin. Until 15 Nov 2026 it did not,
so every tune from this app was refused (403) and left the TV home in the window.

Both surfaces use bundled Nunito, navy/amber colours, image-backed rounded bezel
cards and amber person toggles. Desktop keeps two compact control rows above the
scrolling grid. Channel names and programme titles wrap fully, and the grid reduces
its column count as text grows. Arrow keys follow the current grid; Home/End reach
the first/last channel. Returning from playback restores the tuned card's focus.
Empty and failed lineups have visible feedback, with an explicit Retry action.
The native surface supports light and dark appearance; its embedded player's
controls use desktop sizing.

TV viewer changes now clear the previous lineup immediately, retain rapid local
selections and ignore stale responses. Failed changes leave no old media channels
actionable. TV viewer controls are only active on Home; native viewer controls
remain available during playback and stop it before changing the audience.

## Scored channels (triple j, Double J)

- Server-side channels on numbers 43 and 44; both the TV web UI and native Channels
  surface them through `/api/home` like any other media channel.
- Members and pick bias come from `channel-scores.json` on the Mac running tv-server,
  not from folder names in the catalogue.
- When the score file lists no items for a channel, that channel is omitted from
  `/api/home` until the next rescan picks up new scores.

## Deliberate differences

- Native viewer selections last for the window session, start with everyone, and
  do not follow the TV's watershed or modify its saved defaults.
- Viewer gating applies to Channels and its player. Library and TV mode remain
  adult management surfaces for local files, not a parental access-control boundary.
- Games (6), Uke (7) and Console (20) are TV-only app launchers. They are added by
  the TV page, not returned as media channels by `/api/home`.
- The TV server must already be running on localhost:8686. Native Channels does
  not start it or silently substitute a different catalogue when it is unavailable.

## Known gap: the TV home below 1280x720

The TV home is a ten-foot screen. Below 1280x720 it does not fit: at 960x540 a channel card
stands taller than the grid left under the top bar and the resume row (whose tile also clips
its text), and at 390x844 the grid clips the focused card's last 10 px. No TV runs at those
sizes, guests get their own layout, and since 15 Nov 2026 the Mac app never shows this screen.
`scripts/check-tv-ui.mjs` asserts only "mostly visible" there, with a KNOWN GAP comment, until
a small-window home is designed.

## Verification

`npm test` includes the TV rating model tests and the native home-client contract
checks. `node scripts/check-native-parity.mjs` runs the affected headless checks
sequentially, including `check-native-channels.mjs` with the real TV model and a
synthetic catalogue. It covers viewport fit, both themes, audience changes, delayed
responses, offline retry, prepared artwork reuse, the tuning card, a refused tune,
Find a show (its own failure, a named play, another audience's results), Play on TV
(a card sent, a found show sent, a TV that is not on) and the TV player handoff. The fixture serves plain http, so the https same-origin
rule is covered by `src/tv-server.test.js` instead.
Screenshots are written under `audit/`, which is excluded from Git.

The headless scripts accept `PLAYWRIGHT_MODULE`; the native channel check also
accepts `CHROMIUM_EXECUTABLE`. On this Mac, installed Chrome dropped pointer events
in the cross-origin playback iframe, while the installed headless Chromium binary
passed the same real-pointer check. The verified native invocation is:

```sh
CHROMIUM_EXECUTABLE="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell" node scripts/check-native-channels.mjs
```

Pass that environment variable to `check-native-parity.mjs` to use the same browser
for its native-channel step. The viewport helper is bundled in `scripts/lib/` so
worker runs do not depend on a sibling checkout. The TV check also covers the
short landscape companion layout; its cards now fit the available scrolling area.

## Delivery checks

The macOS production allowlist includes `ui/channels.js`, both bundled Nunito
weights and their license. Packaging tests guard these resources. Source parity
alone does not prove an installed app or an already-running server is current:
check bundle resources and the live `/api/home` contract after updating each.
