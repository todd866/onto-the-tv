# Onto the TV on a Samsung TV

The TV pulls from a Mac on the same network that runs the TV server
(`bin/tv-server.js`, installed as a login item by `scripts/install_tv_server.sh`).

## Quickest: the TV's web browser

Open **Internet** on the TV and go to `http://<Mac address>:8686/`, then bookmark it.
The Mac's address is printed by the install script. The browser drives the page with a
pointer: click a tile to open it, click the video to pause.

## Proper: the installed app

The installed app is driven with the remote's arrows, OK, Back, Play/Pause and ⏭ / Channel ▲.
It remembers the Mac's address; if the address changes it asks for the new one.

Choose **Play channel** for continuous smart shuffle. Selecting an episode also starts
a channel with that episode first: a Bluey selection continues through the kids pool,
using the same picker and learning rules as the Mac player. An explicitly opened
Little Kids or Big Kids channel is preserved; a shared kids episode selected from
home defaults to Little Kids. Grown-up serials continue in story order. Content
without a specific supported channel retains its show/single-item playback.

One-off setup, at the TV with a Mac on the same Wi-Fi:

1. **Developer mode on the TV.** Apps → press `1 2 3 4 5` on the remote → Developer mode
   **On**, and enter the IP address of the Mac you will install from. Restart the TV.
2. **Tizen Studio** on that Mac: the CLI installer (`web-cli_Tizen_Studio_6.1_macos-64.bin
   --accept-license ~/tizen-studio`), then `package-manager-cli.bin install --accept-license
   cert-add-on Certificate-Manager TV-SAMSUNG-Extension-Tools TV-SAMSUNG-Public-WebAppDevelopment`.
   On Apple silicon: its bundled Java and `sdb` are Intel-only. Link `~/tizen-studio/jdk` and
   `~/.package-manager/jdk` to an ARM Java 8 (Azul Zulu 8 tarball; the package manager needs
   JAXB, so not 17), and install Rosetta for `sdb`: `softwareupdate --install-rosetta --agree-to-license`.
3. **Samsung certificate.** Tizen Studio → Certificate Manager → new profile `onto`,
   type *Samsung*, device *TV*. It signs in to a Samsung account in the browser and binds the
   certificate to the TV's DUID (the TV must be connected: `sdb connect <TV address>`).
4. **Build and install.**

   ```sh
   tizen/build.sh --server-host m2          # token and address from the server Mac
   sdb connect <TV address>
   tizen install -n tizen/build/onto.wgt -t "$(sdb devices | awk 'NR==2{print $3}')"
   ```

Developer-mode installs do not expire on current TVs, but a TV factory reset removes them.

## Security

The server answers only private-network addresses and only its own host names. The page it
serves is same-origin; the installed app is cross-origin, so every request it makes carries the
pairing token from `~/Library/Application Support/Onto the TV/tv-server/pairing-token`.
To revoke an installed app, move that file to the Trash and restart the server.

## Local diagnostics

The updated packaged app sends a heartbeat every 15 seconds and events for startup,
connection, browsing and playback to its selected Mac. `GET /api/diagnostics` requires
the pairing token in the `X-Onto-Token` header, even for same-origin requests.
The response includes the build identifier, current page, player engine, position,
duration, pause/visibility state and bounded error codes. It never includes titles,
file paths, account details or free-text error messages.

The server keeps at most 32 sessions and 128 events in memory for 24 hours. Heartbeats
update the latest session without filling the event ring. A session is marked stale
after 45 seconds without a report; restarting the server clears the history.
Advancing playback position is evidence of playback activity, not proof of what a
person sees or hears. Install both the server and packaged app update to enable this.
Do not restart either while someone is watching; stage the update until idle.

## Couch race prototype

The race screen is bundled as `rc-couch.html` rather than loaded from an HTTP URL:
this TV sends remote-document navigation to Samsung Browser. Its game-data host
is configurable through `ONTO_COUCH_ADDRESS` at build time (default M5 :8690).
The separate TV credential is read privately from `../.tv-couch-plan/couch-token`;
start the Guns Only `tools/couch/server.mjs` host with that value in
`ONTO_COUCH_TV_TOKEN`. The signed package contains the credential and stays mode 600.
Do not serve the generated package config publicly. The local-file TV origin is
accepted only with that credential; browser drivers use the host's same-origin UI.

The racing view currently uses the existing RC physics with a simplified overhead
track. It is not the full 3D world. Return leaves the embedded screen and releases
its player slot. A host leaving closes the room. The standalone laptop address is
`http://192.168.20.20:8690/`. The host process must remain running.
