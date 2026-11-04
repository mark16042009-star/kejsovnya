#!/usr/bin/env bash
# Переносит всю базу игроков из Cloudflare на этот сервер.
# Перед запуском включите «Технические работы» в админке старого сайта — чтобы никто ничего не менял во время переноса.
#   bash /opt/pixeldrop/deploy/migrate.sh
set -euo pipefail
DIR=/opt/pixeldrop; VAR=/var/lib/pixeldrop
say()  { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }
ask()  { local q="$1" def="${2:-}" a; read -rp "$q" a </dev/tty || true; printf '%s' "${a:-$def}"; }
asks() { local q="$1" a; read -rsp "$q" a </dev/tty || true; echo >&2; printf '%s' "$a"; }
[ "$(id -u)" = 0 ] || fail "запустите от имени root."

OLD_API="$(ask "Адрес старого сервера [https://hidden-union-e818.mark16042009.workers.dev/api]: " "https://hidden-union-e818.mark16042009.workers.dev/api")"
ADM_LOGIN="$(ask "Логин администратора: " "")"
ADM_PASS="$(asks "Пароль администратора (ввод скрыт): ")"
F="$VAR/export-$(date +%Y%m%d-%H%M%S).json"

say "Скачиваю базу из Cloudflare"
OLD_API="$OLD_API" ADM_LOGIN="$ADM_LOGIN" ADM_PASS="$ADM_PASS" node "$DIR/server/fetch-export.mjs" "$F" || fail "не получилось скачать базу"
chmod 600 "$F"

say "Загружаю в базу этого сервера"
systemctl stop pixeldrop-api
[ -f "$VAR/db.sqlite" ] && node "$DIR/server/backup.mjs" "$VAR/db.sqlite" "$VAR/backups/before-migrate-$(date +%Y%m%d-%H%M%S).sqlite" >/dev/null || true
sudo -u pixeldrop node "$DIR/server/run.mjs" import "$F"
systemctl start pixeldrop-api
sleep 2
systemctl is-active -q pixeldrop-api && printf '\n\033[1;32mБаза перенесена. Игроки, аккаунты и их входы — на этом сервере.\033[0m\n' || fail "сервер не запустился: journalctl -u pixeldrop-api -n 30"
echo "Дальше: зайдите на новый сайт админом, проверьте профиль и выключите «Технические работы»."
