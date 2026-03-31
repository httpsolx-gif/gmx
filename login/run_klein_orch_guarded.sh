#!/usr/bin/env bash
# Пречек Klein (klein_ip_probe), затем lead_simulation_api --klein-orchestration.
#
# Важно: пречек открывает Klein ДО входа WEB.DE в этом же запуске. Оркестрация открывает Klein ② ПОСЛЕ
# длительной сессии auth.web.de + web.de + фильтры на том же прокси. У Klein/антибота решение может
# отличаться (второй заход, корреляция с WEB.DE, лимиты) — пречек «OK» не гарантирует шаг ②.
# fp: по умолч. KLEIN_PROBE_FP_INDEX=0; в логе прогона смотрите «fp_index из сессии WEB.DE» и выставьте тот же индекс.
# Опционально в .env: KLEIN_IP_PROBE_FORGOT_EMAIL=emailKlein_лида — пречек введёт email и Senden (как шаг ②), ловит IP после submit.
# Из корня репозитория:  KLEIN_PROBE_FP_INDEX=0 bash login/run_klein_orch_guarded.sh [leadId]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# Не source .env — в паролях бывают & и ! (ломают bash).
if [[ -f .env ]]; then
  _ws="$(grep '^WORKER_SECRET=' .env | tail -1 | cut -d= -f2-)"
  _pt="$(grep '^PORT=' .env | tail -1 | cut -d= -f2-)"
  _probe_mail="$(grep '^KLEIN_IP_PROBE_FORGOT_EMAIL=' .env | tail -1 | cut -d= -f2-)"
  WORKER_SECRET="${WORKER_SECRET:-$_ws}"
  PORT="${PORT:-${_pt:-3002}}"
  if [[ -n "$_probe_mail" ]]; then
    export KLEIN_IP_PROBE_FORGOT_EMAIL="$_probe_mail"
  fi
fi
PORT="${PORT:-3002}"
BASE_URL="${KLEIN_PROBE_SERVER_URL:-http://127.0.0.1:${PORT}}"
LEAD_ID="${1:-mn9g6yrqbd0476puxc9}"
FP_INDEX="${KLEIN_PROBE_FP_INDEX:-0}"
HEADLESS="${HEADLESS:-1}"

if [[ -z "${WORKER_SECRET:-}" ]]; then
  echo "Нет WORKER_SECRET в окружении — задайте в .env или экспортируйте." >&2
  exit 2
fi

# Как типовой прогон: прокси из админки (не наследуем WEBDE_PROXY_FROM_ADMIN=0 из shell).
export WEBDE_PROXY_FROM_ADMIN=1

echo "=== Klein пречек (forgot-URL, fp_index=${FP_INDEX}, WEBDE_PROXY_FROM_ADMIN=${WEBDE_PROXY_FROM_ADMIN}) ===" >&2
CODE=0
HEADLESS="$HEADLESS" WEBDE_PROXY_FROM_ADMIN="$WEBDE_PROXY_FROM_ADMIN" \
  python3 login/klein_ip_probe.py \
  --fp-index "$FP_INDEX" \
  --server-url "$BASE_URL" \
  --worker-secret "$WORKER_SECRET" \
  || CODE=$?

if [[ "$CODE" -eq 10 ]]; then
  echo "Прогон не запущен: Klein блокирует IP (IP-Bereich gesperrt)." >&2
  exit 10
fi
if [[ "$CODE" -eq 11 ]]; then
  echo "Прогон не запущен: Klein/капча или WAF на странице проверки." >&2
  exit 11
fi
if [[ "$CODE" -ne 0 ]]; then
  echo "Прогон не запущен: пречек завершился с кодом $CODE (ошибка или UNKNOWN)." >&2
  exit "$CODE"
fi

echo "=== Запуск Klein-оркестрации (lead=$LEAD_ID) ===" >&2
HEADLESS="$HEADLESS" python3 -u login/lead_simulation_api.py \
  --server-url "$BASE_URL" \
  --lead-id "$LEAD_ID" \
  --worker-secret "$WORKER_SECRET" \
  --klein-orchestration
