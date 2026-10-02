#!/usr/bin/env bash
# Pull the latest code from GitHub and restart the app. Data and .env are untouched.
#   sudo bash /opt/monal-maintenance/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/monal-maintenance
APP_USER=monal
[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo"; exit 1; }

/usr/local/bin/monal-backup || echo "Backup before update failed — continuing"
git config --global --add safe.directory "$APP_DIR"
git -C "$APP_DIR" pull --ff-only
cd "$APP_DIR"
npm ci --omit=dev
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
systemctl restart monal-maintenance
sleep 2
curl -fsS -o /dev/null http://127.0.0.1:3000/login && echo "Updated and running." || echo "App did not respond; check: sudo journalctl -u monal-maintenance -n 50"
