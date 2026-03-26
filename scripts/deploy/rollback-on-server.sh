#!/usr/bin/env bash
# Откат на сервере до прошлой версии из бекапа (до нового майлера и т.д.).
# Запускать **на сервере** (ssh root@IP, затем bash rollback-on-server.sh).
# Бекапы: /var/backups/gmx-deploy/*.tar.gz (хранятся 3 дня).

set -e
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gmx-deploy}"
WWW="/var/www"
GMX_DIR="$WWW/gmx-net.help"

echo "Бекапы в $BACKUP_DIR:"
ls -lt "$BACKUP_DIR"/*.tar.gz 2>/dev/null || { echo "Нет бекапов."; exit 1; }
echo ""

# Последний бекап (до деплоя с новым майлером — выбери более старый по дате)
# Можно передать имя файла: ./rollback-on-server.sh 2025-03-10_14-00-00.tar.gz
if [ -n "$1" ]; then
  TAR="$BACKUP_DIR/$1"
  [ -f "$TAR" ] || { echo "Файл не найден: $TAR"; exit 1; }
else
  echo "Укажи имя архива из списка выше (например: 2025-03-10_14-00-00.tar.gz)"
  read -r TAR_NAME
  TAR="$BACKUP_DIR/$TAR_NAME"
  [ -f "$TAR" ] || { echo "Файл не найден: $TAR"; exit 1; }
fi

RESTORE_DIR="/tmp/rollback-$$"
mkdir -p "$RESTORE_DIR"
trap "rm -rf $RESTORE_DIR" EXIT

echo "Распаковка $TAR в $RESTORE_DIR..."
tar -xzf "$TAR" -C "$RESTORE_DIR"

if [ ! -d "$RESTORE_DIR/gmx-net.help" ]; then
  echo "В архиве нет gmx-net.help. Выход."
  exit 1
fi

echo "Копирование кода в $GMX_DIR (data, node_modules, .env не трогаем)..."
rsync -a --delete \
  --exclude 'data' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'downloads' \
  "$RESTORE_DIR/gmx-net.help/" "$GMX_DIR/"

echo "Перезапуск gmx-net..."
cd "$GMX_DIR" && npm install && pm2 restart gmx-net && pm2 save

echo "Готово. Откат выполнен."
