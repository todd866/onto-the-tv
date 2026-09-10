<p align="center"><img src="brand/onto-the-tv-icon.png" width="140" alt="An amber television with a sunset on its screen"></p>

# Onto the TV

**Your videos, on the Mac or the big screen.**

Onto the TV brings Kids Shuffler and Samsung TV playback into one small Mac app.
Open an offline family player, or drop a video into a queue for your TV. No
account, subscription, catalogue, or analytics service.

![The combined Mac app with Kids Shuffler ready to open](brand/app-preview.png)

## Two places to watch

**On this Mac — Kids Shuffler.** Choose Little Kids, Big Kids, Grown-ups, Music,
or Everything. The player mixes shows, learns gently from skips and completions,
and avoids recent repeats. Left and right arrows move back and forward through
recent episodes. Going back cancels an early-skip penalty. Each stream learns
separately; empty streams are hidden.

**On the TV.** Drop a local video or choose a folder. The first video starts on
a compatible Samsung DLNA renderer; the rest queue up. Pause, resume, or stop
from the app. Compatible media streams directly; other formats are converted
with FFmpeg and temporary files are cleaned up when playback stops.

The shuffler plays in your default browser. TV playback uses the files you
choose; it does not yet follow the shuffler automatically. The Mac must stay
awake and on the same network while serving the TV.

## Install on a Mac

Requires **macOS 13+**, **Node.js 22.12+**, **Python 3.10+**, and **FFmpeg**. Node
is needed to install/develop, but the installed app contains its own Electron
runtime. FFmpeg and Python are still external prerequisites. With Homebrew:

```sh
brew install node python ffmpeg
git clone https://github.com/todd866/onto-the-tv.git
cd onto-the-tv
npm ci
npm run install-app
```

Open **Onto the TV** from `~/Applications` and drag it to the Dock if you like.
The installer downloads Electron on first use, builds a self-contained app,
checks its local signature, and preserves any previous installation as a hidden
backup beside it. It never starts playback. This is a source-built app with an
ad-hoc signature, not an Apple-notarized binary release.

For development, use `npm start`. To stage a build without registering it:

```sh
python3 scripts/install_mac_app.py --output "dist/Onto the TV.app" --no-register
```

## Set up Kids Shuffler

1. Keep one show per folder inside a video library.
2. Copy [shuffler/tiers.example.json](shuffler/tiers.example.json) to a private
   `tiers.json`. Put your show folder names into the appropriate groups.
3. In **On this Mac → Your video library**, choose the folder and show groups,
   then **Build / refresh player**.
4. Open Kids Shuffler and pick a stream.

Unknown shows go only to Everything. Group choices are yours; they are not
verified age ratings, and the stream picker is not a parental lock. Extra
folders and individual films can be included using the optional
[sources example](shuffler/sources.example.json).

Already have Kids Shuffler? **Use existing player…** opens the same HTML file
in your usual browser, retaining its local preferences. Select your original
show-group and source configurations before rebuilding. Keep using the same
browser profile and HTML location.

The [shuffler guide](shuffler/README.md) covers configuration, shortcuts,
learning, browser compatibility, and safe Android copying with VLC playlists.
Phone playback uses VLC; it does not run the browser learner.

## Set up a TV

In **On the TV → TV settings**, enter the TV's IPv4 address from its network
settings. The default control endpoint is
`http://TV_ADDRESS:9197/upnp/control/AVTransport1`. If your Samsung uses a different
UPnP AVTransport endpoint, enter it under advanced settings. You can also choose
the Mac's Wi-Fi address when automatic interface selection picks the wrong one.

This uses Samsung's DLNA/UPnP renderer, not AirPlay, Chromecast, or the YouTube TV
app. It grew from a 2017 Samsung setup; compatibility with other models depends
on their renderer. There is no automatic device discovery yet.

For advanced command-line use, `npm run cast -- --help` exposes the casting
tools. Optional YouTube URL support in that CLI requires `yt-dlp`; the desktop
app works with local files. Supply your own media and permissions to use it.

## Privacy and network access

- Videos stay in your folders. The app has no cloud account or telemetry.
- Browser preferences and up to 3,000 viewing records stay in local storage.
  The [guide](shuffler/README.md#watching-and-learning) explains exactly what is
  recorded. Clearing browser storage removes them.
- TV settings and selected paths live in
  `~/Library/Application Support/Onto the TV/settings.json`, outside the repo.
- During casting, a temporary HTTP server serves only selected files through
  random, unguessable URLs. It is intended for a trusted local network; the TV
  protocol is unencrypted. Stop or quit revokes the URLs.
- Personal configurations, generated players, phone inventories, playlists,
  and media do not belong in a public fork. The provided `.gitignore` excludes
  their default names. Renamed private files must be kept outside the repo too.

No films, shows, music, download lists, or personal viewing data are included.

## Development and tests

```sh
npm test
npm run test:python
```

Tests use simulated TVs and phones, temporary loopback servers, and short silent
clips generated by FFmpeg. They do not contact real hardware. UI smoke testing
can run in headless Chromium with a simulated preload API; no audible or
foreground playback is required.

| Folder | Purpose |
| --- | --- |
| `src/` | Electron shell, private settings, TV queue and local-player bridge |
| `ui/` | Offline app interface |
| `casting/` | Media preparation, HTTP serving and Samsung control |
| `shuffler/` | Offline player, generator, Android sync and playlist tools |
| `brand/` | Shared TV icon and macOS icon bundle |

## License and credits

[MIT](LICENSE). The original app icon was generated with OpenAI's image tools
and is included under the same license. Electron and its bundled components
retain their own licenses; the installer carries their notices into the app.
FFmpeg and optional tools are installed separately. Samsung is a trademark of
its owner; this is an independent project.
