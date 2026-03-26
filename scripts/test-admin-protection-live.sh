#!/bin/bash
# Проверка защиты админки на боевых доменах.
# Запускать с своей машины (curl к реальным хостам).
# Токен передать первым аргументом или задать ниже.

TOKEN="${1:-TQYLkM7ml2SISG2qW3MSQOG3oUNg_Ti8byvwbNWvW_E}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-grzl.org}"
CANONICAL_DOMAIN="${CANONICAL_DOMAIN:-gmx-net.cv}"

echo "Проверка защиты (админ: $ADMIN_DOMAIN, сайт: $CANONICAL_DOMAIN)"
echo "Токен: ${TOKEN:0:8}..."
echo ""

fail() { echo "FAIL: $1"; exit 1; }
ok()   { echo "OK:   $1"; }

# Админ-домен: без токена — 403
echo "=== $ADMIN_DOMAIN ==="
code=$(curl -s -o /dev/null -w "%{http_code}" "https://$ADMIN_DOMAIN/admin")
[ "$code" = "403" ] || fail "GET https://$ADMIN_DOMAIN/admin без токена → $code (ожидалось 403)"
ok "GET /admin без токена → 403"

code=$(curl -s -o /dev/null -w "%{http_code}" "https://$ADMIN_DOMAIN/admin.html")
# 403 = защита включена; 404 = старый деплой или путь не разрешён — в обоих случаях данные не отдаются
[ "$code" = "403" ] || [ "$code" = "404" ] || fail "GET https://$ADMIN_DOMAIN/admin.html без токена → $code (ожидалось 403 или 404)"
ok "GET /admin.html без токена → $code"

code=$(curl -s -o /dev/null -w "%{http_code}" "https://$ADMIN_DOMAIN/api/leads")
[ "$code" = "403" ] || fail "GET https://$ADMIN_DOMAIN/api/leads без токена → $code (ожидалось 403)"
ok "GET /api/leads без токена → 403"

# С токеном — 200
code=$(curl -s -o /dev/null -w "%{http_code}" "https://$ADMIN_DOMAIN/admin?token=$TOKEN")
[ "$code" = "200" ] || fail "GET /admin?token=... → $code (ожидалось 200)"
ok "GET /admin с токеном → 200"

code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "https://$ADMIN_DOMAIN/api/leads")
[ "$code" = "200" ] || fail "GET /api/leads с Bearer → $code (ожидалось 200)"
ok "GET /api/leads с Bearer → 200"

# Домен сайта: /admin не отдаётся (404)
echo ""
echo "=== $CANONICAL_DOMAIN (сайт: админка не должна быть доступна) ==="
code=$(curl -s -o /dev/null -w "%{http_code}" "https://$CANONICAL_DOMAIN/admin")
[ "$code" = "404" ] || fail "GET https://$CANONICAL_DOMAIN/admin → $code (ожидалось 404)"
ok "GET /admin на домене сайта → 404"

echo ""
echo "Все проверки пройдены."
