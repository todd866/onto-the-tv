# Guest phone app

Stage 1 of the invite site: friends and family watch the library on a phone browser.

- **Server.** `src/guest-server.js` runs inside `bin/tv-server.js` on `127.0.0.1:8687` (`--guest-port`,
  `0` turns it off). It shares the catalogue and media cache but has no route to the TV server's
  pairing token, TV commands, games, diagnostics or the family's taste and history.
- **Reach.** Tailscale Funnel publishes it over https: `tailscale funnel --bg 8687` on the M2. The
  household TV server on 8686 is not published.
- **Invites.** On the M2: `node bin/invite.js "Dave" --rating M --days 7` prints a link once.
  `--list` shows guests and `--revoke "Dave"` ends access at once. Changing a guest's rating
  ends their sessions. `guests.json` holds only SHA-256 hashes of invite and session secrets.
- **What a guest can play.** Channels at their ceiling (G, PG or M map to Sam, Jake or Dad).
  Only MP4, M4V and MOV files, because phones cannot play MKV or AVI. A guest can only fetch media and art the server has dealt to them,
  rechecked against their current ceiling on every request. Each guest keeps their own history.
- **Limits.** 3 simultaneous streams per guest and 6 in total (the M2 is fanless and on a home upload).

Reviewed adversarially on 4 November 2026 (Claude plus two Codex rounds). The findings were a
malformed-URL crash, cross-process races in the guest file, slot and file-descriptor leaks on
early disconnect, and stale grants after a rating change. Each is fixed and has a regression
test in `src/guest-server.test.js`.
