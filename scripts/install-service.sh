#!/usr/bin/env bash
# Installs Note App as a systemd *user* service (no root needed) plus a nightly backup timer.
# To also start at boot without logging in, run once: sudo loginctl enable-linger "$USER"
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
for f in note-app.service note-app-backup.service note-app-backup.timer; do
  sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__NODE__#$NODE#g" "$APP_DIR/deploy/$f" > "$UNIT_DIR/$f"
done
systemctl --user daemon-reload
systemctl --user enable --now note-app.service note-app-backup.timer
systemctl --user --no-pager status note-app.service | head -5
# The `selah` command (start, stop, logs, check, update…), linked so it follows the code.
mkdir -p "$HOME/.local/bin"
ln -sf "$APP_DIR/scripts/selah.sh" "$HOME/.local/bin/selah"
echo "Installed the selah command: run 'selah help'." 
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo
  echo "NOTE: to keep Note App running after you log out and start it at boot, run once:"
  echo "  sudo loginctl enable-linger $USER"
fi
