# TV home redesign: channel-first, who's-watching

Agreed with Ian on 2026-11-02 after a review of the live UI (screenshots from the M2 library at 1920×1080).

## What was wrong

- Item-first Netflix-style layout: hero panel, Continue Watching (12 tiles), Browse shows (40), episode drill-down. Channels were a strip of small blocks.
- No who's-watching control. Audience was baked into channel names (Little Kids, Big Kids, Grown-ups). The TV player had no audiences.
- Type at 18–23 px at the 1920×1080 CSS viewport the Samsung uses (even on 4K). Minimum about 28 px for body text, 40+ for titles.
- Hero stretched a 320 px YouTube thumbnail to about 1750 px. Raw YouTube titles wrapped to five lines. The Games tile was clipped.
- The same fact said three times: tile, hero copy, status line. "1 episodes". "OK Browse episodes".
- `tv/styles.css` held three stacked generations of overrides. Rewrite it; don't patch it.

## Household

| Person | Age | Ceiling |
|---|---|---|
| Sam | 2 | G: preschool + shared tiers |
| Jake | 6 | PG: shared + big tiers |
| Mum | adult | everything; Mum's taste |
| Dad | adult | everything; Dad's taste |

Rule: the youngest person ticked sets the rating ceiling. With only adults ticked, taste follows who is watching: Mum, Dad, or the existing `both` (couple) stream for the two together.

Starting rating map from the existing folder tiers: preschool and shared → G, big → PG, older → PG-13/M, grownup/couple/adultanim → M/MA. Ian can correct individual shows later.

## Layout (1920×1080, 3 rows)

1. Who's watching: a toggle per person (Sam, Jake, Mum, Dad), plus one rating badge for the current ceiling (colour plus letters) and the clock.
2. and 3. Channel cards, about 440×330, four per row. Each card shows full-bleed art of what's on now (the channel's next pick), the channel number at 44 px, the name at 32 px, and "▶ show". Channels are genres (Cartoons, Movies, Sitcoms, Music, Christmas, Docos, Games, Uke), filtered by the ceiling. A channel with nothing allowed under the ceiling is hidden.

- OK starts the channel. Number keys tune directly. Up/down changes channel while watching.
- Continue Watching and Browse shows leave the home screen. If they are kept, they go behind one "Library" card.
- The player overlay shows the channel number and name rather than the raw YouTube title. Text gets larger.
- Render headless at 1920×1080 and look at it before calling it done.

## Player navigation (Ian, 2026-11-14): SUPERSEDES the 2 Nov table below

Ian: "press a button on the remote and the TV needs to respond *instantly*"; "if the UX slaves left/right to seek
then it's a shit UX"; there was "no way to skip a song". Telemetry 1–13 Nov: 38 of 73 plays abandoned in under 30 s,
skip used twice. The map is `tv/remote-map.js` (its header is the spec):

**The remote is the One For All Samsung-layout remote (photo, 14 Nov 2026), and the UX mirrors it key for key.**
Ian, that afternoon: "arrows should only navigate the ux, they shouldn't trigger things"; "seeking to the dedicated
buttons"; "Netflix has great seeking UX, copy that"; "hints that show a diagram of the actual remote". The morning's
map (Up / Down tuned, Left / Right skipped) lost him a live set 24 minutes in with one arrow press.

| Key | Watching | Controls open | Seek mode |
|---|---|---|---|
| Arrows | show the controls, focus on play / pause; **Down: the directions tray** | move; Up: Continue strip; Down: close | nothing |
| OK | pause + open controls | press the focused button | go to the marker |
| RETURN | leave (or undo the last change) | close | back to where it was |
| ◀◀ ▶▶ | enter seek mode | enter seek mode | move the marker 10 s; held: 30 s, 60 s, 5 min |
| CH ▲▼, 0–9 | tune | tune | cancel the seek, tune |
| PRE-CH | back to what was on, where it was left | same | same |
| A red / D blue | previous / next | same | same |
| B green | like (toggle) | same | same |
| ⏸ ▶ ■ | pause, play, stop | same | ⏸ ▶ go to the marker |
| TOOLS / SUBT. | options / subtitles | same | same |
| GUIDE, CH LIST | channel grid (home) | same | same |
| INFO | the remote guide, on every page | same | same |

