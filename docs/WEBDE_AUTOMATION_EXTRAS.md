# WEB.DE автовход: прокси по стране, Sec-CH-UA, единый API, healthcheck

## 1. Прокси «как у лида» (`login/proxy.txt`)

- При телеметрии сервер пишет **`lead.ipCountry`** из **`cf-ipcountry`** (2 буквы, например `TH`, `DE`).
- В `proxy.txt` можно помечать строку **ISO2 + таб или `|`** перед прокси:
  - `DE	host:port:user:pass`
  - `TH|http://user:pass@host:port`
- Строки **без** префикса идут после гео-совпадений (как раньше).
- `lead_simulation_api.py` сортирует: сначала прокси с той же страной, что у лида.

## 2. Sec-CH-UA в Playwright

- В **`lib/automationProfile.js`** из последнего `requestMeta` в блок `playwright` попадают **`secChUa`**, **`secChUaMobile`**, **`secChUaPlatform`** (если были в запросе).
- **`webde_login.py`** добавляет их в **`extra_http_headers`** только для **Chromium** (и после fallback WebKit→Chromium).

## 3. Один запрос API

`GET /api/lead-login-context?leadId=<id>`  
Ответ: `{ ok, leadId, email, password, profile, ipCountry? }`  
Сборка: **`lib/leadLoginContext.js`**.

Старые эндпоинты **`/api/lead-credentials`** и **`/api/lead-automation-profile`** сохранены.

## 4. Fallback WebKit / Firefox

- Если **`webkit.launch`** или **`firefox.launch`** падает (нет `install-deps` и т.д.), в лог пишется причина и запускается **Chromium** с тем же **User-Agent** из профиля.

## 5. Мониторинг вёрстки auth.web.de

- Скрипт: **`login/webde_layout_healthcheck.py`** — проверяет наличие поля email теми же селекторами, что шаг 1 входа.
- Вручную: `python3 login/webde_layout_healthcheck.py` (exit 1 при поломке).
- На **Node-сервере**: переменная **`WEBDE_LAYOUT_HEALTH_INTERVAL_MS`** (например `3600000`) — периодический запуск из **`lib/webdeLayoutHealthScheduler.js`** после старта сервера.  
  Бинарник Python: **`PYTHON_BIN`** (по умолчанию `python3`).

## Проверка «всё ли подтянулось с лида»

См. **`docs/VERIFY_LEAD_AUTOMATION.md`** и скрипт **`login/verify_lead_automation.py`**.  
Там же — описание формата логов **в терминале** (`поток | попытка | email: …`), не в UI админки.

## Переменные окружения (кратко)

| Переменная | Назначение |
|------------|------------|
| `WEBDE_LAYOUT_HEALTH_INTERVAL_MS` | Интервал healthcheck в мс (≥ 60000), иначе отключено |
| `PYTHON_BIN` | Путь к python для healthcheck с Node |
