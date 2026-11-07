#!/usr/bin/env bash
# Selah Cloud: install it on your own server in one go (12.0). On a fresh Ubuntu 24.04 (or newer) server, signed in
# over SSH as a user with sudo (not root):
#
#   curl -fsSL https://raw.githubusercontent.com/JDT12/selah/main/scripts/install.sh -o install.sh && bash install.sh
#
# It asks for your domain, how HTTPS should be proven (Let's Encrypt, or a private certificate for a server on your
# own network), an email for Let's Encrypt and where you'll open the admin console from; checks the DNS; then sets the server up the same way the original Selah Cloud server is set up:
#   - Docker for the Selahs (one container each), Node.js, Caddy (the HTTPS gateway), the firewall's port 443
#   - the admin console and gateway as services that start at boot
#   - the first release, built into the image every Selah runs from
# Then it asks for the admin password and, if you like, makes the first Selah and prints its setup link.
# Safe to run again: each step checks what's already there. The docs (docs/cloud-install.md) explain each question.
set -euo pipefail

REPO_URL="${SELAH_REPO:-https://github.com/JDT12/selah.git}"
APP="${SELAH_APP:-$HOME/selah}"
TTY=/dev/tty
say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask() { # ask "Question" default -> REPLY
  local q="$1" d="${2:-}"
  if [[ -n "$d" ]]; then printf '%s [%s]: ' "$q" "$d" >"$TTY"; else printf '%s: ' "$q" >"$TTY"; fi
  IFS= read -r REPLY <"$TTY" || true
  REPLY="${REPLY:-$d}"
}

[[ $EUID -ne 0 ]] || fail "Run this as an ordinary user with sudo, not root (adduser selah && usermod -aG sudo selah)."
[[ "$(uname -s)" == Linux ]] || fail "Selah Cloud installs on Linux (Ubuntu 24.04 or newer)."
. /etc/os-release 2>/dev/null || true
if [[ "${ID:-}" != ubuntu ]]; then say "This was written for Ubuntu ($PRETTY_NAME found); carrying on, but other systems aren't tested."; fi
sudo -v || fail "This user needs sudo."

step "Selah Cloud"
say "Each Selah lives at <name>.<your domain> (e.g. jason.selah.example.org), and the admin console at"
say "admin.<your domain>. Point a wildcard DNS record (*.<domain>, type A) at this server first (on your own"
say "network: see the third certificate choice below)."
ask "Domain" "${SELAH_DOMAIN:-}"; DOMAIN="$(tr 'A-Z' 'a-z' <<<"$REPLY")"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || fail "That isn't a domain name."
say ""
say "HTTPS certificates:"
say "  1  Any DNS provider (recommended): a certificate for each name, checked on port 443. Needs only the"
say "     wildcard record above, and the server reachable from the internet."
say "  2  Cloudflare: one wildcard certificate, checked through Cloudflare's DNS. Needs a Cloudflare API token."
say "  3  Your own network only (a home server or a test VM, no internet access to it): a private certificate"
say "     authority made here, which you trust once on each device. Any domain works, e.g. selah.lan."
ask "Choose 1, 2 or 3" "1"
LAN=0
case "$REPLY" in 1) TLS=acme-host; DNS_MODULE=none ;; 2) TLS=acme; DNS_MODULE=cloudflare ;; 3) TLS=files; DNS_MODULE=none; LAN=1 ;; *) fail "Choose 1, 2 or 3." ;; esac
EMAIL=""
if ((!LAN)); then
  ask "Email for Let's Encrypt (expiry warnings only)" "${SELAH_EMAIL:-}"; EMAIL="$REPLY"
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "That isn't an email address."
fi
MYIP="$(awk '{print $1}' <<<"${SSH_CLIENT:-}")"
say ""
say "The admin console only answers from addresses you list (anyone else gets a refusal page)."
if ((LAN)); then
  ask "Your address to open it from (this SSH session's, or blank for any address on your network)" "$MYIP"; ALLOW="$REPLY"
else
  ask "Your address to open it from (this SSH session's, or blank for an SSH tunnel only)" "$MYIP"; ALLOW="$REPLY"
fi

if ((LAN)); then
  LANIP="$(hostname -I | awk '{print $1}')"
  step "Names on your network"
  say "admin.$DOMAIN and each Selah's name must point at this server ($LANIP) on the devices you use: a wildcard"
  say "record for *.$DOMAIN in your router or Pi-hole, or one line per name in each device's hosts file. The"
  say "installer prints the lines at the end."
