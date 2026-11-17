#!/usr/bin/env bash
# Selah Ministry: update a self-hosted server to the newest release (12.0). From the app folder, as the user Selah runs as:
#
#   bash scripts/update.sh            the newest release (vX.Y.Z)
#   bash scripts/update.sh v12.1.0    a given one
#   bash scripts/update.sh --beta     the newest beta too (vX.Y.Z-beta.N)
#
# What it does: fetches the release, builds the console, restarts the admin console on it, gets the release's
# published image (14.1; built here only if it isn't published) and moves every Selah to it, one at a time, checking
# each comes back. A Selah that doesn't is put back on the release it was on. To move one back by hand later:
#   npm run admin -- rollback <name>.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/current/bin:$HOME/.local/bin:$PATH"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

PATTERN='-'
REF=""
for a in "$@"; do
  case "$a" in
    --beta) PATTERN='^$' ;;
    v*) REF="$a" ;;
    *) echo "Usage: bash scripts/update.sh [--beta | vX.Y.Z]" >&2; exit 1 ;;
  esac
done
git fetch --quiet --tags
if [[ -z "$REF" ]]; then
  if [[ "$PATTERN" == '-' ]]; then REF="$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -Ev -- '-' | head -1)"
  else REF="$(git tag --list 'v[0-9]*' --sort=-v:refname | head -1)"; fi
fi
[[ -n "$REF" ]] || { echo "No release tags found." >&2; exit 1; }
NOW="$(node -p "require('./package.json').version")"
if [[ "v$NOW" == "$REF" ]] && [[ -z "${SELAH_FORCE:-}" ]]; then echo "Already on $REF."; exit 0; fi

step "Selah $NOW → $REF"
git -c advice.detachedHead=false checkout --quiet "$REF"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent

step "Admin console"
systemctl --user restart selah-admin.service
sleep 3
systemctl --user is-active --quiet selah-admin.service && echo "ok" || { echo "The admin console didn't start: journalctl --user -u selah-admin" >&2; exit 1; }

step "Release"
# 14.1: the published image of this version (ghcr.io/jdt12/selah); built here only if it isn't published.
CH=--main; [[ "$REF" == *-* ]] && CH="--beta"
if ! sg docker -c "npm run --silent admin -- prepare-release --pull ${REF#v} $CH"; then
  echo "Selah ${REF#v} isn't published as an image; building it here instead."
  [[ "$CH" == --beta ]] && CH=""
  sg docker -c "npm run --silent admin -- prepare-release $CH"
fi
[[ "$CH" == --beta ]] && CH=""

step "Updating every Selah"
if [[ -n "$CH" ]]; then sg docker -c "npm run --silent admin -- update" || echo "(Nothing to update, or see the message above.)"
else echo "A beta: move the Selahs you want to try it with: npm run admin -- update <name> --beta"; fi
