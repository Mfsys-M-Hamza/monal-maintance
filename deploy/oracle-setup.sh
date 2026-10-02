#!/usr/bin/env bash
# One-time server setup for Ubuntu 22.04/24.04 (e.g. Oracle Cloud Always Free).
# Installs Node.js 24 + Caddy (automatic HTTPS), runs the app as a systemd service,
# opens ports 80/443 in the OS firewall and schedules daily backups.
#
# Usage (on the server):
#   curl -fsSL https://raw.githubusercontent.com/Mfsys-M-Hamza/monal-maintance/main/deploy/oracle-setup.sh -o setup.sh
#   sudo bash setup.sh                 # uses a free <ip>.sslip.io address
#   sudo bash setup.sh my.domain.com   # or your own (sub)domain pointing to this server
# Safe to re-run: existing data and .env are kept.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Mfsys-M-Hamza/monal-maintance.git}"
APP_DIR=/opt/monal-maintenance
DATA_DIR=/var/lib/monal-maintenance
APP_USER=monal
DOMAIN="${1:-${DOMAIN:-}}"

[ "$(id -u)" -eq 0 ] || { echo "Please run with sudo: sudo bash $0"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

if [ -z "$DOMAIN" ]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
fi
echo "==> Setting up for https://${DOMAIN}"

MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "$MEM_MB" -lt 2048 ] && ! swapon --show | grep -q .; then
  echo "==> Low memory (${MEM_MB} MB): adding a 2 GB swap file"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg sqlite3 debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (HTTPS reverse proxy)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Creating app user and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/backups"

echo "==> Fetching application code"
if [ -d "$APP_DIR/.git" ]; then
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

if [ ! -f "$APP_DIR/.env" ]; then
  echo "==> Writing .env (random session secret)"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
SESSION_SECRET=${SECRET}
DATABASE_PATH=${DATA_DIR}/app.db
UPLOAD_DIR=${DATA_DIR}/uploads
TRUST_PROXY=true
COOKIE_SECURE=true
EOF
fi
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR"
sudo -u "$APP_USER" npm run --silent db:init

echo "==> Installing systemd service"
cat > /etc/systemd/system/monal-maintenance.service <<EOF
[Unit]
Description=Project Utilities & Maintenance Management System
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node --no-warnings=ExperimentalWarning src/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now monal-maintenance
systemctl restart monal-maintenance

echo "==> Configuring Caddy for ${DOMAIN}"
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	encode gzip
	request_body {
		max_size 10MB
	}
	reverse_proxy 127.0.0.1:3000
}
EOF
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo "==> Opening ports 80 and 443 in the OS firewall"
if ! iptables -C INPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
  iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
fi
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi

echo "==> Scheduling daily backups (02:30, kept 14 days)"
cat > /usr/local/bin/monal-backup <<EOF
#!/usr/bin/env bash
set -euo pipefail
STAMP=\$(date +%F)
sqlite3 "${DATA_DIR}/app.db" ".backup '${DATA_DIR}/backups/app-\${STAMP}.db'"
tar -czf "${DATA_DIR}/backups/uploads-\${STAMP}.tar.gz" -C "${DATA_DIR}" uploads
find "${DATA_DIR}/backups" -type f -mtime +14 -delete
EOF
chmod 755 /usr/local/bin/monal-backup
echo "30 2 * * * root /usr/local/bin/monal-backup" > /etc/cron.d/monal-backup

sleep 2
if curl -fsS -o /dev/null http://127.0.0.1:3000/login; then echo "==> App is running."; else echo "!! App did not respond; check: sudo journalctl -u monal-maintenance -n 50"; fi

ADMINS="$(sqlite3 "${DATA_DIR}/app.db" "SELECT COUNT(*) FROM users WHERE role='admin'")"
echo
echo "============================================================"
echo " Done. Your app address:  https://${DOMAIN}"
echo " (the HTTPS certificate can take a minute on first visit)"
if [ "$ADMINS" = "0" ]; then
  echo
  echo " Create the first admin now:"
  echo "   cd ${APP_DIR} && sudo -u ${APP_USER} npm run create-admin"
fi
echo
echo " Update later:   sudo bash ${APP_DIR}/deploy/update.sh"
echo " Logs:           sudo journalctl -u monal-maintenance -f"
echo " Backups:        ${DATA_DIR}/backups"
echo "============================================================"
