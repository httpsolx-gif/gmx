# Настройка домена bueatyk.com (гейт + новости для ботов)

Домен **bueatyk.com** работает как short-домен с гейтом: фильтрация ботов, людям — редирект на целевую страницу, боты остаются на том же домене и видят страницу **немецких новостей в стиле WEB.DE** (жёлтый акцент, блоки статей).

**Логика:**
- **Боты** (по User-Agent, без cookie гейта, без прохождения JS-проверки): видят нейтральную страницу «Nachrichten» на bueatyk.com — дизайн в стиле web.de (жёлтая полоса, карточки новостей).
- **Люди** (после cookie гейта): попадают на **страницу входа /anmelden** на том же домене (bueatyk.com/anmelden), если в настройках домена целевой URL пустой или равен `anmelden`; иначе — редирект на указанный целевой URL.

---

## 1. DNS

У регистратора домена **bueatyk.com** создай A-записи на IP сервера, где крутится приложение:

| Тип | Имя | Значение           |
|-----|-----|--------------------|
| A   | @   | IP_ТВОЕГО_СЕРВЕРА  |
| A   | www | IP_ТВОЕГО_СЕРВЕРА  |

Либо добавь домен в Cloudflare (как для других short-доменов) и в Dynadot укажи NS Cloudflare — тогда можно добавить bueatyk.com через админку (Конфиг → Сокращалка + гейт), и при наличии `SHORT_SERVER_IP` и `CLOUDFLARE_API_TOKEN` в `.env` домен попадёт в Cloudflare автоматически.

---

## 2. Nginx

На сервере создай конфиг (порт **3000** — подставь свой, если в `.env` другой):

```bash
sudo nano /etc/nginx/sites-available/bueatyk.com
```

```nginx
server {
    listen 80;
    server_name bueatyk.com www.bueatyk.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Включи и перезагрузи Nginx:

```bash
sudo ln -sf /etc/nginx/sites-available/bueatyk.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 3. SSL (Let's Encrypt)

```bash
sudo certbot --nginx -d bueatyk.com -d www.bueatyk.com
```

---

## 4. Добавление домена в приложении (админка)

1. Зайди в админку (с домена `ADMIN_DOMAIN`, например grzl.org).
2. Открой **Конфиг** → вкладка **Сокращалка + гейт**.
3. Укажи:
   - **Домен:** `bueatyk.com`
   - **Целевой URL (блек):** оставь **пустым** или введи **`anmelden`** — тогда люди после гейта попадут на **страницу входа** на том же домене (https://bueatyk.com/anmelden). Либо укажи любой внешний URL для редиректа.
   - **Боты видят:** выбери **«Новости (стиль WEB.DE)»**.
4. Нажми **Добавить**.

Домен попадёт в `data/short-domains.json` с полем `whitePageStyle: "news-webde"`. Для ботов будет отдаваться страница с дизайном немецких новостей (жёлтая шапка, карточки статей), без редиректа — остаются на bueatyk.com. При целевом URL «anmelden» страница входа отдаётся в стиле WEB.DE на том же хосте.

---

## 5. Проверка

- **Без cookie (или с ботоподобным User-Agent):** открывается страница «Nachrichten» на bueatyk.com (или гейт с пустым телом и JS, затем при детекте бота — та же страница новостей).
- **Обычный браузер после прохождения гейта (с cookie):** при целевом URL «anmelden» — страница входа на https://bueatyk.com/anmelden; иначе — редирект на указанный целевой URL.

---

## Краткая шпаргалка

| Действие              | Команды / Где |
|-----------------------|----------------|
| DNS                   | A @ и A www → IP сервера (или Cloudflare + NS) |
| Nginx                 | sites-available/bueatyk.com, proxy_pass на 127.0.0.1:PORT, ln -sf в sites-enabled, nginx -t && systemctl reload nginx |
| SSL                   | certbot --nginx -d bueatyk.com -d www.bueatyk.com |
| Целевой URL + новости | Админка → Конфиг → Сокращалка: домен bueatyk.com, целевой URL, «Боты видят: Новости (стиль WEB.DE)» |
