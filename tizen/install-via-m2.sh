#!/bin/zsh
# Build and sign the TV app on the M5 (it holds the Samsung certificate), then install it
# from the M2, which lives next to the TV at a fixed address (Ian, 6 Nov 2026: the laptop's
# address changes with every network, and the TV only accepts installs from one address).
#   tizen/install-via-m2.sh            build + install
#   tizen/install-via-m2.sh --no-build install the last build
set -euo pipefail
HERE=${0:A:h}
TV=${ONTO_TV_HOST:-192.168.20.14}
M2=${ONTO_TV_INSTALLER:-m2}
SDB='~/.local/state/onto-tv-install/sdb'

if [[ ${1:-} != --no-build ]]; then
  export PATH=$HOME/tizen-studio/tools:$HOME/tizen-studio/tools/ide/bin:$PATH
  HEAVY_SLOT_LOCAL=1 UKE_BABEL_BUNDLE=${UKE_BABEL_BUNDLE:-$HOME/.local/state/onto-tv-redesign/babel/bundle.cjs} \
    "$HERE/build.sh" --server-host m2 | tail -1
fi
WGT="$HERE/build/onto.wgt"
[[ -f $WGT ]] || { echo "No build at $WGT" >&2; exit 1; }

# The TV publishes which computer it trusts; compare it with the M2's address on the TV's network.
trusted=$(curl -s --max-time 5 "http://$TV:8001/api/v2/" | python3 -c 'import json,sys; print(json.load(sys.stdin)["device"].get("developerIP",""))') \
  || { echo "The TV at $TV is not answering. Is it on?" >&2; exit 1; }
m2ip=$(ssh "$M2" "route -n get $TV | awk '/interface/{print \$2}' | xargs ipconfig getifaddr")
if [[ $trusted != "$m2ip" ]]; then
  echo "The TV trusts $trusted for installs, but the M2 is $m2ip." >&2
  echo "Fix once: on the TV, Apps, then 1 2 3 4 5, Developer mode On, Host PC IP $m2ip, restart the TV." >&2
  echo "(Reserve $m2ip for the M2 on the router so it never changes.)" >&2
  exit 2
fi

# Stage in the private install folder (user-only), not the shared /tmp.
scp -q "$WGT" "$M2:.local/state/onto-tv-install/onto.wgt"
# Always disconnect: a connection left open makes the TV show an 'RWI mapping info' dialog at launch.
ssh "$M2" "$SDB connect $TV:26101 >/dev/null; $SDB -s $TV:26101 install ~/.local/state/onto-tv-install/onto.wgt 2>&1 | tail -3; rc=\$?; $SDB disconnect $TV:26101 >/dev/null; $SDB kill-server >/dev/null 2>&1; rm -f ~/.local/state/onto-tv-install/onto.wgt; exit \$rc"
