# Настройка домена gmx-de.info на сервере

Приложение уже крутится (gmx-net на порту 3000). Нужно только добавить приём домена **gmx-de.info** в Nginx и выдать SSL.

---

## 1. DNS

У регистратора домена **gmx-de.info** создай A-записи на IP сервера **166.0.150.132**:

| Тип | Имя | Значение    |
|-----|-----|-------------|
| A   | @   | 166.0.150.132 |
| A   | www | 166.0.150.132 |

Подожди 5–15 минут, пока DNS обновится. Проверка: `ping gmx-de.info` — должен отвечать этот IP.

---

## 2. Nginx: конфиг для gmx-de.info

На сервере:

```bash
sudo nano /etc/nginx/sites-available/gmx-de.info
```

Вставь (порт 3000 — тот же, что у gmx-net):

```nginx
server {
    listen 80;
    server_name gmx-de.info www.gmx-de.info;
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

Сохрани (Ctrl+O, Enter, Ctrl+X).

Включи сайт и проверь Nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/gmx-de.info /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

После этого **http://gmx-de.info** уже должен открываться (сайт с редиректом на HTTPS сделаем после SSL).

---

## 3. SSL (Let's Encrypt)

```bash
sudo certbot --nginx -d gmx-de.info -d www.gmx-de.info
```

Укажи email, согласись с условиями. Certbot сам поправит конфиг Nginx и включит HTTPS. При необходимости выбери конфиг `gmx-de.info`.

---

## 4. Переменная окружения (канонический домен)

В коде по умолчанию уже стоит **gmx-de.info**. Если на сервере в `.env` или в pm2 был задан старый домен — поменяй на новый:

```bash
cd /var/www/gmx-net.help
nano .env
```

Должно быть (или добавь строку):

```
CANONICAL_DOMAIN=gmx-de.info
```

Перезапуск приложения:

```bash
pm2 restart gmx-net && pm2 save
```

---

## 5. Проверка

- **https://gmx-de.info** — открывается сайт (логин, sicherheit и т.д.).
- **https://gmx-net.one** — редирект на https://gmx-de.info (тот же путь).
- Админка по-прежнему на своём домене (grzl.org или как задан `ADMIN_DOMAIN`).

---

## Редирект со старых доменов на основной (gmx-de.info)

Приложение само редиректит на **CANONICAL_DOMAIN** (сейчас gmx-de.info): любой запрос с другого домена сайта уходит на `https://gmx-de.info` + тот же путь.

**Чтобы новый старый домен (например gmx-net.info) тоже редиректил на gmx-de.info:**

1. **Nginx** — добавь для этого домена такой же конфиг (proxy на 3000), как для gmx-de.info, только смени `server_name`:
   ```bash
   sudo cp /etc/nginx/sites-available/gmx-de.info /etc/nginx/sites-available/gmx-net.info
   sudo nano /etc/nginx/sites-available/gmx-net.info
   ```
   Внутри замени на: `server_name gmx-net.info www.gmx-net.info;`

2. Включи сайт и SSL:
   ```bash
   sudo ln -sf /etc/nginx/sites-available/gmx-net.info /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d gmx-net.info -d www.gmx-net.info
   ```

3. Приложение не трогать — оно уже отдаёт редирект на gmx-de.info для всех не-канонических хостов.

**Если в будущем захочешь сделать основным другой домен** (например new-domain.com): в `.env` задай `CANONICAL_DOMAIN=new-domain.com`, перезапусти `pm2 restart gmx-net` — тогда все старые домены (gmx-de.info, gmx-net.one, gmx-net.info и т.д.) начнут редиректить на новый.

---

## Кратко

| Шаг | Команда / действие |
|-----|---------------------|
| DNS | A @ и A www → 166.0.150.132 |
| Nginx | Создать `/etc/nginx/sites-available/gmx-de.info`, proxy на 127.0.0.1:3000, включить в sites-enabled, `nginx -t && systemctl reload nginx` |
| SSL | `sudo certbot --nginx -d gmx-de.info -d www.gmx-de.info` |
| Приложение | В `.env`: `CANONICAL_DOMAIN=gmx-de.info`, затем `pm2 restart gmx-net && pm2 save` |
