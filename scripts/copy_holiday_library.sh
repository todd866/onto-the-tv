#!/bin/bash
# Pack a trip: copy a list of titles and the TV server's settings onto a drive, for a Mac that serves the TV
# from that drive when the main TV Mac (the M2) cannot be reached: "holiday mode".
#   scripts/trip_list.py --from m2 --gb 150 --out ~/trip.json           # 1. make the list (copies nothing)
#   scripts/copy_holiday_library.sh /Volumes/TV --from m2 --list ~/trip.json    # 2. pack it
#   … --settings-only                                                    # refresh settings, skip the videos
#   scripts/copy_holiday_library.sh /Volumes/TV                          # the old way: all of ~/Movies on this Mac
# Writes <drive>/Movies and "<drive>/Onto the TV" (settings, show groups, taste, places and the pairing token,
# with every path pointing at the drive), then:
#   scripts/install_tv_server.sh --app-data "<drive>/Onto the TV"
# Run it again before a trip to bring the copy up to date; it copies only what changed and never deletes from
# the drive. The TV app accepts either Mac because both share one pairing token.
#
# 22 Nov 2026. The library moved from ~/Movies to a drive on the hub, so the old whole-library copy took nothing
# (the M2's ~/Movies held 12 KB) and could not have fitted anyway (784 GB). With --list the titles come from
# wherever the hub's library is (the list names its root), the hub's drive is read under disk-slot when it has
# one, and the travel drive is never taken over 75% used (the household ceiling for
# every physical drive; HOLIDAY_CEILING_PCT changes that). A listed title that is only in the cloud
# is not packed yet: it is counted and named, not fetched.
set -eu
TARGET=""; FROM=""; SETTINGS_ONLY=""; LIST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=$2; shift 2 ;;
    --list) LIST=$2; shift 2 ;;
    --settings-only) SETTINGS_ONLY=1; shift ;;
    -*) echo "unknown option $1"; exit 1 ;;
    *) TARGET=${1%/}; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "usage: $0 /Volumes/<drive> [--from <ssh host>] [--list trip.json]"; exit 1; }
[ -d "$TARGET" ] || { echo "$TARGET is not there: plug the drive in"; exit 1; }
[ -z "$LIST" ] || [ -s "$LIST" ] || { echo "$LIST is not there or is empty: make it with scripts/trip_list.py"; exit 1; }
CEILING=${HOLIDAY_CEILING_PCT:-75}
DATA_NAME='Library/Application Support/Onto the TV'
if [ -n "$FROM" ]; then
  SRC_HOME=$(ssh "$FROM" 'echo $HOME'); SRC="$FROM:"
else
  SRC_HOME=$HOME; SRC=""
fi
on_source() { if [ -n "$FROM" ]; then ssh "$FROM" "$1"; else bash -c "$1"; fi; }
APP_DATA="$TARGET/Onto the TV"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/holiday-pack.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

LIBRARY_ROOT="$SRC_HOME/Movies"
if [ -n "$LIST" ]; then
  # What the list asks for, what is already on the drive at the right size, and what only the cloud holds.
  python3 - "$LIST" "$TARGET/Movies" "$WORK" <<'EOF'
import json, os, sys
trip, dest, work = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
root = trip["library_root"].rstrip("/")
want, cloud, need = [], [], 0
for item in trip["items"]:
    rel = item["rel"]
    if os.path.isabs(rel) or ".." in rel.split("/"):
        sys.exit(f"the list names a path outside the library: {rel}")
    if item.get("cloud"):
        cloud.append(rel)
        continue
    want.append(rel)
    try:
        there = os.stat(os.path.join(dest, rel)).st_size == item["size"]
    except OSError:
        there = False
    if not there:
        need += item["size"]
