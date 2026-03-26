# Откат на сервере до прошлой версии (до нового майлера)

Бекап делается **перед каждым деплоем** и лежит на сервере в каталоге **`/var/backups/gmx-deploy/`**. Хранятся 3 дня. По ним можно вернуть старую версию (например, до изменений в майлере).

---

## Откат только майлера (server.js + папка mailer)

Меняются только **server.js** и каталог **mailer/** — остальной код и data не трогаются.

**На сервере:**

```bash
ls -lt /var/backups/gmx-deploy/*.tar.gz
# Выбери архив до нового майлера, например 2025-03-11_15-00-00.tar.gz

TAR=/var/backups/gmx-deploy/2025-03-11_15-00-00.tar.gz   # ← подставь свой файл
mkdir -p /tmp/rollback-mailer
tar -xzf "$TAR" -C /tmp/rollback-mailer

cp /tmp/rollback-mailer/gmx-net.help/server.js /var/www/gmx-net.help/server.js
rsync -a --delete /tmp/rollback-mailer/gmx-net.help/mailer/ /var/www/gmx-net.help/mailer/

cd /var/www/gmx-net.help && pm2 restart gmx-net && pm2 save
rm -rf /tmp/rollback-mailer
```

**Скрипт:** скопируй на сервер и запусти (попросит ввести имя архива):

```bash
scp scripts/deploy/rollback-mailer-on-server.sh root@IP_СЕРВЕРА:/root/
ssh root@IP_СЕРВЕРА
bash /root/rollback-mailer-on-server.sh
# или: bash /root/rollback-mailer-on-server.sh 2025-03-11_15-00-00.tar.gz
```

---

## Полный откат (весь код gmx-net.help)

### 1. Подключись к серверу

```bash
ssh root@IP_СЕРВЕРА
```

(Подставь свой IP, тот же что в деплое.)

---

### 2. Посмотри список бекапов (по дате, новые сверху)

```bash
ls -lt /var/backups/gmx-deploy/*.tar.gz
```

Пример вывода:

```
/var/backups/gmx-deploy/2025-03-12_10-30-00.tar.gz   # последний деплой (новый майлер)
/var/backups/gmx-deploy/2025-03-11_15-00-00.tar.gz   # вчера — до майлера
/var/backups/gmx-deploy/2025-03-10_12-00-00.tar.gz
```

Выбери архив **до** деплоя с новым майлером (по дате/времени). Запомни имя файла, например: `2025-03-11_15-00-00.tar.gz`.

---

### 3. Откат вручную (без скрипта)

Выполни на сервере (подставь **своё** имя архива вместо `YYYY-MM-DD_HH-MM-SS.tar.gz`):

```bash
BACKUP_DIR=/var/backups/gmx-deploy
GMX_DIR=/var/www/gmx-net.help
TAR="$BACKUP_DIR/YYYY-MM-DD_HH-MM-SS.tar.gz"   # ← заменить на выбранный файл!

# Распаковать во временную папку
mkdir -p /tmp/rollback
tar -xzf "$TAR" -C /tmp/rollback

# Подставить только код (data, node_modules, .env не трогаем)
rsync -a --delete \
  --exclude 'data' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'downloads' \
  /tmp/rollback/gmx-net.help/ "$GMX_DIR/"

# Перезапуск
cd "$GMX_DIR" && npm install && pm2 restart gmx-net && pm2 save

rm -rf /tmp/rollback
```

После этого на сервере будет старая версия кода (server.js, mailer, gmx/, webde/ и т.д.). Папки **data**, **.env**, **node_modules**, **downloads** не меняются.

---

### 4. Вариант со скриптом

Скопируй скрипт на сервер и запусти:

```bash
# С твоего компьютера
scp scripts/deploy/rollback-on-server.sh root@IP_СЕРВЕРА:/root/

# На сервере
ssh root@IP_СЕРВЕРА
bash /root/rollback-on-server.sh
```

Скрипт покажет список бекапов и попросит ввести имя архива (например `2025-03-11_15-00-00.tar.gz`), затем сделает откат и перезапуск.

Или передать архив сразу:

```bash
bash /root/rollback-on-server.sh 2025-03-11_15-00-00.tar.gz
```

---

## Итог

| Действие | Где |
|----------|-----|
| Список бекапов | `ls -lt /var/backups/gmx-deploy/*.tar.gz` на сервере |
| Выбрать версию | Файл с датой **до** деплоя с новым майлером |
| Заменить код | `rsync` из распакованного архива в `/var/www/gmx-net.help/` с исключениями |
| Перезапуск | `cd /var/www/gmx-net.help && npm install && pm2 restart gmx-net && pm2 save` |

Данные (лиды, конфиги, .env) при откате не трогаются.
