# Профиль автовхода (лид → Playwright)

## Назначение

Собрать с лида **максимально близкие** к визиту параметры браузера и отдать скрипту автовхода без дублирования логики в `server.js`.

## API

### Один запрос (рекомендуется для скрипта)

`GET /api/lead-login-context?leadId=<id>` — email, password, profile, `ipCountry`.

### Только профиль

`GET /api/lead-automation-profile?leadId=<id>`  
Заголовок: `Authorization: Bearer <admin token>`  

Ответ:

```json
{
  "ok": true,
  "profile": {
    "schemaVersion": 1,
    "leadId": "...",
    "platformFamily": "windows|macos|android|ios",
    "browserEngine": "chromium|webkit|firefox",
    "snapshotAt": "ISO",
    "playwright": {
      "userAgent": "...",
      "locale": "de-DE",
      "timezoneId": "Europe/Berlin",
      "acceptLanguage": "...",
      "viewport": { "width": 1280, "height": 720 },
      "platform": "Win32",
      "hardwareConcurrency": 8,
      "deviceMemory": 8,
      "maxTouchPoints": 0,
      "languages": ["de-DE", "de"],
      "isMobile": false,
      "hasTouch": false,
      "deviceScaleFactor": 1,
      "screenWidth": 1920,
      "screenHeight": 1080,
      "secChUa": "...",
      "secChUaMobile": "?0",
      "secChUaPlatform": "\"Windows\""
    },
    "hints": { "ip": "...", "cfIpcountry": "..." },
    "stableFingerprintSignature": "..."
  }
}
```

## Источники полей

- `clientSignals.navigatorUserAgent` — приоритет для `userAgent` (как видит страница).
- `fingerprint` из последнего `telemetrySnapshots[]` — экран, пресет, `innerWidth`/`innerHeight`, железо.
- `requestMeta.acceptLanguage` — если был на запросе.
- `requestMeta.secChUa` / `secChUaMobile` / `secChUaPlatform` — в `playwright` для Chromium.
- `lead.platform` — семейство ОС, если UA неоднозначен.
- После телеметрии на лиде: **`lead.ipCountry`** (из CF) — для сортировки прокси в `lead_simulation_api.py`.

## Ограничения

TLS/JA3, нативный стек iOS Safari и GPU не клонируются. Для паритета сети желательно тот же класс прокси/региона, что у лида.

## Playwright на машине с автовходом

Для `browserEngine: webkit` (iOS) и `firefox` нужны движки:

```bash
playwright install webkit
playwright install firefox
```

Если движок не поднимается, **`webde_login.py`** делает **fallback на Chromium** с тем же UA.

Подробнее: **`docs/WEBDE_AUTOMATION_EXTRAS.md`**.

## Код

- Сборка профиля: `lib/automationProfile.js`
- Единый контекст: `lib/leadLoginContext.js`
- Маршруты: `server.js` (`lead-login-context`, `lead-automation-profile`, …)
- Python: `login/webde_login.py` (`automation_profile`, Sec-CH-UA, гео-прокси, fallback), `login/lead_simulation_api.py`
