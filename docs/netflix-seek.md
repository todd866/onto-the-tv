# Netflix smart-TV seek (reference for onto-the-tv)

Research date: 16 Nov 2026. Goal: match Netflix on Samsung Tizen–class TVs for **D-pad Left / Right** and **Rewind / Fast-forward**.

Tags: **(sourced)** = tied to a listed URL or official/help page; **(owner spec)** = Ian’s onto-tv rule not verified from Netflix; **(inferred)** = reasonable guess, not directly sourced.

## D-pad Left / Right while watching

| Input | Netflix **(sourced)** | Onto TV |
|-------|----------------------|---------|
| Single tap | Skip **10 seconds** backward or forward on TV apps **(sourced: How-To Geek; BGR)** | Instant seek; playback stays playing; OSD shows elapsed + delta bubble |
| Hold | Faster scan while held **(sourced: How-To Geek; BGR)** | Key-repeat ramp via `seekHoldStepSize`; stays playing on release |
| With transport row focused | Moves between on-screen buttons **(inferred)** | Unchanged: Left/Right only move focus |

## Rewind / Fast-forward keys

| Input | Netflix **(inferred)** | Onto TV |
|-------|------------------------|---------|
| Tap / hold | Skip / scrub with pause on many TV builds **(inferred)** | Enters seek mode: picture pauses, marker + thumbnails, OK commits, Back cancels |

## Step size per press (same session, one direction)

Netflix does not publish exact numbers for growing tap steps **(owner spec for 10 / 30 / 60 / 300 s burst table)**. Community TV threads often describe **larger jumps on repeated presses** **(inferred)**.

| Tap index (0-based) | Step |
|----------------------|------|
| 0 | 10 s |
| 1 | 30 s |
| 2 | 60 s |
| 3+ | 5 min (300 s) |

**(owner spec):** Taps in one direction within **1.5 s** continue the burst; a longer gap or a direction change restarts at 10 s.

Total offset after *n* taps forward = sum of the first *n* steps (10, then +30, then +60, …). Implemented as `seekTapStepSize` in `tv/player.js`.

## While the key is held (key repeat)

Held repeat uses a separate ramp: 10 s → 30 s → 60 s → 300 s per repeat tick, keyed off repeat count **(inferred from Android/TV parity descriptions)**. Implemented as `seekHoldStepSize` in `tv/player.js`.

## Playback and timing

- **Arrow tap:** position and bubble update in the same key handler; no debounce; **does not pause** **(owner spec)**.
- **FF/RW first press:** marker updates in the same frame; pause on next tick **(inferred)**.
- **During FF/RW scrub:** picture paused; thumbnail strip tracks target **(inferred)**.
- **OK / Play after FF/RW scrub:** seek to marker, resume if it was playing **(inferred)**.
- **Back during FF/RW scrub:** cancel to original time **(inferred)**.
- **Release after FF/RW hold:** commit and resume **(inferred)**.

## Bounds

- Never before 0 s; never past **duration − 5 s** **(owner spec)**.

## On-screen elements

| Element | Netflix **(inferred)** | Onto TV |
|---------|------------------------|---------|
| Progress marker | Diamond / dot on bar | `#osd-seek` (FF/RW seek mode) |
| Delta bubble | e.g. `+0:10` | `#osd-seek-time` |
| Elapsed clock | Preview time while scrubbing | `#osd-elapsed.is-preview` |
| Thumbnails | Strip above bar | Scene strip (`showStrip`) on FF/RW seek |

## References (URLs)

- How-To Geek — skip 10 seconds on YouTube, Netflix, etc.: https://www.howtogeek.com/667493/how-to-skip-back-and-forward-10-seconds-in-youtube-and-other-apps/ **(sourced: 10 s tap; hold to scan)**
- BGR — Netflix settings / remote tips: https://www.bgr.com/tech/8-useful-netflix-settings-you-probably-dont-even-know-about/ **(sourced: TV skip behaviour)**
- Netflix Help — *How to fast forward, rewind, or pause*: https://help.netflix.com/node/14563 **(sourced; general wording, no step table)**
- Netflix Help — *Netflix Features on Samsung Smart TV*: https://help.netflix.com/node/14552 **(sourced; controls exist; no timings)**

Anything not backed by those pages or the 10 s / hold notes is **(inferred)** or **(owner spec)** and should be re-checked against a live Samsung Netflix build if behaviour drifts.