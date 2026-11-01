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
