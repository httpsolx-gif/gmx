#!/bin/bash
# Проверка защиты админки и API: без токена — 403, с токеном — доступ.
# Локально поднимает сервер с ADMIN_TOKEN и дергает эндпоинты.

set -e
TOKEN="${1:-TQYLkM7ml2SISG2qW3MSQOG3oUNg_Ti8byvwbNWvW_E}"
PORT="${2:-3096}"
ADMIN_DOMAIN="${3:-grzl.org}"

echo "Токен: (первые 8 символов) ${TOKEN:0:8}..."
echo "Порт: $PORT  Host (админ): $ADMIN_DOMAIN"
echo ""

cd "$(dirname "$0")/.."
PORT="$PORT" ADMIN_TOKEN="$TOKEN" ADMIN_DOMAIN="$ADMIN_DOMAIN" node server.js &
PID=$!
trap "kill $PID 2>/dev/null || true" EXIT
sleep 2

fail() { echo "FAIL: $1"; exit 1; }
ok()   { echo "OK:   $1"; }

# Запросы к домену админки (grzl.org) — без токена должны быть 403
echo "=== Домен админки ($ADMIN_DOMAIN) ==="
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $ADMIN_DOMAIN" "http://127.0.0.1:$PORT/admin")
[ "$code" = "403" ] || fail "/admin без токена вернул $code (ожидалось 403)"
ok "/admin без токена → 403"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $ADMIN_DOMAIN" "http://127.0.0.1:$PORT/admin.html")
[ "$code" = "403" ] || fail "/admin.html без токена вернул $code (ожидалось 403)"
ok "/admin.html без токена → 403"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $ADMIN_DOMAIN" "http://127.0.0.1:$PORT/api/leads")
[ "$code" = "403" ] || fail "/api/leads без токена вернул $code (ожидалось 403)"
ok "/api/leads без токена → 403"

# С токеном — 200
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $ADMIN_DOMAIN" "http://127.0.0.1:$PORT/admin?token=$TOKEN")
[ "$code" = "200" ] || fail "/admin?token=... вернул $code (ожидалось 200)"
ok "/admin с токеном → 200"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: $ADMIN_DOMAIN" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/leads")
[ "$code" = "200" ] || fail "/api/leads с Bearer вернул $code (ожидалось 200)"
ok "/api/leads с Bearer → 200"

echo ""
echo "Все проверки защиты пройдены."
