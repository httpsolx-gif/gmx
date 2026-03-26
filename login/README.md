# Автовход web.de с капчей через API

Скрипт входит в почту web.de, отправляя капчу в API 2Captcha (решение по API).

## Поддерживаемые типы капчи

- **Обычная капча (картинка)** — изображение отправляется в 2Captcha, в форму подставляется распознанный текст.
- **CaptchaFox** — в 2Captcha отправляются URL страницы, ключ виджета и User-Agent; для CaptchaFox **обязателен прокси** (требование API 2Captcha).

## Установка

```bash
cd /Users/greedy/Desktop/login
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

## Настройка

1. Скопируйте пример конфига и заполните переменные:

```bash
cp .env.example .env
```

2. Учётные данные можно задать одним из способов:

   **Вариант А — файл `accounts.txt`** (в папке проекта):
   - Одна строка в формате: `email:password`
   - Пример: `myname@web.de:mypassword`
   - Файл можно создать вручную или скопировать: `cp accounts.txt.example accounts.txt`

   **Вариант Б — переменные в `.env`:**
   - `WEBDE_EMAIL` — адрес @web.de
   - `WEBDE_PASSWORD` — пароль

3. В `.env` также укажите:

- `API_KEY_2CAPTCHA` — ключ с [2captcha.com](https://2captcha.com)
- `PROXY` — **обязателен для CaptchaFox**. Формат: `http://user:pass@host:port` или `host:port`
- `HEADLESS` — `true` (по умолчанию) или `false` (чтобы видеть браузер при отладке)

## Запуск

```bash
python webde_login.py
```

При необходимости отладки задайте `DEBUG=1` и/или `HEADLESS=false` — скрипт сделает снимок экрана в `debug_screenshot.png`.

## Альтернатива без капчи: IMAP

Для доступа к своей почте web.de можно не использовать браузер и капчу, а подключиться по IMAP (в настройках web.de нужно включить доступ по IMAP):

- **IMAP:** `imap.web.de`, порт 993 (SSL)
- **SMTP:** `smtp.web.de`, порт 587 (STARTTLS)

Логин и пароль — те же, что и на сайте.
