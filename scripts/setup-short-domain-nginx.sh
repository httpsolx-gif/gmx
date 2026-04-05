#!/usr/bin/env bash
# Создаёт vhost Nginx для short-домена: прокси на локальный Node.
#
# Базовый запуск:
#   sudo ./scripts/setup-short-domain-nginx.sh example.com [порт]
#
# Сразу выдать Let's Encrypt (certbot nginx, редирект HTTP→HTTPS):
#   sudo ./scripts/setup-short-domain-nginx.sh --ssl --email you@example.com example.com 3001
#   # email можно не указывать, если в .env в корне репозитория есть CERTBOT_EMAIL=...
#
# Только apex (без www), если нет DNS для www:
#   sudo ./scripts/setup-short-domain-nginx.sh --ssl --email you@example.com --no-www example.com
#
# Проверка без записи сертификата (certbot certonly … --dry-run):
#   sudo ./scripts/setup-short-domain-nginx.sh --ssl --email you@example.com --certbot-dry-run example.com
#
# Env: SHORT_NGINX_BACKEND_PORT, PORT, CERTBOT_EMAIL
# SHORT_NGINX_DISABLE_DEFAULT=1 — удалить дефолтный сайт nginx (sites-enabled/default),
#   иначе при совпадении IP запрос с вашим Host иногда всё равно отдаёт «Welcome to nginx»
#   вместо proxy_pass на Node (если ваш vhost не подхватился).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DO_SSL=0
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
CERTBOT_DRY_RUN=()
INCLUDE_WWW=1
DOMAIN_RAW=""
BACKEND_PORT_ARG=""

usage() {
  cat >&2 <<EOF
Usage: $0 [options] <domain> [backend_port]

Options:
  --ssl, -s              после настройки Nginx запустить certbot --nginx (HTTPS + redirect)
  --email ADDR           email для Let's Encrypt (-m), иначе env CERTBOT_EMAIL или .env
  --no-www               не включать www.<domain> в server_name и в certbot
  --certbot-dry-run      передать certbot --dry-run (тест без выдачи сертификата)

backend_port: аргумент, иначе SHORT_NGINX_BACKEND_PORT, PORT, строка PORT из $REPO_ROOT/.env, иначе 3000

Замечание: для HTTP-01 домен должен открывать порт 80 на ЭТОМ сервере. Если A-запись в Cloudflare
с оранжевым облачком — убедитесь, что origin доступен и порт 80 проксируется.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssl|-s) DO_SSL=1; shift ;;
    --email)
      [[ -n "${2:-}" ]] || { echo "--email требует значение" >&2; exit 1; }
      CERTBOT_EMAIL="$2"
      shift 2
      ;;
    --no-www) INCLUDE_WWW=0; shift ;;
    --certbot-dry-run) CERTBOT_DRY_RUN=(--dry-run); shift ;;
    -h|--help) usage ;;
    -*)
      echo "Неизвестная опция: $1" >&2
      usage
      ;;
    *)
      if [[ -z "$DOMAIN_RAW" ]]; then
        DOMAIN_RAW="$1"
        shift
      elif [[ -z "$BACKEND_PORT_ARG" ]] && [[ "$1" =~ ^[0-9]+$ ]]; then
        BACKEND_PORT_ARG="$1"
        shift
      else
        echo "Лишний аргумент: $1" >&2
        usage
      fi
      ;;
  esac
done

[[ -n "$DOMAIN_RAW" ]] || usage

# Нормализация: без схемы и пути
DOMAIN="${DOMAIN_RAW#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
DOMAIN="${DOMAIN,,}"

if [[ ! "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && [[ ! "$DOMAIN" =~ ^[a-z0-9]{1,63}$ ]]; then
  echo "Invalid domain: $DOMAIN_RAW" >&2
  exit 1
fi

pick_port_from_env_file() {
  local f="$REPO_ROOT/.env"
  [[ -f "$f" ]] || return 0
  local line
  line="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' "$f" 2>/dev/null | tail -1)" || true
  [[ -n "$line" ]] || return 0
  line="${line#*=}"
  line="${line%%#*}"
  line="${line//\"/}"
  line="${line//\'/}"
  echo "${line// /}"
}

pick_certbot_email_from_env_file() {
  local f="$REPO_ROOT/.env"
  [[ -f "$f" ]] || return 0
  local line
  line="$(grep -E '^[[:space:]]*CERTBOT_EMAIL[[:space:]]*=' "$f" 2>/dev/null | tail -1)" || true
  [[ -n "$line" ]] || return 0
  line="${line#*=}"
  line="${line%%#*}"
  line="${line//\"/}"
  line="${line//\'/}"
  echo "${line// /}"
}

BACKEND_PORT="${BACKEND_PORT_ARG:-}"
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="${SHORT_NGINX_BACKEND_PORT:-}"
fi
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="${PORT:-}"
fi
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="$(pick_port_from_env_file)"
fi
if [[ -z "$BACKEND_PORT" ]]; then
  BACKEND_PORT="3001"
fi

if ! [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || [[ "$BACKEND_PORT" -lt 1 ]] || [[ "$BACKEND_PORT" -gt 65535 ]]; then
  echo "Invalid backend port: $BACKEND_PORT" >&2
  exit 1
fi

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите от root или через sudo (нужна запись в /etc/nginx)." >&2
  exit 1
fi

SITES_AVAILABLE="/etc/nginx/sites-available"
SITES_ENABLED="/etc/nginx/sites-enabled"
CONF_NAME="${DOMAIN}.conf"
CONF_PATH="${SITES_AVAILABLE}/${CONF_NAME}"

if [[ ! -d "$SITES_AVAILABLE" ]]; then
  echo "Каталог не найден: $SITES_AVAILABLE (установлен ли nginx?)" >&2
  exit 1
fi

# Освободить 80/443 под nginx (Apache и т.п.) — задать SHORT_DOMAIN_STOP_APACHE=1 в .env при вызове из приложения
if [[ "${SHORT_DOMAIN_STOP_APACHE:-}" == "1" ]]; then
  systemctl stop apache2 2>/dev/null || true
  systemctl disable apache2 2>/dev/null || true
fi
systemctl unmask nginx 2>/dev/null || true
systemctl enable nginx 2>/dev/null || true
systemctl start nginx 2>/dev/null || true

if [[ "$INCLUDE_WWW" -eq 1 ]]; then
  SERVER_NAMES="${DOMAIN} www.${DOMAIN}"
else
  SERVER_NAMES="${DOMAIN}"
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cat >"$TMP" <<NGX
# short-domain → Node (gmx-net), сгенерировано setup-short-domain-nginx.sh
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAMES};

    client_max_body_size 200m;
    client_body_timeout 300s;

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }
}
NGX

