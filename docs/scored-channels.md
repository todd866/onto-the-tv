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

The stations are the grown-ups' (15 Nov 2026: the youngest does not need separate station
channels): with a child in the room both are hidden, and their
songs are still on Music.

## Several scorers

`channel-scores.json` is rewritten whole by the tool that scores the stations, so any other
scorer keeps its own file in `channel-scores.d/` beside it (same format, read in name order;
a later file replaces an earlier one's channel whole). Their sizes and times are part of the
catalogue signature too, so a new file is picked up on the next rescan.

## Dance: a leaning channel (15 Nov 2026)

Dance is not a station: its members are the house, techno and other four-on-the-floor acts
named in `TV_CHANNELS` (music folders only). A `dance` entry in the scores leans the picks by
the same `0.4 + 1.6 × score`, but a video with no score keeps its plain weight and a score
never puts an act on the channel.

`scripts/measure_dance.py` writes those scores from the videos themselves, for what the youngest
loves: simple danceable techno with flashing lights. From a minute in the middle of each video it measures
the beat (how regular the pulse is, how much of it is a kick on every beat, a dancing tempo)
and the light (brightness jumping while the scene stays put, at a beat's pace; few cuts; a
dark frame), ranks each measure against the rest of the channel, and blends the two halves
evenly. `--sheet` draws the top and bottom of the ranking as strips of frames: look at it
before trusting a change to the measures. The tempo figure is approximate (a dotted rhythm
can read as 4/3 of the beat); it carries a tenth of the score.

Run it on the M2, where the music is. The music drive takes one heavy job at a time, so the
measuring step goes through `disk-slot <the music folder> -- heavy-slot --`:

```sh
cd ~/onto-the-tv && S=~/.local/state/onto-dance-scores
node bin/channel-members.js dance > $S/members.jsonl
# measure (cached in $S/features.jsonl, so a stopped run resumes): wrap in disk-slot and heavy-slot
/opt/homebrew/bin/python3 scripts/measure_dance.py --state $S --members $S/members.jsonl
# rank, draw the sheet, and write the scores the server reads
/opt/homebrew/bin/python3 scripts/measure_dance.py --state $S --sheet $S/sheet.png \
  --score "$HOME/Library/Application Support/Onto the TV/channel-scores.d/dance.json"
```