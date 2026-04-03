#!/usr/bin/env bash
# Проверка только GMX-автовхода: без lead API, без фильтров, без Klein.
# Видимый браузер + KEEP_BROWSER_OPEN (Enter в терминале после работы).
# Запускать из корня репозитория; открывает Terminal.app — не из фонового агента без TTY.
#
#   export GMX_EMAIL='user@gmx.de'
#   export GMX_PASSWORD='***'
#   export GMX_PROXY_LINE='host:port:user:pass'
#   optional: GMX_FP_INDEX=0  GMX_PROXY_TMP=/path/to/proxy.txt
#   bash login/run_gmx_visible_check.sh

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

: "${GMX_EMAIL:?Set GMX_EMAIL}"
: "${GMX_PASSWORD:?Set GMX_PASSWORD}"
: "${GMX_PROXY_LINE:?Set GMX_PROXY_LINE (host:port:user:pass)}"
FP_INDEX="${GMX_FP_INDEX:-0}"

node "$ROOT/scripts/replace-webde-fingerprint-slot.mjs" --index="$FP_INDEX"

PROXY_TMP="${GMX_PROXY_TMP:-${TMPDIR:-/tmp}/gmx_check_proxy.$$.$RANDOM.txt}"
printf '%s\n' "$GMX_PROXY_LINE" > "$PROXY_TMP"
chmod 600 "$PROXY_TMP"

PYFILE="${TMPDIR:-/tmp}/gmx_visible_run_$$.$RANDOM.py"
cat > "$PYFILE" <<'PY'
import os
from gmx_login import login_gmx, load_all_proxies_from_file
fp = int(os.environ.get("GMX_FP_INDEX") or "0")
proxies = load_all_proxies_from_file()
assert proxies, "no proxy — check PROXY_FILE"
login_gmx(headless=False, proxy_config=proxies[0], fingerprint_index=fp)
PY

RUNNER="${TMPDIR:-/tmp}/gmx_visible_login_$$.$RANDOM.sh"
{
  echo '#!/bin/bash'
  echo 'set -euo pipefail'
  printf 'cd %q\n' "$ROOT/login"
  printf 'export PROXY_FILE=%q\n' "$PROXY_TMP"
  printf 'export GMX_EMAIL=%q\n' "$GMX_EMAIL"
  printf 'export GMX_PASSWORD=%q\n' "$GMX_PASSWORD"
  echo 'export KEEP_BROWSER_OPEN=1'
  echo 'export HEADLESS=0'
  printf 'export GMX_FP_INDEX=%q\n' "$FP_INDEX"
  # Скрипт лежит в /tmp — без PYTHONPATH Python не видит пакет в login/
  printf 'export PYTHONPATH=%q\n' "$ROOT/login"
  printf 'exec python3 %q\n' "$PYFILE"
} > "$RUNNER"

chmod 700 "$RUNNER" "$PYFILE"

osascript \
  -e "tell application \"Terminal\" to do script \"$RUNNER\"" \
  -e 'tell application "Terminal" to activate'

echo "Terminal: $RUNNER | proxy: $PROXY_TMP | py: $PYFILE | fp index: $FP_INDEX"