else
step "DNS"
PUBLIC="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
check_name() {
  local name="$1" got
  got="$(getent ahostsv4 "$name" | awk '{print $1; exit}')"
  if [[ -z "$got" ]]; then say "  ✗ $name doesn't resolve yet"; return 1; fi
  if [[ -n "$PUBLIC" && "$got" != "$PUBLIC" ]]; then say "  ✗ $name points at $got, but this server is $PUBLIC"; return 1; fi
  say "  ✓ $name → $got"
}
dns_ok=1
check_name "admin.$DOMAIN" || dns_ok=0
check_name "selah-check-$RANDOM.$DOMAIN" || dns_ok=0
if ((!dns_ok)); then
  say "Certificates can't be issued until *.$DOMAIN points at this server${PUBLIC:+ ($PUBLIC)}."
  ask "Carry on anyway? (y/N)" "n"; [[ "$REPLY" =~ ^[Yy] ]] || exit 1
fi
fi

step "Getting Selah"
if [[ ! -d "$APP/.git" ]]; then
  command -v git >/dev/null || { sudo apt-get -qq update && sudo apt-get -qq install -y git >/dev/null; }
  git clone --quiet "$REPO_URL" "$APP"
fi
cd "$APP"
git fetch --quiet --tags
# The newest release (vX.Y.Z, not a beta), unless SELAH_REF says otherwise.
REF="${SELAH_REF:-$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -Ev -- '-' | head -1)}"
[[ -n "$REF" ]] || REF=main
git -c advice.detachedHead=false checkout --quiet "$REF"
say "ok (Selah $(node -p "require('./package.json').version" 2>/dev/null || echo "$REF"))"

step "Server setup (Docker, Node.js, Caddy, firewall): a few minutes"
SELAH_QUIET_NEXT=1 bash scripts/cloud-setup.sh --dns "$DNS_MODULE"
export PATH="$HOME/.local/node/current/bin:$HOME/.local/bin:$PATH"
# The services run under this user's own service manager; restart it so it has the docker group from just now.
sudo systemctl restart "user@$(id -u).service" || true
sleep 2

step "Admin console"
ARGS=(--domain "$DOMAIN" --tls "$TLS" --runner docker)
[[ -n "$EMAIL" ]] && ARGS+=(--email "$EMAIL")
if ((LAN)); then
  # The private certificate authority (made once, in data/certs; kept on later runs) signs a wildcard certificate for
  # *.<domain>, so every Selah's name is covered from the start. Port 443 like the other choices.
  CERT_HOSTS="admin.$DOMAIN $LANIP" bash scripts/gen-certs.sh >/dev/null
  ARGS+=(--port 443 --new-cert)
fi
[[ -n "$ALLOW" ]] && ARGS+=(--allow-ip "$ALLOW")
[[ -n "${SELAH_ACME_STAGING:-}" ]] && ARGS+=(--acme-staging)
npm run --silent admin -- init "${ARGS[@]}"
if [[ "$TLS" == acme ]]; then
  say "A Cloudflare API token with Zone → DNS → Edit for $DOMAIN's zone (dash.cloudflare.com → My Profile → API Tokens)."
  npm run --silent admin -- dns-token <"$TTY"
fi
if ! npm run --silent admin -- status 2>/dev/null | grep -q '✓ admin password'; then
  say "Choose the admin console's password (12 characters or more)."
  npm run --silent admin -- set-password <"$TTY"
fi
npm run --silent admin -- install

step "First release (builds the image every Selah runs from: a few minutes)"
# sg: the docker group may not be in this login session yet.
sg docker -c "npm run --silent admin -- prepare-release --main"

step "Done"
ADMIN_URL="https://admin.$DOMAIN"
if ((LAN)); then
  say "On each device you'll use, once:"
  say "  1. Trust the certificate authority: copy $APP/data/certs/ca.crt over (e.g. scp) and install it as a trusted"
  say "     root (Windows: double-click → Install Certificate → Local Machine → Trusted Root Certification"
  say "     Authorities; Mac: Keychain Access → System, set to Always Trust; phones: Settings → certificate install)."
  say "  2. Unless your router or Pi-hole has *.$DOMAIN → $LANIP, add to the hosts file (Windows:"
  say "     C:\Windows\System32\drivers\etc\hosts, Mac/Linux: /etc/hosts), and a line like it for each new Selah:"
  say "       $LANIP  admin.$DOMAIN"
fi
say "Admin console: $ADMIN_URL${ALLOW:+ (from $ALLOW)}"
if [[ -z "$ALLOW" ]]; then
  if ((LAN)); then say "  (from any address on your network)"
  else say "  Open it through an SSH tunnel, or add your address: npm run admin -- allow-ip add <ip>"; fi
fi
say "  Sign in with the password you chose, then turn on two-step sign-in (it's required)."
ask "Make the first Selah now? Its name (e.g. jason), or blank to do it later in the console" ""
if [[ -n "$REPLY" ]]; then
  sg docker -c "npm run --silent admin -- create $(printf '%q' "$REPLY")"
  if ((LAN)); then say "Open the setup link to choose that Selah's password (hosts file: $LANIP  $REPLY.$DOMAIN)."
  else say "Open the setup link to choose that Selah's password. Certificates for a new name take a minute."; fi
fi
say ""
say "Updates: bash $APP/scripts/update.sh (or Updates in the console). Docs: $APP/docs/"
