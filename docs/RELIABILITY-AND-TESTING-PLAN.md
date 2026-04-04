# План анализа и стабилизации проекта GMX

Документ задаёт порядок проверок и исправлений для устранения багов и непрофессиональных решений. Используется скриптом `scripts/check-reliability.js` (Фаза 1).

---

## Обзор проекта

- **Стек:** Node.js (HTTP-сервер без фреймворка), dotenv, nodemailer, ws, yauzl.
- **Роль:** приём данных с форм (email/пароль), отдача списка лидов в админку, WebSocket для обновлений, бренды GMX / WEB.DE / Kleinanzeigen, короткие ссылки, загрузки, рассылки.
- **Критичные данные:** `data/database.sqlite` (и `data/backups/*.sqlite.gz`), бэкапы, конфиги (SMTP, short domains, zip-password и т.д.). Устаревший `data/leads.json` — только для миграции/legacy-скриптов.

---

## Фаза 1: Зависимости и окружение (уже есть в check-reliability.js)

- [x] Наличие `package-lock.json`.
- [x] Зависимости в `package.json`.
- [x] `.env.example` без реальных секретов.
- [x] Наличие `.env` локально (предупреждение, если нет).
- [x] Проверки по коду: `readLeadsAsync`, `getShortDomainsList`, `res.writableEnded`, path traversal, `checkAdminAuth`, `.gitignore` для `.env`.

**Действия:** запускать `npm run check` перед коммитом/деплоем.

---

## Фаза 2: Безопасность

### 2.1 Админка и токен

- [x] **Пустой ADMIN_TOKEN:** при `ADMIN_TOKEN === ''` админка открыта без пароля. В проде это недопустимо.
  - **Сделано:** при старте сервера, если `NODE_ENV=production` и нет `ADMIN_TOKEN`, процесс выходит с ошибкой (process.exit(1)).
- [x] **Проверка домена админки:** доступ к `/admin` и API только с `ADMIN_DOMAIN` (и localhost) реализован в коде (isAdminPage/isAdminRequest + requestHost). Публичные пути не отдают админ-данные без проверки.

### 2.2 Защита от инъекций и некорректных данных

- [x] **Path traversal:** проверка есть: раздача статики — `path.relative(__dirname, filePath)`; загрузки — `findDownloadFile` отсекает `..` и `path.sep`. Пути из конфигов (download-files.json и т.д.), не из query.
- [x] **Логи:** в логах не выводятся полные email и пароли: добавлена `maskEmail()`, в `writeDebugLog` поля `*email` маскируются при записи в debug.log.
- [x] **JSON/body:** все `JSON.parse(body)` в обработчиках обёрнуты в try/catch; лимит 50 MB для POST задан (MAX_POST_BODY_BYTES).

### 2.3 Rate limit и злоупотребления

- [x] **Лимиты:** ограничения есть: visit, submit, downloadFilename, downloadGet; добавлен rate limit `configUpload` (30/15 мин) для POST `/api/config/download`, `/api/config/download-android`, `/api/config/check`, `/api/config/zip-process`.

---

## Фаза 3: Надёжность данных (race conditions и целостность)

### 3.1 Критично: readLeads / writeLeads

- [x] **Очередь записи:** введена очередь `_leadsWriteQueue`: все вызовы `writeLeads(leads)` кладутся в очередь, один воркер последовательно выполняет запись (backup + write + broadcast). Исключена одновременная запись в файл и порча данных. Логическая гонка (два запроса прочитали один и тот же state, оба записали — последняя запись побеждает) по-прежнему возможна; полное устранение потребует перевода всех мест на `applyLeadsUpdate(modifier)`.
- [x] **Проверка:** чеклист ручных сценариев (в т.ч. визит → submit → админка → удаление) описан в docs/MANUAL-TESTING-CHECKLIST.md. Параллельные запросы сериализованы очередью записи (гонка по файлу устранена).

### 3.2 Бэкапы и архивы

- [x] **writeLeads:** архивация ограничена по частоте: `_lastArchiveTime` + `ARCHIVE_THROTTLE_MS` (60 с) — не чаще раза в минуту.
- [x] **Скрипт cleanup-backups.js:** в `listBackupFiles()` обрабатываются только файлы (не каталоги), ошибки stat — пропуск записи; пустая папка возвращает [].

### 3.3 Short links (short/index.js)

- [x] **Тихий проглатывание ошибок:** `getLinks()` при любой ошибке возвращает `{}`. При повреждении `links.json` все короткие ссылки «исчезнут». **Сделано:** в catch логируется `[short] getLinks error:`.
- [x] **Каталог short/data:** при ошибке записи в `writeLinks` ошибка логируется и пробрасывается (throw), чтобы вызывающий код мог отреагировать.

