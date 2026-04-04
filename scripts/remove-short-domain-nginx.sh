#!/usr/bin/env bash
# Полное снятие short-домена с сервера: vhost nginx + сертификат Let's Encrypt (если был).
# Запуск: sudo ./scripts/remove-short-domain-nginx.sh example.com
set -euo pipefail

DOMAIN_RAW="${1:-}"
[[ -n "$DOMAIN_RAW" ]] || { echo "Usage: $0 <domain>" >&2; exit 1; }

DOMAIN="${DOMAIN_RAW#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="${DOMAIN,,}"

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Нужен root или sudo." >&2
  exit 1
fi

CONF_NAME="${DOMAIN}.conf"
rm -f "/etc/nginx/sites-enabled/${CONF_NAME}" "/etc/nginx/sites-available/${CONF_NAME}"

if command -v certbot >/dev/null 2>&1; then
  certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || true
fi

if command -v nginx >/dev/null 2>&1; then
  if nginx -t 2>/dev/null; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
  fi
fi

echo "OK: nginx vhost и cert для ${DOMAIN} сняты."
