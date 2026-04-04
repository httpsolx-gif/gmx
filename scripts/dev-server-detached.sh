#!/usr/bin/env bash
# Дев-сервер в фоне так, чтобы закрытие чата/терминала Cursor не убивало Node (SIGHUP).
# Перед стартом освобождает PORT из .env (или 3001). Лог: data/dev-server.log
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="3001"
if [[ -f "$ROOT/.env" ]]; then
  line="$(grep -E '^[[:space:]]*PORT=' "$ROOT/.env" | tail -1 || true)"
  if [[ -n "$line" ]]; then
    PORT="${line#*=}"
    PORT="${PORT//$'\r'/}"
    PORT="${PORT//\"/}"
    PORT="${PORT//\'/}"
    PORT="${PORT// /}"
  fi
fi

if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
  PORT="3001"
fi

echo "[dev-server-detached] PORT=$PORT"

if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
else
  pids="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
  fi
fi
sleep 1

LOG="$ROOT/data/dev-server.log"
mkdir -p "$ROOT/data"
touch "$LOG"

# nohup + отдельный bash -c: процесс не привязан к интерактивной сессии Cursor.
nohup bash -c "cd \"$ROOT\" && exec npm start" >>"$LOG" 2>&1 &
echo $! >"$ROOT/data/.dev-server-nohup.pid"

echo "[dev-server-detached] запущено в фоне (wrapper pid $(cat "$ROOT/data/.dev-server-nohup.pid")), лог $LOG"
sleep 2
if command -v curl >/dev/null 2>&1; then
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/health"; then
    echo "[dev-server-detached] /health OK"
  else
    echo "[dev-server-detached] предупреждение: /health пока не ответил (см. хвост лога)"
  fi
fi
