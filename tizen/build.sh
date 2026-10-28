#!/bin/bash
# Build the Samsung TV app (.wgt) that talks to the Mac running bin/tv-server.js.
#   tizen/build.sh [--server-host m2] [--address http://192.168.1.30:8686 ...]
# The pairing token is read from the server Mac (locally, or over ssh with --server-host).
# Signing needs Tizen Studio's CLI and a Samsung certificate profile; see tizen/README.md.
set -eu
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
cp "$ROOT"/tv/index.html "$ROOT"/tv/app.js "$ROOT"/tv/player.js "$ROOT"/tv/styles.css "$HERE"/config.xml "$HERE"/icon.png "$APP"/
servers=$(printf '"%s",' "${ADDRESSES[@]}"); servers="[${servers%,}]"
printf 'window.ONTO_CONFIG = {"servers":%s,"token":"%s","port":8686};\n' "$servers" "$TOKEN" > "$APP/config.js"
chmod 600 "$APP/config.js"
# Samsung's web APIs (AVPlay) load only inside an installed app.
perl -0pi -e 's|<script src="config.js"></script>|<script src="\$WEBAPIS/webapis/webapis.js"></script>\n<script src="config.js"></script>|' "$APP/index.html"
echo "app files: $APP (servers $servers)"

TIZEN="${TIZEN:-$(command -v tizen || echo "$HOME/tizen-studio/tools/ide/bin/tizen")}"
if [ -x "$TIZEN" ]; then
  "$TIZEN" package -t wgt -s "$PROFILE" -o "$OUT" -- "$APP"
  ls -l "$OUT"/*.wgt
else
  echo "Tizen CLI not found: install Tizen Studio (see tizen/README.md), then re-run to sign and package."
fi
