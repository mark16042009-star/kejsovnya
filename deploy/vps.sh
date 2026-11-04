#!/usr/bin/env bash
# «ПиксельДроп» целиком на своём VPS: сайт + сервер игры + база данных (SQLite).
# Запуск на Ubuntu/Debian от root:
#   curl -fsSL https://raw.githubusercontent.com/mark16042009-star/kejsovnya/main/deploy/vps.sh | bash
# Повторный запуск безопасен: обновит код и настройки, базу не трогает.
# Перенос базы из Cloudflare: bash /opt/pixeldrop/deploy/migrate.sh
set -euo pipefail

REPO="https://github.com/mark16042009-star/kejsovnya.git"
DIR=/opt/pixeldrop; ETC=/etc/pixeldrop; VAR=/var/lib/pixeldrop

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }
ask()  { local q="$1" def="${2:-}" a; read -rp "$q" a </dev/tty || true; printf '%s' "${a:-$def}"; }
asks() { local q="$1" a; read -rsp "$q" a </dev/tty || true; echo >&2; printf '%s' "$a"; }

[ "$(id -u)" = 0 ] || fail "запустите от имени root."
command -v apt-get >/dev/null || fail "скрипт рассчитан на Ubuntu или Debian."

IP="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DEFAULT_DOMAIN="$(printf '%s' "$IP" | tr . -).sslip.io"
OLD_DOMAIN="$(sed -n 's/^\([^ {#]\+\) {$/\1/p' /etc/caddy/Caddyfile 2>/dev/null | head -1 || true)"

say "Настройка"
echo "Адрес сайта. Нет своего домена — нажмите Enter, будет бесплатный адрес с HTTPS: $DEFAULT_DOMAIN"
DOMAIN="$(ask "Домен [${OLD_DOMAIN:-$DEFAULT_DOMAIN}]: " "${OLD_DOMAIN:-$DEFAULT_DOMAIN}")"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"

