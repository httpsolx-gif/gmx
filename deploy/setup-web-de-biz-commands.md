# WEB.DE на web-de.biz — команды по шагам

Подставь свой **IP сервера** и при необходимости **путь к проекту** (по умолчанию `/var/www/gmx-net.help`).

---

## ШАГ 0. С твоего Mac — залить код на сервер

```bash
cd /Users/greedy/Desktop/gmx
DEPLOY_HOST=root@ТВОЙ_IP ./scripts/deploy/deploy-gmx-with-backup.sh
```

*(Если деплой уже делаешь другим способом — просто убедись, что на сервере есть файл `config/nginx-web-de.biz.conf`.)*

---

## ШАГ 1. Подключиться к серверу

```bash
ssh root@ТВОЙ_IP
```

---

## ШАГ 2. Добавить web-de.biz в .env

```bash
echo 'WEBDE_DOMAINS=web-de.biz,www.web-de.biz' >> /var/www/gmx-net.help/.env
```

Если `WEBDE_DOMAINS` уже есть в `.env`, открой файл и поправь вручную:

```bash
nano /var/www/gmx-net.help/.env
```

Должна быть одна строка (без дубля). Первый домен — канонический (редирект на него):  
`WEBDE_DOMAINS=web-de.biz,www.web-de.biz`

Сохранить: `Ctrl+O`, `Enter`, `Ctrl+X`.

---

## ШАГ 3. Перезапустить приложение

```bash
cd /var/www/gmx-net.help && npm install && pm2 restart gmx-net && pm2 save
```

---

## ШАГ 4. Подключить конфиг Nginx для web-de.biz

```bash
cp /var/www/gmx-net.help/config/nginx-web-de.biz.conf /etc/nginx/sites-enabled/web-de.biz
```

Проверить и перезагрузить Nginx:

```bash
nginx -t && systemctl reload nginx
```

*(Если приложение слушает не 3001, а другой порт — перед этим отредактируй `/etc/nginx/sites-enabled/web-de.biz` и замени `3001` на свой порт в `proxy_pass`.)*

---

## ШАГ 5. Выдать SSL-сертификат для web-de.biz

```bash
certbot certonly --webroot -w /var/www/certbot -d web-de.biz -d www.web-de.biz
```

Ввести email, согласиться с условиями (`Y`).

---

## ШАГ 6. Включить HTTPS в конфиге Nginx

Открыть конфиг:

```bash
nano /etc/nginx/sites-enabled/web-de.biz
```

Раскомментировать **второй** блок `server { ... }` (тот, где `listen 443 ssl;` и `ssl_certificate`): убрать `#` в начале каждой строки этого блока. Сохранить: `Ctrl+O`, `Enter`, `Ctrl+X`.

Проверить и перезагрузить Nginx:

```bash
nginx -t && systemctl reload nginx
```

---

## Проверка

```bash
curl -I https://web-de.biz
```

В браузере открыть: **https://web-de.biz/anmelden** — должна быть страница входа WEB.DE.
