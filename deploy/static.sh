#!/usr/bin/env bash
# «ПиксельДроп» на своём VPS: сайт отдаёт Caddy (с бесплатным HTTPS), а сервер игры и база остаются в Cloudflare.
# Запуск на чистом Ubuntu/Debian одной командой (от root):
#   curl -fsSL https://raw.githubusercontent.com/mark16042009-star/kejsovnya/main/deploy/static.sh | bash
# Повторный запуск безопасен. Сайт сам обновляется с GitHub каждую минуту — GitHub Pages больше не нужен.
set -euo pipefail

REPO="https://github.com/mark16042009-star/kejsovnya.git"
DIR=/opt/pixeldrop

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }
ask()  { local q="$1" def="${2:-}" a; read -rp "$q" a </dev/tty || true; printf '%s' "${a:-$def}"; }

[ "$(id -u)" = 0 ] || fail "запустите от имени root."
command -v apt-get >/dev/null || fail "скрипт рассчитан на Ubuntu или Debian."

IP="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DEFAULT_DOMAIN="$(printf '%s' "$IP" | tr . -).sslip.io"
OLD_DOMAIN="$(sed -n 's/^\([^ {#]\+\) {$/\1/p' /etc/caddy/Caddyfile 2>/dev/null | head -1 || true)"

say "Настройка"
echo "Адрес сайта. Если своего домена пока нет — нажмите Enter, будет бесплатный адрес с HTTPS: $DEFAULT_DOMAIN"
echo "(свой домен нужно заранее направить A-записью на $IP)"
DOMAIN="$(ask "Домен [${OLD_DOMAIN:-$DEFAULT_DOMAIN}]: " "${OLD_DOMAIN:-$DEFAULT_DOMAIN}")"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"

say "Устанавливаю пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ufw debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "Скачиваю сайт"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q; else git clone -q --depth 1 "$REPO" "$DIR"; fi
chmod -R a+rX "$DIR"

say "Настраиваю веб-сервер"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	root * $DIR/docs
	encode zstd gzip
	@html path / /index.html
	header @html Cache-Control "no-cache"
	header /config.js Cache-Control "no-cache"
	file_server
}
EOF
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl enable -q caddy && systemctl reload caddy || systemctl restart caddy

say "Автообновление сайта с GitHub (раз в минуту)"
cat > /etc/systemd/system/pixeldrop-pull.service <<EOF
[Unit]
Description=Обновление сайта ПиксельДроп с GitHub
[Service]
Type=oneshot
ExecStart=/usr/bin/git -C $DIR pull --ff-only -q
EOF
cat > /etc/systemd/system/pixeldrop-pull.timer <<EOF
[Unit]
Description=Обновлять ПиксельДроп каждую минуту
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q --now pixeldrop-pull.timer

say "Файрвол"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Проверка"
sleep 4
if curl -fsS --max-time 20 "https://$DOMAIN/" -o /dev/null; then
  printf '\n\033[1;32mГотово! Сайт работает: https://%s/\033[0m\n' "$DOMAIN"
else
  printf '\n\033[1;33mСайт запущен, HTTPS-сертификат ещё выпускается — откройте https://%s/ через минуту.\033[0m\n' "$DOMAIN"
  echo "Если не открывается долго: journalctl -u caddy -n 50 --no-pager"
fi
echo
echo "Осталось два шага:"
echo "  1) Cloudflare → Worker → Settings → Variables: в ALLOWED_ORIGINS добавьте через запятую  https://$DOMAIN"
echo "  2) BotFather → Bot Settings → Configure Mini App (и Menu Button): адрес  https://$DOMAIN/"
