# Native app ↔ TV web parity

## Surfaces

- **TV web UI** (`tv/`): big-screen UI served by tv-server on port 8686,
  with viewer ceilings, watershed defaults and scene navigation.
- **Native Mac app** (`src/main.js` → `ui/`): compact desktop control surface
  with Channels / Library / Screensaver / TV / History modes.

## Shared channel behaviour

Channels reads `http://localhost:8686/api/home` through a narrowly scoped Electron
IPC handler. Channel numbers, names, now-playing picks and the rating ceiling come
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

## Deliberate differences

- Native viewer selections last for the window session, start with everyone, and
  do not follow the TV's watershed or modify its saved defaults.
- Viewer gating applies to Channels and its player. Library and TV mode remain
  adult management surfaces for local files, not a parental access-control boundary.
- Games (6), Uke (7) and Console (20) are TV-only app launchers. They are added by
  the TV page, not returned as media channels by `/api/home`.
- The TV server must already be running on localhost:8686. Native Channels does
  not start it or silently substitute a different catalogue when it is unavailable.

## Verification

`npm test` includes the TV rating model tests and the native home-client contract
checks. `node scripts/check-native-parity.mjs` runs the affected headless checks
sequentially, including `check-native-channels.mjs` with the real TV model and a
synthetic catalogue. It covers viewport fit, both themes, audience changes, delayed
responses, offline retry, prepared artwork reuse and the TV player handoff.
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
