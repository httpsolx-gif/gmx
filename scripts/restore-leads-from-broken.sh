#!/bin/sh
# Восстановить leads.json из самого тяжёлого файла (leads.json.broken).
# Запускать из корня проекта: ./scripts/restore-leads-from-broken.sh [data/]

cd "$(dirname "$0")/.." || exit 1
DATA_DIR="${1:-data}"

LEADS="$DATA_DIR/leads.json"
BROKEN="$DATA_DIR/leads.json.broken"
BACKUP="$DATA_DIR/leads.json.before-restore-$(date +%Y-%m-%d-%H%M%S).json"

if [ ! -f "$BROKEN" ]; then
  echo "Файл не найден: $BROKEN"
  exit 1
fi

echo "Сохраняю текущий leads.json -> $BACKUP"
cp "$LEADS" "$BACKUP"

echo "Заменяю leads.json на содержимое leads.json.broken"
cp "$BROKEN" "$LEADS"

echo "Готово. Сервер теперь использует полную историю из leads.json.broken."