- Transport row: ⏮ ⏸ ⏭ ♥ ⋯, each with the key that also does it (A, D, B, TOOLS); ◀◀ ▶▶ keycaps flank the line.
- Seek mode: the picture holds; the elapsed time shows the marker, a bubble under it the distance from here;
  scene pictures show above the bar when the file has them. `[OK] ✓ [RETURN] ✕` sits in the title row.
- Remote guide (`tv/remote-guide.js`): a drawing of the remote with this page's keys lit and called out; a pressed
  key flashes on it; it closes on INFO, RETURN or 20 s without a press. Key codes come from the TV
  (`getSupportedKeys`), with Samsung's documented codes as defaults.
- Directions tray (Down while watching; Ian: "options of different directions the algorithm could go, with tiles, and
  then we can collect that data"): up to five real episodes, one per direction (more of this act, new to you, a
  favourite, a long set or quick one, another channel), from `POST /api/directions`. Left / Right move, OK plays,
  RETURN closes; the focused tile's whole title sits under the row. Choosing is not a skip. Every tray shown is
  written to `<appdata>/tv-server/directions.jsonl` with what was offered, what was chosen (or null) and how long it
  was open. Nothing learns from that file yet.
- The installed app is a loader (`tv/boot.js`): the interface comes live from the server (`/api/tv-live`), so a change
  here ships with `npm run tv -- reload` on the M2, with no reinstall. Check with `scripts/check-tv-live.mjs`.
- **A channel remembers what you left** (the fix for the lost live set): tuning back to a channel within 12 hours
  resumes the episode last on it, where it was, if at least 2 minutes had been watched and it is not nearly over.
  The home card bills that episode. Skipping it, or letting it end, moves the channel on as before.
- **Liked on the home screen:** liked episodes follow the half-watched ones in the top row (newest first, up to 30; the
  row scrolls sideways inside itself). The big panel shows the focused tile in full. OK plays it on its own channel.
- Pause, play and entering seek mode repaint before the player is asked (its pause call took 700 ms on the TV).
- The directions chosen most often lead the tray.
- Like: `POST /api/like` doubles the episode's weight for that audience; a second press takes it back.
- `npm run tv -- play <src> [seconds]` puts a show back on at a position.

Rules: every key acts on press, never on release; nothing waits on the server before the screen changes (a skip stops
the old item in the same frame); no hold gestures. Gates: `node --test tv/*.test.js`, `scripts/check-tv-overlay.mjs`
(flow + screenshots), `scripts/measure-tv-latency.mjs` (key-to-screen ms at 1/6 CPU; readings not yet stable).
Telemetry: every press goes to `<appdata>/tv-server/remote-events.jsonl` on the M2 (key, action, focus, ms to next frame).
Deployed to the M2 14 Nov 10:27 as `dfbab67`; rollback: `git -C ~/onto-the-tv reset --hard rollback-20261114` + restart.

## Player navigation (Ian, 2026-11-02): superseded, kept for the scene/ads/intro notes

Jump by scene, not by time. The model to follow is Netflix; Amazon's slow scrubbing is what to avoid.

| Key | Tap | Hold (≥ 600 ms) |
|---|---|---|
| ▲ / ▼, CH+ / CH− | next / previous channel | — |
| ▶ (right) | next scene | next show on this channel |
| ◀ (left) | previous scene (restart this scene if > 3 s in) | previous show |
| OK | play / pause and show the overlay | options: subtitles, audio |
| Back | home | — |

