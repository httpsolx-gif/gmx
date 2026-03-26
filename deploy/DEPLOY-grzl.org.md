# Админка на grzl.org

Домен **grzl.org** в коде задан как домен админки (`ADMIN_DOMAIN`). С него отдаётся только админка (`/admin` и API админки); для всех остальных путей возвращается 404. Сайт (логин, смена пароля) работает на отдельном домене (например gmx-net.one).

## DNS (Cloudflare)

- Тип: **A**
- Имя: `@` (и при необходимости `www`)
- Значение: **IP вашего сервера** (тот же, что для gmx-net.one)
- Прокси: по желанию (оранжевое облако — трафик через CF; серое — напрямую на сервер). Для выдачи Let's Encrypt на сервере лучше временно отключить прокси (серое облако) или использовать SSL в CF.

## Сервер: Nginx

```bash
sudo nano /etc/nginx/sites-enabled/grzl.org
```

Вставить полный конфиг (HTTP + после certbot раскомментировать HTTPS) из `nginx-grzl.org.conf` или ниже.

**Только HTTP для старта (потом добавить HTTPS):**

```nginx
server {
    listen 80;
    server_name grzl.org www.grzl.org;

    location ^~ /.well-known/acme-challenge/ {
        default_type "text/plain";
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:3001;
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

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## SSL (если домен указывает напрямую на сервер)

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d grzl.org -d www.grzl.org
```

Добавить в конфиг блок `server { listen 443 ssl; ... }` с путями к сертификатам (как в комментариях в `nginx-grzl.org.conf`), затем:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## Приложение

По умолчанию в коде уже стоит `ADMIN_DOMAIN=grzl.org`. Переменные можно не задавать или явно:

```bash
export ADMIN_DOMAIN=grzl.org
export CANONICAL_DOMAIN=gmx-net.one
```

Перезапустить приложение (например `pm2 restart all`).

После этого:
- **https://grzl.org/admin** — админка
- **https://grzl.org/anmelden** и любые другие пути — 404 (сайт только на своём домене, например gmx-net.one)
