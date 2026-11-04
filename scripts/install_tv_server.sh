#!/bin/bash
# Run the TV server at login on this Mac and keep it running.
#   scripts/install_tv_server.sh            install or update, then restart
#   scripts/install_tv_server.sh --remove   stop and remove the login item
#   scripts/install_tv_server.sh --app-data "/Volumes/TV/Onto the TV"
#       keep settings, catalogue and artwork in that folder (made by copy_holiday_library.sh)
#       and run the server only while it exists, so it starts when the drive is plugged in.
set -eu
LABEL=com.onto-the-tv.server
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/onto-tv-server.log"
PORT="${ONTO_TV_PORT:-8686}"
NODE="$(command -v node || true)"
APP_DATA=""; REMOVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) REMOVE=1; shift ;;
    --app-data) APP_DATA=${2%/}; shift 2 ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
done

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone; bootstrapping too soon fails with "5: Input/output error".
for _ in $(seq 1 20); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
if [ -n "$REMOVE" ]; then
  mv "$PLIST" "$HOME/.Trash/$LABEL.plist.$(date +%s)" 2>/dev/null || true
  echo "removed $LABEL"; exit 0
fi
[ -n "$NODE" ] || { echo "Node.js 22.12+ is required (brew install node)"; exit 1; }
command -v ffprobe >/dev/null || { echo "FFmpeg is required (brew install ffmpeg)"; exit 1; }
EXTRA=""; KEEPALIVE="<true/>"
if [ -n "$APP_DATA" ]; then
  [ -f "$APP_DATA/settings.json" ] || { echo "no settings.json in $APP_DATA (run copy_holiday_library.sh first)"; exit 1; }
  EXTRA="<string>--app-data</string><string>$APP_DATA</string>"
  KEEPALIVE="<dict><key>PathState</key><dict><key>$APP_DATA/settings.json</key><true/></dict></dict>"
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$ROOT/bin/tv-server.js</string><string>--port</string><string>$PORT</string>$EXTRA
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$(dirname "$(command -v ffprobe)"):/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>$( [ -n "$APP_DATA" ] && echo '<false/>' || echo '<true/>')
  <key>KeepAlive</key>$KEEPALIVE
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
for attempt in 1 2 3; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  [ "$attempt" = 3 ] && { launchctl bootstrap "gui/$(id -u)" "$PLIST"; exit 1; }
  sleep 2
done
# The first start builds the catalogue (probing every video), which takes a while on a USB drive.
for _ in $(seq 1 60); do
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done
if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<this Mac>')
  echo "TV server running: http://$ip:$PORT/"
else
  echo "TV server did not start; see $LOG"; tail -20 "$LOG"; exit 1
fi
