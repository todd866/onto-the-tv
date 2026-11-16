# To do

Open work for Onto the TV, newest first. Each item says what "done" means.
Song-map work that belongs to Glancebar is in `~/Projects/glancebar/docs/TODO.md`; the TV half is here.

## Shipped 16 Nov 2026 (on the M2; the TV loads it when the app next opens)

- [x] Back chip only with the controls; skip names the next title at once; endless Down row.
- [x] Music picks the Glancebar way (heard in 3 days to the back, <30 s skip a mild dislike, no music resume,
  next pick by Glancebar's song vectors: exact song first, artist second; session folders are not artists).
  Reviewed by Codex (7 findings, all fixed).
- [x] Netflix seek on the D-pad: a tap jumps at once while playing; quick taps grow 10 / 30 / 60 / 300 s;
  hold scans. Netflix publishes a 10 s tap and hold-to-scan; the growing taps are Ian's spec
  (`docs/netflix-seek.md`). Live check pending: Ian to try it.

## Next

- [x] **Netflix-style seek** (shipped, see above) (Ian, 16 Nov: "click right or left ... instantly jump, 10 s on first click, 30 s on
  second, then bigger. Figure out *exactly* what the Netflix UX does and copy that"). First write down Netflix's
  real behaviour on a Samsung TV (step sizes, acceleration, preview thumbnails, when playback resumes), from its
  own help pages and a recording, then match it. Done: a press jumps at once, repeated presses grow the step as
  Netflix's do, release resumes play.
- [ ] **TV music follows Ian** (Glancebar session, 16 Nov). The TV's music channels use the same song map,
  kinds and heard-recently state as Glancebar:
  - put the TV's music videos on the song map (exact song first, artist second; ~2¢ a video to embed the
    rest by audio clips, ~$30 for 1,584, only on Ian's yes);
  - score the triple j and Double J channels with it;
  - add Chill, Dance, Alt and Rap channels;
  - decide whether the TV also plays the lossless songs themselves (audio with cover art) from OTV Mirror
    (asked 16 Nov, no answer yet).
- [ ] **Use the YouTube Takeout** (Ian, 16 Nov). Unpacked at `~/.local/state/youtube-takeout/2026-11-16/Takeout/`
  (M5 and M2): 8,901 searches 2012–2026 (647 on YouTube Music) and ~2,300 playlist video ids (Music,
  Watch later, YouTube Library Sync, Apple Music Delta). No watch history in this export. Searches are a shared
  account's (household members' too), so weight Ian's own playlists above searches. Done: music artists and
  shows Ian searched or saved rank higher on the TV's music channels and the Down row; searched-for music not
  in the library goes to the acquisition queue only after Ian's yes.
- [ ] **Show embeddings** (Ian, 16 Nov: "embed the shows in vector space", not by feeding video to Gemini).
  Per show: Wikipedia/Wikidata summary and genres, IMDb's free datasets, YouTube channel and video
  descriptions (paced; YouTube bot-checks). Per episode: subtitles, 6-8 still frames through a small local
  image model on the M2. Done: "nearest shows" lists for South Park, Bluey and KEXP that Ian agrees with,
  then the Down row ranks by them (`rankCandidates` is the hook).
- [ ] **Home layout per person.** The paged "now" layout is the default for everyone; narrow per profile once
  Ian has lived with it (Jake keeps `tube`).

- [ ] **Fold unslop's audit into `instrument-ux`** (Ian, 16 Nov: "sure"). From github.com/heydamir/unslop
  (CC BY 4.0, credit Damir Sokolovsky): its `references/signs.md` checklist (emoji labels, tracked uppercase,
  uneven spacing, glows, mixed number formats) and its copy rules (no `!` in interface text, short labels, no
  hype words, sentence case, tabular figures) become an audit step in `~/.claude/skills/instrument-ux/SKILL.md`,
  plus its pass order (spacing, colour, icons, copy, type, layout, details). Not its landing-page hero rules or
  its 400/500 weights (the TV uses heavy type for couch distance). Do not install the plugin.

## Faults to look into

- [ ] **Stash drive stalls** (16 Nov, 15:07). The library drive (WD My Passport, USB) stopped answering: the
  catalogue builder sat in disk wait for 18 min and a server restart took 75 s. Earlier the same day the server
  hung on a Stash read and the TV lost every picture. Find out whether it is the drive, the USB path or
  macOS prompts; keep the server answering whatever the drive does.
- [ ] **A channel resumed a title at its last second** and the TV stuck (fixed in b420833: nearly over is
  over). Test added (45f1a4e).
- [x] **`scripts/check-tv-undo.mjs` updated** (passes; one flaky run seen 16 Nov) (waits for a Continue row that the now layout no longer
  shows). Update it to the paged cards.
- [ ] **Push to GitHub needs Ian's yes** (public repo). The M2 runs commits that are not on origin; the morning
  check warns about it until they are pushed.