open(os.path.join(work, "files.txt"), "w").write("".join(rel + "\n" for rel in want))
open(os.path.join(work, "cloud.txt"), "w").write("".join(rel + "\n" for rel in cloud))
open(os.path.join(work, "plan"), "w").write(f"{root}\n{need}\n{len(want)}\n{len(cloud)}\n")
EOF
  LIBRARY_ROOT=$(sed -n 1p "$WORK/plan"); NEED_BYTES=$(sed -n 2p "$WORK/plan")
  COUNT=$(sed -n 3p "$WORK/plan"); CLOUD_COUNT=$(sed -n 4p "$WORK/plan")
elif [ -z "$SETTINGS_ONLY" ]; then
  HUB_LIBRARY=$(on_source "python3 -c 'import json,os;print(json.load(open(os.path.expanduser(\"~/$DATA_NAME/settings.json\"))).get(\"library\",\"\"))'" 2>/dev/null || true)
  case "$HUB_LIBRARY" in
    ""|"$SRC_HOME/Movies"|"$SRC_HOME/Movies/"*) ;;
    *) echo "the library is at $HUB_LIBRARY, not ~/Movies, so there is nothing here to copy whole."
       echo "make a list first:  scripts/trip_list.py ${FROM:+--from $FROM }--gb <size> --out trip.json   then add  --list trip.json"
       exit 1 ;;
  esac
  NEED_BYTES=$(( $(on_source 'du -sk ~/Movies' | awk '{print $1}') * 1024 ))
fi

if [ -z "$SETTINGS_ONLY" ]; then
  # The travel drive stays inside its ceiling: used now, plus what is still to copy, against its size.
  read -r SIZE_KB USED_KB <<<"$(df -k "$TARGET" | awk 'NR==2{print $2, $3}')"
  AFTER_PCT=$(( (USED_KB * 1024 + NEED_BYTES) * 100 / (SIZE_KB * 1024) ))
  echo "to copy: $((NEED_BYTES / 1000000000)) GB; the drive is $((USED_KB * 100 / SIZE_KB))% used now and would be ${AFTER_PCT}% after (ceiling ${CEILING}%)"
  if [ "$AFTER_PCT" -gt "$CEILING" ]; then
    ROOM=$(( (SIZE_KB * 1024 * CEILING / 100 - USED_KB * 1024) / 1000000000 ))
    echo "that would take the drive over ${CEILING}%. It has room for about $(( ROOM > 0 ? ROOM : 0 )) GB: make a smaller list (trip_list.py --gb), or free some space on the drive."
    exit 1
  fi
fi

mkdir -p "$TARGET/Movies" "$APP_DATA/tv-server"
chmod 700 "$APP_DATA" "$APP_DATA/tv-server"
echo "copying settings…"
FILES='settings.json kids-sources.json kids-tiers.json audiences.json taste.json playback-history.json
       tv-server/pairing-token tv-server/taste-storage.json tv-server/playback-history.json'
# One tar stream: files the source lacks are skipped (an rsync of a missing file makes a folder).
PACK="cd \"\$HOME/$DATA_NAME\" && for f in $(echo $FILES); do [ -f \"\$f\" ] && echo \"\$f\"; done | tar cf - -T -"
on_source "$PACK" | (cd "$APP_DATA" && tar xpf -)
[ -s "$APP_DATA/settings.json" ] || { echo "no settings.json came across from $SRC_HOME/$DATA_NAME"; exit 1; }
[ -s "$APP_DATA/tv-server/pairing-token" ] || echo "  warning: no pairing token; the installed TV app will not accept this Mac"

