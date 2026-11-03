#!/usr/bin/env bash
# Установка «Кейсовни» как обычного сайта на Ubuntu/Debian VPS одной командой:
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
OLD_ADMINS=""; OLD_DOMAIN=""; OLD_EMAIL=""
[ -f /etc/caddy/Caddyfile ] && OLD_EMAIL="$(sed -n 's/^[[:space:]]*email[[:space:]]\+//p' /etc/caddy/Caddyfile | head -1)"
if [ -f "$APP/.env" ]; then
  OLD_ADMINS="$(sed -n 's/^ADMIN_IDS=//p' "$APP/.env")"
  OLD_DOMAIN="$(sed -n 's#^WEBAPP_URL=https://##p' "$APP/.env")"
fi
# прежний логин админа (если это не Telegram ID)
OLD_LOGIN="$(printf '%s' "$OLD_ADMINS" | tr ', ' '\n\n' | grep -E '^[A-Za-z0-9_]{3,20}$' | grep -vE '^[0-9]+$' | head -1 || true)"

say "Настройка"
echo "1) Адрес сайта. Если своего домена нет, просто нажмите Enter: будет бесплатный адрес $DEFAULT_DOMAIN"
echo "   (сайт в любом случае будет открываться и по http://$IP)"
DOMAIN="$(ask "Домен [${OLD_DOMAIN:-$DEFAULT_DOMAIN}]: " "${OLD_DOMAIN:-$DEFAULT_DOMAIN}")"

echo
echo "2) Email для HTTPS-сертификата (на него приходят только письма о сертификате)."
EMAIL="$(ask "Email [${OLD_EMAIL}]: " "$OLD_EMAIL")"
[ -z "$EMAIL" ] || [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || fail "email выглядит неверно."

echo
echo "3) Аккаунт администратора: с ним вы войдёте на сайт и получите админ-панель."
ADMIN_LOGIN="$(ask "Логин админа (латиница, цифры, _) [${OLD_LOGIN}]: " "$OLD_LOGIN")"
[[ "$ADMIN_LOGIN" =~ ^[A-Za-z0-9_]{3,20}$ ]] || fail "логин: от 3 до 20 символов — латинские буквы, цифры и _."
read -rsp "Пароль админа (символы не отображаются; Enter — не менять): " ADMIN_PASS </dev/tty || true; echo
if [ -n "$ADMIN_PASS" ]; then
  [ "${#ADMIN_PASS}" -ge 6 ] || fail "пароль должен быть не короче 6 символов."
  read -rsp "Пароль ещё раз: " ADMIN_PASS2 </dev/tty || true; echo
  [ "$ADMIN_PASS" = "$ADMIN_PASS2" ] || fail "пароли не совпадают, запустите установку ещё раз."
elif [ -z "$OLD_LOGIN" ] || [ "$OLD_LOGIN" != "$ADMIN_LOGIN" ]; then
  fail "для нового админа нужен пароль."
fi

echo
echo "4) Telegram-бот (необязательно). Нажмите Enter, чтобы сайт работал без Telegram."
BOT_TOKEN="$(ask "Токен бота: " "")"
[ -z "$BOT_TOKEN" ] || [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || fail "токен выглядит неверно. Он должен быть вида 1234567890:AAH..."
ADMIN_IDS="$ADMIN_LOGIN"

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
WEBAPP_URL=$( [ -n "$BOT_TOKEN" ] && printf 'https://%s' "$DOMAIN" )
ADMIN_IDS=$ADMIN_IDS
PORT=3000
HOST=127.0.0.1
BUTTON_TEXT=Играть
EOF
chown -R "$SVC:$SVC" "$APP"
chmod 600 "$APP/.env"
if [ -n "$ADMIN_PASS" ]; then
  say "Создаю аккаунт администратора"
  ( cd "$APP" && sudo -u "$SVC" env PASS="$ADMIN_PASS" "$(command -v node)" server.js set-password "$ADMIN_LOGIN" ) || fail "не удалось создать аккаунт админа."
fi
unset ADMIN_PASS ADMIN_PASS2

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
  printf '%s {\n    encode gzip\n    reverse_proxy 127.0.0.1:3000\n}\n\n' "$DOMAIN"
  printf 'http://%s {\n    encode gzip\n    reverse_proxy 127.0.0.1:3000\n}\n' "$IP"
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
if [ -n "$BOT_TOKEN" ]; then
  if curl -fsS --max-time 8 -o /dev/null "https://api.telegram.org"; then
    echo "Связь с Telegram есть."
  else
    echo "ВНИМАНИЕ: сервер не достучался до api.telegram.org: бот не сможет отвечать на /start. Сайт при этом работает."
  fi
fi
if curl -fsS --max-time 5 -o /dev/null "http://$IP/"; then echo "Сайт открывается по http://$IP"; fi
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

if [ "${OK:-}" = 1 ]; then MAIN="https://$DOMAIN"; else MAIN="http://$IP"; fi
cat <<EOF

────────────────────────────────────────────
Готово! Сайт: $MAIN
$( [ "${OK:-}" = 1 ] && printf 'Также открывается по http://%s' "$IP" || printf 'Защищённый адрес https://%s заработает, когда выдадут сертификат.' "$DOMAIN" )

Войдите на сайт кнопкой «Войти» с логином $ADMIN_LOGIN — у вас появится раздел «Админ».
Игроки регистрируются сами кнопкой «Войти» → «Регистрация».

Полезные команды:
  Обновить игру после изменений на GitHub:  bash $APP/deploy/update.sh
  Сменить пароль любого аккаунта:           cd $APP && sudo -u $SVC env PASS='новый_пароль' node server.js set-password логин
  Посмотреть лог игры:                      journalctl -u $SVC -f
  Резервная копия данных:                   cp $APP/data.sqlite ~/kejsovnya-backup.sqlite
────────────────────────────────────────────
EOF
