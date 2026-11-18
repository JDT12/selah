#!/usr/bin/env bash
# Selah Cloud (14.1): one Selah on your own server, for one person or a family. scripts/install.sh runs this when you
# choose Selah Cloud; it can also run by itself on a fresh Ubuntu 24.04 (or newer) server, as a user with sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/JDT12/selah/main/scripts/install-cloud.sh -o install-cloud.sh && bash install-cloud.sh
#
# It asks for the address (one name, e.g. selah.example.org, pointed at this server) and how HTTPS is proven, checks
# the DNS, installs Docker, then starts Selah from its published image with Caddy for HTTPS and the updater
# (docker/cloud/: compose.yaml, Caddyfile, updater.sh, the selah command), all in ~/selah-cloud. Nothing is built
# here. Last, it prints the setup link where you choose your username and password.
# Safe to run again: it keeps an existing ~/selah-cloud (its .env and data) and only starts what isn't running.
set -euo pipefail

DIR="${SELAH_CLOUD_DIR:-$HOME/selah-cloud}"
IMAGE="${SELAH_IMAGE:-ghcr.io/jdt12/selah}"
TTY=/dev/tty
say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask() {
  local q="$1" d="${2:-}"
  if [[ -n "$d" ]]; then printf '%s [%s]: ' "$q" "$d" >"$TTY"; else printf '%s: ' "$q" >"$TTY"; fi
  IFS= read -r REPLY <"$TTY" || true
  REPLY="${REPLY:-$d}"
}
envval() { sed -n "s/^$1=//p" "$DIR/.env" 2>/dev/null | tail -1; }

[[ $EUID -ne 0 ]] || fail "Run this as an ordinary user with sudo, not root (adduser selah && usermod -aG sudo selah)."
[[ "$(uname -s)" == Linux ]] || fail "Selah Cloud installs on Linux (Ubuntu 24.04 or newer)."
. /etc/os-release 2>/dev/null || true
[[ "${ID:-}" == ubuntu ]] || say "This was written for Ubuntu (${PRETTY_NAME:-unknown} found); carrying on, but other systems aren't tested."
sudo -n true 2>/dev/null || sudo -v || fail "This user needs sudo."

step "Selah Cloud"
if [[ -f "$DIR/.env" ]]; then
  DOMAIN="$(envval SELAH_DOMAIN)"; TLS="$(envval SELAH_TLS)"; TZ_="$(envval SELAH_TZ)"
  say "Using the settings already in $DIR/.env (https://$DOMAIN)."
else
  say "Selah will live at one address, e.g. selah.example.org. Point that name (a DNS record of type A) at this"
  say "server first; on your own network, a name your router or Pi-hole knows works too."
  ask "Address" "${SELAH_DOMAIN:-}"; DOMAIN="$(tr 'A-Z' 'a-z' <<<"$REPLY")"
  [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || fail "That isn't a domain name."
  say ""
  say "HTTPS certificate:"
  say "  1  Let's Encrypt (recommended): free and trusted everywhere. Needs the server reachable from the internet"
  say "     on ports 80 and 443."
  say "  2  Your own network only (a home server, no internet access to it): a private certificate, which you trust"
  say "     once on each device."
  ask "Choose 1 or 2" "${SELAH_TLS_CHOICE:-1}"
  case "$REPLY" in
    1) ask "Email for Let's Encrypt (expiry warnings only)" "${SELAH_EMAIL:-}"; TLS="$REPLY"
       [[ "$TLS" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "That isn't an email address." ;;
    2) TLS=internal ;;
    *) fail "Choose 1 or 2." ;;
  esac
  TZ_="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  ask "Time zone for your calendar and reminders" "${TZ_:-America/Chicago}"; TZ_="$REPLY"
fi

if [[ "$TLS" != internal ]]; then
  step "DNS"
  PUBLIC="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
  got="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')"
  if [[ -z "$got" ]]; then say "  ✗ $DOMAIN doesn't resolve yet"; dns_ok=0
  elif [[ -n "$PUBLIC" && "$got" != "$PUBLIC" ]]; then say "  ✗ $DOMAIN points at $got, but this server is $PUBLIC"; dns_ok=0
  else say "  ✓ $DOMAIN → $got"; dns_ok=1; fi
  if ((!dns_ok)); then
    say "Let's Encrypt can't issue the certificate until $DOMAIN points at this server${PUBLIC:+ ($PUBLIC)}."
    ask "Carry on anyway? (y/N)" "n"; [[ "$REPLY" =~ ^[Yy] ]] || exit 1
  fi
fi

