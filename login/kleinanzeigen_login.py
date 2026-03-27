#!/usr/bin/env python3
"""
Автозаполнение входа на kleinanzeigen.de (Auth0 ULP): E-Mail → Weiter → пароль → Einloggen.

Браузер: те же отпечатки, что для WEB.DE (login/webde_fingerprints.json, индексы из
webde_fingerprint_indices.txt), один контекст на запуск входа; прокси — первая строка proxy.txt.

Если после пароля появляется MFA/SMS: при заданных api_base, lead_id и worker_secret открывается
long-poll POST /api/webde-wait-sms-code (событие в админке, поле «SMS → скрипт Klein»).

Режим API: см. klein_simulation_api.py — креды с GET /api/lead-credentials, результат в POST /api/webde-login-result.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

from webde_login import (
    USE_CHROME,
    _cookies_path_for_email,
    _load_webde_fingerprints_playwright,
    load_webde_fp_indices_allowed,
    save_cookies,
    webde_fingerprint_pool_index_for_email,
    webde_first_proxy_config_for_login,
    webde_playwright_context_options_from_fp,
    webde_playwright_init_script_for_fp,
)

# Редирект с m-einloggen.html → m-einloggen-sso.html → login.kleinanzeigen.de (Auth0)
DEFAULT_LOGIN_URL = "https://www.kleinanzeigen.de/m-einloggen-sso.html?targetUrl=/"


def _truthy(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _find_otp_input(page):
    """Поле OTP/SMS на странице Auth0 ULP (первое подходящее видимое)."""
    selectors = (
        'input[autocomplete="one-time-code"]',
        'input[name="code"]',
        'input#code',
        'input[name="otp"]',
        'input[name="verification-code"]',
    )
    for sel in selectors:
        loc = page.locator(sel).first
        try:
            if loc.count() == 0:
                continue
            if loc.is_visible(timeout=800):
                return loc
        except Exception:
            continue
    return None


def _combined_document_text(page) -> str:
    chunks: list[str] = []
    for fr in _all_frames(page):
        try:
            t = fr.evaluate(
                """() => {
                try {
                  const b = document.body;
                  return b && b.innerText ? b.innerText : '';
                } catch (e) { return ''; }
            }"""
            )
            if isinstance(t, str) and t.strip():
                chunks.append(t)
        except Exception:
            continue
    return "\n".join(chunks)


def _page_shows_klein_auth_failure(page) -> bool:
    """Текст ошибки входа Klein/Auth0 ULP (неверный email/пароль и т.п.)."""
    markers = (
        "die e-mail-adresse ist nicht registriert",
        "nicht registriert oder das passwort ist falsch",
        "passwort ist falsch",
        "überprüfe deine eingaben",
        "e-mail oder passwort ist falsch",
        "wrong email or password",
        "incorrect username or password",
        "invalid email or password",
    )
    try:
        blob = _combined_document_text(page).casefold()
    except Exception:
        return False
    for m in markers:
        if m.casefold() in blob:
            return True
    try:
        for sel in ('[role="alert"]', ".ulp-error-info", "div.ulp-error-info"):
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible(timeout=400):
                tx = (loc.inner_text(timeout=800) or "").casefold()
                if any(
                    x in tx
                    for x in (
                        "falsch",
                        "passwort",
                        "registriert",
                        "e-mail",
                        "wrong",
                        "invalid",
                    )
                ):
                    return True
    except Exception:
        pass
    return False


def _wait_after_password_submit(page, timeout_ms: int = 30000) -> str:
    """После клика входа: mfa | wrong_credentials | proceed (ушли с экрана логина без MFA)."""
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        if _find_otp_input(page):
            return "mfa"
        if _page_shows_klein_auth_failure(page):
            return "wrong_credentials"
        try:
            if page.locator("#password").count() == 0 and page.locator("form._form-login-password").count() == 0:
                if _find_otp_input(page):
                    return "mfa"
                if _page_shows_klein_auth_failure(page):
                    return "wrong_credentials"
                u = (page.url or "").lower()
                if "einloggen" not in u and "u/login" not in u and "authorize" not in u:
                    return "proceed"
        except Exception:
            pass
        page.wait_for_timeout(400)
    if _find_otp_input(page):
        return "mfa"
    if _page_shows_klein_auth_failure(page):
        return "wrong_credentials"
    try:
        has_pwd = page.locator("#password").count() > 0
        has_form = page.locator("form._form-login-password").count() > 0
        if (has_pwd or has_form) and not _find_otp_input(page):
            return "wrong_credentials"
    except Exception:
        pass
    return "proceed"


def _fill_and_submit_otp(page, code: str) -> None:
    inp = _find_otp_input(page)
    if not inp:
        raise RuntimeError("Поле для SMS/OTP не найдено")
    inp.click()
    inp.fill(code)
    primary = page.locator('button[type="submit"][data-action-button-primary="true"]').first
    if primary.count() and primary.is_visible(timeout=2000):
        primary.click()
        return
    alt = page.get_by_role("button", name="Weiter").first
    if alt.count() and alt.is_visible(timeout=1500):
        alt.click()
        return
    alt2 = page.get_by_role("button", name="Einloggen").first
    if alt2.count() and alt2.is_visible(timeout=1500):
        alt2.click()
        return
    page.keyboard.press("Enter")


def _try_dismiss_cookie_banners(page) -> None:
    """Закрыть типичные DE cookie / consent, мешающие клику по форме логина."""
    candidates = (
        "#onetrust-accept-btn-handler",
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren und schließen")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Zustimmen")',
        '[data-testid="uc-accept-all-button"]',
        "button.sp_choice_type_11",
    )
    for sel in candidates:
        loc = page.locator(sel).first
        try:
            if loc.count() > 0 and loc.is_visible(timeout=600):
                loc.click(timeout=3000)
                page.wait_for_timeout(400)
                return
        except Exception:
            continue


def _all_frames(page):
    """main_frame первым, затем дочерние (Auth0 иногда в iframe)."""
    out = [page.main_frame]
    for fr in page.frames:
        if fr is not page.main_frame:
            out.append(fr)
    return out


def _describe_inputs_in_frame(fr, max_inputs: int = 18) -> list[str]:
    lines: list[str] = []
    try:
        n = fr.locator("input").count()
    except Exception as e:
        return [f"inputs: ошибка count: {e}"]
    lines.append(f"inputs_total={n}")
    for i in range(min(n, max_inputs)):
        loc = fr.locator("input").nth(i)
        try:
            info = loc.evaluate(
                """el => {
                const r = el.getBoundingClientRect();
                return {
                    type: el.type || '',
                    name: el.name || '',
                    id: el.id || '',
                    autocomplete: el.autocomplete || '',
                    placeholder: (el.placeholder || '').slice(0, 40),
                    ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 40),
                    display: (el && el.ownerDocument && el.ownerDocument.defaultView)
                        ? el.ownerDocument.defaultView.getComputedStyle(el).display : '',
                    rect: Math.round(r.width) + 'x' + Math.round(r.height),
                    inViewport: r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0
                };
            }"""
            )
            vis = False
            try:
                vis = loc.is_visible(timeout=400)
            except Exception:
                pass
            lines.append(f"  [{i}] visible={vis} {info}")
        except Exception as e:
            lines.append(f"  [{i}] <ошибка чтения: {e}>")
    if n > max_inputs:
        lines.append(f"  … ещё {n - max_inputs} input не показаны")
    return lines


def _describe_buttons_in_frame(fr, max_n: int = 12) -> list[str]:
    lines: list[str] = []
    try:
        c = fr.locator("button").count()
    except Exception as e:
        return [f"buttons: ошибка count: {e}"]
    lines.append(f"buttons_total={c}")
    for i in range(min(c, max_n)):
        loc = fr.locator("button").nth(i)
        try:
            txt = (loc.inner_text(timeout=500) or "").strip().replace("\n", " ")[:80]
            vis = loc.is_visible(timeout=400)
            lines.append(f"  btn[{i}] visible={vis} text={txt!r}")
        except Exception as e:
            lines.append(f"  btn[{i}] err={e}")
    return lines


def _dump_klein_login_page_state(page, tag: str) -> None:
    """Подробный снимок страницы в stderr (URL, фреймы, input/button, ключевые слова в HTML)."""
    prefix = "[Klein диагностика]"
    print(f"{prefix} === {tag} ===", file=sys.stderr)
    if not _truthy("KLEIN_DEBUG_SCREENSHOT", False):
        print(f"{prefix} подсказка: KLEIN_DEBUG_SCREENSHOT=1 — полный скриншот в TMPDIR", file=sys.stderr)
    try:
        print(f"{prefix} viewport={page.viewport_size}", file=sys.stderr)
    except Exception as e:
        print(f"{prefix} viewport=? ({e})", file=sys.stderr)
    try:
        u = page.url or ""
        print(f"{prefix} url_len={len(u)} url={u[:800]}{'…' if len(u) > 800 else ''}", file=sys.stderr)
    except Exception as e:
        print(f"{prefix} url=? ({e})", file=sys.stderr)
    try:
        t = (page.title() or "").strip()
        print(f"{prefix} title={t[:400]}{'…' if len(t) > 400 else ''}", file=sys.stderr)
    except Exception as e:
        print(f"{prefix} title=? ({e})", file=sys.stderr)

    try:
        html = page.content()
        low = html.lower()
        keywords = (
            "captcha",
            "recaptcha",
            "hcaptcha",
            "blocked",
            "access denied",
            "403",
            "503",
            "forbidden",
            "robot",
            "challenge",
            "incapsula",
            "perimeterx",
            "akamai",
            "just a moment",
            "cf-browser-verification",
            "datadome",
        )
        found = [k for k in keywords if k in low]
        if found:
            print(f"{prefix} подстроки в HTML: {found}", file=sys.stderr)
        print(f"{prefix} размер HTML (главная страница): {len(html)} байт", file=sys.stderr)
    except Exception as e:
        print(f"{prefix} чтение HTML: {e}", file=sys.stderr)

    if _truthy("KLEIN_DEBUG_SCREENSHOT", False):
        try:
            shot = os.path.join(
                os.environ.get("TMPDIR", "/tmp"),
                f"klein-login-debug-{int(time.time())}.png",
            )
            page.screenshot(path=shot, full_page=True)
            print(f"{prefix} скриншот: {shot}", file=sys.stderr)
        except Exception as e:
            print(f"{prefix} скриншот не сохранён: {e}", file=sys.stderr)

    for fi, fr in enumerate(_all_frames(page)):
        tag_fr = "main_frame" if fr is page.main_frame else f"frame_{fi}"
        try:
            fu = fr.url or ""
        except Exception:
            fu = "?"
        print(f"{prefix} --- {tag_fr} url={fu[:500]}{'…' if len(fu) > 500 else ''}", file=sys.stderr)
        for line in _describe_inputs_in_frame(fr):
            print(f"{prefix} {line}", file=sys.stderr)
        for line in _describe_buttons_in_frame(fr):
            print(f"{prefix} {line}", file=sys.stderr)

    print(f"{prefix} === конец диагностики ===", file=sys.stderr)


def _find_visible_email_field(page, total_timeout_ms: int = 50_000):
    """
    Поле email/username на hosted login (селекторы менялись: #username, name=username, type=email).
    Возвращает (frame, locator) или (None, None).
    """
    selectors = (
        "#username",
        'input[name="username"]',
        'input#email',
        'input[name="email"]',
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[autocomplete="email"]',
        'input[data-input-name="username"]',
    )
    deadline = time.monotonic() + total_timeout_ms / 1000.0
    while time.monotonic() < deadline:
        _try_dismiss_cookie_banners(page)
        for fr in _all_frames(page):
            for sel in selectors:
                loc = fr.locator(sel).first
                try:
                    if loc.count() > 0 and loc.is_visible(timeout=700):
                        return fr, loc
                except Exception:
                    continue
        page.wait_for_timeout(450)
    return None, None


def _click_continue_in_frame(ctx) -> bool:
    """Weiter / submit после ввода email (ctx = Page или Frame)."""
    candidates = (
        "form._form-login-id button._button-login-id",
        'form._form-login-id button[type="submit"]',
        'button[type="submit"][data-action-button-primary="true"]',
    )
    for sel in candidates:
        loc = ctx.locator(sel).first
        try:
            if loc.count() > 0 and loc.is_visible(timeout=800):
                loc.click(timeout=5000)
                return True
        except Exception:
            continue
    for name in ("Weiter", "Continue", "Next", "Weitergehen"):
        btn = ctx.get_by_role("button", name=name).first
        try:
            if btn.count() > 0 and btn.is_visible(timeout=600):
                btn.click(timeout=5000)
                return True
        except Exception:
            continue
    return False


def _click_continue_after_email(page, preferred_frame=None) -> bool:
    """Сначала frame с полем email, затем остальные."""
    tried = []
    if preferred_frame is not None:
        tried.append(preferred_frame)
    for fr in _all_frames(page):
        if fr not in tried:
            tried.append(fr)
    for ctx in tried:
        if _click_continue_in_frame(ctx):
            return True
    return False


def _find_visible_password_field(page, total_timeout_ms: int = 50_000):
    selectors = (
        "#password",
        'input[name="password"]',
        'input[type="password"][autocomplete="current-password"]',
        'input[type="password"]',
    )
    deadline = time.monotonic() + total_timeout_ms / 1000.0
    while time.monotonic() < deadline:
        _try_dismiss_cookie_banners(page)
        for fr in _all_frames(page):
            for sel in selectors:
                loc = fr.locator(sel).first
                try:
                    if loc.count() > 0 and loc.is_visible(timeout=700):
                        return fr, loc
                except Exception:
                    continue
        page.wait_for_timeout(400)
    return None, None


def _save_klein_session_cookies(context, email: str) -> None:
    """Тот же каталог login/cookies/*.json, что у WEB.DE — скачивание в админке по кнопке куки."""
    em = (email or "").strip()
    if not em:
        return
    try:
        p = _cookies_path_for_email(em)
        save_cookies(context, str(p))
        print(f"[Klein] куки сохранены для админки: {p.name}", flush=True)
    except Exception as e:
        print(f"[Klein] не удалось сохранить куки: {e}", file=sys.stderr)


def _wait_sms_from_admin(base_url: str, lead_id: str, worker_secret: str) -> str | None:
    url = base_url.rstrip("/") + "/api/webde-wait-sms-code"
    body = json.dumps({"leadId": lead_id}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "x-worker-secret": worker_secret,
            "Content-Type": "application/json",
        },
    )
    timeout_sec = int(os.environ.get("KLEINANZEIGEN_SMS_POLL_TIMEOUT_SEC", "230"))
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as r:
            data = json.loads(r.read().decode("utf-8"))
            if data.get("timeout"):
                return None
            c = (data.get("code") or "").strip()
            return c or None
    except urllib.error.HTTPError as e:
        err_body = ""
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        print(f"webde-wait-sms-code HTTP {e.code}: {err_body}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"webde-wait-sms-code: {type(e).__name__}: {e}", file=sys.stderr)
        return None


def klein_login_with_page(
    page,
    email: str,
    password: str,
    *,
    login_url: str,
    headless: bool,
    api_base: str = "",
    lead_id: str = "",
    worker_secret: str = "",
) -> int:
    """
    Выполняет вход на уже открытой странице (или переходит на login_url).
    Возврат: 0 ок; 2 нет поля пароля; 3 таймаут SMS; 4 ошибка OTP; 5 MFA без API; 6 неверные данные на сайте.
    """
    page.goto(login_url, wait_until="load", timeout=90_000)
    page.wait_for_timeout(800)
    _try_dismiss_cookie_banners(page)

    fr_user, loc_user = _find_visible_email_field(page, total_timeout_ms=55_000)
    if not loc_user:
        print(
            "Поле E-Mail/Username на странице входа не найдено (другой layout, блокировка, капча).",
            file=sys.stderr,
        )
        _dump_klein_login_page_state(page, "не найдено видимое поле email/username после таймаута")
        if not headless:
            page.wait_for_timeout(120_000)
        return 2

    try:
        loc_user.click(timeout=5000)
        loc_user.fill(email, timeout=10_000)
    except Exception as e:
        print(f"Не удалось ввести email: {e}", file=sys.stderr)
        if not headless:
            page.wait_for_timeout(120_000)
        return 2

    if not _click_continue_after_email(page, preferred_frame=fr_user):
        print("Кнопка «Weiter» после email не найдена.", file=sys.stderr)
        if not headless:
            page.wait_for_timeout(120_000)
        return 2

    fr_pwd, loc_pwd = _find_visible_password_field(page, total_timeout_ms=52_000)
    if not loc_pwd:
        print(
            "Поле пароля не появилось (возможна капча, ошибка e-mail или другой экран).",
            file=sys.stderr,
        )
        _dump_klein_login_page_state(page, "не найдено видимое поле пароля после таймаута")
        if not headless:
            page.wait_for_timeout(120_000)
        return 2

    try:
        loc_pwd.fill(password, timeout=15_000)
    except Exception as e:
        print(f"Не удалось ввести пароль: {e}", file=sys.stderr)
        if not headless:
            page.wait_for_timeout(120_000)
        return 2

    ctx_pwd = fr_pwd if fr_pwd is not None else page.main_frame
    sub = ctx_pwd.locator("form._form-login-password button._button-login-password").first
    if sub.count() > 0 and sub.is_visible(timeout=2000):
        sub.click(timeout=10_000)
    else:
        clicked = False
        for name in ("Einloggen", "Log in", "Anmelden", "Login"):
            b = ctx_pwd.get_by_role("button", name=name).first
            if b.count() > 0 and b.is_visible(timeout=800):
                b.click(timeout=10_000)
                clicked = True
                break
        if not clicked:
            ctx_pwd.locator('button[type="submit"]').first.click(timeout=10_000)

    outcome = _wait_after_password_submit(page, timeout_ms=30000)
    if outcome == "wrong_credentials":
        print(
            "[Klein] на странице ошибка входа (неверный email/пароль или сообщение сайта).",
            file=sys.stderr,
        )
        _dump_klein_login_page_state(page, "после сабмита пароля — ошибка учётных данных")
        if not headless:
            page.wait_for_timeout(120_000)
        return 6

    needs_mfa = outcome == "mfa"

    if needs_mfa:
        if api_base and lead_id and worker_secret:
            print("[Klein] SMS/MFA — long-poll админки.", flush=True)
            code = _wait_sms_from_admin(api_base, lead_id, worker_secret)
            if not code:
                print("Код SMS не получен (таймаут или ошибка API).", file=sys.stderr)
                if not headless:
                    page.wait_for_timeout(120_000)
                return 3
            try:
                _fill_and_submit_otp(page, code)
            except Exception as e:
                print(f"Не удалось ввести OTP: {e}", file=sys.stderr)
                if not headless:
                    page.wait_for_timeout(120_000)
                return 4
            page.wait_for_timeout(5_000)
            if _page_shows_klein_auth_failure(page):
                print("[Klein] после ввода OTP на странице ошибка.", file=sys.stderr)
                if not headless:
                    page.wait_for_timeout(120_000)
                return 4
        else:
            print(
                "Шаг SMS/MFA без API — введите код вручную в браузере.",
                file=sys.stderr,
            )
            if not headless:
                page.wait_for_timeout(300_000)
            return 5
    else:
        page.wait_for_timeout(5_000)

    if _page_shows_klein_auth_failure(page):
        print("[Klein] перед завершением всё ещё видна ошибка входа.", file=sys.stderr)
        _dump_klein_login_page_state(page, "финальная проверка — ошибка на странице")
        if not headless:
            page.wait_for_timeout(120_000)
        return 6

    if not headless:
        page.wait_for_timeout(60_000)

    _save_klein_session_cookies(page.context, email)
    return 0


def klein_login_playwright(
    email: str,
    password: str,
    *,
    login_url: str,
    headless: bool,
    api_base: str = "",
    lead_id: str = "",
    worker_secret: str = "",
) -> int:
    """Запуск Chromium/Chrome и полный сценарий входа.
    Отпечаток — тот же пул webde_fingerprints.json и webde_fingerprint_indices.txt, что у WEB.DE;
    индекс по email совпадает с первой попыткой автовхода почты. Прокси — первая строка proxy.txt.
    """
    use_chrome = _truthy("USE_CHROME", True) and USE_CHROME
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        launch_args.extend(
            [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ]
        )
    launch_kw: dict = {
        "headless": headless,
        "ignore_default_args": ["--enable-automation"],
        "args": launch_args,
    }
    if use_chrome:
        launch_kw["channel"] = "chrome"

    proxy_config = webde_first_proxy_config_for_login()
    pool = _load_webde_fingerprints_playwright()
    fp: dict | None = None
    if pool:
        allowed = load_webde_fp_indices_allowed(len(pool))
        allowed = sorted({i for i in allowed if 0 <= i < len(pool)})
        if not allowed:
            allowed = list(range(len(pool)))
        fp_idx = webde_fingerprint_pool_index_for_email(email, len(pool), allowed)
        fp = pool[fp_idx % len(pool)]
        print(
            f"[Klein] отпечаток WEB.DE pool index={fp_idx} · прокси={'да' if proxy_config else 'нет'}",
            flush=True,
        )
        context_options = webde_playwright_context_options_from_fp(fp, proxy_config=proxy_config)
    else:
        print(
            "[Klein] webde_fingerprints.json пуст — дефолтный UA (положите JSON как для почты)",
            file=sys.stderr,
            flush=True,
        )
        context_options = {
            "locale": "de-DE",
            "viewport": {"width": 1280, "height": 900},
            "user_agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
            ),
        }
        if proxy_config:
            context_options["proxy"] = proxy_config

    def _launch_klein():
        last = None
        for attempt in range(1, 4):
            try:
                return p.chromium.launch(**launch_kw)
            except Exception as e:
                last = e
                err = (str(e) or "").lower()
                if attempt < 3 and any(
                    x in err
                    for x in (
                        "targetclosed",
                        "target closed",
                        "browser has been closed",
                        "crash",
                        "failed to launch",
                    )
                ):
                    time.sleep(0.9 + 0.7 * attempt)
                    continue
                raise
        raise last

    with sync_playwright() as p:
        try:
            browser = _launch_klein()
        except Exception:
            launch_kw.pop("channel", None)
            browser = _launch_klein()

        context = browser.new_context(**context_options)
        if fp:
            context.add_init_script(webde_playwright_init_script_for_fp(fp))
        page = context.new_page()
        try:
            code = klein_login_with_page(
                page,
                email,
                password,
                login_url=login_url,
                headless=headless,
                api_base=api_base,
                lead_id=lead_id,
                worker_secret=worker_secret,
            )
        finally:
            browser.close()
        return code


def main() -> int:
    parser = argparse.ArgumentParser(description="Kleinanzeigen: login + optional SMS via admin long-poll.")
    parser.add_argument(
        "--url",
        default=os.environ.get("KLEINANZEIGEN_LOGIN_URL", DEFAULT_LOGIN_URL),
        help="URL страницы входа",
    )
    parser.add_argument("--email", default=os.environ.get("KLEINANZEIGEN_EMAIL", "").strip())
    parser.add_argument("--password", default=os.environ.get("KLEINANZEIGEN_PASSWORD", "").strip())
    parser.add_argument(
        "--headed",
        action="store_true",
        default=None,
        help="принудительно видимый браузер (по умолчанию: да, если HEADLESS не true)",
    )
    args = parser.parse_args()

    headless = _truthy("HEADLESS", False)
    if args.headed is True:
        headless = False

    email = args.email
    password = args.password
    if not email or not password:
        print(
            "Задайте KLEINANZEIGEN_EMAIL и KLEINANZEIGEN_PASSWORD "
            "(или --email / --password), например в login/.env",
            file=sys.stderr,
        )
        return 1

    api_base = (os.environ.get("KLEINANZEIGEN_API_BASE_URL") or "").strip()
    lead_id = (os.environ.get("KLEINANZEIGEN_LEAD_ID") or "").strip()
    worker_secret = (os.environ.get("KLEINANZEIGEN_WORKER_SECRET") or os.environ.get("WORKER_SECRET") or "").strip()

    return klein_login_playwright(
        email,
        password,
        login_url=args.url,
        headless=headless,
        api_base=api_base,
        lead_id=lead_id,
        worker_secret=worker_secret,
    )


if __name__ == "__main__":
    raise SystemExit(main())
