#!/usr/bin/env bash
# Установка «Кейсовни» на чистый Ubuntu/Debian VPS одной командой:
#   curl -fsSL https://raw.githubusercontent.com/mark16042009-star/kejsovnya/main/deploy/install.sh | sudo bash
# Повторный запуск безопасен: обновит код и настройки, данные игроков не трогает.
set -euo pipefail

REPO="${REPO:-https://github.com/mark16042009-star/kejsovnya.git}"
APP=/opt/kejsovnya
SVC=kejsovnya

say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }
ask()  { local q="$1" def="${2:-}" a; read -rp "$q" a </dev/tty || true; printf '%s' "${a:-$def}"; }

[ "$(id -u)" = 0 ] || fail "запустите от имени root (или через sudo)."
command -v apt-get >/dev/null || fail "скрипт рассчитан на Ubuntu или Debian."

# ---------- Настройки ----------
IP="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DEFAULT_DOMAIN="$(printf '%s' "$IP" | tr . -).sslip.io"
OLD_TOKEN=""; OLD_ADMINS=""; OLD_DOMAIN=""; OLD_EMAIL=""
[ -f /etc/caddy/Caddyfile ] && OLD_EMAIL="$(sed -n 's/^[[:space:]]*email[[:space:]]\+//p' /etc/caddy/Caddyfile | head -1)"
if [ -f "$APP/.env" ]; then
  OLD_TOKEN="$(sed -n 's/^BOT_TOKEN=//p' "$APP/.env")"
  OLD_ADMINS="$(sed -n 's/^ADMIN_IDS=//p' "$APP/.env")"
  OLD_DOMAIN="$(sed -n 's#^WEBAPP_URL=https://##p' "$APP/.env")"
fi

say "Настройка"
echo "Адрес игры. Если у вас нет своего домена, просто нажмите Enter: будет бесплатный адрес $DEFAULT_DOMAIN"
DOMAIN="$(ask "Домен [${OLD_DOMAIN:-$DEFAULT_DOMAIN}]: " "${OLD_DOMAIN:-$DEFAULT_DOMAIN}")"
if [ -n "$OLD_TOKEN" ]; then
  BOT_TOKEN="$(ask "Токен бота (Enter — оставить прежний): " "$OLD_TOKEN")"
else
  BOT_TOKEN="$(ask "Токен бота от @BotFather: ")"
fi
[[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || fail "токен выглядит неверно. Он должен быть вида 1234567890:AAH... Скопируйте его из @BotFather."
ADMIN_IDS="$(ask "Ваш Telegram ID для админки (узнать: @userinfobot) [${OLD_ADMINS}]: " "$OLD_ADMINS")"
[[ "$ADMIN_IDS" =~ ^[0-9]+([,[:space:]]+[0-9]+)*$ ]] || fail "Telegram ID — это число, например 123456789. Несколько ID пишите через запятую."
echo "Email для HTTPS-сертификата. С ним, если Let's Encrypt не сможет проверить сервер, сертификат выдаст ZeroSSL. На него приходят только уведомления о сертификате."
EMAIL="$(ask "Email [${OLD_EMAIL}]: " "$OLD_EMAIL")"
[ -z "$EMAIL" ] || [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "email выглядит неверно."

# ---------- Программы ----------
say "Устанавливаю системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
  say "Устанавливаю Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node.js $(node -v)"

if ! command -v caddy >/dev/null; then
  say "Устанавливаю Caddy (HTTPS)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# ---------- Код ----------
say "Скачиваю игру"
id "$SVC" >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin "$SVC"
git config --global --add safe.directory "$APP" 2>/dev/null || true
if [ -d "$APP/.git" ]; then
  git -C "$APP" pull --ff-only -q
else
  git clone -q "$REPO" "$APP"
fi

cat > "$APP/.env" <<EOF
BOT_TOKEN=$BOT_TOKEN
WEBAPP_URL=https://$DOMAIN
ADMIN_IDS=$ADMIN_IDS
PORT=3000
HOST=127.0.0.1
BUTTON_TEXT=Играть
EOF
chown -R "$SVC:$SVC" "$APP"
chmod 600 "$APP/.env"

# ---------- Автозапуск ----------
say "Включаю автозапуск"
cat > /etc/systemd/system/$SVC.service <<EOF
[Unit]
Description=Kejsovnya game server
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC
WorkingDirectory=$APP
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

{
  if [ -n "$EMAIL" ]; then printf '{\n    email %s\n}\n\n' "$EMAIL"; fi
  printf '%s {\n    encode gzip\n    reverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN"
} > /etc/caddy/Caddyfile

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

systemctl daemon-reload
systemctl enable -q --now "$SVC"
systemctl restart "$SVC"
systemctl enable -q --now caddy
systemctl reload caddy || systemctl restart caddy

# ---------- Проверка ----------
say "Проверяю"
sleep 3
systemctl is-active -q "$SVC" || { journalctl -u "$SVC" -n 30 --no-pager; fail "сервер игры не запустился, лог выше."; }
curl -fsS -o /dev/null http://127.0.0.1:3000/ || fail "сервер игры не отвечает."
echo "Сервер игры работает."
if curl -fsS --max-time 8 -o /dev/null "https://api.telegram.org"; then
  echo "Связь с Telegram есть."
else
  echo "ВНИМАНИЕ: сервер не достучался до api.telegram.org. Игра откроется, но бот не сможет отвечать на /start и ставить кнопку."
fi
echo "Жду HTTPS-сертификат (до двух минут)..."
for i in $(seq 1 40); do
  if curl -fsS --max-time 5 -o /dev/null "https://$DOMAIN/" 2>/dev/null; then OK=1; break; fi
  sleep 3
done
if [ "${OK:-}" = 1 ]; then
  echo "HTTPS работает."
else
  printf '\033[1;31mHTTPS пока не работает: сертификат не выдан.\033[0m Caddy продолжит попытки сам, проверьте через несколько минут: https://%s\n' "$DOMAIN"
  if [ -z "$EMAIL" ]; then echo "Совет: запустите установку ещё раз и укажите email — тогда сертификат сможет выдать ZeroSSL."; fi
  echo "Подробности: journalctl -u caddy -n 50 --no-pager"
fi

cat <<EOF

────────────────────────────────────────────
Готово! Игра: https://$DOMAIN

Что дальше:
  1. Откройте бота в Telegram и отправьте /start — придёт приветствие с кнопкой «Играть».
  2. Если делали прямую ссылку через /newapp: @BotFather → /myapps → бот → игра →
     Edit Web App URL → пришлите https://$DOMAIN

Полезные команды:
  Обновить игру после изменений на GitHub:  sudo bash $APP/deploy/update.sh
  Посмотреть лог игры:                      journalctl -u $SVC -f
  Резервная копия данных:                   cp $APP/data.sqlite ~/kejsovnya-backup.sqlite
────────────────────────────────────────────
EOF
