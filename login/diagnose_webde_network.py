#!/usr/bin/env python3
"""
Диагностика доступа к auth.web.de с этой машины.
Запуск: python3 diagnose_webde_network.py

Проверяет: DNS, простой HTTP(S) запрос, переход в браузере (Playwright).
Если задан прокси (proxy.txt или PROXY в .env) — дополнительно проверяет доступ через прокси.
"""
import os
import socket
import sys
import urllib.request
import urllib.error
from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

TARGET_HOST = "auth.web.de"
TARGET_URL = "https://auth.web.de/"
HTTP_TIMEOUT = 25


def get_proxy_config():
    """Прокси из proxy.txt или PROXY. Возвращает (proxy_config для Playwright, proxy_url для urllib) или (None, None)."""
    try:
        from webde_login import load_all_proxies_from_file
        proxies = load_all_proxies_from_file()
        if proxies:
            pc = proxies[0]
            server = pc.get("server", "")
            user = pc.get("username") or ""
            password = pc.get("password") or ""
            if user and password:
                from urllib.parse import quote
                host_port = server.replace("http://", "").replace("https://", "")
                proxy_url = f"http://{quote(user)}:{quote(password)}@{host_port}"
            else:
                proxy_url = server
            return pc, proxy_url
    except Exception:
        pass
    proxy_str = os.getenv("PROXY", "").strip()
    if not proxy_str:
        return None, None
    try:
        from captcha_solver import parse_proxy
        p = parse_proxy(proxy_str)
        if not p:
            return None, None
        server = f"{p.get('proxyType', 'http')}://{p['proxyAddress']}:{p['proxyPort']}"
        pc = {"server": server, "username": p.get("proxyLogin"), "password": p.get("proxyPassword")}
        login = p.get("proxyLogin") or ""
        password = p.get("proxyPassword") or ""
        if login and password:
            from urllib.parse import quote
            proxy_url = f"http://{quote(login)}:{quote(password)}@{p['proxyAddress']}:{p['proxyPort']}"
        else:
            proxy_url = f"http://{p['proxyAddress']}:{p['proxyPort']}"
        return pc, proxy_url
    except Exception:
        return None, None


def step(name: str, fn, *args, **kwargs):
    print(f"\n--- {name} ---")
    try:
        result = fn(*args, **kwargs)
        print(f"OK: {result}")
        return result
    except Exception as e:
        print(f"ОШИБКА: {type(e).__name__}: {e}")
        return None


def check_dns():
    def resolve():
        ip = socket.gethostbyname(TARGET_HOST)
        return f"{TARGET_HOST} -> {ip}"
    return step("DNS", resolve)


def check_proxy_tcp(proxy_config, timeout=10):
    """Проверяет, доступен ли прокси по TCP (подключение к host:port)."""
    def connect():
        server = proxy_config.get("server", "")
        if not server:
            return "нет server в конфиге"
        s = server.replace("http://", "").replace("https://", "").replace("socks5://", "").strip()
        if ":" in s:
            host, port_str = s.rsplit(":", 1)
            port = int(port_str)
        else:
            host, port = s, 8080
        socket.create_connection((host, port), timeout=timeout)
        return f"{host}:{port}"
    return step("Доступность прокси (TCP)", connect)


def check_https(proxy_url=None):
    def get():
        req = urllib.request.Request(TARGET_URL, headers={"User-Agent": "Mozilla/5.0 (diagnostic)"})
        if proxy_url:
            proxy_handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
            opener = urllib.request.build_opener(proxy_handler)
            urllib.request.install_opener(opener)
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return f"HTTP {r.status}, len={r.headers.get('Content-Length', '?')}"
    label = "HTTPS через прокси (urllib)" if proxy_url else "HTTPS (urllib)"
    return step(label, get)


def check_playwright_goto(proxy_config=None):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright не установлен, шаг пропущен.")
        return None

    def goto():
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"])
            try:
                context_options = {}
                if proxy_config:
                    context_options["proxy"] = proxy_config
                context = browser.new_context(**context_options) if context_options else browser.new_context()
                page = context.new_page()
                page.set_default_navigation_timeout(20000)
                page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=20000)
                title = page.title()
                context.close()
                return f"title={title!r}"
            finally:
                browser.close()

    label = "Playwright через прокси" if proxy_config else "Playwright page.goto"
    return step(label, goto)


def main():
    print("Диагностика доступа к auth.web.de")
    print("(таймаут HTTPS:", HTTP_TIMEOUT, "сек)")

    proxy_config, proxy_url = get_proxy_config()
    if proxy_config:
        s = proxy_config.get("server", "")
        print("Прокси:", s)
    else:
        print("Прокси: не используется (добавьте login/proxy.txt или PROXY в .env)")

    check_dns()
    check_https()
    check_playwright_goto()

    if proxy_config and proxy_url:
        print("\n--- Проверка через прокси ---")
        check_proxy_tcp(proxy_config)
        check_https(proxy_url)
        check_playwright_goto(proxy_config)

    print("\n--- Итог ---")
    print("Если DNS OK, а HTTPS или Playwright падают по таймауту:")
    print("  — медленная сеть или блокировка доступа к web.de с этого IP")
    print("  — попробуйте прокси в .env / proxy.txt")
    print("Если HTTPS или страница возвращают 403 Forbidden:")
    print("  — web.de блокирует IP сервера (датацентр). Нужен прокси: резидентный или домашний.")
    print("  — Файл login/proxy.txt: по одной строке host:port:login:password (HTTP-прокси)")
    print("  — Или переменная PROXY в .env: http://user:pass@host:port")
    print("Если через прокси — таймаут или «Доступность прокси (TCP)» падает:")
    print("  — прокси с этого сервера недоступен или не отвечает. Смените прокси или проверьте его с другой сети.")
    print("Если DNS падает:")
    print("  — проблема с DNS на сервере (проверьте /etc/resolv.conf, сеть)")
    print("Если HTTPS OK, а Playwright таймаут:")
    print("  — возможно, браузер блокируется или нужны другие аргументы запуска Chromium")
    return 0


if __name__ == "__main__":
    sys.exit(main())
