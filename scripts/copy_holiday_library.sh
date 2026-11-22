#!/bin/bash
# Copy the TV library and the TV server's settings onto a drive, for a Mac that serves
# the TV from that drive when the main TV Mac (the M2) cannot be reached: "holiday mode".
#   scripts/copy_holiday_library.sh /Volumes/TV               # library on this Mac
#   scripts/copy_holiday_library.sh /Volumes/TV --from m2     # pull it from the M2 over ssh
#   … --settings-only                                          # refresh settings, skip the videos
# Writes <drive>/Movies (a copy of ~/Movies) and "<drive>/Onto the TV" (settings, show
# groups, taste, places and the pairing token, with paths pointing at the drive), then:
#   scripts/install_tv_server.sh --app-data "<drive>/Onto the TV"
# Re-run before a trip to bring the copy up to date; it only copies what changed and never
# deletes from the drive. The TV app accepts either Mac because both share one pairing token.
set -eu
TARGET=""; FROM=""; SETTINGS_ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=$2; shift 2 ;;
    --settings-only) SETTINGS_ONLY=1; shift ;;
    -*) echo "unknown option $1"; exit 1 ;;
    *) TARGET=${1%/}; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: $0 /Volumes/<drive> [--from <ssh host>]"; exit 1; }
[ -d "$TARGET" ] || { echo "$TARGET is not there: plug the drive in"; exit 1; }
DATA_NAME='Library/Application Support/Onto the TV'
if [ -n "$FROM" ]; then
  SRC_HOME=$(ssh "$FROM" 'echo $HOME'); SRC="$FROM:"
else
  SRC_HOME=$HOME; SRC=""
fi
APP_DATA="$TARGET/Onto the TV"
mkdir -p "$TARGET/Movies" "$APP_DATA/tv-server"
chmod 700 "$APP_DATA" "$APP_DATA/tv-server"

need=$( (if [ -n "$FROM" ]; then ssh "$FROM" 'du -sk ~/Movies'; else du -sk ~/Movies; fi) | awk '{print $1}')
have=$(df -k "$TARGET" | awk 'NR==2{print $4}')
echo "library: $((need / 1048576)) GB; free on the drive: $((have / 1048576)) GB (only changes are copied)"

echo "copying settings…"
FILES='settings.json kids-sources.json kids-tiers.json audiences.json taste.json playback-history.json
       tv-server/pairing-token tv-server/taste-storage.json tv-server/playback-history.json'
# One tar stream: files the source lacks are skipped (an rsync of a missing file makes a folder).
PACK="cd \"\$HOME/$DATA_NAME\" && for f in $(echo $FILES); do [ -f \"\$f\" ] && echo \"\$f\"; done | tar cf - -T -"
if [ -n "$FROM" ]; then ssh "$FROM" "$PACK"; else bash -c "$PACK"; fi | (cd "$APP_DATA" && tar xpf -)
[ -s "$APP_DATA/settings.json" ] || { echo "no settings.json came across from $SRC_HOME/$DATA_NAME"; exit 1; }
[ -s "$APP_DATA/tv-server/pairing-token" ] || echo "  warning: no pairing token; the installed TV app will not accept this Mac"

# Point every path at the drive: the library folders, and the settings files themselves.
python3 - "$APP_DATA" "$SRC_HOME" "$TARGET" <<'EOF'
import json, os, sys
app_data, src_home, target = sys.argv[1:]
swaps = [(f'{src_home}/{"Library/Application Support/Onto the TV"}', app_data),
         (f'{src_home}/Movies', f'{target}/Movies'), ('~/Movies', f'{target}/Movies')]
def fix(value):
    if isinstance(value, str):
        for old, new in swaps:
            if value == old or value.startswith(old + '/'): return new + value[len(old):]
        return value
    if isinstance(value, list): return [fix(v) for v in value]
    if isinstance(value, dict): return {fix(k): fix(v) for k, v in value.items()}
    return value
for folder, _, files in os.walk(app_data):
    for name in files:
        if not name.endswith('.json'): continue
        path = os.path.join(folder, name)
        with open(path) as f: data = json.load(f)
        with open(path + '.new', 'w') as f: json.dump(fix(data), f, indent=2)
        os.chmod(path + '.new', 0o600); os.replace(path + '.new', path)
print(f"settings now point at {target}/Movies")
EOF

if [ -z "$SETTINGS_ONLY" ]; then
  echo "copying the library (the first copy takes a while)…"
  rsync -a --partial --exclude .DS_Store "$SRC$SRC_HOME/Movies/" "$TARGET/Movies/"
fi
echo "done. Next, on the Mac the drive travels with:"
echo "  scripts/install_tv_server.sh --app-data \"$APP_DATA\""
