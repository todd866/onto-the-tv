#!/bin/bash
# Publish a sanitized snapshot of this repo to the public GitHub repo.
#
# The working repo (origin, private) keeps full history. The public repo never
# receives that history: each publish is one new commit whose tree is a filtered
# export of REF, stacked on the previous public commit. No force push, ever.
#
#   scripts/publish-public.sh            # dry run: build, gate, show the diff
#   scripts/publish-public.sh --push     # also commit and push to the public repo
#
# Gates (any failure stops the publish):
#   1. Paths listed in .public-exclude are dropped from the export.
#   2. No text file may match the private term list ($DENYLIST, outside the repo).
#   3. Every image must have its sha256 in $IMAGES_OK (reviewed by eye first).
#   4. The commit author/committer are the noreply identity, never a real email.
set -euo pipefail

REF=${REF:-main}
PUBLIC_URL=${PUBLIC_URL:-https://github.com/todd866/onto-the-tv.git}
CONF=${ONTO_CONFIG_DIR:-$HOME/.config/onto-the-tv}
DENYLIST=$CONF/public-denylist.txt
IMAGES_OK=$CONF/public-images-approved.txt
WORK=${ONTO_PUBLIC_WORK:-$HOME/.local/state/onto-the-tv-public}
IDENT_NAME="todd866"
IDENT_EMAIL="todd866@users.noreply.github.com"
PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
[ -f "$DENYLIST" ] || { echo "missing $DENYLIST" >&2; exit 2; }
[ -f "$IMAGES_OK" ] || touch "$IMAGES_OK"

EXPORT=$(mktemp -d "${TMPDIR:-/tmp}/onto-public.XXXXXX")
trap 'rm -rf "$EXPORT"' EXIT
git archive "$REF" | tar -x -C "$EXPORT"

# 1. Exclusions (one path or glob per line, relative to the repo root).
if [ -f "$EXPORT/.public-exclude" ]; then
  while IFS= read -r pat; do
    case "$pat" in ''|\#*) continue ;; esac
    (cd "$EXPORT" && for p in $pat; do [ -e "$p" ] && rm -rf "$p"; done) || true
    # Fail closed: nothing a listed pattern names may survive the removal.
    if (cd "$EXPORT" && for p in $pat; do [ -e "$p" ] && exit 0; done; exit 1); then
      echo "BLOCKED: excluded path still present: $pat" >&2; exit 1
    fi
  done < "$EXPORT/.public-exclude"
fi

fail=0
# 2. Term gate over every text file (ripgrep skips binaries).
if hits=$(cd "$EXPORT" && rg -P -i -l --hidden -f <(grep -v '^#' "$DENYLIST" | grep -v '^$') . 2>/dev/null); then
  echo "BLOCKED: private terms in:" >&2
  echo "$hits" | sed 's/^/  /' >&2
  fail=1
fi

# 3. Image gate: every image must be approved by hash.
while IFS= read -r -d '' img; do
  sum=$(shasum -a 256 "$img" | cut -d' ' -f1)
  if ! grep -q "^$sum" "$IMAGES_OK"; then
    echo "BLOCKED: unreviewed image ${img#$EXPORT/} ($sum)" >&2
    fail=1
  fi
done < <(find "$EXPORT" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.webp' -o -iname '*.icns' -o -iname '*.svg' \) -print0)

[ $fail -eq 0 ] || { echo "Nothing published." >&2; exit 1; }
echo "Gates passed: $(cd "$EXPORT" && find . -type f | wc -l | tr -d ' ') files from $REF ($(git rev-parse --short "$REF"))."

# 4. Stage into the public clone and commit on top of its history.
mkdir -p "$WORK"
if [ ! -d "$WORK/.git" ]; then
  git -C "$WORK" init -q -b main
  git -C "$WORK" remote add origin "$PUBLIC_URL"
fi
if git -C "$WORK" ls-remote --exit-code origin main >/dev/null 2>&1; then
  git -C "$WORK" fetch -q origin main
  git -C "$WORK" reset -q --hard origin/main
fi
rsync -a --delete --exclude .git "$EXPORT"/ "$WORK"/
git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then
  echo "Public repo already matches $REF."; exit 0
fi
git -C "$WORK" diff --cached --stat | tail -1
if [ $PUSH -eq 0 ]; then
  echo "Dry run. Re-run with --push to publish."; git -C "$WORK" reset -q; exit 0
fi
GIT_AUTHOR_NAME=$IDENT_NAME GIT_AUTHOR_EMAIL=$IDENT_EMAIL \
GIT_COMMITTER_NAME=$IDENT_NAME GIT_COMMITTER_EMAIL=$IDENT_EMAIL \
  git -C "$WORK" -c commit.gpgsign=false commit -q -m "Snapshot of $(git rev-parse --short "$REF") ($(date -u +%Y-%m-%d))"
git -C "$WORK" log -1 --format='%an <%ae> / %cn <%ce>' | grep -qv gmail
git -C "$WORK" push origin main
