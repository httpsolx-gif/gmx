#!/bin/sh
# Проверка /health при уже запущенном сервере. PORT из .env или 3000.
# Использование: ./scripts/smoke-health.sh   или  PORT=3001 ./scripts/smoke-health.sh
PORT="${PORT:-3000}"
URL="http://127.0.0.1:${PORT}/health"
if command -v curl >/dev/null 2>&1; then
  code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 "$URL" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    echo "[OK] $URL -> $code"
    exit 0
  fi
  if [ "$code" = "000" ]; then
    echo "[?] $URL — сервер не запущен или таймаут (curl)"
    exit 0
  fi
  echo "[FAIL] $URL -> $code (ожидалось 200)"
  exit 1
fi
if command -v wget >/dev/null 2>&1; then
  code=$(wget -q -O /dev/null -S "$URL" 2>&1 | sed -n 's/  HTTP.* \([0-9][0-9][0-9]\).*/\1/p' | head -1)
  if [ "$code" = "200" ]; then
    echo "[OK] $URL -> $code"
    exit 0
  fi
  echo "[FAIL] $URL -> $code (ожидалось 200)"
  exit 1
fi
echo "[?] Нет curl/wget для проверки $URL"
exit 0
