#!/usr/bin/env bash
# Один деплой на сервер: gmx + майлер. Перед деплоем — бекап на сервере (хранится 3 дня). Без потери данных при rsync.
# Пароль/ключ запрашивается один раз за счёт SSH ControlMaster.

set -e
HOST="${DEPLOY_HOST:-root@166.0.150.132}"
GMX_SRC="${GMX_SRC:-/Users/greedy/Desktop/gmx}"
SPAM_SRC="${SPAM_SRC:-/Users/greedy/Desktop/spam1}"
GMX_DEST="$HOST:/var/www/gmx-net.help/"
MAILER_DEST="$HOST:/var/www/mailer/"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gmx-deploy}"
# Только архивы — логи и прочее в BACKUP_DIR не трогаем
BACKUP_ARCHIVES="$BACKUP_DIR/archives"

# Один SSH-канал: пароль один раз, дальше переиспользуем
CONTROL_SOCK="${SSH_CONTROL_SOCK:-/tmp/ssh-deploy-$$}"
cleanup_ssh() { ssh -o ControlPath="$CONTROL_SOCK" -O exit "$HOST" 2>/dev/null || true; }
trap cleanup_ssh EXIT
ssh -o ControlMaster=yes -o ControlPath="$CONTROL_SOCK" -o ControlPersist=120 -N -f "$HOST"
SSH_OPTS=(-o "ControlPath=$CONTROL_SOCK")
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

echo "→ бекап текущей версии на сервере..."
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $BACKUP_ARCHIVES && \
  AVAIL=\$(df -m $BACKUP_ARCHIVES | awk 'NR==2 {print \$4}'); \
  if [ \"\${AVAIL:-0}\" -lt 300 ]; then \
    echo \"ОШИБКА: мало места на диске для бекапа (свободно \${AVAIL}MB). Освободите место или удалите старые архивы:\"; \
    echo \"  find $BACKUP_ARCHIVES -maxdepth 1 -name '*.tar.gz' -mtime +1 -delete\"; \
    exit 1; \
  fi && \
  TS=\$(date +%Y-%m-%d_%H-%M-%S) && \
  cd /var/www && \
  tar --exclude='gmx-net.help/node_modules' \
      --exclude='gmx-net.help/data/backups' \
      --exclude='mailer/venv' \
      --exclude='mailer/__pycache__' \
      --exclude='mailer/*.ctl' \
      --exclude='mailer/*.sock' \
      -czf $BACKUP_ARCHIVES/\${TS}.tar.gz gmx-net.help mailer && \
  echo \"Бекап: \$TS.tar.gz\" && \
  find $BACKUP_ARCHIVES -maxdepth 1 -name '*.tar.gz' -mtime +3 -delete && \
  echo \"Удалены бекапы старше 3 дней\""

echo "→ gmx → $GMX_DEST (исключены: node_modules, data, .env, downloads, login/.venv, login/cookies)"
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'downloads' \
  --exclude 'login/.venv' --exclude 'login/cookies' \
  "$GMX_SRC/" "$GMX_DEST"

if [ -d "$SPAM_SRC" ]; then
  echo "→ mailer → $MAILER_DEST"
  rsync -avz --delete -e "$RSYNC_SSH" \
    --exclude 'configs' --exclude 'uploads' --exclude 'venv' --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' \
    "$SPAM_SRC/" "$MAILER_DEST"
  RESTART_MAILER=' && cd /var/www/mailer && pm2 restart mailer'
else
  echo "→ mailer: пропуск (нет каталога $SPAM_SRC, задайте SPAM_SRC при необходимости)"
  RESTART_MAILER=''
fi

echo ""
echo "→ перезапуск на сервере..."
ssh "${SSH_OPTS[@]}" "$HOST" "cd /var/www/gmx-net.help && npm install && pm2 restart gmx-net${RESTART_MAILER} && pm2 save"
echo "→ очистка старых бэкапов и ротация логов на сервере..."
ssh "${SSH_OPTS[@]}" "$HOST" "cd /var/www/gmx-net.help && node scripts/cleanup-backups.js --keep-days=30 --keep-count=50 --debug-log-max-mb=10 --all-log-max-mb=50"
echo "Готово."