# Point every path at the drive: the library folders, and the settings files themselves. Then make sure every
# root the sources file names exists there, even empty: a root that is missing reads as "drive away" and stops
# the catalogue build, whereas an empty one is just a shelf that did not come on this trip.
python3 - "$APP_DATA" "$SRC_HOME" "$TARGET" "$LIBRARY_ROOT" <<'EOF'
import json, os, sys
app_data, src_home, target, library_root = sys.argv[1:]
swaps = [(f'{src_home}/{"Library/Application Support/Onto the TV"}', app_data),
         (library_root.rstrip('/'), f'{target}/Movies'),
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
made = 0
settings = json.load(open(os.path.join(app_data, 'settings.json')))
roots = [settings.get('library', '')]
sources = settings.get('sourcesPath') or os.path.join(app_data, 'kids-sources.json')
try: roots += [root.get('path', '') for root in json.load(open(sources)).get('roots', [])]
except (OSError, ValueError): pass
for root in roots:
    root = os.path.expanduser(root)
    if root.startswith(f'{target}/Movies') and not os.path.isdir(root):
        os.makedirs(root); made += 1
print(f"settings now point at {target}/Movies" + (f" ({made} shelf folders made ready)" if made else ""))
EOF

if [ -z "$SETTINGS_ONLY" ]; then
  RSYNC=rsync; [ -x /opt/homebrew/bin/rsync ] && RSYNC=/opt/homebrew/bin/rsync
  # The hub's drive is read in its turn: the sending rsync runs under disk-slot when the source Mac has it and
  # the library is on an external drive there.
  REMOTE_RSYNC=""
  case "$LIBRARY_ROOT" in /Volumes/*)
    if on_source 'test -x "$HOME/.local/bin/disk-slot"' 2>/dev/null; then
      SENDER=rsync; on_source 'test -x /opt/homebrew/bin/rsync' 2>/dev/null && SENDER=/opt/homebrew/bin/rsync
      REMOTE_RSYNC="\$HOME/.local/bin/disk-slot --wait 43200 --label holiday-pack '$LIBRARY_ROOT' -- $SENDER"
    fi ;;
  esac
  if [ -n "$LIST" ]; then
    echo "copying $COUNT titles from $LIBRARY_ROOT (only what the drive lacks; the first copy takes a while)…"
    if [ -n "$FROM" ] && [ -n "$REMOTE_RSYNC" ]; then
      "$RSYNC" -a --partial --files-from="$WORK/files.txt" --rsync-path="$REMOTE_RSYNC" "$SRC$LIBRARY_ROOT/" "$TARGET/Movies/"
    elif [ -z "$FROM" ] && [ -n "$REMOTE_RSYNC" ]; then
      "$HOME/.local/bin/disk-slot" --wait 43200 --label holiday-pack "$LIBRARY_ROOT" -- "$RSYNC" -a --partial --files-from="$WORK/files.txt" "$LIBRARY_ROOT/" "$TARGET/Movies/"
    else
      "$RSYNC" -a --partial --files-from="$WORK/files.txt" "$SRC$LIBRARY_ROOT/" "$TARGET/Movies/"
    fi
    # Every listed title is there at the size the list gave.
    python3 - "$LIST" "$TARGET/Movies" <<'EOF'
import json, os, sys
trip, dest = json.load(open(sys.argv[1])), sys.argv[2]
short = [i["rel"] for i in trip["items"] if not i.get("cloud") and not (os.path.isfile(os.path.join(dest, i["rel"])) and os.stat(os.path.join(dest, i["rel"])).st_size == i["size"])]
if short:
    print(f"{len(short)} titles did not arrive whole, for example {short[0]}: run the same command again")
    sys.exit(1)
print(f"checked: every one of the {sum(1 for i in trip['items'] if not i.get('cloud'))} titles is on the drive at its listed size")
EOF
    if [ "$CLOUD_COUNT" -gt 0 ]; then
      echo "$CLOUD_COUNT listed titles are only in the cloud and were NOT packed (fetching from the cloud copy is not built yet). The first of them:"
      head -3 "$WORK/cloud.txt" | sed 's/^/  /'
    fi
  else
    echo "copying the library (the first copy takes a while)…"
    "$RSYNC" -a --partial --exclude .DS_Store "$SRC$SRC_HOME/Movies/" "$TARGET/Movies/"
  fi
fi
echo "done. Next, on the Mac the drive travels with:"
echo "  scripts/install_tv_server.sh --app-data \"$APP_DATA\""
