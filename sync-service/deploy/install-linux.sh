#!/bin/sh
# Installs the sync service as a systemd user unit: starts at boot (with
# lingering enabled), restarts on a crash.
set -eu
SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$UNIT_DIR"
sed -e "s|__NODE__|$NODE|g" -e "s|__SERVICE_DIR__|$SERVICE_DIR|g" \
  "$SERVICE_DIR/deploy/catalog-sync.service" > "$UNIT_DIR/catalog-sync.service"
systemctl --user daemon-reload
systemctl --user enable --now catalog-sync.service
# Keep user services running without an open login session (needs sudo once).
loginctl enable-linger "$(id -un)" 2>/dev/null || echo "Run 'sudo loginctl enable-linger $(id -un)' to start at boot without logging in."
echo "Installed. Dashboard: http://localhost:${SYNC_PORT:-4100}"
echo "Logs: journalctl --user -u catalog-sync -f"
