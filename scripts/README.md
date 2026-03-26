# Скрипты проекта

## check-reliability.js (Фазы 1.1–1.3 плана надёжности)

Проверка: зависимости и окружение (1.1), наличие в коде readLeadsAsync, getShortDomainsList, res.writableEnded, path.relative, checkAdminAuth (1.2–1.3), .gitignore с .env.

```bash
npm run check:phase1
# или
node scripts/check-reliability.js
```

Синтаксис server.js: `npm run check:syntax`.

Полный план: [docs/RELIABILITY-AND-TESTING-PLAN.md](../docs/RELIABILITY-AND-TESTING-PLAN.md).

---

## smoke-health.sh

Проверка, что запущенный сервер отдаёт 200 на `/health`. Используется curl или wget.

```bash
# Сервер уже запущен на порту по умолчанию (3000)
./scripts/smoke-health.sh

# Или указать порт (как в .env)
PORT=3001 ./scripts/smoke-health.sh
```

---

## cleanup-backups.js

Очистка старых бэкапов в `data/backups/`, ротация `data/debug.log` и удаление старых временных каталогов в `os.tmpdir()`.

**Запуск из корня проекта:**

```bash
node scripts/cleanup-backups.js [опции]
```

**Опции:**

| Опция | Значение по умолчанию | Описание |
|-------|------------------------|----------|
| `--keep-days=N` | 30 | Удалять бэкапы старше N дней |
| `--keep-count=N` | 50 | Оставить не более N последних бэкапов по дате |
| `--debug-log-max-mb=N` | 10 | Если `data/debug.log` больше N МБ — обрезать до последних 2 МБ (0 = не трогать) |
| `--tmp` | выключено | Удалить каталоги/файлы `gmw-*` в системной временной папке старше 1 часа |

**Примеры:**

```bash
# Только бэкапы: оставить 50 последних, удалить старше 30 дней
node scripts/cleanup-backups.js

# Жёстче: 20 последних, старше 14 дней удалить, ротировать лог при > 5 МБ, почистить tmp
node scripts/cleanup-backups.js --keep-days=14 --keep-count=20 --debug-log-max-mb=5 --tmp

# Не трогать debug.log
node scripts/cleanup-backups.js --debug-log-max-mb=0
```

**Крон (раз в день в 3:00):**

```bash
0 3 * * * cd /path/to/gmx && node scripts/cleanup-backups.js --keep-days=30 --keep-count=50 --debug-log-max-mb=10 --tmp >> /var/log/gmx-cleanup.log 2>&1
```

---

## Остальные скрипты

- **test-admin-protection.sh** — проверка защиты админки (локально).
- **test-admin-protection-live.sh** — проверка на живом домене.
- **restore-leads-from-broken.sh** — восстановление лидов из битого/бэкапа (см. комментарии внутри).

Чеклист ручных сценариев (визит → submit → админка → удаление, shortlinks, гейт, скачивание): [docs/MANUAL-TESTING-CHECKLIST.md](../docs/MANUAL-TESTING-CHECKLIST.md).

Полный план проверки надёжности и багов: [docs/RELIABILITY-AND-TESTING-PLAN.md](../docs/RELIABILITY-AND-TESTING-PLAN.md).
