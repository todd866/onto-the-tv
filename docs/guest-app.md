# Guest phone app

Stage 1 of the invite site: friends and family watch the library on a phone browser, in the real
Onto the TV interface (`tv/`) running in guest mode (`ONTO_CONFIG.guest` from the guest server's
`/config.js`). Guest mode drops the viewer row and the Games, Uke and Console tiles, adds a Back
key and the phone's back gesture, tap-to-show controls and tap-to-seek, and wraps long titles.

- **Server.** `src/guest-server.js` runs inside `bin/tv-server.js` on `127.0.0.1:8687` (`--guest-port`,
  `0` turns it off). It shares the catalogue and media cache but has no route to the TV server's
  pairing token, TV commands, games, diagnostics or the family's taste and history.
- **Reach.** Tailscale Funnel publishes it over https: `tailscale funnel --bg 8687` on the M2. The
  household TV server on 8686 is not published.
- **Invites.** On the M2: `node bin/invite.js "Dave" --rating PG --days 7` prints a link once
  (the rating defaults to G). The link is single-use: opening it shows an Open button (so link
  previews do not spend it), the first device to press it gets the session, and any later device
  is told the link was already used. The first device keeps its session until the expiry.
  `--list` shows guests and `--revoke "Dave"` ends access at once. Changing a guest's rating
  ends their sessions. `guests.json` holds only SHA-256 hashes of invite and session secrets.
- **What a guest can play.** Channels at their ceiling (G, PG or M map to the household's youngest child, older child or first grown-up).
  Only MP4, M4V and MOV files, because phones cannot play MKV or AVI. A guest can only fetch media and art the server has dealt to them,
  rechecked against their current ceiling on every request. Each guest keeps their own history.
- **Limits.** 3 simultaneous streams per guest and 6 in total (the M2 is fanless and on a home upload).

Reviewed adversarially on 4 November 2026 (Claude plus two Codex rounds). The findings were a
malformed-URL crash, cross-process races in the guest file, slot and file-descriptor leaks on
early disconnect, and stale grants after a rating change. Each is fixed and has a regression
test in `src/guest-server.test.js`.
