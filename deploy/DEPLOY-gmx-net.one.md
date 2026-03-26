# Настройка домена gmx-net.one

## Разделение: админка и сайт

- **Админка** — только на одном постоянном домене. Задаётся переменной `ADMIN_DOMAIN` (например `admin.gmx-net.one` или отдельный домен). Запросы к `/admin` и API админки с других доменов редиректятся на этот домен.
- **Сайт** (логин, смена пароля и т.д.) — на сменных доменах. Канонический домен сайта задаётся `CANONICAL_DOMAIN` (по умолчанию `gmx-net.one`). Запросы с других хостов (кроме домена админки) редиректятся на `https://CANONICAL_DOMAIN` + путь.

Переменные окружения:
- `CANONICAL_DOMAIN=gmx-net.one` — основной домен сайта
- `ADMIN_DOMAIN=admin.gmx-net.one` — домен админки (если не задан, админка доступна с любого домена)

## 1. DNS

У регистратора домена **gmx-net.one** создать A-запись:

| Тип | Имя | Значение (IP сервера) |
|-----|-----|------------------------|
| A   | @   | IP вашего сервера     |
| A   | www | IP вашего сервера     |

## 2. Nginx на сервере

```bash
# Каталог для проверки Certbot
sudo mkdir -p /var/www/certbot
sudo chown www-data:www-data /var/www/certbot

# Скопировать конфиг из репозитория
sudo cp /path/to/gmx/nginx-gmx-net.one.conf /etc/nginx/sites-enabled/gmx-net.one

# Проверить и перезагрузить
sudo nginx -t && sudo systemctl reload nginx
```

## 3. Сертификат SSL

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d gmx-net.one -d www.gmx-net.one
```

## 4. Включить HTTPS в Nginx

Открыть `/etc/nginx/sites-enabled/gmx-net.one`, раскомментировать блок `server { listen 443 ssl; ... }`, затем:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

При желании добавить редирект HTTP → HTTPS в блок `listen 80` (см. комментарии в конфиге).

## 5. Переменная окружения приложения

Чтобы редирект со старых доменов вёл на gmx-net.one, при запуске приложения задать (или оставить по умолчанию):

```bash
export CANONICAL_DOMAIN=gmx-net.one
# или в pm2: env.CANONICAL_DOMAIN = "gmx-net.one"
```

Перезапустить приложение (например `pm2 restart all`).
