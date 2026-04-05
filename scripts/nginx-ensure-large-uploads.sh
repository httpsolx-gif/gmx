#!/usr/bin/env bash
# Однократно на сервере: поднять лимит тела POST для всех vhost (админка CONFIG → ZIP).
# По умолчанию nginx — 1m → 413 на больших multipart. Запуск: sudo bash scripts/nginx-ensure-large-uploads.sh
set -euo pipefail
NGINX_CONF="${NGINX_CONF:-/etc/nginx/nginx.conf}"
MARKER="# gmw-large-uploads (scripts/nginx-ensure-large-uploads.sh)"
if [[ ! -f "$NGINX_CONF" ]]; then
  echo "Нет файла: $NGINX_CONF" >&2
  exit 1
fi
if grep -qF "$MARKER" "$NGINX_CONF" 2>/dev/null; then
  echo "OK: маркер уже есть в $NGINX_CONF — пропуск вставки."
else
  TMP="$(mktemp)"
  awk -v m="$MARKER" '
    { print }
    /^http[[:space:]]*\{/ && !done {
      print ""; print "\t" m; print "\tclient_max_body_size 200m;"; print "\tclient_body_timeout 300s;"; print "";
      done=1
    }
  ' "$NGINX_CONF" >"$TMP"
  cp -a "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
  mv "$TMP" "$NGINX_CONF"
  echo "Добавлены client_max_body_size 200m в http { } в $NGINX_CONF (бэкап рядом)."
fi
nginx -t
systemctl reload nginx 2>/dev/null || nginx -s reload
echo "OK: nginx перезагружен."
