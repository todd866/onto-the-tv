# To do

Open work for Onto the TV, newest first. Each item says what "done" means.
Song-map work that belongs to Glancebar is in `~/Projects/glancebar/docs/TODO.md`; the TV half is here.

## Waiting to ship (built, tested, on the M2 or in a worktree)

- [ ] **Back chip only with the controls** ("< KEXP" / "< COLORS" stuck on screen, 16 Nov). Merged on the M2
  (bd4629e); live after the next TV reload. Done: the chip never sits alone on a playing picture.
- [ ] **Skip names the next title at once.** Merged (bd4629e + f46cbdc). Done: the title shows in the frame of
  the press when the next pick is known, else when /api/next answers.
- [ ] **Endless Down row.** Merged (60dc18c, 6fa7091). Done: Down while watching opens a sideways row that
  loads 12 more at a time, no show twice within five tiles, full title under the row.
- [ ] **Music picks the Glancebar way** (worktree `tv-music-pick`, 4e578b9, not reviewed or merged). Heard in
  the last 3 days goes to the back; a skip under 30 s is a mild dislike; music never offers "resume"; next pick
  by Glancebar's song vectors (artist centroids). Review, then match a video to its exact song first, artist
  average second. Done: on Live Sets / Music, nothing heard today comes back and no skipped half-played video
  is offered.

## Next

- [ ] **Netflix-style seek** (Ian, 16 Nov: "click right or left ... instantly jump, 10 s on first click, 30 s on
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
- [ ] **Show embeddings** (Ian, 16 Nov: "embed the shows in vector space", not by feeding video to Gemini).
  Per show: Wikipedia/Wikidata summary and genres, IMDb's free datasets, YouTube channel and video
  descriptions (paced; YouTube bot-checks). Per episode: subtitles, 6-8 still frames through a small local
  image model on the M2. Done: "nearest shows" lists for South Park, Bluey and KEXP that Ian agrees with,
  then the Down row ranks by them (`rankCandidates` is the hook).
- [ ] **Home layout per person.** The paged "now" layout is the default for everyone; narrow per profile once
  Ian has lived with it (Jake keeps `tube`).

## Faults to look into

- [ ] **Stash drive stalls** (16 Nov, 15:07). The library drive (WD My Passport, USB) stopped answering: the
  catalogue builder sat in disk wait for 18 min and a server restart took 75 s. Earlier the same day the server
  hung on a Stash read and the TV lost every picture. Find out whether it is the drive, the USB path or
  macOS prompts; keep the server answering whatever the drive does.
- [ ] **A channel resumed a title at its last second** and the TV stuck (fixed in b420833: nearly over is
  over). Add a test for it.
- [ ] **`scripts/check-tv-undo.mjs` fails on main** (waits for a Continue row that the now layout no longer
  shows). Update it to the paged cards.
- [ ] **Push to GitHub needs Ian's yes** (public repo). The M2 runs commits that are not on origin; the morning
  check warns about it until they are pushed.