- **Scenes** come from the file's chapters (ffprobe) when it has them. Otherwise a background pass on the M2 runs ffmpeg scene detection at low resolution and caches the cuts plus one thumbnail per cut beside the catalogue. The pass is incremental and runs under heavy-slot, one file at a time (the M2 is fanless). With no data yet, fall back to 60 s jumps.
- While jumping, a strip of scene thumbnails shows where you'll land, Netflix-style. Repeated taps queue jumps, and the jump commits 700 ms after the last tap, so five taps don't mean five seeks.
- **Period ad breaks (retro channels):** some channels (the decade channels and any Ian flags) play original old-school ads from archive.org between shows, like broadcast TV. Ads live in `ads/<decade>/` folders in the library, are rated like any other folder, and obey the viewers' ceiling. A break is 2–3 ads, about 2 minutes, never repeating an ad within the same day if the pool allows. Shows over 20 minutes also get mid-show breaks where the original broadcast had them: the scene pass records fade-to-black points (ffmpeg blackdetect), and breaks go at the ones nearest 1/3 and 2/3 of the way through. In a break, a small corner chip shows "Ad 2/3 ⏭". Tapping ▶ skips the rest of the break; holding ▶ goes to the next show, as everywhere else.
- **Ads already in the recording** (the Super Bowl with its original ads, or a taped 80s broadcast): the scene pass marks those breaks as `ad` segments, using Comskip if it is installed and otherwise blackdetect plus silencedetect clusters. They play by default, with the same "Ad ⏭" chip, and tapping ▶ jumps to the end of the break. Inserted and recorded ads behave the same way.
- **Ads: Play / Skip** is in the OK-hold options panel and is remembered per channel. With Skip set, both kinds of break are passed over automatically.
- **Skip intro:** episodic shows get intro and credits detection by matching audio across episodes of the same show (the Plex/Jellyfin approach). The first intro of a session shows a "Skip intro" button where OK skips it. Later intros on the same channel skip automatically. At the credits, the next show (or the ad break) starts.
- **Subtitles:** sidecar .srt/.vtt files plus embedded text tracks; new YouTube downloads also fetch subtitles. Turn them on from the OK-hold options panel or the remote's SUBT key. The choice is remembered per viewer set.

## Watershed (Ian, 2026-11-02)

At 20:00 the who's-watching default becomes Mum and Dad (ceiling M); at 05:00 it returns to everyone (G). A manual change holds until the next switch. This is TV-local time, implemented in `tv/app.js` (`band()`, `storedViewers()`).

## Design language (Ian, 2026-11-02): built from the app icon

The approved icon (`tizen/icon.svg`, a navy retro TV with antenna on amber) sets the visual language for every TV surface: home, player overlay, options panel, ad and skip chips, setup, Games and Uke.

- **Colour:** navy `#14213d` for surfaces and amber `#ffb547` for focus and action. The background is deep navy `#0b1428`, not grey-black. Text is white or `#f4f1ea`. Ratings keep their own colours (G green, PG yellow, M red), always with the letters.
- **Shape:** chunky, flat, rounded. Corner radius is about 22% of the short side, as on the icon tile. Strokes are thick (6–8 px at 1080). No gradients except the dark scrim under card text. No drop shadows.
- **The TV as the frame:** a channel card is a TV screen with a navy bezel and the now-on art as the picture. When focused, the bezel turns amber, the card grows about 6%, and a small antenna "V" appears above it. The rating badge is a small TV-shaped chip.
- **Glyphs:** one flat line-icon set in the icon's stroke style, drawn in SVG (no emoji): game controller, ukulele, ▶ ⏸ ⏭ ⏮, subtitles, ads ⏭, people. The Games and Uke cards use these glyphs on navy.
- **Type:** a heavy rounded sans bundled as WOFF (Nunito ExtraBold/Bold, OFL), because old Tizen has no system rounded face. Channel numbers are tabular, at least 44 px. Nothing smaller than 26 px.
- **Motion:** 150 ms ease-out on focus. A channel change shows a quick "tuning" snow/static flash of about 200 ms, then the channel number big in the corner for 2 s, like an old set.
- **Player overlay:** a navy bar with an amber progress line and the channel number in an amber TV chip, followed by the show name.
