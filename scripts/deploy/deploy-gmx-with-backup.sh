#!/usr/bin/env bash
# Деплой только gmx: бекап на сервере (3 дня) → rsync → npm install → pm2 restart.
# Без mailer. Путь и имя процесса настраиваются через переменные.

set -e
HOST="${DEPLOY_HOST:-root@166.0.150.132}"
GMX_SRC="${GMX_SRC:-/Users/greedy/Desktop/gmx}"
GMX_DEST="${GMX_DEST:-$HOST:/var/www/gmx-net.help/}"
PM2_NAME="${PM2_NAME:-gmx-net}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/gmx-deploy}"
# Только архивы — логи и прочее в BACKUP_DIR не трогаем
BACKUP_ARCHIVES="$BACKUP_DIR/archives"
# Путь на сервере (папка с server.js). Если другой — задай: GMX_PATH=/var/www/gmx
GMX_PATH="${GMX_PATH:-/var/www/gmx-net.help}"
GMX_DIRNAME="${GMX_PATH##*/}"

CONTROL_SOCK="${SSH_CONTROL_SOCK:-/tmp/ssh-deploy-$$}"
cleanup_ssh() { ssh -o ControlPath="$CONTROL_SOCK" -O exit "$HOST" 2>/dev/null || true; }
trap cleanup_ssh EXIT
ssh -o ControlMaster=yes -o ControlPath="$CONTROL_SOCK" -o ControlPersist=120 -N -f "$HOST"
SSH_OPTS=(-o "ControlPath=$CONTROL_SOCK")
RSYNC_SSH="ssh ${SSH_OPTS[*]}"

echo "→ бекап на сервере ($BACKUP_ARCHIVES, храним 3 дня)..."
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p $BACKUP_ARCHIVES && \
  AVAIL=\$(df -m $BACKUP_ARCHIVES | awk 'NR==2 {print \$4}'); \
  if [ \"\${AVAIL:-0}\" -lt 300 ]; then \
    echo \"ОШИБКА: мало места на диске для бекапа (свободно \${AVAIL}MB). Освободите место или удалите старые архивы:\"; \
    echo \"  find $BACKUP_ARCHIVES -maxdepth 1 -name '*.tar.gz' -mtime +1 -delete\"; \
    exit 1; \
  fi && \
  TS=\$(date +%Y-%m-%d_%H-%M-%S) && \
  cd ${GMX_PATH%/*} && \
  tar --exclude='$GMX_DIRNAME/node_modules' -czf $BACKUP_ARCHIVES/\${TS}-gmx.tar.gz $GMX_DIRNAME && \
  echo \"Бекап: \${TS}-gmx.tar.gz\" && \
  find $BACKUP_ARCHIVES -maxdepth 1 -name '*-gmx.tar.gz' -mtime +3 -delete && \
  echo \"Удалены бекапы старше 3 дней\""

echo "→ gmx → $GMX_DEST (исключены: node_modules, data, .env, downloads, login/.venv, login/cookies)"
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'downloads' \
  --exclude 'login/.venv' --exclude 'login/cookies' \
  "$GMX_SRC/" "$GMX_DEST"

echo "→ перезапуск на сервере..."
ssh "${SSH_OPTS[@]}" "$HOST" "cd $GMX_PATH && npm install && pm2 restart $PM2_NAME && pm2 save"
echo "→ очистка старых бэкапов и ротация логов на сервере..."
ssh "${SSH_OPTS[@]}" "$HOST" "cd $GMX_PATH && node scripts/cleanup-backups.js --keep-days=30 --keep-count=50 --debug-log-max-mb=10 --all-log-max-mb=50"
echo "Готово."
echo "Бекапы: ssh $HOST \"ls -la $BACKUP_ARCHIVES\""
#
# Использование:
#   ./deploy/deploy-gmx-with-backup.sh
# С другими хостом/путём:
#   DEPLOY_HOST=root@1.2.3.4 GMX_DEST=root@1.2.3.4:/var/www/gmx/ GMX_PATH=/var/www/gmx PM2_NAME=gmx ./deploy/deploy-gmx-with-backup.sh
# Чтобы логи PM2 не забивали диск: на сервере один раз: sudo cp deploy/logrotate-pm2.conf /etc/logrotate.d/pm2
