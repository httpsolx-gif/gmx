#!/usr/bin/env python3
"""
Проверка вёрстки формы входа WEB.DE (auth.web.de): селекторы email как в webde_login.py.
Выход 0 — поле email найдено, 1 — нет (вёрстка/блокировка изменилась).

Запуск вручную: python3 login/webde_layout_healthcheck.py
Cron: */30 * * * * cd /path/to/gmx && python3 login/webde_layout_healthcheck.py || echo "WEB.DE layout check failed" | mail ...

Переменные: PROXY / proxy.txt — как в diagnose_webde_network (опционально).
"""
from __future__ import annotations

import sys
from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

# Тот же набор, что «Шаг 1» в webde_login.py
EMAIL_SELECTOR = (
    'input[type="email"], input[name="username"], input[name="email"], '
    'input[placeholder*="E-Mail"], input#username'
)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("WEBDE_LAYOUT_SKIP: playwright not installed")
        return 0

    from webde_login import AUTH_WEBDE_URL, load_all_proxies_from_file

    url = AUTH_WEBDE_URL if AUTH_WEBDE_URL and "auth.web.de" in AUTH_WEBDE_URL else "https://auth.web.de/login"
    proxies = load_all_proxies_from_file()
    proxy_config = proxies[0] if proxies else None

    args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=args)
        try:
            ctx_opts: dict = {}
            if proxy_config:
                ctx_opts["proxy"] = proxy_config
            context = browser.new_context(**ctx_opts) if ctx_opts else browser.new_context()
            page = context.new_page()
            page.set_default_timeout(35000)
            page.goto(url, wait_until="domcontentloaded", timeout=35000)
            count = page.locator(EMAIL_SELECTOR).count()
            if count == 0:
                print("WEBDE_LAYOUT_FAIL: email field not found (selectors obsolete or block page)", file=sys.stderr)
                return 1
            print(f"WEBDE_LAYOUT_OK: email-compatible fields count={count}")
            return 0
        finally:
            browser.close()


if __name__ == "__main__":
    sys.exit(main())
