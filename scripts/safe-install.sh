#!/usr/bin/env bash
# Installs packages without ever leaving the app with a broken node_modules (13.0):
#   bash scripts/safe-install.sh [app dir]
# npm ci empties node_modules before it downloads, so one GitHub 504 on ffmpeg-static's binary used to leave the server
# with nothing. This installs into a separate folder, retries, checks the result, and swaps it in only once it's good.
# If the lockfile and Node version haven't changed and the packages are whole, it downloads nothing at all.
# SELAH_INSTALL_ATTEMPTS (default 5) and SELAH_INSTALL_WAIT (seconds before the first retry, default 20, then doubling).
set -euo pipefail
APP="$(cd "${1:-.}" && pwd)"
ATTEMPTS="${SELAH_INSTALL_ATTEMPTS:-5}"
WAIT="${SELAH_INSTALL_WAIT:-20}"
# Beside the app, not in it: same disk so the swap is a rename, and cloud-push's cleanup doesn't touch it.
WORK="$(dirname "$APP")/.selah-install-$(basename "$APP")"
STAMP_FILE=.selah-install-stamp
cd "$APP"

STAMP="$(sha256sum package-lock.json | cut -d' ' -f1) $(node -v) $(uname -m)"

# Every direct dependency is present, and ffmpeg-static really has its downloaded binary.
whole() {
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = path.resolve(process.argv[1]), deps = Object.keys(require(path.resolve("package.json")).dependencies || {});
    const missing = deps.filter((d) => !fs.existsSync(path.join(dir, d, "package.json")));
    if (deps.includes("ffmpeg-static") && !["ffmpeg", "ffmpeg.exe"].some((f) => fs.existsSync(path.join(dir, "ffmpeg-static", f)))) missing.push("ffmpeg-static binary");
    if (missing.length) { console.error("  Missing: " + missing.slice(0, 8).join(", ")); process.exit(1); }
  ' "$1"
}

if [[ -f "node_modules/$STAMP_FILE" && "$(cat "node_modules/$STAMP_FILE")" == "$STAMP" ]] && whole node_modules 2>/dev/null; then
  echo "Packages are up to date"
  exit 0
fi

rm -rf "$WORK"
mkdir -p "$WORK/new"
cp package.json package-lock.json "$WORK/new/"
if [[ -f .npmrc ]]; then cp .npmrc "$WORK/new/"; fi

attempt=1
while :; do
  echo "Installing packages (attempt $attempt of $ATTEMPTS)"
  rm -rf "$WORK/new/node_modules"
  if (cd "$WORK/new" && npm ci --no-audit --no-fund --loglevel=error) && whole "$WORK/new/node_modules"; then
    break
  fi
  if (( attempt >= ATTEMPTS )); then
    rm -rf "$WORK"
    echo "Package install failed after $ATTEMPTS attempts. The existing node_modules was left as it was." >&2
    exit 1
  fi
  echo "  Install failed; trying again in ${WAIT}s"
  sleep "$WAIT"
  WAIT=$(( WAIT * 2 ))
  attempt=$(( attempt + 1 ))
done

echo "$STAMP" > "$WORK/new/node_modules/$STAMP_FILE"
if [[ -e node_modules ]]; then mv node_modules "$WORK/old"; fi
if ! mv "$WORK/new/node_modules" node_modules; then
  if [[ -e "$WORK/old" ]]; then mv "$WORK/old" node_modules; fi
  echo "Couldn't move the new packages into place. The existing node_modules was put back." >&2
  exit 1
fi
rm -rf "$WORK"
echo "Packages installed"
