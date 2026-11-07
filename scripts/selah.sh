#!/usr/bin/env bash
# The `selah` command: look after the Selah server from any folder. Installed as ~/.local/bin/selah by
# scripts/install-service.sh (a link to this file, so it stays current with the code).
#   selah start | stop | restart | status | logs [-f] | check | update | backup | version | help
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
UNIT=note-app.service
PORT="$(systemctl --user show "$UNIT" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^NOTEAPP_PORT=//p')"
PORT="${PORT:-8443}"

version() { node -p "require('$APP_DIR/package.json').version"; }
up() { curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://localhost:$PORT/" 2>/dev/null | grep -q '^200$'; }
# Waits up to 20 seconds for the server to answer.
wait_up() {
  for _ in $(seq 40); do up && return 0; sleep 0.5; done
  return 1
}
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }

case "${1:-help}" in
  start)
    systemctl --user start "$UNIT"
    if wait_up; then echo "Selah $(version) is running on port $PORT."; else echo "Started, but it isn't answering yet: selah logs"; exit 1; fi
    ;;
  stop)
    systemctl --user stop "$UNIT"
    echo "Selah is stopped. It starts again with: selah start (or at the next boot)."
    ;;
  restart)
    systemctl --user restart "$UNIT"
    if wait_up; then echo "Selah $(version) restarted."; else echo "Restarted, but it isn't answering yet: selah logs"; exit 1; fi
    ;;
  status)
    systemctl --user --no-pager status "$UNIT" | head -12
    ;;
  logs)
    shift
    if [[ "${1:-}" == "-f" ]]; then journalctl --user -u "$UNIT" -f -o cat
    else journalctl --user -u "$UNIT" -n "${1:-60}" --no-pager -o cat; fi
    ;;
  check)
    # Everything that has to be right for Selah to run, and to come back by itself after a reboot.
    FAILED=0
    echo "Selah $(version) on $(hostname)"
    if systemctl --user is-active -q "$UNIT"; then ok "service running (since $(systemctl --user show "$UNIT" -p ActiveEnterTimestamp --value))"; else bad "service not running: selah start"; fi
    if up; then ok "answering on https://localhost:$PORT"; else bad "not answering on port $PORT: selah logs"; fi
    if systemctl --user is-enabled -q "$UNIT"; then ok "starts at boot (service enabled)"; else bad "not enabled: systemctl --user enable $UNIT"; fi
    if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == "yes" ]]; then ok "runs without anyone logged in (linger on)"
    else bad "linger off, so it stops when you log out: sudo loginctl enable-linger $USER"; fi
    if [[ -f "$APP_DIR/notes-data/.note-app-storage" ]]; then ok "notes disk mounted ($(df -h --output=avail "$APP_DIR/notes-data" | tail -1 | tr -d ' ') free)"
    else bad "notes disk not mounted at notes-data/ (see DISASTER-RECOVERY.md)"; fi
    if systemctl --user is-active -q note-app-backup.timer; then ok "nightly backup on (next: $(systemctl --user show note-app-backup.timer -p NextElapseUSecRealtime --value))"
    else bad "nightly backup timer off: systemctl --user enable --now note-app-backup.timer"; fi
    last="$(ls -t "$APP_DIR"/data/backups/note-app-*.tar.gz 2>/dev/null | head -1)"
    if [[ -n "$last" ]]; then ok "last backup $(date -r "$last" '+%Y-%m-%d %H:%M') ($(du -h "$last" | cut -f1))"; else bad "no backups in data/backups yet: selah backup"; fi
    boot="$(uptime -s)"
    echo "  · server up since $boot"
    exit "$FAILED"
    ;;
  update)
    # Brings in the latest code from GitHub and restarts. Your notes are not touched.
    cd "$APP_DIR"
    if [[ -n "$(git status --porcelain)" ]]; then echo "There are uncommitted changes in $APP_DIR; not updating."; git status --short; exit 1; fi
    before="$(git rev-parse HEAD)"
    git pull --ff-only
    if [[ "$(git rev-parse HEAD)" == "$before" ]]; then echo "Already up to date (Selah $(version))."; exit 0; fi
    if ! git diff --quiet "$before" HEAD -- package-lock.json; then npm ci; fi
    npm run build
    "$0" restart
    ;;
  backup)
    echo "Backing up the notes and attachments (and the encrypted off-site copy, if it's set up)…"
    if ! systemctl --user start note-app-backup.service; then
      echo "The backup reported a problem:"
      journalctl --user -u note-app-backup.service -n 8 --no-pager -o cat
      exit 1
    fi
    last="$(ls -t "$APP_DIR"/data/backups/note-app-*.tar.gz 2>/dev/null | head -1)"
    echo "Done: $last ($(du -h "$last" | cut -f1)). The off-site result is on the dashboard's Backups widget."
    ;;
  version|-v|--version)
    version
    ;;
  help|-h|--help|*)
    cat <<EOF
selah — look after the Selah server ($APP_DIR)

  selah start      start Selah
  selah stop       stop it (for maintenance); it also starts again at the next boot
  selah restart    restart it (after changing settings or code)
  selah status     is the service running?
  selah logs       the last 60 lines of its log (selah logs 200, or selah logs -f to follow)
  selah check      everything it needs: running, answering, starts at boot, disk, backups
  selah update     pull the latest code from GitHub, build and restart
  selah backup     back up now, locally and off-site (also runs every night)
  selah version    the version installed

The maintenance guide (Settings → About → Maintenance guide) explains each of these.
EOF
    [[ "${1:-help}" =~ ^(help|-h|--help)$ ]] || exit 1
    ;;
esac
