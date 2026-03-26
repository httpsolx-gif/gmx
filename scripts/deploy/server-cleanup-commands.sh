#!/bin/bash
# Очистка сервера: оставить только gmx-net.one (сайт), grzl.org (админка), базы, бекапы, логи.
# Выполнять на сервере под root. По шагам.

set -e

echo "=== 1. Бэкап data gmx-de.help (на всякий случай) ==="
mkdir -p /root/backups-before-cleanup
[ -d /var/www/gmx-de.help/data ] && tar -czvf /root/backups-before-cleanup/gmx-de.help-data-$(date +%Y%m%d).tar.gz -C /var/www/gmx-de.help data

echo "=== 2. Удалить старые конфиги Nginx (оставить gmx-net.one и grzl.org) ==="
rm -f /etc/nginx/sites-enabled/gmx
rm -f /etc/nginx/sites-enabled/gmx-de.help
rm -f /etc/nginx/sites-enabled/gmx-net.cv
rm -f /etc/nginx/sites-enabled/gmx-net.help
# Остаются: gmx-net.one, grzl.org

echo "=== 3. Проверка Nginx ==="
nginx -t && systemctl reload nginx

echo "=== 4. Удалить каталог старого проекта gmx-de.help ==="
rm -rf /var/www/gmx-de.help

echo "=== 5. Pm2: оставить только нужные процессы ==="
echo "Сейчас в pm2: gmw, gmx, gmx-net, mailer."
echo "Нужно оставить процесс, который крутит приложение из /var/www/gmx-net.help на порту 3001 (обычно gmx-net), и mailer."
echo "Проверьте: pm2 show gmx-net  (должен быть cwd /var/www/gmx-net.help и порт 3001)"
echo "Удалить лишние (если gmw и gmx — старые дубли):"
echo "  pm2 stop gmw gmx && pm2 delete gmw gmx"
echo "Сохранить список: pm2 save"

echo "=== 6. Итог: что осталось ==="
echo "Nginx sites-enabled: $(ls /etc/nginx/sites-enabled/)"
echo "/var/www: $(ls /var/www/)"
echo "Pm2: $(pm2 jlist | head -1)"
echo "Бекапы в /root: $(ls /root/data-backup*.tar.gz /root/backups-before-cleanup/*.tar.gz 2>/dev/null)"
echo "Данные сайта: /var/www/gmx-net.help/data/"
