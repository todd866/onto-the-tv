#!/bin/bash
# Build the Samsung TV app (.wgt) that talks to the Mac running bin/tv-server.js.
#   tizen/build.sh [--server-host m2] [--address http://192.168.1.30:8686 ...]
# The pairing token is read from the server Mac (locally, or over ssh with --server-host).
# Signing needs Tizen Studio's CLI and a Samsung certificate profile; see tizen/README.md.
set -eu
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
OUT="$HERE/build"; APP="$OUT/app"
TOKEN_PATH='Library/Application Support/Onto the TV/tv-server/pairing-token'
HOST=""; ADDRESSES=(); PROFILE="${TIZEN_PROFILE:-onto}"
while [ $# -gt 0 ]; do
  case "$1" in
    --server-host) HOST=$2; shift 2 ;;
    --address) ADDRESSES+=("$2"); shift 2 ;;
    --profile) PROFILE=$2; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done
if [ -n "$HOST" ]; then
  TOKEN=$(ssh "$HOST" "cat \"\$HOME/$TOKEN_PATH\"")
  [ ${#ADDRESSES[@]} -gt 0 ] || ADDRESSES=("http://$(ssh "$HOST" 'ipconfig getifaddr en0 || ipconfig getifaddr en1'):8686")
else
  TOKEN=$(cat "$HOME/$TOKEN_PATH")
  [ ${#ADDRESSES[@]} -gt 0 ] || ADDRESSES=("http://$(ipconfig getifaddr en0 || ipconfig getifaddr en1):8686")
fi
[ -n "$TOKEN" ] || { echo "no pairing token: start bin/tv-server.js once on the server Mac"; exit 1; }

mkdir -p "$APP"
cp "$ROOT"/tv/index.html "$ROOT"/tv/app.js "$ROOT"/tv/player.js "$ROOT"/tv/nav.js "$ROOT"/tv/watch-tracker.js "$ROOT"/tv/watch-delivery.js "$ROOT"/tv/diagnostics.js "$ROOT"/tv/gamepad.js "$ROOT"/tv/remote-games.js "$ROOT"/tv/game-bridge.js "$ROOT"/tv/couch.js "$ROOT"/tv/uke.js "$ROOT"/tv/number-rover.js "$ROOT"/tv/number-rover.css "$ROOT"/tv/remote-games.css "$ROOT"/tv/styles.css "$HERE"/config.xml "$HERE"/icon.png "$APP"/
mkdir -p "$APP/fonts"
cp "$ROOT"/tv/fonts/Nunito-Bold.woff "$ROOT"/tv/fonts/Nunito-ExtraBold.woff "$APP/fonts/"
UKE_ROOT="${UKE_ROOT:-$ROOT/../uke}"
node "$UKE_ROOT/tools/build-tv.mjs" "$APP/uke"
cp "$ROOT/tv/uke-probe.js" "$APP/uke/probe.js"
python3 - "$APP/uke/index.html" <<'PYPROBE'
import sys
from pathlib import Path
p=Path(sys.argv[1]);s=p.read_text()
if 'src="probe.js"' not in s:
    s=s.replace('<head>', '<head><script src="probe.js"></script>')
p.write_text(s)
PYPROBE
# Keep the race document inside the package: remote documents open Samsung Browser.
COUCH_SOURCE="$ROOT/../guns-only/web/wwwroot/rc"
COUCH_ADDRESS="${ONTO_COUCH_ADDRESS:-http://192.168.20.20:8690}"
COUCH_TOKEN=$(cat "$ROOT/../.tv-couch-plan/couch-token")
cp "$HERE/icon.png" "$APP/onto-icon-v3.png"
cp "$COUCH_SOURCE/couch.js" "$APP/rc-couch.js"
cp "$COUCH_SOURCE/couch.css" "$APP/rc-couch.css"
python3 - "$COUCH_SOURCE/couch.html" "$APP/rc-couch.html" <<'PYHTML'
import sys
from pathlib import Path
s=Path(sys.argv[1]).read_text().replace('/rc/couch.css','rc-couch.css').replace('<script src="/rc/couch.js">','<script src="config.js"></script><script src="rc-couch.js">')
Path(sys.argv[2]).write_text(s)
PYHTML
servers=$(printf '"%s",' "${ADDRESSES[@]}"); servers="[${servers%,}]"
BUILD=$(cat "$ROOT"/tv/*.js "$ROOT"/tv/index.html "$ROOT"/tv/*.css "$HERE/config.xml" "$HERE/icon.png" "$COUCH_SOURCE/couch.js" "$COUCH_SOURCE/couch.css" "$COUCH_SOURCE/couch.html" "$APP"/uke/* | shasum -a 256 | cut -c1-16)
ONTO_COUCH_ADDRESS="$COUCH_ADDRESS" ONTO_COUCH_TOKEN="$COUCH_TOKEN" ONTO_BUILD_TOKEN="$TOKEN" ONTO_BUILD_SERVERS="$(printf '%s\n' "${ADDRESSES[@]}")" ONTO_BUILD_ID="$BUILD" python3 -c 'import os,json; print("window.ONTO_CONFIG = " + json.dumps({"servers":os.environ["ONTO_BUILD_SERVERS"].splitlines(),"token":os.environ["ONTO_BUILD_TOKEN"],"couchServer":os.environ["ONTO_COUCH_ADDRESS"],"couchToken":os.environ["ONTO_COUCH_TOKEN"],"port":8686,"build":os.environ["ONTO_BUILD_ID"]}) + ";")' > "$APP/config.js"
chmod 600 "$APP/config.js"
# Samsung's web APIs (AVPlay) load only inside an installed app.
perl -0pi -e 's|<script src="config.js"></script>|<script src="\$WEBAPIS/webapis/webapis.js"></script>\n<script src="config.js"></script>|' "$APP/index.html"
echo "app files: $APP (servers $servers)"

TIZEN="${TIZEN:-$(command -v tizen || echo "$HOME/tizen-studio/tools/ide/bin/tizen")}"
if [ -x "$TIZEN" ]; then
  "$TIZEN" package -t wgt -s "$PROFILE" -o "$OUT" -- "$APP"
  cp "$OUT/Onto the TV.wgt" "$OUT/onto.wgt"
  chmod 600 "$OUT/Onto the TV.wgt" "$OUT/onto.wgt"
  ls -l "$OUT/onto.wgt"
else
  echo "Tizen CLI not found: install Tizen Studio (see tizen/README.md), then re-run to sign and package."
fi
