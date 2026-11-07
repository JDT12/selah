#!/usr/bin/env bash
# Installs rclone (used for the encrypted OneDrive backup) into ~/.local/bin. No root needed.
# The version and checksums are pinned; to upgrade, change them from the release's SHA256SUMS
# (https://downloads.rclone.org/vX.Y.Z/SHA256SUMS).
set -euo pipefail
VERSION=1.75.1
declare -A SHA256=(
  [amd64]=982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab
  [arm64]=03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9
)
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
DEST="$HOME/.local/bin"
if [[ -x "$DEST/rclone" ]] && "$DEST/rclone" version 2>/dev/null | head -1 | grep -q "v$VERSION\$"; then
  echo "rclone v$VERSION is already installed in $DEST"
  exit 0
fi

NAME="rclone-v$VERSION-linux-$ARCH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$NAME.zip" "https://downloads.rclone.org/v$VERSION/$NAME.zip"
echo "${SHA256[$ARCH]}  $TMP/$NAME.zip" | sha256sum -c --quiet
if command -v unzip >/dev/null; then
  unzip -q "$TMP/$NAME.zip" -d "$TMP"
else
  python3 -m zipfile -e "$TMP/$NAME.zip" "$TMP"
fi
mkdir -p "$DEST"
install -m 755 "$TMP/$NAME/rclone" "$DEST/rclone"
"$DEST/rclone" version | head -1
echo "Installed to $DEST/rclone"
