#!/usr/bin/env python3
"""
Klein: сброс пароля через m-passwort-vergessen → письмо в WEB.DE (Papierkorb) → ссылка → два поля пароля
→ модалка «Passwort erfolgreich geändert» → Einloggen → ULP вход (иногда SMS, иногда нет).

Оркестрация (lead_simulation_api --klein-orchestration): после emailKl сначала поднимается изолированный Chromium ②
(Klein: forgot → Senden), затем вызывается mail_browser_opener → браузер ③ с тем же отпечатком, прокси и куками
что у ① (reopen_webde_browser_same_profile) — только Postfach/Papierkorb и ссылка. Без opener: как раньше, page_mail
уже открыт в ③ до входа в reset flow.

Шаги (порядок):
  1) Вкладка Klein (②): forgot URL → email → Senden → ждём «E-Mail versendet» / PasswordResetSent.
  2) Вкладка WEB.DE (③): портал → Postfach → Papierkorb (в т.ч. iframe).
  3) Поиск письма/ссылки сброса (iframe, периодический reload списка).
  4) Страница сброса: пароли во всех frame → submit.
  5) Модалка успеха → Einloggen (все frame).
  6) ULP вход с новым паролем; при MFA — on_sms_redirect, затем long-poll.
  7) Успех: POST куки на /api/lead-cookies-upload.

on_step (опционально): строки STEP_* → в оркестраторе уходит в /api/script-event.

Режим отладки: KLEIN_RESET_DEBUG=1 — PNG + HTML в login/klein_reset_debug/<ts>_<lead>/.

Переменные:
  KLEIN_RESET_FORGOT_URL, KLEIN_RESET_MAIL_WAIT_SEC (по умолч. 180),
  KLEIN_ORCH_LEGACY_KLEIN_LOGIN=1 — старый вход по passwordKl (lead_simulation_api).
  KLEIN_RESET_KLEIN_SEPARATE_BROWSER=1 — второй Chromium без куков: forgot + ссылка из письма + ULP только там;
    почта WEB.DE остаётся в исходном context. Нужен playwright из сессии (передаёт оркестратор).
  KLEIN_RESET_KLEIN_BROWSER_NO_PROXY=1 — у изолированного Klein-браузера без прокси (прямой IP).
  Браузер ② по умолчанию: эфемерный chromium.launch + new_context — как klein_ip_probe (без persistent profile).
  Постоянный профиль только при KLEIN_ISOLATED_USE_PERSISTENT_PROFILE=1 и заданном KLEIN_ISOLATED_CHROME_USER_DATA_DIR
  (или fallback WEBDE_CHROME_USER_DATA_DIR) — иначе Klein мог блокировать только persistent, а пречек проходил.
  CDP: KLEIN_ISOLATED_PLAYWRIGHT_CDP_ENDPOINT / KLEIN_ISOLATED_CHROME_REMOTE_DEBUGGING_PORT.
  KLEIN_ISOLATED_BROWSER_EXECUTABLE — только для ветки persistent (не для эфемерного стека пречека).
  KLEIN_ISOLATED_NETSCAPE_COOKIES_FILE=/path/cookies.txt|.json — Netscape или JSON-экспорт; в ② только kleinanzeigen.de.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional, Tuple


def _klein_env_truthy(name: str) -> bool:
    return (os.environ.get(name) or "").strip().lower() in ("1", "true", "yes", "on")
from urllib.parse import urljoin

from playwright.sync_api import Browser, Frame, Page, BrowserContext, TimeoutError as PlaywrightTimeout

LOGIN_DIR = Path(__file__).resolve().parent

DEFAULT_FORGOT_URL = "https://www.kleinanzeigen.de/m-passwort-vergessen.html"


def _klein_isolated_cdp_endpoint_from_env() -> str | None:
    """CDP для браузера ②: сначала KLEIN_ISOLATED_*, иначе те же WEBDE_* что и webde_login."""
    import webde_login as wl

    u = (os.environ.get("KLEIN_ISOLATED_PLAYWRIGHT_CDP_ENDPOINT") or "").strip()
    if u:
        return u
    port = (os.environ.get("KLEIN_ISOLATED_CHROME_REMOTE_DEBUGGING_PORT") or "").strip()
    if port.isdigit():
        return f"http://127.0.0.1:{int(port, 10)}"
    return wl._webde_cdp_endpoint_from_env()


def _klein_isolated_chrome_user_data_dir() -> str | None:
    import webde_login as wl

    k = (os.environ.get("KLEIN_ISOLATED_CHROME_USER_DATA_DIR") or "").strip()
    if k:
        return k
    return wl._webde_chrome_user_data_dir()


def _klein_isolated_browser_executable() -> str | None:
    import webde_login as wl

    k = (os.environ.get("KLEIN_ISOLATED_BROWSER_EXECUTABLE") or "").strip()
    if k:
        return k
    return wl._webde_browser_executable_optional()

# Подписи для /api/script-event (короткие, без дублирования в lead_simulation_api).
STEP_KLEIN_FORGOT_OPEN = "Klein-Reset: страница Passwort vergessen"
STEP_KLEIN_FORGOT_SENT = "Klein-Reset: запрос письма сброса отправлен (E-Mail versendet)"
STEP_WEBDE_POSTFACH = "Klein-Reset: открыт Postfach WEB.DE"
STEP_WEBDE_PAPIERKORB = "Klein-Reset: папка Papierkorb"
STEP_MAIL_LINK_OPEN = "Klein-Reset: открыта ссылка сброса из письма"
STEP_RESET_PASS_SUBMIT = "Klein-Reset: новый пароль отправлен на форме"
STEP_RESET_SUCCESS = "Klein-Reset: успех смены пароля, Einloggen"
STEP_ULIP_LOGIN = "Klein-Reset: вход ULP (новый пароль)"
STEP_COOKIES_UPLOAD = "Klein-Reset: куки отправлены на сервер"


def _truthy(name: str) -> bool:
    v = (os.environ.get(name) or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _notify_step(on_step: Optional[Callable[[str], None]], label: str) -> None:
    if not on_step:
        return
    try:
        on_step(label[:180])
    except Exception:
        pass


def _ordered_frames(page: Page) -> list[Frame]:
    """main_frame первым, затем остальные (письмо BAP часто в iframe)."""
    seen: list[Frame] = []
    try:
        mf = page.main_frame
        if mf:
            seen.append(mf)
    except Exception:
        pass
    try:
        for fr in page.frames:
            if fr not in seen:
                seen.append(fr)
    except Exception:
        pass
    return seen


def _slug(s: str) -> str:
    s = re.sub(r"[^\w\-]+", "_", (s or "").strip(), flags=re.UNICODE)[:60]
    return s or "step"


class KleinResetDebug:
    def __init__(self, lead_id: str):
        self.enabled = _truthy("KLEIN_RESET_DEBUG")
        self.seq = 0
        self.root: Optional[Path] = None
        if self.enabled:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            short = (lead_id or "nolead")[:12]
            self.root = LOGIN_DIR / "klein_reset_debug" / f"{ts}_{short}"
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / "README.txt").write_text(
                "KLEIN_RESET_DEBUG=1: PNG + HTML на шагах сценария сброса Klein.\n",
                encoding="utf-8",
            )

    def step(self, page: Page, tag: str) -> None:
        if not self.enabled or not self.root:
            return
        self.seq += 1
        base = f"{self.seq:02d}_{_slug(tag)}"
        try:
            (self.root / f"{base}.html").write_text(page.content(), encoding="utf-8")
        except Exception as e:
            print(f"[Klein-Reset][debug] html {base}: {e}", flush=True)
        try:
            page.screenshot(path=str(self.root / f"{base}.png"), full_page=True, timeout=60_000)
        except Exception as e:
            print(f"[Klein-Reset][debug] png {base}: {e}", flush=True)


def _upload_lead_cookies(
    context: BrowserContext,
    base_url: str,
    lead_id: str,
    worker_secret: str,
) -> None:
    try:
        cookies = context.cookies()
    except Exception as e:
        print(f"[Klein-Reset] cookies: не прочитаны: {e}", flush=True)
        return
    url = base_url.rstrip("/") + "/api/lead-cookies-upload"
    body = json.dumps({"id": lead_id, "cookies": cookies}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "x-worker-secret": worker_secret,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            r.read()
        print("[Klein-Reset] куки отправлены в /api/lead-cookies-upload", flush=True)
    except urllib.error.HTTPError as e:
        err = ""
        try:
            err = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        print(f"[Klein-Reset] lead-cookies-upload HTTP {e.code} {err}", flush=True)
    except Exception as e:
        print(f"[Klein-Reset] lead-cookies-upload {e}", flush=True)


def _open_webde_postfach(page: Page, context: BrowserContext) -> Page:
    """Портал web.de → меню → Postfach; возвращает страницу с почтовым клиентом."""
    import time as time_mod

    from webde_mail_filters import (
        _navigate_to_webde_portal_for_filters,
        _open_profile_menu,
        _wait_webde_portal_after_goto,
        _fsleep,
    )

    try:
        page.bring_to_front()
    except Exception:
        pass
    _navigate_to_webde_portal_for_filters(page)
    _wait_webde_portal_after_goto(page, timeout_sec=55.0)
    _open_profile_menu(page)
    time_mod.sleep(0.45)
    rows = page.locator(
        "#appa-account-flyout a.appa-navigation-row, "
        "a.appa-navigation-row[href*='navigator.web.de' i], "
        "a[href*='navigator.web.de' i][href*='mail' i]"
    )
    clicked = False
    for i in range(min(rows.count(), 12)):
        el = rows.nth(i)
        try:
            if not el.is_visible(timeout=800):
                continue
            href = (el.get_attribute("href") or "").lower()
            txt = (el.inner_text() or "").lower()
            if "showmailsettings" in href or "einstellungen" in txt:
                continue
            if "navigator" in href or "mail" in href or "postfach" in txt or txt.strip() == "e-mail":
                el.click(timeout=12000)
                clicked = True
                break
        except Exception:
            continue
    if not clicked:
        for name_rx in (
            re.compile(r"Zum\s+Postfach", re.I),
            re.compile(r"^E-Mail$", re.I),
            re.compile(r"E-Mail\s+öffnen", re.I),
        ):
            try:
                link = page.get_by_role("link", name=name_rx).first
                if link.count() and link.is_visible(timeout=1500):
                    link.click(timeout=12000)
                    clicked = True
                    break
            except Exception:
                continue
    if not clicked:
        raise RuntimeError("WEB.DE: не найдена ссылка Postfach для чтения письма сброса")
    _fsleep(2.2, 0.8)
    deadline = time_mod.monotonic() + 55.0
    mail_page = page
    while time_mod.monotonic() < deadline:
        for pg in context.pages:
            try:
                u = (pg.url or "").lower()
            except Exception:
                continue
            if "navigator.web.de" in u and "mail" in u:
                mail_page = pg
                break
            if "mail/client" in u or "posteingang" in u:
                mail_page = pg
                break
        try:
            u2 = (mail_page.url or "").lower()
            if "navigator" in u2 or "mail/client" in u2:
                break
        except Exception:
            pass
        time_mod.sleep(0.5)
    try:
        mail_page.bring_to_front()
    except Exception:
        pass
    try:
        from webde_login import close_consent_popup

        close_consent_popup(mail_page, timeout=8000)
    except Exception:
        pass
    return mail_page


def _click_papierkorb_in_mail(mail_page: Page) -> None:
    """Papierkorb в основном документе и во всех iframe (BAP)."""
    for fr in _ordered_frames(mail_page):
        candidates = (
            fr.get_by_role("link", name=re.compile(r"Papierkorb", re.I)),
            fr.get_by_role("tab", name=re.compile(r"Papierkorb", re.I)),
            fr.get_by_role("treeitem", name=re.compile(r"Papierkorb", re.I)),
            fr.get_by_role("button", name=re.compile(r"Papierkorb", re.I)),
            fr.locator('a[href*="papierkorb" i]').first,
            fr.locator('[href*="Papierkorb" i]').first,
            fr.get_by_text(re.compile(r"^\s*Papierkorb\s*$", re.I)).first,
        )
        for loc in candidates:
            try:
                if loc.count() == 0:
                    continue
                el = loc.first
                if el.is_visible(timeout=1500):
                    el.scroll_into_view_if_needed(timeout=4000)
                    el.click(timeout=8000)
                    time.sleep(1.2)
                    return
            except Exception:
                continue
    raise RuntimeError("WEB.DE: не найден переход в Papierkorb")


def _find_and_click_klein_reset_link(mail_page: Page, context: BrowserContext, dbg: KleinResetDebug) -> Page:
    """Ищет письмо/ссылку сброса Klein; клик может открыть новую вкладку."""
    deadline = time.monotonic() + float(os.environ.get("KLEIN_RESET_MAIL_WAIT_SEC") or "180")
    last_err: Optional[Exception] = None
    poll_idx = 0
    last_reload = 0.0

    def _try_click_reset_href() -> Optional[Page]:
        nonlocal last_err
        for fr in _ordered_frames(mail_page):
            links = fr.locator(
                'a[href*="kleinanzeigen.de" i], a[href*="login.kleinanzeigen" i], '
                'a[href*="uuid=" i], a[href*="reset" i], a[href*="passwort" i], '
                'a[href*="user-settings" i]'
            )
            n = min(links.count(), 30)
            for i in range(n):
                a = links.nth(i)
                try:
                    href = (a.get_attribute("href") or "").lower()
                    if not href or href.startswith("#"):
                        continue
                    if not a.is_visible(timeout=500):
                        continue
                    if (
                        "kleinanzeigen" not in href
                        and "uuid=" not in href
                        and "user-settings" not in href
                        and "passwort" not in href
                    ):
                        continue
                    try:
                        with context.expect_page(timeout=45_000) as pg_info:
                            a.click(timeout=12000)
                        np = pg_info.value
                        np.wait_for_load_state("domcontentloaded", timeout=60000)
                        dbg.step(np, "reset_page_new_tab")
                        return np
                    except PlaywrightTimeout:
                        a.click(timeout=12000)
                        time.sleep(2.0)
                        for pg in context.pages:
                            u = (pg.url or "").lower()
                            if "kleinanzeigen" in u and (
                                "reset" in u
                                or "passwort" in u
                                or "uuid=" in u
                                or "user-settings" in u
                                or "authorize" in u
                            ):
                                dbg.step(pg, "reset_page_same_context")
                                return pg
                except Exception as e:
                    last_err = e
        return None

    def _click_mail_row() -> None:
        for fr in _ordered_frames(mail_page):
            for pat in (
                re.compile(r"kleinanzeigen", re.I),
                re.compile(r"Passwort", re.I),
                re.compile(r"passwort.*erneuern", re.I),
                re.compile(r"marktplaats", re.I),
            ):
                try:
                    row = fr.get_by_text(pat).first
                    if row.count() and row.is_visible(timeout=900):
                        row.click(timeout=8000)
                        time.sleep(1.0)
                        dbg.step(mail_page, "mail_after_row_click")
                        return
                except Exception:
                    continue

    while time.monotonic() < deadline:
        poll_idx += 1
        try:
            mail_page.bring_to_front()
        except Exception:
            pass
        dbg.step(mail_page, "mail_poll_list")

        now = time.monotonic()
        if poll_idx % 12 == 0 and now - last_reload > 35.0:
            try:
                mail_page.reload(wait_until="domcontentloaded", timeout=45000)
                last_reload = now
                time.sleep(1.5)
            except Exception:
                pass

        hit = _try_click_reset_href()
        if hit:
            return hit

        _click_mail_row()

        hit = _try_click_reset_href()
        if hit:
            return hit

        time.sleep(2.5)

    raise RuntimeError(
        "WEB.DE: письмо/ссылка сброса Klein не найдены за отведённое время"
        + (f" ({last_err})" if last_err else "")
    )


def _try_get_reset_href_from_mail(mail_page: Page) -> Optional[str]:
    """Только чтение href (без клика) — для открытия ссылки во втором браузере без общих куков."""
    for fr in _ordered_frames(mail_page):
        try:
            fr_url = (fr.url or "").strip() or (mail_page.url or "").strip() or "https://web.de/"
        except Exception:
            fr_url = (mail_page.url or "").strip() or "https://web.de/"
        links = fr.locator(
            'a[href*="kleinanzeigen.de" i], a[href*="login.kleinanzeigen" i], '
            'a[href*="uuid=" i], a[href*="reset" i], a[href*="passwort" i], '
            'a[href*="user-settings" i]'
        )
        n = min(links.count(), 30)
        for i in range(n):
            a = links.nth(i)
            try:
                href = (a.get_attribute("href") or "").strip()
                if not href or href.startswith("#") or href.lower().startswith("javascript:"):
                    continue
                if not a.is_visible(timeout=500):
                    continue
                hlow = href.lower()
                if (
                    "kleinanzeigen" not in hlow
                    and "uuid=" not in hlow
                    and "user-settings" not in hlow
                    and "passwort" not in hlow
                ):
                    continue
                return urljoin(fr_url, href)
            except Exception:
                continue
    return None


def _find_klein_reset_link_url(mail_page: Page, dbg: KleinResetDebug) -> str:
    """Как _find_and_click_klein_reset_link, но возвращает абсолютный URL вместо клика (отдельный браузер Klein)."""
    deadline = time.monotonic() + float(os.environ.get("KLEIN_RESET_MAIL_WAIT_SEC") or "180")
    poll_idx = 0
    last_reload = 0.0

    def _click_mail_row() -> None:
        for fr in _ordered_frames(mail_page):
            for pat in (
                re.compile(r"kleinanzeigen", re.I),
                re.compile(r"Passwort", re.I),
                re.compile(r"passwort.*erneuern", re.I),
                re.compile(r"marktplaats", re.I),
            ):
                try:
                    row = fr.get_by_text(pat).first
                    if row.count() and row.is_visible(timeout=900):
                        row.click(timeout=8000)
                        time.sleep(1.0)
                        dbg.step(mail_page, "mail_after_row_click_url_only")
                        return
                except Exception:
                    continue

    while time.monotonic() < deadline:
        poll_idx += 1
        try:
            mail_page.bring_to_front()
        except Exception:
            pass
        dbg.step(mail_page, "mail_poll_list_url_only")
        now = time.monotonic()
        if poll_idx % 12 == 0 and now - last_reload > 35.0:
            try:
                mail_page.reload(wait_until="domcontentloaded", timeout=45000)
                last_reload = now
                time.sleep(1.5)
            except Exception:
                pass
        u = _try_get_reset_href_from_mail(mail_page)
        if u:
            print(f"[Klein-Reset] ссылка сброса (только URL, без клика): {u[:120]}…", flush=True)
            return u
        _click_mail_row()
        u = _try_get_reset_href_from_mail(mail_page)
        if u:
            print(f"[Klein-Reset] ссылка сброса (только URL, без клика): {u[:120]}…", flush=True)
            return u
        time.sleep(2.5)
    raise RuntimeError("WEB.DE: ссылка сброса Klein не найдена за отведённое время (режим отдельного браузера)")


def _launch_isolated_klein_browser(
    p,
    *,
    fingerprint_index: Optional[int],
    headless: bool,
    proxy_config: Optional[dict],
) -> tuple[Optional[Browser], BrowserContext]:
    """Второй Chromium: fp из webde_fingerprints.json, без куков WEB.DE; CDP / persistent / как webde_login.

    После launch_persistent_context Playwright может не выставить context.browser — тогда закрытие только через
    BrowserContext.close() (см. finally в run_klein_password_reset_flow).
    """
    import webde_login as wl

    pool = wl._load_webde_fingerprints_playwright()
    if not pool:
        raise RuntimeError("Klein isolated: пустой webde_fingerprints.json")
    idx = int(fingerprint_index) if fingerprint_index is not None else 0
    fp = pool[idx % len(pool)]
    opts = wl.webde_playwright_context_options_from_fp(fp, proxy_config=proxy_config)
    dpr = wl._device_scale_factor_from_fp(fp)
    eh = dict(opts.get("extra_http_headers") or {})
    if not eh.get("Sec-CH-UA"):
        syn = wl._sec_ch_client_hints_for_windows_chrome_ua((fp.get("user_agent") or "").strip())
        if syn:
            eh.update(syn)
    opts["extra_http_headers"] = eh
    ch_hints: dict = {}
    wl._merge_sec_ch_hints_for_fp_chromium(ch_hints, fp, engine="chromium")
    if ch_hints:
        eh2 = dict(opts.get("extra_http_headers") or {})
        eh2.update(ch_hints)
        opts["extra_http_headers"] = eh2

    launch_args_persistent = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if headless:
        launch_args_persistent.extend(
            [
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
            ]
        )

    cdp_url = _klein_isolated_cdp_endpoint_from_env()
    persist_dir = _klein_isolated_chrome_user_data_dir()
    use_persistent = bool((persist_dir or "").strip()) and _klein_env_truthy(
        "KLEIN_ISOLATED_USE_PERSISTENT_PROFILE"
    )
    browser: Optional[Browser]
    context: BrowserContext

    if cdp_url:
        print(f"[Klein-Reset] браузер ② CDP (реальный Chrome): {cdp_url}", flush=True)
        browser = wl._connect_chromium_cdp_resilient(p, cdp_url)
        context = browser.new_context(**opts)
        wl._webde_add_fingerprint_init_script(context, fp, engine="chromium", device_scale_factor=dpr)
    elif use_persistent:
        Path(persist_dir).mkdir(parents=True, exist_ok=True)
        persist_kw = {
            "headless": headless,
            "args": launch_args_persistent,
            "ignore_default_args": ["--enable-automation"],
            **opts,
        }
        ex = _klein_isolated_browser_executable()
        if ex:
            persist_kw["executable_path"] = ex
        elif wl.USE_CHROME:
            persist_kw["channel"] = "chrome"
        print(f"[Klein-Reset] браузер ② persistent profile: {persist_dir}", flush=True)
        context = wl._launch_chromium_persistent_resilient(p, persist_dir, persist_kw)
        browser = context.browser
        if browser is None:
            print(
                "[Klein-Reset] persistent: нет context.browser — завершение сессии через context.close()",
                flush=True,
            )
        wl._webde_add_fingerprint_init_script(context, fp, engine="chromium", device_scale_factor=dpr)
    else:
        print(
            "[Klein-Reset] браузер ② эфемерный launch+context (как klein_ip_probe; persistent выкл.)",
            flush=True,
        )
        lo = wl.webde_klein_ephemeral_launch_kw(headless=headless)
        try:
            browser = wl._launch_chromium_resilient(p, lo)
        except Exception:
            lo.pop("channel", None)
            browser = wl._launch_chromium_resilient(p, lo)
        context = browser.new_context(**opts)
        context.add_init_script(wl.webde_playwright_init_script_for_fp(fp))

    _nc = (os.environ.get("KLEIN_ISOLATED_NETSCAPE_COOKIES_FILE") or "").strip()
    if _nc:
        try:
            ck = wl.playwright_cookies_from_export_file(_nc)
            if ck:
                context.add_cookies(ck)
                print(f"[Klein-Reset] файл куков: {len(ck)} шт. Klein → контекст ②", flush=True)
            else:
                print(
                    f"[Klein-Reset] в файле нет непросроченных куков kleinanzeigen.de ({_nc[:96]!r})",
                    flush=True,
                )
        except Exception as ex:
            print(f"[Klein-Reset] куки из файла не применены: {ex}", flush=True)

    print(
        "[Klein-Reset] изолированный браузер Klein готов (без куков WEB.DE)"
        + ("; без прокси" if not proxy_config else ""),
        flush=True,
    )
    return browser, context


def _norm_scan_text(s: str) -> str:
    """Нижний регистр + унификация пробелов/дефисов для сравнения с копирайтом сайта."""
    t = (s or "").lower()
    t = t.replace("\u00a0", " ").replace("\u2011", "-").replace("\u2013", "-")
    return t


def _forgot_sent_confirmed(low_h: str, low_b: str, url_low: str, low_title: str = "") -> bool:
    """Текст/HTML/URL/заголовок после Senden на m-passwort-vergessen (копирайт Klein менялся)."""
    lt = _norm_scan_text(low_title)
    combined = _norm_scan_text(low_h) + "\n" + _norm_scan_text(low_b) + "\n" + lt
    if "passwordresetsent" in low_h or "resetpwd-cnfrm" in low_h:
        return True
    if "password-reset" in low_h and ("success" in low_h or "bestätig" in low_h or "bestatig" in low_h):
        return True
    if "reset" in url_low and "sent" in url_low and "kleinanzeigen" in url_low:
        return True
    if "/passwort" in url_low and ("bestaetigt" in url_low or "confirm" in url_low or "gesendet" in url_low):
        return True
    if "versendet" in lt and ("e-mail" in lt or "email" in lt or "passwort" in lt):
        return True
    if (
        "e-mail versendet" in low_b
        or "email versendet" in low_b
        or ("versendet" in low_b and "passwort" in low_b)
        or "e-mail geschickt" in low_b
        or "email geschickt" in low_b
        or "e-mail gesendet" in low_b
        or "email gesendet" in low_b
        or "e-mail wurde gesendet" in low_b
        or "bestätigungsmail" in low_b
        or "bestatigungsmail" in low_b
    ):
        return True
    if "wir haben dir" in low_b and ("e-mail" in low_b or "email" in low_b):
        return True
    if "wir haben eine e-mail" in combined or "haben wir dir eine e-mail" in combined:
        return True
    if (
        "überprüfe" in low_b
        or "uberprufe" in low_b
        or "prüfe dein" in low_b
        or "prufe dein" in low_b
    ) and ("postfach" in low_b or "e-mail" in low_b or "email" in low_b):
        return True
    if "prüfe dein postfach" in low_b or "schau in dein postfach" in low_b or "in deinem postfach" in low_b:
        return True
    if "link zum zurücksetzen" in low_b or "link zum zurucksetzen" in low_b:
        return True
    if "passwort zurücksetzen" in low_b and ("e-mail" in low_b or "email" in low_b):
        return True
    if "check your email" in low_b or "we've sent" in low_b or "we sent an email" in low_b:
        return True
    # DSGVO: не подтверждают существование аккаунта, но это всё равно успешный запрос сброса
    if "wenn diese e-mail-adresse" in low_b and "registriert" in low_b:
        return True
    if "wenn ein konto" in low_b and "registriert" in low_b:
        return True
    if "falls ein konto" in low_b and "e-mail" in low_b and "registriert" in low_b:
        return True
    return False


def _visible_forgot_success(page: Page) -> bool:
    """SPA: иногда inner_text body пустой или без ключевых слов — ищем видимый текст во всех фреймах."""
    pats = (
        re.compile(r"E-?Mail.*versendet", re.I),
        re.compile(r"versendet.*E-?Mail", re.I),
        re.compile(r"Bestätigungsmail", re.I),
        re.compile(r"Prüfe.*Postfach", re.I),
        re.compile(r"überprüfe.*postfach", re.I),
        re.compile(r"Link zum Zurücksetzen", re.I),
        re.compile(r"wir haben dir eine", re.I),
    )
    for fr in _ordered_frames(page):
        for pat in pats:
            try:
                loc = fr.get_by_text(pat).first
                if loc.count() > 0 and loc.is_visible(timeout=600):
                    return True
            except Exception:
                continue
        try:
            st = fr.locator('[role="status"], [role="alert"]').first
            if st.count() > 0 and st.is_visible(timeout=400):
                tx = (st.inner_text(timeout=800) or "").lower()
                if "versendet" in tx or "postfach" in tx or "e-mail" in tx:
                    return True
        except Exception:
            pass
    return False


def _page_looks_like_klein_captcha_or_block(page: Page) -> Optional[str]:
    """Возвращает короткую причину, если похоже на капчу/блокировку (чтобы не ждать 55s зря)."""
    try:
        html = (page.content() or "").lower()
    except Exception:
        html = ""
    keys = (
        ("ip-bereich", "klein_ip_range"),
        ("ip-bereich vorübergehend gesperrt", "klein_ip_range"),
        ("ip-bereich vorubergehend gesperrt", "klein_ip_range"),
        ("recaptcha", "recaptcha"),
        ("hcaptcha", "hcaptcha"),
        ("datadome", "datadome"),
        ("perimeterx", "perimeterx"),
        ("incapsula", "incapsula"),
        ("just a moment", "cloudflare"),
        ("attention required", "cloudflare"),
        ("access denied", "access denied"),
        ("captcha", "captcha"),
    )
    for needle, label in keys:
        if needle in html:
            return label
    return None


def _klein_ip_range_blocked_from_text(low: str) -> bool:
    """Страница Klein «IP-Bereich vorübergehend gesperrt» (часто при датацентровом прокси)."""
    x = _norm_scan_text(low)
    if "ip-bereich" not in x:
        return False
    return (
        "gesperrt" in x
        or "ausgeschlossen" in x
        or "vorübergehend" in x
        or "vorubergehend" in x
        or "unsicheren versuchen" in x
    )


def _gather_forgot_page_low_texts(page: Page) -> tuple[str, str]:
    """HTML и body-текст (основной документ + iframe) для проверок после forgot/Senden."""
    html_chunks: list[str] = []
    text_chunks: list[str] = []
    try:
        html_chunks.append(page.content() or "")
    except Exception:
        pass
    try:
        text_chunks.append(page.inner_text("body", timeout=5000) or "")
    except Exception:
        pass
    for fr in _ordered_frames(page):
        if fr is page.main_frame:
            continue
        try:
            html_chunks.append(fr.content() or "")
        except Exception:
            pass
        try:
            t = fr.evaluate("() => (document.body && document.body.innerText) || ''")
            if t:
                text_chunks.append(str(t))
        except Exception:
            pass
    low_h = "\n".join(html_chunks).lower()
    low_b = "\n".join(text_chunks).lower()
    return low_h, low_b


def _assert_klein_not_ip_blocked(page: Page) -> None:
    """Сразу после загрузки m-passwort-vergessen — не тратить время на форму при блоке IP."""
    chunks: list[str] = []
    try:
        chunks.append(page.content() or "")
    except Exception:
        pass
    try:
        chunks.append(page.inner_text("body", timeout=8000) or "")
    except Exception:
        pass
    low = "\n".join(chunks).lower()
    if _klein_ip_range_blocked_from_text(low):
        raise RuntimeError(
            "Klein: IP-Bereich bei Kleinanzeigen gesperrt — andere Proxy-IP (residential) oder später erneut versuchen"
        )


def _wait_forgot_email_sent_confirmation(page: Page, dbg: KleinResetDebug, timeout_sec: float = 50.0) -> None:
    """Ожидание экрана «E-Mail versendet» / PasswordResetSent (основной документ + iframe)."""
    t0 = time.monotonic()
    deadline = t0 + timeout_sec
    last_snap = 0.0
    while time.monotonic() < deadline:
        url_low = ""
        try:
            url_low = (page.url or "").lower()
        except Exception:
            pass
        low_title = ""
        try:
            low_title = page.title() or ""
        except Exception:
            pass
        low_h, low_b = _gather_forgot_page_low_texts(page)
        if _klein_ip_range_blocked_from_text(low_h) or _klein_ip_range_blocked_from_text(low_b):
            raise RuntimeError(
                "Klein: IP-Bereich bei Kleinanzeigen gesperrt — andere Proxy-IP (residential) oder später erneut versuchen"
            )
        if _forgot_sent_confirmed(low_h, low_b, url_low, low_title):
            dbg.step(page, "forgot_confirmed_sent")
            return
        if _visible_forgot_success(page):
            dbg.step(page, "forgot_confirmed_sent_visible")
            return
        block = _page_looks_like_klein_captcha_or_block(page)
        if block == "klein_ip_range":
            raise RuntimeError(
                "Klein: IP-Bereich bei Kleinanzeigen gesperrt — andere Proxy-IP (residential) oder später erneut versuchen"
            )
        if block and (time.monotonic() - t0 > 8.0):
            raise RuntimeError(f"Klein: после Senden похоже на блокировку/капчу ({block}) — нет «E-Mail versendet»")
        if "nicht registriert" in low_b or "kein konto" in low_b or "kein nutzerkonto" in low_b:
            if "wenn diese e-mail" not in low_b and "wenn ein konto" not in low_b and "falls ein konto" not in low_b:
                raise RuntimeError("Klein: аккаунт для этого email не найден (сообщение на странице)")
        now = time.monotonic()
        if dbg.enabled and now - last_snap > 7.0:
            dbg.step(page, "forgot_wait_confirmation")
            last_snap = now
        time.sleep(0.45)
    if _truthy("KLEIN_RESET_DIAG_TIMEOUT"):
        try:
            u = (page.url or "")[:400]
            ti = (page.title() or "")[:200]
            b0 = (page.inner_text("body", timeout=4000) or "")[:2000]
            print(f"[Klein-Reset][diag-timeout] url={u!r} title={ti!r}", flush=True)
            print(f"[Klein-Reset][diag-timeout] body[:2000]={b0!r}", flush=True)
        except Exception as ex:
            print(f"[Klein-Reset][diag-timeout] не удалось снять body: {ex}", flush=True)
    raise RuntimeError("Klein: нет подтверждения «E-Mail versendet» после Senden")


def _fill_forgot_email_and_click_send(page: Page, email_kl: str, dbg: KleinResetDebug) -> None:
    """Заполнить email на forgot и нажать Senden (без ожидания «E-Mail versendet»)."""
    from kleinanzeigen_login import _try_dismiss_cookie_banners

    _try_dismiss_cookie_banners(page)
    dbg.step(page, "forgot_initial")
    time.sleep(0.35)
    filled = False
    for fr in _ordered_frames(page):
        vis_mail = fr.locator('input[type="email"], input[name="email"]').first
        try:
            if vis_mail.count() and vis_mail.is_visible(timeout=1200):
                vis_mail.fill(email_kl, timeout=8000)
                filled = True
                break
        except Exception:
            pass
    if not filled:
        for fr in _ordered_frames(page):
            for sel in ("input#email", 'input[autocomplete="email"]'):
                loc = fr.locator(sel).first
                try:
                    if loc.count() and loc.is_visible(timeout=800):
                        loc.fill(email_kl, timeout=8000)
                        filled = True
                        break
                except Exception:
                    continue
            if filled:
                break
    if not filled:
        raise RuntimeError("Klein: поле E-Mail на странице «Passwort vergessen» не найдено")
    dbg.step(page, "forgot_filled")
    clicked = False
    # Кнопка может быть в другом фрейме, чем поле email (редко, но не ограничиваем target_fr).
    for fr in _ordered_frames(page):
        for btn_rx in (
            re.compile(r"^Senden$", re.I),
            re.compile(r"E-Mail\s+senden", re.I),
            re.compile(r"Weiter", re.I),
            re.compile(r"Absenden", re.I),
        ):
            try:
                b = fr.get_by_role("button", name=btn_rx).first
                if b.count() and b.is_visible(timeout=1200):
                    b.click(timeout=12000)
                    clicked = True
                    break
            except Exception:
                continue
        if clicked:
            break
    if not clicked:
        for fr in _ordered_frames(page):
            try:
                sub = fr.locator('button[type="submit"]').first
                if sub.count() and sub.is_visible(timeout=1200):
                    sub.click(timeout=12000)
                    clicked = True
                    break
            except Exception:
                continue
    if not clicked:
        page.locator('button[type="submit"]').first.click(timeout=12000)
    try:
        page.wait_for_load_state("domcontentloaded", timeout=30000)
    except Exception:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=12000)
    except Exception:
        pass
    time.sleep(1.6)
    dbg.step(page, "forgot_after_submit")


def _wait_forgot_post_submit_ip_block_only(page: Page, dbg: KleinResetDebug, *, timeout_sec: float) -> None:
    """После Senden: только детект IP-Bereich (как в _wait_forgot_email_sent_confirmation), без требования «versendet»."""
    t0 = time.monotonic()
    deadline = t0 + timeout_sec
    last_snap = 0.0
    while time.monotonic() < deadline:
        low_h, low_b = _gather_forgot_page_low_texts(page)
        if _klein_ip_range_blocked_from_text(low_h) or _klein_ip_range_blocked_from_text(low_b):
            raise RuntimeError(
                "Klein: IP-Bereich bei Kleinanzeigen gesperrt — andere Proxy-IP (residential) oder später erneut versuchen"
            )
        block = _page_looks_like_klein_captcha_or_block(page)
        if block == "klein_ip_range":
            raise RuntimeError(
                "Klein: IP-Bereich bei Kleinanzeigen gesperrt — andere Proxy-IP (residential) oder später erneut versuchen"
            )
        now = time.monotonic()
        if dbg.enabled and now - last_snap > 7.0:
            dbg.step(page, "forgot_ip_probe_poll")
            last_snap = now
        time.sleep(0.45)


def klein_ip_probe_forgot_after_submit(
    page: Page, email_kl: str, *, dbg: Optional[KleinResetDebug] = None, after_submit_wait_sec: float = 20.0
) -> None:
    """
    Как шаги Klein-Reset до ожидания письма: assert на загрузке → email → Senden → короткий опрос IP-Sperre.
    Для klein_ip_probe при подозрении, что блок только после отправки формы.
    """
    d = dbg if dbg is not None else KleinResetDebug("ip-probe")
    _assert_klein_not_ip_blocked(page)
    _fill_forgot_email_and_click_send(page, email_kl, d)
    _wait_forgot_post_submit_ip_block_only(page, d, timeout_sec=float(after_submit_wait_sec))


def _fill_forgot_email_and_send(page: Page, email_kl: str, dbg: KleinResetDebug) -> None:
    _fill_forgot_email_and_click_send(page, email_kl, dbg)
    _wait_forgot_email_sent_confirmation(page, dbg, timeout_sec=55.0)


def _combined_frame_text(fr: Frame) -> str:
    try:
        t = fr.evaluate(
            """() => {
            try {
              const b = document.body;
              return b && b.innerText ? b.innerText : '';
            } catch (e) { return ''; }
        }"""
        )
        return t if isinstance(t, str) else ""
    except Exception:
        return ""


def _fill_reset_password_form(page: Page, new_pw: str, dbg: KleinResetDebug) -> None:
    dbg.step(page, "reset_before_fill")
    time.sleep(1.0)
    target_fr: Optional[Frame] = None
    pws = None
    for _ in range(28):
        for fr in _ordered_frames(page):
            loc = fr.locator('input[type="password"]')
            try:
                cnt = loc.count()
            except Exception:
                continue
            for j in range(min(cnt, 6)):
                el = loc.nth(j)
                try:
                    if el.is_visible(timeout=400):
                        target_fr = fr
                        pws = loc
                        break
                except Exception:
                    continue
            if target_fr is not None:
                break
        if target_fr is not None:
            break
        time.sleep(0.5)
    if target_fr is None or pws is None:
        raise RuntimeError("Klein: нет полей пароля на странице сброса")
    filled = 0
    n = min(pws.count(), 6)
    for i in range(n):
        try:
            el = pws.nth(i)
            if el.is_visible(timeout=1200):
                el.click(timeout=3000)
                el.fill(new_pw, timeout=10000)
                filled += 1
                if filled >= 2:
                    break
        except Exception:
            continue
    if filled < 1:
        raise RuntimeError("Klein: не удалось заполнить поля нового пароля")
    dbg.step(page, "reset_filled")
    clicked = False
    for fr in _ordered_frames(page):
        for name in (
            re.compile(r"Passwort\s+(ändern|speichern|setzen)", re.I),
            re.compile(r"^Weiter$", re.I),
            re.compile(r"Bestätigen", re.I),
            re.compile(r"Speichern", re.I),
            re.compile(r"^OK$", re.I),
        ):
            try:
                b = fr.get_by_role("button", name=name).first
                if b.count() and b.is_visible(timeout=900):
                    b.click(timeout=15000)
                    clicked = True
                    break
            except Exception:
                continue
        if clicked:
            break
    if not clicked:
        for fr in _ordered_frames(page):
            try:
                sub = fr.locator('button[type="submit"]').first
                if sub.count() and sub.is_visible(timeout=800):
                    sub.click(timeout=15000)
                    clicked = True
                    break
            except Exception:
                continue
    if not clicked:
        page.locator('button[type="submit"]').first.click(timeout=15000)
    time.sleep(2.0)
    dbg.step(page, "reset_after_submit")


def _click_success_einloggen(page: Page, dbg: KleinResetDebug) -> None:
    dbg.step(page, "wait_success_modal_start")
    deadline = time.monotonic() + 50.0
    last_snap = 0.0
    while time.monotonic() < deadline:
        found = False
        for fr in _ordered_frames(page):
            txt = _combined_frame_text(fr).lower()
            if "erfolgreich geändert" in txt or "passwort erfolgreich" in txt or "du hast dein passwort" in txt:
                found = True
                break
        if found:
            dbg.step(page, "success_modal_text_seen")
            break
        now = time.monotonic()
        if dbg.enabled and now - last_snap > 8.0:
            dbg.step(page, "wait_success_modal_poll")
            last_snap = now
        time.sleep(0.55)
    for fr in _ordered_frames(page):
        btn = fr.get_by_role("button", name=re.compile(r"Einloggen", re.I)).first
        try:
            if btn.count() and btn.is_visible(timeout=2500):
                btn.click(timeout=15000)
                time.sleep(2.0)
                dbg.step(page, "after_einloggen_click")
                return
        except Exception:
            continue
    for fr in _ordered_frames(page):
        link = fr.get_by_role("link", name=re.compile(r"Einloggen", re.I)).first
        try:
            if link.count() and link.is_visible(timeout=2000):
                link.click(timeout=12000)
                time.sleep(2.0)
                dbg.step(page, "after_einloggen_link")
                return
        except Exception:
            continue
    raise RuntimeError("Klein: после смены пароля не найдена кнопка «Einloggen»")


def run_klein_password_reset_flow(
    context: Optional[BrowserContext],
    page_mail: Optional[Page],
    email_kl: str,
    new_password: str,
    *,
    headless: bool,
    base_url: str,
    lead_id: str,
    worker_secret: str,
    login_url: str,
    on_sms_redirect: Callable[[], None],
    on_step: Optional[Callable[[str], None]] = None,
    playwright=None,
    mail_proxy_config: Optional[dict] = None,
    fingerprint_index: Optional[int] = None,
    force_separate_klein: bool = False,
    mail_browser_opener: Optional[Callable[[], Tuple[Browser, BrowserContext, Page]]] = None,
    mail_session_out: Optional[dict] = None,
) -> int:
    """
    on_step: вызов на каждом крупном шаге (для /api/script-event в оркестраторе).
    Возврат: 0 успех; 2 layout; 3 SMS таймаут; 4 OTP; 6 ошибка учётки; 7 почта/письмо; 8 сброс формы; 9 IP Klein gesperrt.

    Три браузера (Klein-оркестрация): ① вход WEB.DE + фильтры (закрывается до сюда); ② только Klein
    (forgot + ссылка сброса + ULP) — без куков почты; ③ только WEB.DE Postfach/Papierkorb,
    те же прокси/отпечаток/куки что у ①. Ссылка из письма передаётся во ② через page.goto.

    Оркестратор: force_separate_klein=True + mail_browser_opener — сначала ② (forgot/Senden), затем opener() → ③.
    Без opener при separate: передать готовые context/page_mail (браузер ③ уже открыт).
    mail_session_out: при открытии ③ через opener сюда пишутся ключи browser, context, page (для закрытия снаружи).

    force_separate_klein=True (оркестратор): всегда изолированный Chromium для Klein; иначе
    KLEIN_RESET_KLEIN_SEPARATE_BROWSER=1 — то же самое через env.
    """
    from kleinanzeigen_login import klein_login_with_page

    dbg = KleinResetDebug(lead_id)
    forgot = (os.environ.get("KLEIN_RESET_FORGOT_URL") or DEFAULT_FORGOT_URL).strip()
    print(f"[Klein-Reset] первый переход (новая вкладка): {forgot}", flush=True)

    separate = bool(force_separate_klein) or _truthy("KLEIN_RESET_KLEIN_SEPARATE_BROWSER")
    klein_browser: Optional[Browser] = None
    ctx_klein: Optional[BrowserContext] = None
    kp: Optional[Page] = None

    if separate and mail_browser_opener and (context is not None or page_mail is not None):
        raise RuntimeError(
            "Klein-Reset: при mail_browser_opener передайте context=None и page_mail=None (почта открывается после forgot)"
        )
    if separate and not mail_browser_opener and (context is None or page_mail is None):
        raise RuntimeError(
            "Klein-Reset: отдельный Klein без mail_browser_opener — нужны context и page_mail (браузер ③ уже открыт)"
        )
    if not separate and (context is None or page_mail is None):
        raise RuntimeError("Klein-Reset: без отдельного Klein нужны context и page_mail")

    if separate:
        if playwright is None:
            raise RuntimeError(
                "Klein: изолированный браузер ② — в run_klein_password_reset_flow нужен playwright (сессия оркестратора)"
            )
        print(
            "[Klein-Reset] браузер ②: отдельный Chromium без куков WEB.DE (forgot/Senden → затем ③ → ссылка → ULP)",
            flush=True,
        )
        px_klein = None if _truthy("KLEIN_RESET_KLEIN_BROWSER_NO_PROXY") else mail_proxy_config
        klein_browser, ctx_klein = _launch_isolated_klein_browser(
            playwright,
            fingerprint_index=fingerprint_index,
            headless=headless,
            proxy_config=px_klein,
        )
        kp = ctx_klein.new_page()
        work_ctx = ctx_klein
    else:
        kp = context.new_page()
        work_ctx = context

    try:
        _notify_step(on_step, STEP_KLEIN_FORGOT_OPEN)
        assert kp is not None
        kp.goto(forgot, wait_until="load", timeout=90_000)
        dbg.step(kp, "klein_forgot_loaded")
        _assert_klein_not_ip_blocked(kp)
        _fill_forgot_email_and_send(kp, email_kl, dbg)
        _notify_step(on_step, STEP_KLEIN_FORGOT_SENT)

        if separate and mail_browser_opener:
            print(
                "[Klein-Reset] браузер ③: WEB.DE с куками/прокси/fp как у ① — вход в Postfach после запроса сброса",
                flush=True,
            )
            b_mail, ctx_mail, pg_mail = mail_browser_opener()
            if mail_session_out is not None:
                mail_session_out.clear()
                mail_session_out["browser"] = b_mail
                mail_session_out["context"] = ctx_mail
                mail_session_out["page"] = pg_mail
            mail_pg = _open_webde_postfach(pg_mail, ctx_mail)
        else:
            assert page_mail is not None and context is not None
            mail_pg = _open_webde_postfach(page_mail, context)
        dbg.step(mail_pg, "mail_postfach")
        _notify_step(on_step, STEP_WEBDE_POSTFACH)
        _click_papierkorb_in_mail(mail_pg)
        dbg.step(mail_pg, "mail_in_papierkorb")
        _notify_step(on_step, STEP_WEBDE_PAPIERKORB)

        if separate:
            reset_url = _find_klein_reset_link_url(mail_pg, dbg)
            reset_pg = ctx_klein.new_page()
            reset_pg.goto(reset_url, wait_until="load", timeout=120_000)
            dbg.step(reset_pg, "reset_page_goto_isolated")
        else:
            reset_pg = _find_and_click_klein_reset_link(mail_pg, context, dbg)
        _notify_step(on_step, STEP_MAIL_LINK_OPEN)
        try:
            reset_pg.bring_to_front()
        except Exception:
            pass

        _fill_reset_password_form(reset_pg, new_password, dbg)
        _notify_step(on_step, STEP_RESET_PASS_SUBMIT)
        _click_success_einloggen(reset_pg, dbg)
        _notify_step(on_step, STEP_RESET_SUCCESS)
        try:
            reset_pg.wait_for_load_state("domcontentloaded", timeout=30000)
        except Exception:
            pass
        time.sleep(1.0)

        active = reset_pg
        try:
            u = (reset_pg.url or "").lower()
            if "einloggen" not in u and "authorize" not in u and "login" not in u:
                for pg in work_ctx.pages:
                    ul = (pg.url or "").lower()
                    if "kleinanzeigen" in ul or "auth0" in ul or "login" in ul:
                        active = pg
                        break
        except Exception:
            pass
        try:
            active.bring_to_front()
        except Exception:
            pass
        dbg.step(active, "before_klein_ulip_login")
        _notify_step(on_step, STEP_ULIP_LOGIN)

        def _mfa():
            on_sms_redirect()

        exit_login = klein_login_with_page(
            active,
            email_kl,
            new_password,
            login_url=login_url,
            headless=headless,
            api_base=base_url,
            lead_id=lead_id,
            worker_secret=worker_secret,
            skip_initial_goto=True,
            on_mfa_start=_mfa,
        )
        dbg.step(active, f"after_ulip_login_exit_{exit_login}")
        if exit_login == 0:
            _upload_lead_cookies(work_ctx, base_url, lead_id, worker_secret)
            _notify_step(on_step, STEP_COOKIES_UPLOAD)
        return exit_login
    except RuntimeError as e:
        print(f"[Klein-Reset] {e}", flush=True)
        try:
            if kp:
                dbg.step(kp, "error_state")
        except Exception:
            pass
        msg = str(e).lower()
        if "papierkorb" in msg or "postfach" in msg or "письмо" in msg or "ссылка" in msg:
            return 7
        if "ip-bereich" in msg or ("gesperrt" in msg and "klein" in msg):
            return 9
        if (
            "passwort vergessen" in msg
            or "поле e-mail" in msg
            or "аккаунт" in msg
            or "нет подтверждения" in msg
            or "блокировку/капчу" in msg
        ):
            return 8
        return 2
    except Exception as e:
        print(f"[Klein-Reset] {type(e).__name__}: {e}", flush=True)
        try:
            if kp:
                dbg.step(kp, "error_exception")
        except Exception:
            pass
        return 2
    finally:
        if klein_browser:
            try:
                klein_browser.close()
            except Exception:
                pass
        elif ctx_klein:
            try:
                ctx_klein.close()
            except Exception:
                pass
        else:
            try:
                if kp:
                    kp.close()
            except Exception:
                pass