---

## Фаза 4: Качество кода и обработка ошибок

### 4.1 Ответы клиенту

- [x] **Двойная отправка:** добавлена проверка `safeEnd(res)` (res.writableEnded) перед каждым прямым вызовом `res.writeHead`/`res.end` (редиректы, gate, export, download, статика в fs.stat и т.д.). send() и serveFile уже имели проверку.
- [x] **serveFile:** в начале serveFile и в колбэке fs.readFile добавлена проверка `res.writableEnded`.
- [x] **Таймауты:** для POST upload/check установлен `req.setTimeout(300000)` и `req.on('timeout', () => req.destroy())` для закрытия соединения при таймауте.

### 4.2 Асинхронность и event loop

- [x] **readLeads() в горячем пути:** в `/api/leads` используется `readLeadsAsync`; запись сериализована очередью (3.1). Остальные пути по-прежнему sync — при росте данных можно вынести чтение в async.
- [x] **Обработка ошибок в колбэках:** JSON.parse(body) везде в try/catch с ответом 400/500; send(res, ...) вызывается при ошибках. Гео-запрос (ip-api) обрабатывает timeout и error с ответом клиенту.

### 4.3 Глобальные обработчики

- [x] **uncaughtException / unhandledRejection:** добавлены `process.on('uncaughtException')` и `process.on('unhandledRejection')` с логированием и exit(1).

### 4.4 Стиль и поддерживаемость

- [x] **Монолит server.js:** разбиение на модули не выполнялось (риск регрессий). Вместо этого добавлены хелперы `safeEnd(res)`, `maskEmail()`, троттлинг архива и очередь записи — стабильность улучшена без рефакторинга структуры файла.
- [x] **Дублирование:** проверка ответа вынесена в `safeEnd(res)`; маскировка email — в `maskEmail()` и в `writeDebugLog` (safe). Константы RATE_LIMITS, ARCHIVE_THROTTLE_MS вынесены.

---

## Фаза 5: Конфигурация и окружение

- [x] **Порты и хост:** PORT парсится через `parseInt(process.env.PORT, 10)`, HOST через `.trim()`.
- [x] **Отсутствующие файлы:** при старте вызываются `ensureDataFile()`, `ensureBackupsDir()`, создаётся `downloads/` при отсутствии.
- [x] **Опциональные зависимости:** при старте логируется, если не установлены nodemailer или ws.

---

## Фаза 6: Тесты и регрессии

- [x] **Синтаксис:** `npm run check:syntax` запускает `scripts/check-syntax.js`, который проверяет src/server.js, src/short/index.js, scripts/cleanup-backups.js, scripts/check-reliability.js, scripts/restore-leads.js, scripts/test-download-rotation.js. mailer/mailer.js — код для браузера (window/fetch), не проверяется через node -c.
- [x] **Smoke/health:** скрипт `scripts/smoke-health.sh` проверяет /health (curl или wget). В package.json добавлен `npm run check:smoke` (опционально, требует запущенный сервер).
- [x] **Ручные сценарии:** чеклист описан в docs/MANUAL-TESTING-CHECKLIST.md (визит, submit, админка, удаление, shortlinks, гейт, скачивание, безопасность админки).

---

## Фаза 7: Деплой и эксплуатация

- [x] **Документация деплоя:** в `deploy/DEPLOY.md` и `deploy/DEPLOY-quick.md` добавлены разделы: обязательность `ADMIN_TOKEN` и `NODE_ENV=production` на проде, рекомендация по ротации (cron для `npm run cleanup`).
- [x] **Логи:** в console.log и в debug.log email маскируется через `maskEmail()` (a***@b.com). В `writeDebugLog` все поля с именами `email` / `*Email` при записи в файл подменяются на маскированные значения.
- [x] **Ротация логов:** в документации деплоя указано настроить cron для `npm run cleanup` (или cleanup:full).

---

## Порядок выполнения (рекомендуемый)

1. **Сначала:** Фаза 1 (уже автоматизирована), Фаза 2.1 (ADMIN_TOKEN в production), Фаза 4.1–4.2 (двойная отправка, serveFile, таймауты).
2. **Затем:** Фаза 3.1 (очередь или lock для leads), Фаза 3.3 (short links — логирование ошибок).
3. **Далее:** Фаза 4.3 (uncaughtException/unhandledRejection), Фаза 5 (конфиг и каталоги при старте).
4. **По возможности:** Фаза 4.4 (разбиение server.js), Фаза 6 (расширение проверок и smoke).

После каждого изменения — запуск `npm run check`, ручной прогон сценариев и при необходимости откат (см. deploy/ROLLBACK.md).