say "Устанавливаю пакеты (Node.js 22, Caddy)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ufw ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
NODE_OK=0; command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' && NODE_OK=1
if [ "$NODE_OK" != 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "Скачиваю игру"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else git clone -q --depth 1 "$REPO" "$DIR"; fi
chmod -R a+rX "$DIR"
id pixeldrop >/dev/null 2>&1 || useradd --system --home "$VAR" --shell /usr/sbin/nologin pixeldrop
mkdir -p "$ETC" "$VAR/backups"; chown -R pixeldrop:pixeldrop "$VAR"

if [ ! -f "$ETC/api.env" ]; then
  say "Настройки сервера игры (вводятся только здесь, на сервере)"
  ADM="$(ask "Логин администратора на сайте (ваш логин) [admin]: " "admin")"
  echo "Токен Telegram-бота — для проверки подписки на канал и уведомлений о трейдах."
  echo "(можно оставить пустым и добавить позже в $ETC/api.env)"
  BOT="$(asks "BOT_TOKEN (ввод скрыт): ")"
  CH="$(ask "Канал для проверки подписки, например @pixeldropsimulator (Enter — не проверять): " "")"
  umask 077
  cat > "$ETC/api.env" <<EOF
ADMIN_LOGINS=$ADM
BOT_TOKEN=$BOT
TG_CHANNEL=$CH
ALLOWED_ORIGINS=https://$DOMAIN
APP_URL=https://$DOMAIN/
DB_FILE=$VAR/db.sqlite
PORT=8787
EOF
  umask 022
else
  sed -i "s#^ALLOWED_ORIGINS=.*#ALLOWED_ORIGINS=https://$DOMAIN#; s#^APP_URL=.*#APP_URL=https://$DOMAIN/#" "$ETC/api.env"
fi
chown root:pixeldrop "$ETC/api.env"; chmod 640 "$ETC/api.env"

# config.js для этого сервера: игра ходит в свой /api
sed 's#^\(\s*api:\s*\)"[^"]*"#\1"/api"#' "$DIR/docs/config.js" > "$ETC/config.js"

say "Сервис игры"
cat > /etc/systemd/system/pixeldrop-api.service <<EOF
[Unit]
Description=ПиксельДроп — сервер игры
After=network.target
[Service]
User=pixeldrop
WorkingDirectory=$DIR
ExecStart=/usr/bin/node $DIR/server/run.mjs
Restart=always
RestartSec=2
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
EOF

say "Веб-сервер и HTTPS"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode zstd gzip
	handle /api* {
		reverse_proxy 127.0.0.1:8787
	}
	handle /config.js {
		root * $ETC
		header Cache-Control "no-cache"
		file_server
	}
	handle {
		root * $DIR/docs
		@html path / /index.html
		header @html Cache-Control "no-cache"
		file_server
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null

say "Автообновление и резервные копии"
cat > /usr/local/bin/pixeldrop-update <<'EOF'
#!/usr/bin/env bash
# раз в минуту: забрать обновления с GitHub; если изменился сервер — перезапустить его
set -e
D=/opt/pixeldrop; OLD="$(git -C $D rev-parse HEAD)"
git -C $D pull --ff-only -q || exit 0
NEW="$(git -C $D rev-parse HEAD)"
[ "$OLD" = "$NEW" ] && exit 0
chmod -R a+rX $D
sed 's#^\(\s*api:\s*\)"[^"]*"#\1"/api"#' $D/docs/config.js > /etc/pixeldrop/config.js
git -C $D diff --name-only "$OLD" "$NEW" | grep -qE '^(worker|server)/' && systemctl restart pixeldrop-api || true
EOF
cat > /usr/local/bin/pixeldrop-backup <<'EOF'
#!/usr/bin/env bash
# раз в сутки: копия базы, хранятся 14 последних
set -e
B=/var/lib/pixeldrop/backups; mkdir -p $B
F="$B/db-$(date +%Y%m%d-%H%M).sqlite"
node /opt/pixeldrop/server/backup.mjs /var/lib/pixeldrop/db.sqlite "$F"
ls -1t $B/db-*.sqlite | tail -n +15 | xargs -r rm -f
EOF
chmod +x /usr/local/bin/pixeldrop-update /usr/local/bin/pixeldrop-backup
for n in update backup; do
  cat > /etc/systemd/system/pixeldrop-$n.service <<EOF
[Unit]
Description=ПиксельДроп: $n
[Service]
Type=oneshot
ExecStart=/usr/local/bin/pixeldrop-$n
EOF
done
cat > /etc/systemd/system/pixeldrop-update.timer <<EOF
[Unit]
Description=Обновлять ПиксельДроп каждую минуту
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/pixeldrop-backup.timer <<EOF
[Unit]
Description=Резервная копия базы ПиксельДропа раз в сутки
[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl disable -q --now pixeldrop-pull.timer 2>/dev/null || true
systemctl daemon-reload
systemctl enable -q --now pixeldrop-api pixeldrop-update.timer pixeldrop-backup.timer
systemctl restart pixeldrop-api
systemctl enable -q caddy && (systemctl reload caddy || systemctl restart caddy)

ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

say "Проверка"
sleep 4
systemctl is-active -q pixeldrop-api || { journalctl -u pixeldrop-api -n 30 --no-pager; fail "сервер игры не запустился"; }
if curl -fsS --max-time 20 "https://$DOMAIN/api" >/dev/null; then
  printf '\n\033[1;32mГотово! Игра работает: https://%s/\033[0m\n' "$DOMAIN"
else
  printf '\n\033[1;33mВсё запущено, HTTPS-сертификат ещё выпускается — откройте https://%s/ через минуту.\033[0m\n' "$DOMAIN"
fi
echo
echo "База сейчас пустая. Чтобы перенести игроков из Cloudflare:"
echo "  1) на старом сайте включите «Технические работы» в админке"
echo "  2) выполните:  bash $DIR/deploy/migrate.sh"
