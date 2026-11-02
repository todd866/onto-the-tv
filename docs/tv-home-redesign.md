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

## Player navigation (Ian, 2026-11-02)

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
