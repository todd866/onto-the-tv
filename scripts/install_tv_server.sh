#!/bin/bash
# Run the TV server at login on this Mac and keep it running.
#   scripts/install_tv_server.sh            install or update, then restart
#   scripts/install_tv_server.sh --remove   stop and remove the login item
set -eu
LABEL=com.onto-the-tv.server
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/onto-tv-server.log"
PORT="${ONTO_TV_PORT:-8765}"
NODE="$(command -v node || true)"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  mv "$PLIST" "$HOME/.Trash/$LABEL.plist.$(date +%s)" 2>/dev/null || true
  echo "removed $LABEL"; exit 0
fi
[ -n "$NODE" ] || { echo "Node.js 22.12+ is required (brew install node)"; exit 1; }
command -v ffprobe >/dev/null || { echo "FFmpeg is required (brew install ffmpeg)"; exit 1; }

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>$ROOT/bin/tv-server.js</string><string>--port</string><string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$(dirname "$(command -v ffprobe)"):/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 2
done
if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<this Mac>')
  echo "TV server running: http://$ip:$PORT/"
else
  echo "TV server did not start; see $LOG"; tail -20 "$LOG"; exit 1
fi
