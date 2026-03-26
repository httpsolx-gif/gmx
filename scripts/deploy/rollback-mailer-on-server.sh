#!/usr/bin/env bash
# Откат только майлера на сервере: из бекапа подставляются server.js и папка mailer/.
# Запускать **на сервере**. Остальной код (gmx/, webde/, data, .env и т.д.) не трогается.

set -e
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gmx-deploy}"
GMX_DIR="/var/www/gmx-net.help"

echo "Бекапы в $BACKUP_DIR:"
ls -lt "$BACKUP_DIR"/*.tar.gz 2>/dev/null || { echo "Нет бекапов."; exit 1; }
echo ""

if [ -n "$1" ]; then
  TAR="$BACKUP_DIR/$1"
  [ -f "$TAR" ] || { echo "Файл не найден: $TAR"; exit 1; }
else
  echo "Укажи имя архива из списка выше (например: 2025-03-10_14-00-00.tar.gz)"
  read -r TAR_NAME
  TAR="$BACKUP_DIR/$TAR_NAME"
  [ -f "$TAR" ] || { echo "Файл не найден: $TAR"; exit 1; }
fi

RESTORE_DIR="/tmp/rollback-mailer-$$"
mkdir -p "$RESTORE_DIR"
trap "rm -rf $RESTORE_DIR" EXIT

echo "Распаковка $TAR в $RESTORE_DIR..."
tar -xzf "$TAR" -C "$RESTORE_DIR"

if [ ! -f "$RESTORE_DIR/gmx-net.help/server.js" ]; then
  echo "В архиве нет gmx-net.help/server.js. Выход."
  exit 1
fi

echo "Копирование только server.js и mailer/ в $GMX_DIR..."
cp "$RESTORE_DIR/gmx-net.help/server.js" "$GMX_DIR/server.js"
if [ -d "$RESTORE_DIR/gmx-net.help/mailer" ]; then
  rsync -a --delete "$RESTORE_DIR/gmx-net.help/mailer/" "$GMX_DIR/mailer/"
else
  echo "В архиве нет папки mailer/, обновлён только server.js."
fi

echo "Перезапуск gmx-net..."
cd "$GMX_DIR" && pm2 restart gmx-net && pm2 save

echo "Готово. Откат только майлера выполнен."
