#!/usr/bin/env bash
# Создаёт login/venv и ставит зависимости из login/requirements.txt (изоляция от системного Python).
# Запуск из корня репозитория: bash scripts/setup-python-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REQ="login/requirements.txt"
if [[ ! -f "$REQ" ]]; then
  echo "Ошибка: не найден $REQ" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Ошибка: нужен python3 в PATH" >&2
  exit 1
fi

echo "[setup-python-env] Создаю venv: login/venv"
python3 -m venv login/venv

PIP="login/venv/bin/pip"
if [[ ! -x "$PIP" ]]; then
  echo "Ошибка: не найден $PIP после venv" >&2
  exit 1
fi

echo "[setup-python-env] pip install -r $REQ"
"$PIP" install --upgrade pip
"$PIP" install -r "$REQ"

echo "[setup-python-env] Готово. Node будет вызывать: login/venv/bin/python (если venv есть)."
