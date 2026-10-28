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
   tizen install -n "$(ls tizen/build/*.wgt)" -t "$(sdb devices | awk 'NR==2{print $3}')"
   ```

Developer-mode installs do not expire on current TVs, but a TV factory reset removes them.

## Security

The server answers only private-network addresses and only its own host names. The page it
serves is same-origin; the installed app is cross-origin, so every request it makes carries the
pairing token from `~/Library/Application Support/Onto the TV/tv-server/pairing-token`.
To revoke an installed app, move that file to the Trash and restart the server.
