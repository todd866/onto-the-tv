# The YouTube watch ledger

Another tool records what the household watches on YouTube and writes `youtube-watch.json`. The TV
server reads it so the tube grid (the older child's layout, `docs/tv-tube-layout.md`) leads with the same
creators and videos. The server only reads the file; it never contacts YouTube.

## Settings

- **Key:** `youtubeWatchPath` in app settings
- **Default:** `<app data>/youtube-watch.json`
- Checked at most once a minute; a changed file is picked up without a restart.
- A missing, unreadable or malformed file means no signal: the grid orders exactly as it did before.

## File format (version 1)

```json
{
  "version": 1,
  "generated": "2026-11-22T05:00:00Z",
  "channels": {
    "@somemaker": {
      "name": "Some Maker",
      "verdict": "good",
      "events": 41, "long": 30, "shorts": 11, "seconds": 28800,
      "recent": { "events": 9, "seconds": 5400, "shorts": 3 },
      "last": "2026-11-21"
    }
  },
  "events": [
    { "date": "2026-11-21", "id": "abcDEF12345", "kind": "video", "title": "…", "channel": "@somemaker", "dur": 900, "pct": 95 }
  ]
}
```

- One event per video per day it was watched. `pct` is how far a long video was watched; Shorts carry none.
- `recent` is the last 60 days. Ranking uses it, so the grid follows what is watched now.
- `verdict`: `good` (promote), `block` (leave out), `lowgrade`, `cleared`, `unsure`, `unjudged`. Unknown values read as `unjudged`.
- Other fields are ignored.

## How a library creator is matched to a channel

1. By the YouTube id in a file's name (`Title [abcDEF12345].mp4`): any file of the creator that appears
   in `events` ties the creator to that event's channel.
2. Otherwise by name, only when the creator's name equals one channel's name exactly (ignoring case and
   punctuation) and no second channel shares it.

## What it changes

Only the tube endpoints (`/api/feed`, `/api/related`, `/api/search`, `/api/creators`), and only among
titles the audience rules already allow. It never admits a title.

- **Chips and Creators:** a creator's recent YouTube time counts alongside time watched on the TV.
- **Card order:** a card's learned weight is multiplied by up to 2 for a creator watched lately (an hour
  or more in the window), by 1.5 for a `good` creator, and by 1.5 for a video watched to the end or on
  more than one day on YouTube. Unwatched cards from `good` creators, and such well-loved videos, join
  the favourites that follow the continue-watching cards.
- **Whose watching it is:** the history is the whole household's. A creator whose library videos are all
  in the `preschool` tier lifts a grid only when a viewer with the youngest ceiling (G) is among the
  viewers; for anyone else those shows keep their ordinary place.
- **Blocked creators:** a creator whose every matched channel is `block` is left out of all four endpoints.
