#!/usr/bin/env python3
"""Генерация gmx_login.py / gmx_mail_filters.py из WEB.DE (вариант B). Запуск: python3 login/_gen_gmx_modules.py"""
from __future__ import annotations

import re
from pathlib import Path

DIR = Path(__file__).resolve().parent

DOMAIN_REPLACEMENTS = [
    ("meinvollbild.web.de", "meinvollbild.gmx.net"),
    ("interception.web.de", "interception.gmx.net"),
    ("obligation.web.de", "obligation.gmx.net"),
    ("navigator.web.de", "navigator.gmx.net"),
    ("sicherheit.web.de", "sicherheit.gmx.net"),
    ("pwchange.web.de", "pwchange.gmx.net"),
    ("anmelden.web.de", "anmelden.gmx.net"),
    ("auth.web.de", "auth.gmx.net"),
    ("hilfe.web.de", "hilfe.gmx.net"),
    ("link.web.de", "link.gmx.net"),
    ("www.web.de", "www.gmx.net"),
    ("https://web.de/", "https://www.gmx.net/"),
    ("https://web.de", "https://www.gmx.net"),
]

GMX_AUTH_DEFAULT = (
    "https://auth.gmx.net/login?prompt=none&state=eyJpZCI6Ijk0YmIzMTA0LWM0ZTktNDNhZS1iZTFlLTE2Nzc4MjkzYTYxMCIsImNsaWVudElkIjoiZ214bmV0X2FsbGlnYXRvcl9saXZlIiwieFVpQXBwIjoiZ214bmV0LmFsbGlnYXRvci8xLjE5LjAiLCJwYXlsb2FkIjoiZXlKa1l5STZJbUp6SWl3aWRHRnlaMlYwVlZKSklqb2lhSFIwY0hNNkx5OXNhVzVyTG1kdGVDNXVaWFF2YldGcGJDOXphRzkzVTNSaGNuUldhV1YzSWl3aWNISnZZMlZ6YzBsa0lqb2liMmxmY0d0alpURWlmUT09In0%3D&authcode-context=QMtmGOEpNT"
)

LOGIN_HELPER = '''
def _gmx_portal_host_in_url(url: str) -> bool:
    """URL принадлежит инфраструктуре входа/портала GMX."""
    if not url:
        return False
    u = url.lower()
    return any(
        h in u
        for h in (
            "gmx.net",
            "gmx.de",
            "auth.gmx",
            "navigator.gmx",
            "link.gmx",
            "interception.gmx",
            "obligation.gmx",
            "hilfe.gmx",
            "pwchange.gmx",
            "meinvollbild.gmx",
            "sicherheit.gmx",
            "anmelden.gmx",
        )
    )


'''

FILTERS_HELPER = '''
def _gmx_portal_url(u: str) -> bool:
    """Страница на домене портала GMX (аналог проверок web.de в фильтрах)."""
    if not u:
        return False
    s = u.lower()
    return "gmx.net" in s or "gmx.de" in s


'''


