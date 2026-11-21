#!/bin/zsh
# Nightly dual-map video embedding runner for Onto the TV (M2).
# Runs Map A (gemini-embedding-2 Batch API, strictly <= $5/day) + Map B (local MLX
# EmbeddingGemma 2, $0/day, bounded time slice), then aligns (768 -> 3072) and exports
# blended video-space.json for tv-server.js.
#
# zsh, not bash: on M2 only zsh/python3 hold external-drive privacy grants (W17), and
# launchd invokes this via `ssh localhost` so /Volumes/Stash is readable without blocking.
set -u
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

here=${0:A:h}
state="$HOME/.local/state/onto-tv-video-embed"
log="$state/nightly.log"
mkdir -p "$state"

# Reuse M2's Gemini venv (google-genai + numpy); local MLX uses its own venv if present.
gemini_py="${ONTO_VIDEO_GEMINI_PY:-$HOME/.local/state/glancebar-music-embed/venv/bin/python}"
gemma_py="${ONTO_VIDEO_GEMMA_PY:-$state/gemma-venv/bin/python}"
# The music map's EmbeddingGemma venv on the M2 has the same model and a working mlx-vlm; share it.
[ -x "$gemma_py" ] || gemma_py="$HOME/.local/state/music-gemma/venv/bin/python"
keyfile="$HOME/.config/glancebar/gemini.env"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { print -r -- "$(stamp) $*" >> "$log"; }

steps=() failed=()
run_step() {
  local name=$1; shift
  say "$name: start"
  "$@" >> "$log" 2>&1
  local rc=$?
  steps+=("$name:$rc")
  (( rc == 0 )) || failed+=("$name exit $rc")
  say "$name: exit $rc"
}

# Single instance: utc-daily runs this over `ssh localhost`; a cut ssh client orphans the
# remote copy (ppid 1) and the retry starts another, so three copies queued on 21 Nov 2026.
zmodload zsh/system
exec {lockfd}>>"$state/nightly.lock"
if ! zsystem flock -t 0 -f lockfd "$state/nightly.lock"; then
  say "another nightly holds $state/nightly.lock; exiting"
  exit 0
fi

say "nightly start"

# 1. Map A — Gemini Embedding 2 (progressive Tier 1 -> 2 -> 3, <= $5/day)
if [ -e "$HOME/.local/state/METERED_LINK" ]; then
  say "metered link: skipping Gemini Batch API tonight"
elif [ ! -x "$gemini_py" ]; then
  say "FAIL no gemini python venv at $gemini_py"
  failed+=("no gemini venv")
else
  if [ -r "$keyfile" ]; then
    GEMINI_API_KEY=$(sed -n 's/^GEMINI_API_KEY=//p' "$keyfile" | head -1 | tr -d '"'"'"' \r')
    export GEMINI_API_KEY
  fi
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    say "FAIL no GEMINI_API_KEY in $keyfile"
    failed+=("no key")
  else
    max_tier="${ONTO_VIDEO_MAX_TIER:-1}"  # text metadata only (Ian, 21 Nov 2026: "embed non-video metadata and save money"); 2 adds keyframes
    run_step gemini-init "$gemini_py" "$here/video_embed.py" spend --init
    run_step gemini-collect "$gemini_py" "$here/video_embed.py" collect
    if [ -d "/Volumes/Stash" ] && command -v disk-slot >/dev/null 2>&1; then
      run_step gemini-prepare env HEAVY_SLOT_LOCAL=1 heavy-slot -- disk-slot --wait 1800 --label otv-video-embed /Volumes/Stash -- "$gemini_py" "$here/video_embed.py" prepare --max-tier "$max_tier"
    else
      run_step gemini-prepare env HEAVY_SLOT_LOCAL=1 heavy-slot -- "$gemini_py" "$here/video_embed.py" prepare --max-tier "$max_tier"
    fi
    # Spend hold (Ian, 21 Nov 2026): Gemini bills the Google Cloud credit, which must last until next
    # month's AI Pro credit. While ~/.config/fleet/gcp-spend-hold exists, clips are prepared but not sent.
    if [ -f "$HOME/.config/fleet/gcp-spend-hold" ]; then
      say "gemini-submit: skipped, Google Cloud spend hold is on"
    else
      run_step gemini-submit "$gemini_py" "$here/video_embed.py" submit
    fi
    run_step gemini-wait "$gemini_py" "$here/video_embed.py" wait --timeout 3600 --interval 60
  fi
fi

# 2. Map B — Local EmbeddingGemma 2 (768-dim MLX, $0/day, bounded 40-min slice)
if [ -x "$gemma_py" ]; then
  if [ -d "/Volumes/Stash" ] && command -v disk-slot >/dev/null 2>&1; then
    run_step gemma-slice env HEAVY_SLOT_LOCAL=1 heavy-slot -- disk-slot --wait 1800 --label otv-gemma-embed /Volumes/Stash -- "$gemma_py" "$here/gemma_embed.py" --budget-seconds "${ONTO_GEMMA_BUDGET_S:-10800}"
  else
    run_step gemma-slice env HEAVY_SLOT_LOCAL=1 heavy-slot -- "$gemma_py" "$here/gemma_embed.py" --budget-seconds "${ONTO_GEMMA_BUDGET_S:-10800}"
  fi
else
  say "gemma-slice: skipped (venv not yet installed at $gemma_py)"
fi

# 3. Cross-space Ridge alignment (768 -> 3072) + blended video-space.json export
if [ -x "$gemini_py" ]; then
  run_step align "$gemini_py" "$here/video_embed.py" align
  run_step export "$gemini_py" "$here/video_embed.py" export
  run_step status "$gemini_py" "$here/video_embed.py" status
fi

ok_flag=true
(( ${#failed} )) && ok_flag=false
"$gemini_py" - "$state/nightly-status.json" "$ok_flag" "$(stamp)" "${(j:; :)failed:-ok}" "${(j:,:)steps}" <<'EOF'
import json, os, sys
p, ok, at, note, steps = sys.argv[1:6]
doc = {"ok": ok == "true", "at": at, "note": note, "steps": [s for s in steps.split(",") if s]}
tmp = p + ".part"
open(tmp, "w").write(json.dumps(doc, indent=2) + "\n")
os.replace(tmp, p)
EOF
say "nightly end: ok=$ok_flag (${#failed} problems)"
[ "$ok_flag" = "true" ]
