#!/usr/bin/env bash
# Деплой gmx через rsync без потери данных на сервере.
# Не трогаем и никогда не удаляем на сервере: .env, data/, downloads/, node_modules/, login/.venv, login/cookies/
# Лиды и все базы хранятся в data/ и дополняются в реальном времени; при деплое они не перезаписываются.

set -e
SOURCE="${SOURCE:-/Users/greedy/Desktop/gmx}"
DEST="${RSYNC_DEST:-root@166.0.150.132:/var/www/gmx-net.help/}"
# Из DEST извлекаем host и путь на сервере
HOST="${DEST%%:*}"
SERVER_PATH="${DEST#*:}"
SERVER_PATH="${SERVER_PATH%/}"   # убрать завершающий /
CONTROL_SOCK="${SSH_CONTROL_SOCK:-/tmp/ssh-deploy-$$}"
cleanup_ssh() { ssh -o ControlPath="$CONTROL_SOCK" -O exit "$HOST" 2>/dev/null || true; }
trap cleanup_ssh EXIT
ssh -o ControlMaster=yes -o ControlPath="$CONTROL_SOCK" -o ControlPersist=60 -N -f "$HOST"
RSYNC_SSH="ssh -o ControlPath=$CONTROL_SOCK"

echo "→ gmx: $SOURCE -> $DEST (исключены: .env, data/, downloads/, node_modules/, login/.venv, login/cookies/)"
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.env' \
  --exclude 'downloads' \
  --exclude 'login/.venv' \
  --exclude 'login/cookies' \
  "$SOURCE/" "$DEST"

echo "→ перезапуск на сервере: npm install && pm2 restart gmx-net && pm2 save"
ssh -o ControlPath="$CONTROL_SOCK" "$HOST" "cd $SERVER_PATH && npm install && pm2 restart gmx-net && pm2 save"
echo "Готово."
