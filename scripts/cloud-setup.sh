#!/usr/bin/env bash
# Prepares a cloud server (Ubuntu 24.04 or newer) to host Selah for others (6.0.1). Run it from the app folder as the
# user Selah runs as (not root; it uses sudo for the system parts):  bash scripts/cloud-setup.sh
# Safe to run again: each step checks what's already there.
#
# What it does:
#   system   Docker (containers can't talk to each other; logs capped), rsync, sqlite3; port 443 bindable without
#            root; the firewall opened for HTTPS (TCP 443) next to SSH; this user in the docker group; linger, so the
#            admin console and gateway (user services) run from boot without anyone signed in
#   user     Node.js (pinned, checksummed) in ~/.local/node, rclone, and Caddy with the Cloudflare DNS module
#   app      npm ci and the build
# It doesn't harden SSH or turn the firewall on; that's done once by hand when the server is first set up (see the
# maintenance guide, "A cloud server"). Then: npm run admin -- init --tls acme … (printed at the end).
set -euo pipefail
# --dns none: the standard Caddy (certificates per name, any DNS provider; init --tls acme-host). Default: Caddy with
# the Cloudflare DNS module (a wildcard certificate; init --tls acme).
DNS_MODULE=cloudflare
if [[ "${1:-}" == "--dns" ]]; then DNS_MODULE="${2:-cloudflare}"; fi
[[ "$DNS_MODULE" == cloudflare || "$DNS_MODULE" == none ]] || { echo "--dns is cloudflare or none" >&2; exit 1; }
cd "$(dirname "$0")/.."
APP="$(pwd)"
[[ $EUID -ne 0 ]] || { echo "Run this as the user Selah runs as, not root." >&2; exit 1; }
ME="$(id -un)"
step() { printf '\n== %s\n' "$*"; }

NODE_VERSION=24.22.0
declare -A NODE_SHA256=(
  [x64]=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
  [arm64]=fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143
)
case "$(uname -m)" in
  x86_64) NARCH=x64 ;;
  aarch64 | arm64) NARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

step "System packages"
export DEBIAN_FRONTEND=noninteractive
need=()
for p in docker.io rsync sqlite3 openssl curl unzip ca-certificates git; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
if ((${#need[@]})); then
  sudo apt-get -qq update
  sudo -E apt-get -qq install -y --no-install-recommends "${need[@]}" >/dev/null
fi
echo "ok"

step "Docker"
# icc false: containers on the default network can't reach each other (each tenant only talks to the gateway on this
# server). Logs are capped so a noisy tenant can't fill the disk. live-restore keeps tenants running while Docker
# itself is updated.
want='{
  "icc": false,
  "no-new-privileges": true,
  "live-restore": true,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}'
if [[ "$(sudo cat /etc/docker/daemon.json 2>/dev/null)" != "$want" ]]; then
  echo "$want" | sudo tee /etc/docker/daemon.json >/dev/null
  sudo systemctl restart docker
fi
sudo systemctl enable --now docker >/dev/null 2>&1
id -nG "$ME" | grep -qw docker || sudo usermod -aG docker "$ME"
echo "ok (docker $(sudo docker version --format '{{.Server.Version}}'))"

step "Port 443, firewall, linger"
# The gateway runs as this user, so let unprivileged programs bind 443 (and up); 22 and 80 stay privileged.
echo 'net.ipv4.ip_unprivileged_port_start = 443' | sudo tee /etc/sysctl.d/91-selah-gateway.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/91-selah-gateway.conf
if sudo ufw status | grep -q '^Status: active'; then
  sudo ufw status | grep -q '^443/tcp' || sudo ufw allow 443/tcp comment 'Selah (HTTPS)' >/dev/null
else
  echo "  The firewall (ufw) is off; turn it on with SSH and 443/tcp allowed (see the maintenance guide)."
fi
sudo loginctl enable-linger "$ME"
echo "ok"

step "Node.js $NODE_VERSION"
NODE_DIR="$HOME/.local/node/node-v$NODE_VERSION-linux-$NARCH"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  TMP="$(mktemp -d)"
  NAME="node-v$NODE_VERSION-linux-$NARCH.tar.xz"
  curl -fsSL -o "$TMP/$NAME" "https://nodejs.org/dist/v$NODE_VERSION/$NAME"
  echo "${NODE_SHA256[$NARCH]}  $TMP/$NAME" | sha256sum -c --quiet
  mkdir -p "$HOME/.local/node"
  tar -xJf "$TMP/$NAME" -C "$HOME/.local/node"
  rm -rf "$TMP"
fi
ln -sfn "$NODE_DIR" "$HOME/.local/node/current"
if ! grep -q 'selah: node and tools' "$HOME/.profile" 2>/dev/null; then
  printf '\n# selah: node and tools\nexport PATH="$HOME/.local/node/current/bin:$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile"
fi
export PATH="$HOME/.local/node/current/bin:$HOME/.local/bin:$PATH"
echo "ok ($(node -v))"

step "rclone and Caddy"
bash scripts/install-rclone.sh
if [[ "$DNS_MODULE" == cloudflare ]]; then bash scripts/install-caddy.sh --dns cloudflare; else bash scripts/install-caddy.sh; fi

step "App: npm ci and build"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
echo "ok ($(node -p "require('./package.json').version"))"

[[ -n "${SELAH_QUIET_NEXT:-}" ]] && exit 0
cat <<EOF

The server is ready. Next (from $APP):
  npm run admin -- init --domain <domain> --tls acme --runner docker --allow-ip <your home address>
  npm run admin -- dns-token
  npm run admin -- set-password
  npm run admin -- install
Sign out and back in first if this was the first run, so the docker group applies to you.
EOF
