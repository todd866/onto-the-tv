# Content wishlist — inspiration for acquisition agents

Ian, 4 Nov 2026: "anything you can't download yourself at least put it into a list so future
agents can use it for inspo." Sources: the household's last 5,000 YouTube watches and 248
subscriptions (pulled 4 Nov 2026; counts are title matches, grep-checked), and a survey of
Australian free-to-air channels and ratings (2025). Read this before an acquisition run; tick
items off (move to "Have") when they land, with the date.

Household (see the acquisition brief in `~/.local/state/onto-the-tv-acquisition/run-ablit.sh`):
Ian (M), Fran (M; no animation, no graphic violence), Jake 6 (PG; cars, games), Sam 2 (G).

## Already downloading (4 Nov 2026, `m2:~/.local/state/onto-the-tv-channels/yt-batch`)

The household's own long-form watches, by video id: Tiny Desk (25), Like A Version (25),
From the Basement (5), Cercle (4), BBC live sessions (7), Fred again.. (12), Barry Can't Swim (8),
Tame Impala (10), Jamie xx (8), The Avalanches (8), Radiohead (8), Jungle (7), ODESZA (6),
RÜFÜS DU SOL (6) → `/Volumes/Stash/Movies/music-videos/<series or artist>`;
Come Dine With Me (20) → `grown-ups`; Hop Hop the Owl (12) → `preschool`.
The runner is idempotent (`archive.txt`) and stops on YouTube bot-checks; re-run it to resume.

## Priority (Ian, 4 Nov 2026)

Fran's top three are **Come Dine With Me, Friends and The Big Bang Theory**, and she is a big fan
of **British reality TV**, and she likes **Kath & Kim** (have). We have Friends and some Come Dine. Get **The Big Bang Theory** (full
series, torrent via the M2's qBittorrent pattern) into `/Volumes/Stash/Movies/sitcoms/The Big Bang
Theory (2007)`, more **Come Dine With Me** (UK, Couples, Ireland), and British reality: Gogglebox,
First Dates, Four in a Bed, The Great British Bake Off, A Place in the Sun, Escape to the Country,
The Traitors, Race Across the World, The Repair Shop, The Apprentice, Dragons' Den, Bargain Hunt,
Homes Under the Hammer → `/Volumes/Stash/Movies/grown-ups/<Show>`. Folder names must match the
show name: the "For Fran" channel picks these shows by folder name.

## Wanted — YouTube, downloadable (next runs)

| For | What | Why (evidence) |
|---|---|---|
| Ian | More Tiny Desk, Like A Version, Cercle, Boiler Room-style long sets, KEXP sessions | 57 / 62 / 11 watches; long-form live music is the household's biggest single habit (~770 music watches) |
| Ian | Four Tet, Caribou, Bonobo, Chemical Brothers, Flume, Ben Böhmer, Elderbrook, Sam Fender | 9–25 watches each |
| Ian | Aviation: Air Safety Institute, EAA, cockpit and airshow films | subscribed; ex-pilot |
| Ian (+Jake) | Mark Rober, Johnny Harris, Outdoor Boys, abandoned-places and restoration docs | subscribed; ~22 urbex/resto watches |
| Ian (+Jake) | Car restoration and Top Gear / Grand Tour-style long-form | ~15 car watches; Jake loves cars |
| Fran | Come Dine With Me full episodes and omnibuses (UK, Ireland, Couples) | 41 watches; her top show |
| Ian + Fran | **Bald and Bankrupt** — one of the few YouTubers they share (Ian, 4 Nov); queued in batch 2 → `together` | subscribed |
| Fran | Christmas carol and Christmas songs playlists (seasonal) | 21 watches |
| Sam | Hop Hop the Owl full episodes; The Wiggles; Ms Rachel | 32 Hop Hop, 74 nursery-song watches |
| Jake | **Minecraft (his favourite, Ian 4 Nov)**: Grian, Mumbo Jumbo, Hermitcraft episodes, official Minecraft animations and Minecraft Live, LEGO Minecraft → `/Volumes/Stash/Movies/gaming/<creator>` ("For Jake" picks folders matching minecraft/grian/mumbo/hermitcraft/lego) | 40 Minecraft watches; keep the YTP/"try not to laugh" edits off |

## Wanted — not downloadable by us (buy, record, or find a legal free source)

| For | What | Note |
|---|---|---|
| Sam, Jake | **Real Bluey episodes** (beyond what iview carries) | History shows 41 Bluey watches, almost all YTP edits; give them the real thing |
| Fran, Ian | Muster Dogs, Gruen (have), Hard Quiz (have), Have You Been Paying Attention?, Taskmaster, QI | Top-rated AU comedy / factual; ABC iview may carry some (check before buying) |
| Fran | The Block, Grand Designs, Location Location Location, Escape to the Country | 9Life / 7two lifestyle anchors; Fran likes reality |
| Ian (+together) | Cosy British mysteries: Father Brown, Midsomer Murders, Foyle's War, Vera (have a little), Death in Paradise (have a little) | 7two's "Best of British"; not Fran's thing (Ian, 4 Nov) |
| Fran | True crime series: Snapped, Australian Story, Four Corners episodes on cases | 7Bravo / ABC; Fran likes real cases |
| Family | RFDS, The Family Next Door, Austin | top AU drama/comedy 2025 |
| Sam | ABC Kids staples: Play School (have), In the Night Garden, Teletubbies, Bananas in Pyjamas, Peppa Pig (have), Paddington, Peter Rabbit | ABC Kids morning and wind-down blocks |
| Jake | Pokémon, LEGO Dreamzzz, Paw Patrol, SpongeBob, Odd Squad, Gardening Australia Junior | 9Go!/Nickelodeon/ABC 5–8 anchors |
| Family | Friday family films (Paddington, Wallace & Gromit, Pixar) | the "Friday movie" ritual |
| Jake | A Minecraft Movie (2025, PG) | his favourite game; buy or rent |

## Keep, but rationed

Billy's Aviation / "If Planes Could Talk" (air-crash cartoons): Jake loves them, Fran doesn't. Keep
them (the rotation tops them up), never add more of the kind, and the server plays them rarely
and never bills them as a card's "now on" (LIMITED_SHOWS in `src/tv-server.js`).

## Keep off the TV

YouTube Poop / "try not to laugh" edits of Bluey and Peppa (42 watches), #fyp comedy
compilations, IQ-puzzle bait, Lava Chicken / Believer remix loops, rank/edit Shorts channels
(most of the 248 subscriptions), Cocomelon-style autoplay loops, Vlad and Niki, Unspeakable,
Stokes Twins, Brent Rivera. ABC NEWS live is a live stream, not library material.

## Channel ideas (from free-to-air scheduling)

Fixed anchors (one show at the same time daily, like Play School at 9), a bedtime handover at
7:30 pm from preschool to family viewing, themed nights (cartoon Wednesday for Jake, Friday
family film, Sunday drama), Sunday omnibus of a serial, a cosy British mystery channel, a home
and garden channel, a "big machines" channel (cars, mining, aviation), a live-sessions music
channel, and a game-night channel (quiz and panel comedy).
