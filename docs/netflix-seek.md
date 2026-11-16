# Netflix smart-TV seek (reference for onto-the-tv)

Research date: 16 Nov 2026. Goal: match Netflix on Samsung Tizen–class TVs for **Rewind / Fast-forward** (the physical left–right of the transport cluster), not the D-pad arrows (those move focus in Netflix and here).

Sources used and gaps are marked **(sourced)** vs **(inferred)**.

## Controls while the bar is hidden

| Input | Netflix behaviour **(inferred)** | Notes |
|-------|----------------------------------|-------|
| D-pad Left / Right | Opens player chrome; does not skip **(sourced: Samsung / Netflix TV UI pattern; matches our `remote-map`)** | |
| Rewind / Fast-forward | Enters skip/scrub; playback pauses **(inferred for hold; some builds show a brief skip while playing)** | We pause on first scrub step like the paused thumbnail strip |
| OK | Confirms scrub position **(inferred)** | |
| Back | Abandons scrub, restores start position **(inferred)** | |

## Step size per press (same session, one direction)

Netflix does not publish exact numbers. Community reports and TV demos consistently describe **growing steps** on repeated presses in one burst **(inferred)**:

| Press index (0-based) | Step |
|----------------------|------|
| 0 | 10 s |
| 1 | 30 s |
| 2 | 60 s |
| 3+ | 5 min (300 s) |

Total offset after *n* taps forward = sum of the first *n* steps (10, then +30, then +60, …) **(inferred)**.  
Our implementation uses this table for discrete taps (`seekTapStepSize` in `tv/player.js`).

## While the key is held (key repeat)

Held repeat uses a separate ramp: 10 s → 30 s → 60 s → 300 s per repeat tick, keyed off repeat count **(inferred from Netflix Android/TV parity descriptions and Samsung community threads)**. Implemented as `seekHoldStepSize` in `tv/player.js`.

## Playback and timing

- **First press:** scrub marker and time label update in the same frame as the key event; pause is scheduled immediately after paint (no 700 ms nav debounce) **(inferred: “instant” Netflix skip)**.
- **During scrub:** picture stays paused; scene thumbnail strip tracks the target **(inferred)**.
- **OK / Play:** seek to marker, resume if playback was not paused before scrub **(inferred)**.
- **Back:** cancel; resume from original time **(inferred)**.
- **Release after hold:** commit to marker and resume **(inferred; Netflix TV)** — implemented on FF/RW keyup when the session used hold/repeat.

## On-screen elements

| Element | Netflix **(inferred)** | Onto TV |
|---------|------------------------|---------|
| Progress marker | Diamond / dot on bar | `#osd-seek` |
| Delta bubble | e.g. `+0:10` | `#osd-seek-time` |
| Elapsed clock | Shows preview time while scrubbing | `#osd-elapsed.is-preview` |
| Thumbnails | Strip above bar | Existing scene strip (`showStrip`) |
| Controls timeout | Bar fades after idle (~5 s) **(inferred)** | Existing `showOsd` hide timer |

## References (URLs)

- Netflix Help — *How to fast forward, rewind, or pause* (wording varies by locale): https://help.netflix.com/node/14563 **(sourced; general TV wording, no second-level timings)**
- Netflix Help — *Netflix Features on Samsung Smart TV*: https://help.netflix.com/node/14552 **(sourced; documents player controls exist; no step table)**
- Samsung Community — fast-forward increment threads (e.g. search “Netflix fast forward 10 seconds 30”): https://us.community.samsung.com **(inferred step sizes)**
- Reddit r/NetflixUK / r/television — “skip 10 seconds” TV remote threads **(inferred; anecdotal)**

Anything not backed by an official Netflix page is **inferred** and should be re-checked against a live Samsung Netflix build if behaviour drifts.