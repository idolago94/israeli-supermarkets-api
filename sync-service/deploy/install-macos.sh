#!/bin/sh
# Installs the sync service as a launchd agent: starts at login, restarts on a
# crash. Re-run after moving the repo or changing Node versions.
set -eu
SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.catalog.sync-service.plist"

mkdir -p "$SERVICE_DIR/data" "$HOME/Library/LaunchAgents"
sed -e "s|__NODE__|$NODE|g" -e "s|__SERVICE_DIR__|$SERVICE_DIR|g" -e "s|__PATH__|$PATH|g" \
  "$SERVICE_DIR/deploy/com.catalog.sync-service.plist" > "$PLIST"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Dashboard: http://localhost:${SYNC_PORT:-4100}"
echo "Logs: $SERVICE_DIR/data/service.log"
echo "Stop:  launchctl bootout gui/$(id -u) $PLIST"
