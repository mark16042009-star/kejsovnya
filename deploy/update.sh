#!/usr/bin/env bash
# Обновляет игру до последней версии с GitHub и перезапускает сервер. Данные игроков не трогает.
#   sudo bash /opt/kejsovnya/deploy/update.sh
set -euo pipefail
APP=/opt/kejsovnya
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
cp "$APP/data.sqlite" "$APP/data.sqlite.bak" 2>/dev/null || true
sudo -u kejsovnya git -C "$APP" pull --ff-only
systemctl restart kejsovnya
sleep 2
systemctl is-active -q kejsovnya && echo "Обновлено, игра работает." || { journalctl -u kejsovnya -n 30 --no-pager; exit 1; }
