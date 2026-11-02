# Native app ↔ TV web parity

Owner direction (AGENTS.md): reconcile the native Mac app and the TV web surface as
ordinary development. This file records deliberate differences and remaining gaps.

## Surfaces

- **TV web UI** (`tv/`): big-screen 10-foot UI served by tv-server on port 8686 —
  who's-watching, channel grid (navy/amber TV-bezel cards, Nunito), rating
  ceilings, watershed, player OSD with scene seeking.
- **Native Mac app** (Electron, `src/main.js` → `ui/`): desktop control surface
  with Channels / Library / Screensaver / TV / History modes, own styling
  (`ui/styles.css`), own channel-player iframe. Shares the backend (src/
  library, tv-server data) but none of the TV UX.

## Deliberate differences

- The native app is a manager/control surface, not a 10-foot UI; it does not need
  who's-watching or the watershed band.

## Gaps (recorded 2026-11-02)

- `ui/` does not render the TV channel lineup (numbers 1–20, genre channels,
  rating gating); its Channels mode is a separate local player.
- `ui/` styling predates the navy/amber TV design language.
- New library content added via Stash roots reaches the native app only through the
  shared catalogue; channel-aware browsing (e.g. Rides & Adventures) is absent.
- Rating ceilings are enforced per-viewer on the TV; the native app has no
  viewer/ceiling concept.

## Reconciliation in flight

- Codex native-parity job (2026-11-02, running): bring `ui/` onto the tv/
  design language and TV channel lineup with rating gating.
