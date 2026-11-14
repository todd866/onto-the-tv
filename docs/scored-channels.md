# Scored rotation channels (triple j, Double J)

Another tool scores songs on station rotation against the household taste and writes
`channel-scores.json`. The TV server reads it when building the library and on each
10-minute catalogue rescan (the file's mtime and size are part of the catalogue
signature, so a new or edited file triggers a reload without a restart).

## Settings

- **Key:** `channelScoresPath` in app settings
- **Default:** `<app data>/channel-scores.json` (same folder as `settings.json` for
  the Onto the TV app)

## File format (version 1)

```json
{
  "version": 1,
  "generated": "2026-11-14T12:00:00Z",
  "channels": {
    "triplej": {
      "items": {
        "music/Some Artist/Some Artist - Song (Official Video) [abc123].mp4": {
          "score": 0.92,
          "why": "like Some Artist"
        }
      }
    },
    "doublej": { "items": {} }
  }
}
```

- `items` keys are catalogue `src` strings exactly as the TV catalogue lists them.
- `score` is 0..1 (out-of-range values are clamped; non-numeric scores are skipped).
- Other fields are ignored.
- A missing, unreadable, or malformed file means no scored items: those channels stay
  hidden like any empty channel.

## Playback

Membership is entirely from the file (catalogue videos only). Pick weights multiply
the usual learned weight by `0.4 + 1.6 × score`, so the weakest listed song still
plays and the strongest is favoured fourfold before learning continues to apply.