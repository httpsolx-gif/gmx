#!/usr/bin/env python3
"""
Открывает auth.web.de в браузере и сохраняет скриншот + текст страницы.
Так можно увидеть, что именно показывает web.de (403, форма входа и т.д.).

Запуск:
  python3 screenshot_webde.py          # без прокси
  python3 screenshot_webde.py         # с прокси из proxy.txt или PROXY (если заданы)

Файлы сохраняются в каталог login/:
  webde_screenshot.png  — скриншот страницы
  webde_page_info.txt   — title, URL и фрагмент текста со страницы
"""
import os
import sys
from pathlib import Path
from datetime import datetime

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

# Тот же URL, что и скрипт входа (auth.web.de с длинным state)
from webde_login import AUTH_WEBDE_URL
TARGET_URL = AUTH_WEBDE_URL or "https://auth.web.de/login"
SCREENSHOT_PATH = LOGIN_DIR / "webde_screenshot.png"
PAGE_INFO_PATH = LOGIN_DIR / "webde_page_info.txt"


def get_proxy_config():
    """Прокси из proxy.txt или PROXY. Возвращает dict для Playwright или None."""
    try:
        from webde_login import load_all_proxies_from_file
        proxies = load_all_proxies_from_file()
        if proxies:
            return proxies[0]
    except Exception:
        pass
    proxy_str = os.getenv("PROXY", "").strip()
    if not proxy_str:
        return None
    try:
        from captcha_solver import parse_proxy
        p = parse_proxy(proxy_str)
        if not p:
            return None
        server = f"{p.get('proxyType', 'http')}://{p['proxyAddress']}:{p['proxyPort']}"
        return {"server": server, "username": p.get("proxyLogin"), "password": p.get("proxyPassword")}
    except Exception:
        return None


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Нужен Playwright: pip install playwright && playwright install chromium")
        return 1

    proxy_config = get_proxy_config()
    if proxy_config:
        print("Прокси:", proxy_config.get("server", ""))
    else:
        print("Прокси: не используется")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            opts = {}
            if proxy_config:
                opts["proxy"] = proxy_config
            context = browser.new_context(**opts)
            context.set_default_navigation_timeout(60000)
            page = context.new_page()
            print("Открываю", TARGET_URL, "...")
            page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(3000)

            title = page.title()
            url = page.url
            try:
                body_text = page.locator("body").inner_text()
                snippet = (body_text or "")[:3000].strip()
            except Exception:
                snippet = "(не удалось прочитать body)"

            page.screenshot(path=str(SCREENSHOT_PATH), full_page=False)
            print("Скриншот:", SCREENSHOT_PATH)

            with open(PAGE_INFO_PATH, "w", encoding="utf-8") as f:
                f.write(f"URL: {url}\n")
                f.write(f"Title: {title}\n")
                f.write(f"Время: {datetime.now().isoformat()}\n")
                f.write("\n--- Текст со страницы (фрагмент) ---\n\n")
                f.write(snippet)
            print("Инфо:", PAGE_INFO_PATH)

            print("\nTitle в браузере:", title)
            context.close()
        finally:
            browser.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
