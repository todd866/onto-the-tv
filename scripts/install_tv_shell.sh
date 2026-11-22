#!/bin/bash
# Run the TV shell (the full-screen home screen) at login on the Mac behind the TV,
# and restart it if it quits. Needs the TV server (install_tv_server.sh) on this Mac.
#   scripts/install_tv_shell.sh            install or update, then restart
#   scripts/install_tv_shell.sh --remove   stop and remove the login item
set -eu
LABEL=com.onto-the-tv.shell
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/onto-tv-shell.log"
ELECTRON="$ROOT/node_modules/.bin/electron"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then
  mv "$PLIST" "$HOME/.Trash/$LABEL.plist.$(date +%s)" 2>/dev/null || true
  echo "removed $LABEL"; exit 0
fi
[ -x "$ELECTRON" ] || { echo "Run npm ci in $ROOT first"; exit 1; }

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$ELECTRON</string><string>$ROOT/src/tv-shell.js</string>
  </array>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "TV shell running; log: $LOG"