step "Docker"
need=()
for p in docker.io docker-compose-v2 curl ca-certificates; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if ((${#need[@]})); then
  sudo apt-get -qq update
  sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y "${need[@]}" >/dev/null
fi
sudo systemctl enable --now docker >/dev/null 2>&1
id -nG "$USER" | grep -qw docker || sudo usermod -aG docker "$USER"
D() { sudo docker "$@"; }
say "ok (docker $(D version --format '{{.Server.Version}}'), $(D compose version --short 2>/dev/null | sed 's/^/compose /'))"

if sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
  sudo ufw status | grep -q '^80/tcp' || sudo ufw allow 80/tcp comment 'Selah (HTTPS certificates)' >/dev/null
  sudo ufw status | grep -q '^443/tcp' || sudo ufw allow 443/tcp comment 'Selah (HTTPS)' >/dev/null
  sudo ufw status | grep -q '^443/udp' || sudo ufw allow 443/udp comment 'Selah (HTTP/3)' >/dev/null
  say "Firewall: ports 80 and 443 open."
fi

step "Getting Selah"
VERSION="${SELAH_VERSION:-$(envval SELAH_VERSION)}"
if [[ -z "$VERSION" ]]; then
  D pull -q "$IMAGE:latest" >/dev/null || fail "Couldn't download $IMAGE:latest. Check the server can reach ghcr.io."
  VERSION="$(D run --rm --entrypoint node "$IMAGE:latest" -p "require('./package.json').version")"
fi
D image inspect "$IMAGE:$VERSION" >/dev/null 2>&1 || D pull -q "$IMAGE:$VERSION" >/dev/null || fail "Couldn't download $IMAGE:$VERSION."
say "ok (Selah $VERSION)"

# The compose file, Caddyfile, updater and selah command come out of the image, so they always match its version.
mkdir -p "$DIR"
box="selah-files-$$"
D create --name "$box" "$IMAGE:$VERSION" >/dev/null
trap 'sudo docker rm -f "$box" >/dev/null 2>&1 || true' EXIT
for f in compose.yaml Caddyfile updater.sh selah; do D cp -q "$box:/app/docker/cloud/$f" "$DIR/$f.new"; done
D rm -f "$box" >/dev/null
for f in compose.yaml Caddyfile updater.sh selah; do sudo chown "$USER:" "$DIR/$f.new"; mv "$DIR/$f.new" "$DIR/$f"; done
chmod +x "$DIR/selah" "$DIR/updater.sh"

if [[ ! -f "$DIR/.env" ]]; then
  cat > "$DIR/.env" <<EOF
# Selah Cloud's settings (14.1). Change SELAH_DOMAIN or SELAH_TLS, then: selah start
SELAH_DOMAIN=$DOMAIN
SELAH_TLS=$TLS
SELAH_TZ=$TZ_
SELAH_VERSION=$VERSION
SELAH_DIR=$DIR
SELAH_IMAGE=$IMAGE
EOF
fi
mkdir -p "$DIR/data" "$DIR/updates" "$DIR/caddy/data" "$DIR/caddy/config" "$DIR/backups"
# Selah runs as the image's node user (uid 1000); its library and the updates folder must be its own.
sudo chown -R 1000:1000 "$DIR/data" "$DIR/updates"
sudo ln -sf "$DIR/selah" /usr/local/bin/selah

step "Starting Selah"
cd "$DIR"
D compose up -d --remove-orphans >/dev/null
for _ in $(seq 1 60); do
  [[ "$(D inspect -f '{{.State.Health.Status}}' "$(D compose ps -q selah)" 2>/dev/null)" == healthy ]] && break
  sleep 3
done
[[ "$(D inspect -f '{{.State.Health.Status}}' "$(D compose ps -q selah)" 2>/dev/null)" == healthy ]] \
  || fail "Selah didn't start. Its log: sudo docker compose -f $DIR/compose.yaml logs selah"
say "ok"

step "Done"
if D compose exec -T selah node -e "import('./server/auth.js').then((a) => process.exit(a.passwordIsSet() ? 0 : 1))" </dev/null 2>/dev/null; then
  say "Selah is at https://$DOMAIN (already set up)."
else
  say "Open this link to choose your username and password. It works once:"
  D compose exec -T selah node scripts/setup-link.mjs </dev/null | sed -n '2p'
fi
if [[ "$TLS" == internal ]]; then
  say ""
  say "On each device you'll use, once: trust this server's certificate authority. Copy it from"
  say "  $DIR/caddy/data/caddy/pki/authorities/local/root.crt"
  say "and install it as a trusted root (Windows: Local Machine → Trusted Root Certification Authorities; Mac:"
  say "Keychain Access → System → Always Trust; phones: Settings → install certificate). Your router or Pi-hole (or"
  say "each device's hosts file) must point $DOMAIN at $(hostname -I | awk '{print $1}')."
fi
say ""
say "Looking after it: selah status · selah update · selah backup · selah setup-link (a lost password) · selah logs"
say "Updates also come from Settings → About → Updates. Your library is in $DIR/data."
