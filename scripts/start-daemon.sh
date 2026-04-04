#!/usr/bin/env bash
set -euo pipefail

APP_NAME="gmx-net"
ECOSYSTEM_FILE="ecosystem.config.cjs"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 не найден. Установите: npm i -g pm2"
  exit 1
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start "$ECOSYSTEM_FILE" --only "$APP_NAME" --update-env
fi

pm2 save
echo "OK: $APP_NAME запущен как daemon через PM2."
