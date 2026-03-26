# Быстрый деплой на сервер

Один раз настраиваешь сервер и Nginx, дальше — только rsync и `pm2 restart`.

---

## Первый раз на сервере

### 1. Папка и зависимости

```bash
ssh root@IP_СЕРВЕРА

mkdir -p /var/www/gmx
cd /var/www/gmx
# После первого rsync (см. ниже) здесь будет код
npm install -g pm2
```

### 2. Файл .env (создать вручную)

```bash
nano /var/www/gmx/.env
```

Минимум:

```
NODE_ENV=production
ADMIN_TOKEN=твой-секретный-токен
PORT=3001
```

На проде **обязательно** задай `NODE_ENV=production` и непустой `ADMIN_TOKEN`, иначе админка будет доступна без пароля или сервер не стартует.

Опционально (домены):

```
GMX_DOMAIN=gmx-net.cv
WEBDE_DOMAIN=web-de.biz
# Несколько доменов WEB.DE (первый — канонический):
WEBDE_DOMAINS=web-de.biz,www.web-de.biz
ADMIN_DOMAIN=grzl.org
```

Сохранить и выйти (Ctrl+O, Enter, Ctrl+X).

### 3. Nginx

Конфиги лежат в **config/** в репозитории. После первого rsync:

- GMX: `cp /var/www/gmx/config/nginx-gmx-net.cv.conf /etc/nginx/sites-enabled/gmx-net.cv`
- WEB.DE (web-de.biz): `cp /var/www/gmx/config/nginx-web-de.biz.conf /etc/nginx/sites-enabled/web-de.biz`
- Админка: см. `config/nginx-grzl.org.conf` (если нужна)

В конфигах проверь порт приложения: `proxy_pass http://127.0.0.1:3001;` (должен совпадать с `PORT` из `.env`).

Проверка и перезагрузка Nginx:

```bash
nginx -t && systemctl reload nginx
```

### 4. SSL (Let's Encrypt)

```bash
certbot certonly --webroot -w /var/www/certbot -d gmx-net.cv -d www.gmx-net.cv
certbot certonly --webroot -w /var/www/certbot -d web-de.biz -d www.web-de.biz
```

Потом в соответствующих конфигах Nginx раскомментировать блоки `server { listen 443 ssl; ... }` и снова `nginx -t && systemctl reload nginx`.

### 5. Запуск приложения (PM2)

```bash
cd /var/www/gmx
pm2 start server.js --name gmx
pm2 save
pm2 startup   # один раз — автозапуск после перезагрузки сервера
```

Проверка: `curl -I http://127.0.0.1:3001` — должен ответить приложение.

---

## С локальной машины: залить код и обновить

**Не копируются:** `.env`, `data/`, `downloads/`, `node_modules/` — они остаются на сервере.

### Вариант 1: скрипт (подставь свой хост и путь)

```bash
cd /Users/greedy/Desktop/gmx
export RSYNC_DEST="root@IP_СЕРВЕРА:/var/www/gmx/"
./scripts/deploy/deploy-rsync.sh
```

### Вариант 2: rsync вручную

```bash
cd /Users/greedy/Desktop/gmx
rsync -avz --delete \
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'downloads' \
  ./ root@IP_СЕРВЕРА:/var/www/gmx/
```

### После загрузки — на сервере

```bash
ssh root@IP_СЕРВЕРА
cd /var/www/gmx && npm install && pm2 restart gmx && pm2 save
```

Готово: код обновлён, логи и `.env` не тронуты.

---

## Полезные команды на сервере

| Действие | Команда |
|----------|--------|
| Логи приложения | `pm2 logs gmx --lines 50` |
| Статус | `pm2 status` |
| Перезапуск | `pm2 restart gmx && pm2 save` |
| Кто слушает порт | `ss -tlnp \| grep 3001` |
| Проверка Nginx | `nginx -t && systemctl reload nginx` |

---

## Если порт занят (EADDRINUSE)

В `.env` на сервере задай другой порт, например `PORT=3002`. Во **всех** конфигах Nginx для этого приложения в `proxy_pass` укажи тот же порт: `http://127.0.0.1:3002;`. Затем:

```bash
pm2 restart gmx && pm2 save
```

Подробнее и другие сценарии — в **DEPLOY.md**.
