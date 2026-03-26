# Транспорт: JA3 / TLS / HTTP2 и прокси

## Зачем

В процессе **Node.js**, который принимает уже **расшифрованный** HTTP за reverse proxy (nginx, Caddy, Cloudflare), **нельзя** вычислить настоящий **JA3/JA4** или полный **fingerprint HTTP/2** клиентского TLS — TLS завершается на прокси.

Поэтому приложение:

1. **Читает опциональные заголовки**, которые прокси сам добавляет (JA3, bot score, cipher и т.д.) — см. `TRANSPORT_PROXY_HEADER_MAP` в `server.js`.
2. **Сравнивает** `User-Agent`, `Sec-CH-UA` и `fingerprint.userAgent` из JSON тела — см. `analyzeTransportUaConsistency` в `server.js`.
3. **Пишет** в `requestMeta` поля `transportFromProxy`, `transportUaConsistency`, `inboundProtocol` (что реально видит Node до прокси).

## План внедрения на инфраструктуре

### 1. Cloudflare (перед origin)

- Включите **Bot Management** / аналоги — в запрос к origin могут попадать заголовки вроде **`cf-bot-score`** (зависит от тарифа и настроек).
- **JA3** в стандартный запрос к origin Cloudflare **не всегда** отдаёт одним стабильным заголовком; уточняйте в документации CF для вашего плана. Если доступен Workers / логирование на edge — можно прокинуть свой заголовок, например **`X-JA3-Fingerprint`**, в origin.
- Убедитесь, что **не вырезаются** `Sec-CH-UA*`, `Sec-Fetch-*` (для согласованности в `transportUaConsistency`).

### 2. nginx (терминация TLS)

- Соберите nginx с модулем **JA3** (например, `ngx_http_ssl_ja3_module` или аналог вашей сборки) **или** используйте **OpenResty**/сторонний WAF, который умеет считать JA3.
- В `location` к upstream на Node добавьте, например:

```nginx
proxy_set_header X-JA3-Fingerprint $ssl_ja3_hash;  # имя переменной зависит от модуля
proxy_set_header X-Forwarded-Proto $scheme;
```

- Имена заголовков должны совпадать с теми, что перечислены в `TRANSPORT_PROXY_HEADER_MAP`, **или** добавьте свою пару в код.

### 3. Caddy

- Аналогично: плагины / `reverse_proxy` с переменными TLS; пробросьте хэш ClientHello в **`X-TLS-Client-Hello-Hash`** или **`X-JA3-Fingerprint`** (как договоритесь).

### 4. HTTP/2 fingerprint

- Если прокси умеет вычислять отпечаток SETTINGS/priority (как в исследованиях по h2), пробросьте строку в один из заголовков: **`X-H2-Fingerprint`**, **`X-HTTP2-Fingerprint`** — они уже учтены в маппинге.

### 5. Проверка

- После настройки сделайте запрос с браузера и с `curl` к `/api/submit` (или любому пути, где вызывается `applyLeadTelemetry`).
- В админке откройте **иконку ОС** у лида: в **`requestMeta`** должны появиться **`transportFromProxy`** и при необходимости предупреждения в **`transportUaConsistency.warnings`**.

## Ограничения

- **Согласованность TLS ↔ UA** в полном смысле (как у крупных антифродов) требует **базы эталонных JA3** по версиям браузеров; здесь только **заголовки от прокси + эвристики по HTTP**.
- **`inboundProtocol`** у соединения Node→nginx чаще всего **HTTP/1.1**, даже если клиент к CDN был на HTTP/2 — это ожидаемо.
