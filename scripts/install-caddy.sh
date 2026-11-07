#!/usr/bin/env bash
# Installs Caddy (the gateway in front of the admin console and tenants, 6.0) into ~/.local/bin. No root needed.
#
#   npm run install-caddy                      the standard Caddy (home server: certificate from the private CA)
#   npm run install-caddy -- --dns cloudflare  Caddy with the Cloudflare DNS module (cloud server: a Let's Encrypt
#                                              wildcard certificate, checked through DNS), built from source
#
# The standard build's version and checksums are pinned (SHA-256 of the release tarballs, matching the SHA-512s in the
# release's caddy_X.Y.Z_checksums.txt); to upgrade, download the new tarballs, check them against that file and update
# both. The Cloudflare build uses a pinned Go (checksummed from go.dev/dl) and pinned xcaddy, Caddy and module versions;
# Go checks every module it downloads against the public checksum database (sum.golang.org).
set -euo pipefail
VERSION=2.11.7
declare -A SHA256=(
  [amd64]=727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b
  [arm64]=d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42
)
GO_VERSION=1.27.3
declare -A GO_SHA256=(
  [amd64]=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
  [arm64]=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
)
XCADDY_VERSION=v0.4.7
CLOUDFLARE_VERSION=v0.2.4

DNS=""
if [[ "${1:-}" == "--dns" ]]; then DNS="${2:-}"; fi
if [[ -n "$DNS" && "$DNS" != "cloudflare" ]]; then echo "Only --dns cloudflare is supported." >&2; exit 1; fi

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
DEST="$HOME/.local/bin"
have_version() { [[ -x "$DEST/caddy" ]] && "$DEST/caddy" version 2>/dev/null | grep -q "^v$VERSION "; }
have_cloudflare() { "$DEST/caddy" list-modules 2>/dev/null | grep -qx 'dns.providers.cloudflare'; }

if have_version && { [[ -z "$DNS" ]] || have_cloudflare; }; then
  echo "Caddy v$VERSION${DNS:+ with the $DNS DNS module} is already installed in $DEST"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT
mkdir -p "$DEST"

if [[ -z "$DNS" ]]; then
  NAME="caddy_${VERSION}_linux_$ARCH.tar.gz"
  curl -fsSL -o "$TMP/$NAME" "https://github.com/caddyserver/caddy/releases/download/v$VERSION/$NAME"
  echo "${SHA256[$ARCH]}  $TMP/$NAME" | sha256sum -c --quiet
  tar -xzf "$TMP/$NAME" -C "$TMP" caddy
  install -m 755 "$TMP/caddy" "$DEST/caddy"
else
  GO_TAR="go$GO_VERSION.linux-$ARCH.tar.gz"
  echo "Downloading Go $GO_VERSION to build Caddy (a few minutes)…"
  curl -fsSL -o "$TMP/$GO_TAR" "https://go.dev/dl/$GO_TAR"
  echo "${GO_SHA256[$ARCH]}  $TMP/$GO_TAR" | sha256sum -c --quiet
  tar -xzf "$TMP/$GO_TAR" -C "$TMP"
  export PATH="$TMP/go/bin:$PATH" GOPATH="$TMP/gopath" GOCACHE="$TMP/gocache" GOTOOLCHAIN=local CGO_ENABLED=0
  (cd "$TMP" && go run "github.com/caddyserver/xcaddy/cmd/xcaddy@$XCADDY_VERSION" build "v$VERSION" \
    --with "github.com/caddy-dns/cloudflare@$CLOUDFLARE_VERSION" --output "$TMP/caddy")
  install -m 755 "$TMP/caddy" "$DEST/caddy"
  have_cloudflare || { echo "The build doesn't include the Cloudflare module." >&2; exit 1; }
fi
"$DEST/caddy" version
echo "Installed to $DEST/caddy"
