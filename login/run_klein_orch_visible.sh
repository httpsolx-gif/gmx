#!/usr/bin/env bash
# Полный прогон: WEB.DE → фильтры → (закрытие браузера) → emailKl → Klein сброс пароля.
# Требуется: npm start в другом терминале; в корневом .env — TEST_WEBDE_EMAIL, TEST_WEBDE_PASSWORD,
# WORKER_SECRET, PORT (как у сервера).
# Окно Chromium: HEADLESS=0 (по умолчанию в этом скрипте).
set -euo pipefail
LOGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$LOGIN_DIR"

export HEADLESS="${HEADLESS:-0}"
export PYTHONUNBUFFERED=1
# PORT и секреты читает test_klein_orch_browser_reopen_flow.py из ../.env (dotenv)

exec python3 -u test_klein_orch_browser_reopen_flow.py
