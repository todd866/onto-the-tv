# Kids Shuffler

An offline player for your own video library, included in Onto the TV. Pick a
stream and it mixes up the shows, gently learning from skips and completions.
The generated player is a single HTML file with no server, account or network
dependency. Videos remain separate files beside it or in configured folders.

## Build a player

Requires Python 3.10+ and `ffprobe` from FFmpeg. H.264 video with AAC audio in MP4
is a useful compatibility target; browser and operating-system codec support
varies. The generator checks container metadata and rejects unsupported formats,
corrupt containers and audio-only files. It does not decode every frame.

Run these commands from this folder:

```sh
cp tiers.example.json tiers.json
# Edit tiers.json to match your show folder names.
python3 make_shuffler.py --library "$HOME/Movies/kids-holiday" --tiers tiers.json
```

Keep one show per directory under the library, for example
`Example Family Show/episode-one.mp4`. Open the resulting
`~/Movies/kids-holiday/kids-shuffler.html` in a browser. Rebuild after adding or
removing videos. `--output PATH` writes the player elsewhere, retaining paths
relative to that output. Keep its location stable to preserve browser storage.

The default library is `~/Movies/kids-holiday`. `--no-sources` uses only that
library or the directory supplied with `--library`. Empty or missing libraries
leave existing output untouched.

## Choose what each stream contains

The example folder names are placeholders. Classifications are a parent's own
choices, not certified age ratings or a lock that prevents changing streams.

| Tier in `tiers.json` | Offered in |
| --- | --- |
| `preschool` | Little Kids, Everything |
| `shared` | Little Kids, Big Kids, Everything |
| `big` | Big Kids, Everything |
| `older` | Everything |

Every folder can belong to at most one tier. Unknown folders go to Everything
with a warning and never enter either kids stream automatically. No real show
list ships with the project. Without a tiers file, the main library appears
only in Everything. Buttons with no matching videos are hidden.

For other folders or individual films, copy `sources.example.json` to
`sources.json` and edit its paths. The generator reads local `sources.json` and
`tiers.json` automatically when present; `--sources PATH` and `--tiers PATH`
select explicit files. Relative paths in a sources file are relative to that
file. `~` expands to your home directory.

A root can use `"classify": "shows"` to classify its first-level folders, or a
fixed `"tier"` for every file. Use `grownup` for Grown-ups and `music` for Music;
both also appear in Everything. Give each additional root a stable, distinct
`label` so its learned preferences have unique names. Individual picks look like:

```json
{
  "roots": [],
  "picks": [
    {"path": "../family-film.mp4", "show": "Family Films", "title": "An example film", "tier": "grownup"}
  ]
}
```

Keep your edited configurations and generated player private: they contain your
folder and file names. Only the `.example.json` files belong in a public fork.

## Watching and learning

| Key | Action |
| --- | --- |
| Left arrow | Return to the previous episode at its saved position |
| Right arrow or S | Go forward through recent episodes, then shuffle a new one |
| Space | Pause or resume |
| F | Toggle full screen |
| W | Open preferences |
| Escape | Close preferences |

The Back button cancels an early-skip penalty when someone changes their mind.
History retains up to 50 visits in the current stream and resets when switching
streams or reloading. Playback failures do not teach a dislike.

Learning counts what you watched during a visit, not where the playhead sits.
Leaving within three minutes of watching lowers that video's weight by 30%.
Reaching the end raises it by 30%, as does leaving at 80% or more once you have
watched at least three minutes or most of the file. So resuming a bookmark near
the end and skipping straight past it teaches nothing, and rejecting a resumed
film immediately counts as a fresh bail-out. Seeking makes a visit neutral;
returning to it later starts a fresh visit that can teach again.

Weights stay between 0.15 and 4. Opening a channel for the first time in a
session moves that audience's saved preferences 25% back toward the neutral
weight of 1; moving between that audience's channels does not decay them again.
Each audience learns separately, and Reset in the preferences panel clears only
the episodes on the channel you are watching. The picker first chooses a show,
helping small catalogues compete with large ones, then chooses an episode. It
avoids recent repeats where possible.

“Prefer short episodes” is enabled initially. Videos over 15 minutes become
less likely as their duration increases; they remain reachable. Turn it off
for longer viewing sessions. Preferences includes a reset for the current
stream.

Learning and the latest 3,000 viewing records stay in browser local storage.
There is no upload or analytics service. A record stores the timestamp (`t`),
stream (`s`), relative video identifier (`v`), departure reason (`r`), last
playback position (`w`), starting position (`p`), and duration (`d`). The log key
is `kidshuffle.log.v1`; preference keys begin with `kidshuffle.weights.v2.s`.
Positions are not a precise watch-time measurement: seeking, pauses, crashes,
and simultaneous tabs can make totals misleading. This is a local activity
record, not a guaranteed audit trail. Clearing browser storage clears it;
private browsing may keep it only for the session. Resetting preferences does
not clear the viewing log.

## Copy videos to Android

Requires Android platform tools (`adb`), FFmpeg, and USB debugging authorized on
the intended phone. VLC or another local player handles the copied files. The
phone playlists do not run the browser learner.

```sh
python3 sync_phone.py --library "$HOME/Movies/kids-holiday"
# Review the dry-run output, then copy:
python3 sync_phone.py --library "$HOME/Movies/kids-holiday" --apply
```

Dry run is the default and does not write to the phone. Exactly one connected
device is required unless `--serial SERIAL` selects one. `--dest` changes the
destination from `/sdcard/Movies/kids-holiday`; `--reserve-gib` changes the
default 8 GiB free-space reserve. A replacement needs room for the entire staged
copy while its existing version remains in place.

Only completed MP4 files with a usable video stream are eligible. Each transfer
uses a unique temporary file, verifies its SHA-256, then renames it into place.
The tool stops on failure and removes only its own temporary file. It does not
delete other videos to make space. Existing files with matching path and size
are skipped without checksum verification. To omit specific relative paths,
copy `phone-exclusions.example.json` to `phone-exclusions.json`, edit it, or pass
`--exclusions PATH`. Excluding a file does not delete an existing phone copy.

## Generate VLC playlists

The playlist tool reads an inventory of files actually on the phone. It needs
no local media audit or saved device identifier. For the default destination:

```sh
adb shell 'find /sdcard/Movies/kids-holiday -type f -print0' > phone-files.nul
python3 make_phone_playlists.py --inventory phone-files.nul --output phone-playlists --tiers tiers.json
adb push phone-playlists /sdcard/Movies/kids-holiday/
```

When multiple phones are connected, use `adb -s SERIAL` for the two adb commands.
Set `--phone-root` to match a different inventory directory and `--playback-root`
to the corresponding absolute path VLC opens (usually under
`/storage/emulated/0`). Three M3U files cover Little Kids, Big Kids, and
Everything using the same tier rules. Unknown folders appear only in
Everything. Durations are left unspecified for VLC to discover. Existing
unrelated playlists are left alone.

Keep inventories and generated playlists private too: they list your videos.

## Tests

```sh
node --test tests/player.test.js
python3 -m unittest discover -s tests -v
python3 -m unittest test_sync_phone -v
```

The tests use synthetic fixtures and a simulated phone. FFmpeg-dependent tests
create short silent clips in temporary folders and skip if FFmpeg is absent.
They neither inspect a personal library nor connect to real hardware.
