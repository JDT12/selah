#!/bin/sh
# Selah Cloud's updater (14.1), the third container in compose.yaml. Selah (Settings → Updates) asks for a version by
# writing updates/request (one line: the version, e.g. 14.1.0); `selah update` on the server does the same. This
# moves the selah service to that version and waits for it to be healthy. If it doesn't come up within five minutes,
# it goes back to the version it was on. Selah saves a restore point of the library before it asks.
# It writes what happened to updates/status (JSON), which Settings shows. Nothing else reaches it: it has no port.
set -u
cd "${SELAH_DIR:-}" 2>/dev/null || cd "$(dirname "$0")"
DIR="$(pwd)"
REQ="$DIR/updates/request"
STATUS="$DIR/updates/status"
mkdir -p "$DIR/updates"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
status() { # state version from [error]
  printf '{"state":"%s","version":"%s","from":"%s","at":"%s","error":"%s"}\n' "$1" "$2" "$3" "$(now)" "$(printf '%s' "${4:-}" | tr '"\n' "' " | cut -c1-300)" > "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
  # Selah reads it as the node user (uid 1000).
  chmod 644 "$STATUS" 2>/dev/null || true
}
current() { sed -n 's/^SELAH_VERSION=//p' "$DIR/.env" | tail -1; }
set_version() { # writes SELAH_VERSION=<v> into .env, keeping everything else
  if grep -q '^SELAH_VERSION=' "$DIR/.env"; then
    sed "s/^SELAH_VERSION=.*/SELAH_VERSION=$1/" "$DIR/.env" > "$DIR/.env.tmp" && cat "$DIR/.env.tmp" > "$DIR/.env" && rm -f "$DIR/.env.tmp"
  else
    printf 'SELAH_VERSION=%s\n' "$1" >> "$DIR/.env"
  fi
}
healthy() { # waits up to 5 minutes for selah to be healthy
  i=0
  while [ $i -lt 60 ]; do
    id="$(docker compose ps -q selah 2>/dev/null)"
    h="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)"
    [ "$h" = healthy ] && return 0
    # Crashing as it starts (restarted three times already): no use waiting out the five minutes.
    [ "$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)" -ge 3 ] && return 1
    sleep 5; i=$((i + 1))
  done
  return 1
}

move() { # move <version>
  to="$1"; from="$(current)"
  case "$to" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) status failed "$to" "$from" "That isn't a version."; return ;;
  esac
  status pulling "$to" "$from"
  img="$(sed -n 's/^SELAH_IMAGE=//p' "$DIR/.env" | tail -1)"; img="${img:-ghcr.io/jdt12/selah}"
  # An image already on the server (loaded by hand, or a test) is used if the registry can't be reached.
  if ! out="$(docker pull "$img:$to" 2>&1)" && ! docker image inspect "$img:$to" >/dev/null 2>&1; then
    status failed "$to" "$from" "Couldn't download $img:$to: $(printf '%s' "$out" | tail -1)"; return
  fi
  status starting "$to" "$from"
  set_version "$to"
  if docker compose up -d selah >/dev/null 2>&1 && healthy; then
    status done "$to" "$from"
    docker image prune -f >/dev/null 2>&1 || true
    return
  fi
  # It didn't come up: back to where it was, with the database as Selah saved it just before asking (pre-update.db).
  set_version "$from"
  docker compose stop selah >/dev/null 2>&1
  lib="$DIR/data/library"
  if [ -s "$lib/pre-update.db" ]; then
    rm -f "$lib/notes.db-wal" "$lib/notes.db-shm"
    cp -p "$lib/pre-update.db" "$lib/notes.db"
  fi
  docker compose up -d selah >/dev/null 2>&1
  if healthy; then status rolled-back "$to" "$from" "Selah $to didn't start, so it's back on $from."
  else status failed "$to" "$from" "Selah $to didn't start, and $from isn't up again either. On the server: selah status"; fi
}

[ -f "$STATUS" ] || status idle "$(current)" ""
while :; do
  if [ -s "$REQ" ]; then
    v="$(head -1 "$REQ" | tr -d ' \r\n')"
    rm -f "$REQ"
    move "$v"
  fi
  sleep 5
done