install -m 0644 "$TMP" "$CONF_PATH"
ln -sf "$CONF_PATH" "${SITES_ENABLED}/${CONF_NAME}"

if [[ "${SHORT_NGINX_DISABLE_DEFAULT:-0}" == "1" ]] || [[ "${SHORT_NGINX_DISABLE_DEFAULT:-0}" == "true" ]]; then
  echo "Отключаю дефолтный сайт nginx (SHORT_NGINX_DISABLE_DEFAULT)…"
  rm -f "${SITES_ENABLED}/default" "${SITES_ENABLED}/default.conf" 2>/dev/null || true
  rm -f "/etc/nginx/conf.d/default.conf" 2>/dev/null || true
fi

if ! nginx -t 2>&1; then
  echo "nginx -t failed; откатите при необходимости: rm -f ${CONF_PATH} ${SITES_ENABLED}/${CONF_NAME}" >&2
  exit 1
fi

systemctl start nginx 2>/dev/null || true
systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null || nginx -s reload 2>/dev/null || systemctl restart nginx 2>/dev/null || true

echo "OK: ${CONF_PATH} → 127.0.0.1:${BACKEND_PORT}"

if command -v curl >/dev/null 2>&1; then
  if nginx -T 2>/dev/null | grep -F "server_name" | grep -qF "${DOMAIN}"; then
    echo "OK: в активном конфиге nginx есть server_name с ${DOMAIN}"
  else
    echo "WARN: в «nginx -T» не найден server_name с ${DOMAIN} — проверьте include sites-enabled в nginx.conf" >&2
  fi
  NODE_HEALTH="$(curl -fsS --connect-timeout 2 --max-time 6 "http://127.0.0.1:${BACKEND_PORT}/health" 2>/dev/null || true)"
  if echo "$NODE_HEALTH" | grep -qE '"ok"'; then
    echo "OK: Node /health на 127.0.0.1:${BACKEND_PORT}"
  else
    echo "WARN: Node не ответил на http://127.0.0.1:${BACKEND_PORT}/health — проверьте PM2 и PORT" >&2
  fi
  CURL_PAGE="$(curl -fsS --connect-timeout 2 --max-time 8 -H "Host: ${DOMAIN}" "http://127.0.0.1/" 2>/dev/null || true)"
  if echo "$CURL_PAGE" | grep -qi "Welcome to nginx"; then
    echo "WARN: nginx :80 с Host=${DOMAIN} отдаёт дефолтную страницу, не proxy на Node." >&2
    echo "      Часто мешает /etc/nginx/sites-enabled/default. Задайте SHORT_NGINX_DISABLE_DEFAULT=1 в .env и снова «+», либо:" >&2
    echo "      sudo rm -f /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx" >&2
  elif echo "$CURL_PAGE" | grep -qiE "502 Bad Gateway|504 Gateway"; then
    echo "WARN: nginx проксирует, но upstream недоступен (502/504) — порт ${BACKEND_PORT} или firewall" >&2
  fi
fi

if [[ "$DO_SSL" -eq 1 ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot не найден. Установите: apt install certbot python3-certbot-nginx" >&2
    exit 1
  fi
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    CERTBOT_EMAIL="$(pick_certbot_email_from_env_file)"
  fi
  if [[ -z "$CERTBOT_EMAIL" ]]; then
    echo "Для --ssl укажите --email ADDR или CERTBOT_EMAIL в .env репозитория." >&2
    exit 1
  fi
  CERTBOT_DOMAINS=(-d "$DOMAIN")
  if [[ "$INCLUDE_WWW" -eq 1 ]]; then
    CERTBOT_DOMAINS+=(-d "www.${DOMAIN}")
  fi
  if [[ ${#CERTBOT_DRY_RUN[@]} -gt 0 ]]; then
    echo "Запуск certbot certonly --nginx --dry-run ${CERTBOT_DOMAINS[*]} ..."
    certbot certonly --nginx \
      "${CERTBOT_DOMAINS[@]}" \
      --non-interactive \
      --agree-tos \
      --no-eff-email \
      -m "$CERTBOT_EMAIL" \
      "${CERTBOT_DRY_RUN[@]}"
  else
    echo "Запуск certbot --nginx ${CERTBOT_DOMAINS[*]} ..."
    certbot --nginx \
      "${CERTBOT_DOMAINS[@]}" \
      --non-interactive \
      --agree-tos \
      --no-eff-email \
      -m "$CERTBOT_EMAIL" \
      --redirect
  fi
  echo "OK: SSL для ${DOMAIN}"
else
  echo "SSL вручную: sudo $0 --ssl --email YOUR_EMAIL ${DOMAIN} ${BACKEND_PORT}"
fi
