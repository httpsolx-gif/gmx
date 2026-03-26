# Майлер на grzl.org/mailer

Проект майлера: **spam1** (Flask, рассылка по базе с шаблоном и картинкой).  
Кнопка «Mailer» в админке grzl.org открывает **https://grzl.org/mailer/**.

---

## Зависимости на сервере

- **Python 3** (3.8+): `python3 --version`
- **pip**: `python3 -m pip --version` или `pip3 --version`
- **venv**: обычно входит в пакет python3-venv  
  Установка (Debian/Ubuntu): `apt update && apt install -y python3 python3-pip python3-venv`
- Для **gunicorn** (запуск под pm2): `pip install gunicorn` (в venv майлера)
- **boto3** — только если используете AWS SES (уже в requirements.txt)

---

## 1. Залить проект майлера на сервер

С вашего Mac (папка spam1 рядом с gmx):

```bash
rsync -avz --exclude='__pycache__' --exclude='*.pyc' --exclude='.git' \
  /Users/greedy/Desktop/spam1/ root@166.0.150.132:/var/www/mailer/
```

Если папки `/var/www/mailer` ещё нет на сервере:

```bash
ssh root@166.0.150.132 "mkdir -p /var/www/mailer"
```

Потом снова rsync.

---

## 2. На сервере: venv и зависимости

```bash
ssh root@166.0.150.132
cd /var/www/mailer

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
pip install gunicorn
```

Проверка: `python -c "from app import app; print('ok')"`

---

## 3. Запуск майлера (pm2) на порту 5050

```bash
cd /var/www/mailer
pm2 start "venv/bin/gunicorn -w 1 -b 127.0.0.1:5050 app:app" --name mailer
pm2 save
```

Проверка: `curl -s http://127.0.0.1:5050/ | head -5`

---

## 4. Nginx: выдать grzl.org/mailer на майлер (5050)

В конфиге **grzl.org** уже должен быть блок (добавьте, если нет):

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

Важно: **location /mailer/** должен быть **выше** блока **location /** в том же server.

Перезагрузить nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5. Кнопка в админке GMX

В админке (grzl.org) ссылка уже стоит: `href="/mailer/"` — при открытии с grzl.org это даёт **https://grzl.org/mailer/**.

---

## Итог

| Что              | Где / как                          |
|------------------|------------------------------------|
| Код майлера      | `/var/www/mailer/` (spam1)         |
| Зависимости      | Python 3, venv, Flask, Werkzeug, boto3, gunicorn |
| Порт             | 5050 (localhost)                   |
| URL              | https://grzl.org/mailer/           |
| Конфиги/загрузки | `/var/www/mailer/configs/`, `uploads/` |
| Pm2              | `pm2 restart mailer` после обновления кода |

После деплоя откройте **https://grzl.org/admin** → кнопка **Mailer** → откроется **https://grzl.org/mailer/**.