def patch_login(src: str) -> str:
    for a, b in DOMAIN_REPLACEMENTS:
        src = src.replace(a, b)
    src = src.replace("WEBDE_PWCHANGE_URL", "GMX_PWCHANGE_URL")
    src = src.replace("WEBDE_AUTH_URL", "GMX_AUTH_URL")
    src = src.replace("_AUTH_WEBDE_DEFAULT", "_AUTH_GMX_DEFAULT")
    src = src.replace("AUTH_WEBDE_URL", "AUTH_GMX_URL")
    src = src.replace("PWCHANGE_WEBDE_URL", "PWCHANGE_GMX_URL")
    src = src.replace("get_auth_webde_url_for_attempt", "get_auth_gmx_url_for_attempt")
    src = src.replace("probe_webde_proxy_fingerprint", "probe_gmx_proxy_fingerprint")
    src = src.replace("def login_webde(", "def login_gmx(")
    src = src.replace("login_webde(", "login_gmx(")
    src = src.replace('"web.de" not in u', "not _gmx_portal_host_in_url(u)")
    src = src.replace('"web.de" in u and', "_gmx_portal_host_in_url(u) and")
    src = src.replace('"web.de" in url and', "_gmx_portal_host_in_url(url) and")
    src = src.replace('"web.de" in url and not', "_gmx_portal_host_in_url(url) and not")
    src = src.replace("not url or not _gmx_portal_host_in_url(url)", "not url or not _gmx_portal_host_in_url(url)")
    src = src.replace(
        'not url or "web.de" not in url',
        "not url or not _gmx_portal_host_in_url(url)",
    )
    src = src.replace("Автовход в почту web.de", "Автовход в почту GMX (gmx.de / gmx.net)")
    src = src.replace("[WEBDE] auth.gmx.net", "[GMX] auth.gmx.net")
    src = src.replace('line = f"[{ts}] [WEBDE] WAIT | {em} | {message}"', 'line = f"[{ts}] [GMX] WAIT | {em} | {message}"')
    src = re.sub(
        r'_WEBDE_VERBOSE_LOG = os\.environ\.get\("WEBDE_VERBOSE_LOG", ""\)\.strip\(\)\.lower\(\) in \("1", "true", "yes"\)',
        r'_WEBDE_VERBOSE_LOG = (os.environ.get("GMX_VERBOSE_LOG") or os.environ.get("WEBDE_VERBOSE_LOG", "")).strip().lower() in ("1", "true", "yes")',
        src,
    )
    src = src.replace(
        'EMAIL = os.getenv("WEBDE_EMAIL", "").strip()',
        'EMAIL = os.getenv("GMX_EMAIL", os.getenv("WEBDE_EMAIL", "")).strip()',
    )
    src = src.replace(
        'PASSWORD = os.getenv("WEBDE_PASSWORD", "").strip()',
        'PASSWORD = os.getenv("GMX_PASSWORD", os.getenv("WEBDE_PASSWORD", "")).strip()',
    )
    src = re.sub(
        r"WEBDE_BROWSER_LAUNCH_RETRIES = max\(1, int\(os\.getenv\(\"WEBDE_BROWSER_LAUNCH_RETRIES\", \"3\"\)\)\)",
        r'GMX_BROWSER_LAUNCH_RETRIES = max(1, int(os.getenv("GMX_BROWSER_LAUNCH_RETRIES", os.getenv("WEBDE_BROWSER_LAUNCH_RETRIES", "3"))))',
        src,
    )
    src = src.replace("WEBDE_BROWSER_LAUNCH_RETRIES", "GMX_BROWSER_LAUNCH_RETRIES")
    src = src.replace('page.get_by_role("link", name="Zum WEB.DE Login")', 'page.get_by_role("link", name="Zum GMX Login")')
    src = src.replace('page.get_by_role("button", name="Zum WEB.DE Login")', 'page.get_by_role("button", name="Zum GMX Login")')
    src = src.replace('page.get_by_text("Zum WEB.DE Login")', 'page.get_by_text("Zum GMX Login")')
    src = src.replace('log("Вход", "клик «Zum WEB.DE Login»"', 'log("Вход", "клик «Zum GMX Login»"')

    insert_at = src.find("from captcha_solver import")
    if insert_at == -1:
        raise SystemExit("captcha_solver import not found")
    src = src[:insert_at] + LOGIN_HELPER + src[insert_at:]

    m = re.search(
        r'_AUTH_GMX_DEFAULT = \(\n\s*"https://auth\.gmx\.net/login[^"]*"\n\)',
        src,
    )
    if m:
        src = src[: m.start()] + '_AUTH_GMX_DEFAULT = (\n    "' + GMX_AUTH_DEFAULT + '"\n)' + src[m.end() :]

    return src


def patch_filters(src: str) -> str:
    for a, b in DOMAIN_REPLACEMENTS:
        src = src.replace(a, b)
    src = src.replace("Фильтры почты WEB.DE", "Фильтры почты GMX")
    src = src.replace('if "web.de" not in u:', "if not _gmx_portal_url(u):")
    src = src.replace(
        'if ("web.de" in u or "www.gmx.net" in u) and "hilfe." not in u and "auth." not in u:',
        'if _gmx_portal_url(u) and "hilfe." not in u and "auth." not in u:',
    )
    # if still old pattern (www.web.de replaced to www.gmx.net already):
    src = src.replace(
        'if ("gmx.net" in u or "www.gmx.net" in u) and "hilfe." not in u and "auth." not in u:',
        'if _gmx_portal_url(u) and "hilfe." not in u and "auth." not in u:',
    )
    ins = src.find("from __future__ import annotations")
    if ins == -1:
        ins = 0
    nl = src.find("\n", ins) + 1
    src = src[:nl] + FILTERS_HELPER + src[nl:]
    # JS snippet: href gmx
    src = src.replace("if (!href.includes('web.de'))", "if (!href.includes('gmx.net') && !href.includes('gmx.de'))")
    return src


def main() -> None:
    wl = (DIR / "webde_login.py").read_text(encoding="utf-8")
    (DIR / "gmx_login.py").write_text(patch_login(wl), encoding="utf-8")
    print("OK", DIR / "gmx_login.py")

    wf = (DIR / "webde_mail_filters.py").read_text(encoding="utf-8")
    (DIR / "gmx_mail_filters.py").write_text(patch_filters(wf), encoding="utf-8")
    print("OK", DIR / "gmx_mail_filters.py")


if __name__ == "__main__":
    main()
