#!/usr/bin/env python3
"""
После успешного входа WEB.DE: главная → меню профиля → E-Mail Einstellungen →
hub настроек `navigator.web.de/mail_settings?sid=…` — в сайдбаре пункт «Filterregeln»;
редактор правил часто уезжает на другой хост, путь вида `…/mail/client/settings/filterrules`
(напр. `3c.web.de/.../filterrules;jsessionid=…`). Если вкладка уже на filterrules — клик по сайдбару не нужен.
Далее в основной колонке кнопка
«Filterregel(n) erstellen» (встречается и ед.ч.) → модалка с тем же заголовком →
«Alle neuen E-Mails» → «Verschiebe in Ordner» → «Papierkorb» → сохранение:
«Filterregel einrichten» или «Filterregel erstellen» (альт. подпись в футере модалки).

Зависит только от Playwright; логирует в stdout. Селекторы ориентированы на немецкий UI (2025–2026).

Вариант BAP/navigator: форма .customfilter — условие <select value="ALL_MAILS">, папка — [data-webdriver="moveToButton"]
и пункты flyout как input.menu-item[value="Papierkorb"], не <select> и часто без role=option.

После успеха: в stdout печатается «Фильтр - корзина включен»; куки дополнительно пишутся в
login/cookies/<email>.json (нужны WEBDE_TEST_EMAIL или WEBDE_EMAIL). После callback входа WEB.DE
куки всё равно сохраняются ещё раз — файл будет актуален.
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

from playwright.sync_api import BrowserContext, Page, TimeoutError as PlaywrightTimeout

# Подписи в UI WEB.DE плавают: «Filterregeln…» / «Filterregel…»
RE_BTN_OPEN_FILTER_MODAL = re.compile(r"Filterregeln?\s+erstellen", re.I)
RE_MODAL_FILTER_TITLE = re.compile(r"Filterregeln?\s+erstellen", re.I)
RE_BTN_SAVE_EINRICHTEN = re.compile(r"Filterregel\s+einrichten", re.I)
RE_BTN_SAVE_ERSTELLEN = re.compile(r"Filterregel\s+erstellen", re.I)

# Тот же критерий, что wait_for_function в _wait_webde_portal_after_goto.
# Важно: у гостя тоже есть <account-avatar> и «кнопка профиля» — без отсечения Login/Anmelden
# STEP-02 считался успешным, а в flyout не было «E-Mail Einstellungen».
_WEBDE_PORTAL_LOGGED_IN_JS = r"""() => {
  const href = location.href || '';
  if (href.includes('consent-management') || href.includes('consent.app')) return false;
  if (!href.includes('web.de')) return false;
  const body = document.body;
  if (!body) return false;
  const t = body.innerText || '';
  const tl = t.toLowerCase();
  if (t.indexOf('Sie sind eingeloggt') >= 0) return true;
  if (t.indexOf('Zum Postfach') >= 0) return true;

  function guestLoginInHeader() {
    const scope = document.querySelector('header') || body;
    const sel = scope.querySelectorAll('a, button, [role="button"]');
    for (const el of sel) {
      const raw = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const isLogin =
        raw === 'login' ||
        raw === 'anmelden' ||
        raw === 'einloggen' ||
        raw.startsWith('login ') ||
        raw.startsWith('anmelden ') ||
        raw.startsWith('einloggen ');
      if (!isLogin) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.top > 140) continue;
      return true;
    }
    return false;
  }
  if (guestLoginInHeader()) return false;

  const lux = document.querySelector(
    'account-avatar.webde[role="button"], account-avatar.webde.hydrated'
  );
  if (lux) {
    const r = lux.getBoundingClientRect();
    if (r.width >= 10 && r.height >= 10) return true;
  }
  const avAppa = document.querySelector(
    'account-avatar[role="button"][aria-controls*="appa"]'
  );
  if (avAppa) {
    const r2 = avAppa.getBoundingClientRect();
    if (r2.width >= 10 && r2.height >= 10) return true;
  }
  return false;
}"""


def _webde_portal_logged_in_ui(page: Page) -> bool:
    try:
        return bool(page.evaluate(_WEBDE_PORTAL_LOGGED_IN_JS))
    except Exception:
        return False


def _ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _email_for_cookie_export() -> str:
    return (
        (os.environ.get("WEBDE_TEST_EMAIL") or os.environ.get("WEBDE_EMAIL") or "").strip()
    )


def _save_cookies_after_filter_success(context: BrowserContext) -> None:
    """После «фильтр в корзину» — актуальный JSON в login/cookies/ (тот же файл, что после входа)."""
    email = _email_for_cookie_export()
    if not email:
        flog(
            "куки после фильтра",
            "email не задан (WEBDE_TEST_EMAIL / WEBDE_EMAIL) — пропуск записи из сценария фильтров",
        )
        return
    try:
        from webde_login import save_cookies_for_account

        path = save_cookies_for_account(context, email)
        flog("куки после фильтра", path)
    except Exception as e:
        flog("куки после фильтра", f"ошибка: {e!s}"[:120])


def flog(msg: str, detail: str = "") -> None:
    line = f"[{_ts()}] [WEB.DE][FILTERS] {msg}"
    if detail:
        line += f" — {detail}"
    print(line, flush=True)


def _filters_screenshots_enabled() -> bool:
    return os.environ.get("WEBDE_FILTERS_SCREENSHOTS", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _filters_milestone_shots_enabled() -> bool:
    return os.environ.get("WEBDE_FILTERS_SCREENSHOT_MILESTONES", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _filters_debug_dir() -> Path:
    return Path(__file__).resolve().parent / "debug_filters"


def _filters_fast_mode() -> bool:
    """WEBDE_FILTERS_FAST=1 — короче ожидания и sleep (удобно с открытым браузером)."""
    return os.environ.get("WEBDE_FILTERS_FAST", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _fsleep(sec: float, fast_sec: float | None = None) -> None:
    """Спим меньше в fast-режиме; fast_sec по умолчанию ~половина sec (мин. 0.12)."""
    if _filters_fast_mode():
        t = fast_sec if fast_sec is not None else max(0.12, sec * 0.35)
        time.sleep(t)
    else:
        time.sleep(sec)


def filters_log_state(page: Page, step: str) -> None:
    """Детальный дамп вкладки: URL, title, список frame, фрагмент body."""
    try:
        page.bring_to_front()
    except Exception:
        pass
    try:
        live = _page_url_live(page)[:240]
    except Exception:
        live = "?"
    try:
        title = page.title()[:140]
    except Exception:
        title = "?"
    try:
        nframes = len(page.frames)
    except Exception:
        nframes = -1
    flog(f"STATE[{step}] url", live)
    flog(f"STATE[{step}] meta", f"title={title!r} · frames={nframes}")
    try:
        parts = []
        for i, fr in enumerate(page.frames[:14]):
            try:
                parts.append(f"[{i}] {(fr.url or '')[:72]}")
            except Exception:
                parts.append(f"[{i}] ?")
        if parts:
            flog(f"STATE[{step}] frames", " · ".join(parts)[:260])
    except Exception:
        pass
    try:
        snippet = page.evaluate(
            """() => {
            const b = document.body;
            if (!b || !b.innerText) return '';
            return (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
          }"""
        )
        if snippet:
            flog(f"STATE[{step}] body[:500]", snippet)
    except Exception as ex:
        flog(f"STATE[{step}] body", f"не прочитан: {ex!s}"[:100])


def filters_screenshot(page: Page, tag: str) -> str | None:
    """Полноэкранный скрин вкладки в login/debug_filters/. Возвращает путь или None."""
    if not _filters_screenshots_enabled():
        return None
    try:
        d = _filters_debug_dir()
        d.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe = re.sub(r"[^\w\-\.]+", "_", tag, flags=re.I).strip("_")[:85]
        path = d / f"{ts}_{safe}.png"
        page.screenshot(path=str(path), full_page=True, timeout=90000)
        flog("SCREENSHOT сохранён", str(path))
        return str(path)
    except Exception as e:
        flog("SCREENSHOT ошибка", str(e)[:150])
        return None


def filters_capture_debug(page: Page, tag: str) -> None:
    """Лог состояния + скрин (на застревании / перед исключением)."""
    flog("─── отладка ◀", tag)
    try:
        filters_log_state(page, tag)
    except Exception as e:
        flog("STATE ошибка", str(e)[:120])
    try:
        filters_screenshot(page, tag)
    except Exception:
        pass


def _filters_milestone(page: Page, tag: str) -> None:
    if _filters_milestone_shots_enabled():
        flog("milestone", tag)
        filters_screenshot(page, f"milestone_{tag}")


def _filters_raise(page: Page, step_tag: str, msg: str) -> None:
    flog("СТОП: исключение", f"{step_tag}: {msg[:220]}")
    filters_capture_debug(page, f"fail_{step_tag}")
    raise RuntimeError(msg)


def _page_url_live(p: Page) -> str:
    """
    Фактический URL из document.location (page.url у Playwright иногда отстаёт
    после цепочки редиректов link.web.de → alligator/start → bap/mail_settings).
    """
    try:
        if p.is_closed():
            return ""
    except Exception:
        return ""
    try:
        href = p.evaluate(
            "() => (typeof location !== 'undefined' && location.href) ? location.href : ''"
        )
        if isinstance(href, str) and href.strip():
            return href.strip()
    except Exception:
        pass
    try:
        return (p.url or "").strip()
    except Exception:
        return ""


def _pick_settings_page(context: BrowserContext, fallback: Page) -> Page:
    """Вкладка с настройками почты. Приоритет: mail_settings, не промежуточный /start/?state=."""
    def score(url: str) -> int:
        ul = url.lower()
        if "mail_settings" in ul:
            return 4
        if "showmailsettings" in ul:
            return 3
        if "navigator.web.de" in ul:
            if "/start/" in ul and "state=" in ul:
                return 0  # alligator launcher — ждём редирект
            return 1
        return 0

    best_p, best_s = None, -1
    for p in context.pages:
        u = _page_url_live(p)
        if not u:
            continue
        s = score(u)
        if s > best_s:
            best_s, best_p = s, p
    if best_p is not None and best_s > 0:
        try:
            best_p.bring_to_front()
        except Exception:
            pass
        return best_p
    return fallback


def _navigator_url_ready_for_sidebar(url: str) -> bool:
    """True только когда открыт интерфейс настроек (есть сайдбар), не launcher start/state."""
    ul = (url or "").lower()
    if "mail_settings" in ul:
        return True
    if "showmailsettings" in ul:
        return True
    if "/start/" in ul and "state=" in ul:
        return False
    if "alligator.navigator" in ul and "start" in ul:
        return False
    return False


def _try_click_cmp_accept_buttons(page: Page) -> bool:
    """Типичные кнопки CMP на /consent-management/ и похожих страницах."""
    patterns = [
        re.compile(r"Akzeptieren und weiter", re.I),
        re.compile(r"Alle akzeptieren", re.I),
        re.compile(r"Zustimmen und weiter", re.I),
        re.compile(r"Einverstanden", re.I),
        re.compile(r"Weiter zur Webseite", re.I),
    ]
    for pat in patterns:
        btn = page.get_by_role("button", name=pat)
        if btn.count() > 0:
            try:
                btn.first.click(timeout=10000)
                flog("CMP: кнопка", pat.pattern[:50])
                time.sleep(2)
                return True
            except Exception:
                pass
    for sel in (
        'button:has-text("Akzeptieren")',
        'a:has-text("Akzeptieren")',
        '[role="link"]:has-text("Akzeptieren")',
    ):
        loc = page.locator(sel)
        if loc.count() > 0:
            try:
                loc.first.click(timeout=8000)
                flog("CMP: селектор", sel)
                time.sleep(2)
                return True
            except Exception:
                pass
    return False


def _sso_navigator_then_webde_portal(page: Page) -> bool:
    """
    После auth.web.de куки иногда не «приклеиваются» к главной web.de сразу.
    Один проход через navigator.web.de часто поднимает SSO, затем повторный goto web.de/.
    """
    try:
        flog(
            "SSO-fallback",
            "переход на https://navigator.web.de/ для поднятия сессии, затем снова web.de/",
        )
        page.goto("https://navigator.web.de/", wait_until="domcontentloaded", timeout=120000)
        time.sleep(2.5)
        ul = (page.url or "").lower()
        if any(x in ul for x in ("auth.web.de", "/login", "anmelden", "einloggen")):
            flog("SSO-fallback", f"навигатор не залогинен: {ul[:100]}")
            return False
        flog("STEP-01b", "повтор https://web.de/ после навигатора")
        page.goto("https://web.de/", wait_until="domcontentloaded", timeout=120000)
        time.sleep(2.0)
        page.wait_for_function(_WEBDE_PORTAL_LOGGED_IN_JS, timeout=45000)
        flog("SSO-fallback", "главная web.de после навигатора — признаки входа OK")
        return True
    except Exception as e:
        flog("SSO-fallback", f"не удалось: {str(e)[:120]}")
    return False


def _wait_webde_portal_after_goto(page: Page, timeout_sec: float = 90.0) -> None:
    """
    После goto https://web.de/ часто редирект на /consent-management/ — без принятия CMP
    нет «Sie sind eingeloggt» и меню профиля. Ждём выхода с consent и явных признаков главной.
    """
    from webde_login import close_consent_popup

    deadline = time.monotonic() + timeout_sec
    last_heartbeat = 0.0
    u_last = ""

    while time.monotonic() < deadline:
        try:
            u = (page.url or "").lower()
        except Exception:
            u = ""
        u_last = u

        on_consent = "consent-management" in u or "consent.app" in u or "/permission" in u

        if on_consent:
            flog("страница согласия (CMP) — закрываю и жду редирект", u[:100])
            try:
                close_consent_popup(page, wait_for_appear=22)
            except Exception as ex:
                flog("close_consent_popup", str(ex)[:100])
            _try_click_cmp_accept_buttons(page)
            try:
                page.wait_for_load_state("domcontentloaded", timeout=30000)
            except Exception:
                pass
            time.sleep(1.2)
            continue

        if "web.de" not in u:
            time.sleep(0.25)
            continue

        # Гость тоже имеет <account-avatar> — ждём явный текст или avatar без видимого Login/Anmelden в шапке.
        remaining_ms = int(max(500, min(20000, (deadline - time.monotonic()) * 1000)))
        try:
            page.wait_for_function(
                _WEBDE_PORTAL_LOGGED_IN_JS,
                timeout=remaining_ms,
            )
            flog("главная готова: обнаружен залогиненный UI или иконка профиля (wait_for_function)")
            return
        except PlaywrightTimeout:
            pass

        if time.monotonic() - last_heartbeat > 10:
            last_heartbeat = time.monotonic()
            flog("жду главную web.de после CMP/загрузки…", u[:110])

        time.sleep(0.25)

    if _sso_navigator_then_webde_portal(page):
        return

    raise RuntimeError(
        f"Таймаут {timeout_sec:.0f}с: главная web.de не готова (url={u_last[:180]!r}). "
        "Примите CMP вручную или увеличьте таймаут."
    )


def _safe_click(locator, timeout: float = 15000) -> bool:
    try:
        locator.first.wait_for(state="visible", timeout=timeout)
        locator.first.click(timeout=timeout)
        return True
    except PlaywrightTimeout:
        return False
    except Exception:
        return False


def _mouse_click_locator_center(locator, timeout: float = 14000) -> bool:
    """
    Клик мышью по центру bbox (viewport). Иногда Wicket не реагирует на Playwright click(force),
    но принимает нативный mouse-down/up.
    """
    try:
        page = locator.page
    except Exception:
        return False
    try:
        tgt = locator.first
        tgt.wait_for(state="visible", timeout=min(timeout, 15000))
        tgt.scroll_into_view_if_needed(timeout=min(10000, int(timeout)))
        box = tgt.bounding_box()
        if not box or box.get("width", 0) < 2 or box.get("height", 0) < 2:
            return False
        x = box["x"] + box["width"] / 2
        y = box["y"] + box["height"] / 2
        page.mouse.move(x, y)
        time.sleep(0.05)
        page.mouse.click(x, y)
        return True
    except Exception:
        return False


def _try_click_first_or_last_force(locator, timeout: float = 18000, prefer_last: bool = True) -> bool:
    """Клик с force=True — оверлей/spinner Wicket часто блокирует обычный click."""
    try:
        n = locator.count()
        if n == 0:
            return False
        target = locator.last if prefer_last and n > 1 else locator.first
        try:
            target.scroll_into_view_if_needed(timeout=min(10000, int(timeout)))
        except Exception:
            pass
        target.click(timeout=timeout, force=True)
        return True
    except Exception:
        return False


def _wait_wicket_modal_spinner_hidden(scope, timeout_ms: int = 30000) -> None:
    """
    Пока виден .layer-dialog.spinner, отправка формы не срабатывает (кнопка есть, клик «глотается»).
    """
    try:
        spin = scope.locator(".layer-dialog.spinner, .layer-root .layer-dialog.spinner")
        if spin.count() == 0:
            return
        try:
            if not spin.first.is_visible(timeout=800):
                return
        except Exception:
            return
        spin.first.wait_for(state="hidden", timeout=timeout_ms)
        flog("Wicket", "спиннер модалки скрыт — жму «Filterregel einrichten»")
    except Exception as ex:
        flog("Wicket спиннер", f"ожидание: {ex!s}"[:70])


def _wait_spinner_only_near_customfilter(page: Page, timeout_ms: int = 12000) -> None:
    """
    Глобальный контейнер #idd1 часто держит .layer-dialog.spinner в DOM — ждать его на всём page
    даёт ложное «вечное» ожидание. Здесь только спиннер внутри layer-root, где есть form.customfilter.
    """
    tmo = min(timeout_ms, 14000) if _filters_fast_mode() else timeout_ms
    try:
        roots = page.locator(".layer-root").filter(has=page.locator("form.customfilter"))
        if roots.count() == 0:
            return
        spin = roots.first.locator(".layer-dialog.spinner")
        if spin.count() == 0:
            return
        try:
            if not spin.first.is_visible(timeout=600):
                return
        except Exception:
            return
        spin.first.wait_for(state="hidden", timeout=tmo)
        flog("Wicket", "спиннер у модалки .customfilter скрыт")
    except Exception as ex:
        flog("Wicket спиннер (customfilter)", f"{ex!s}"[:70])


def _js_click_customfilter_save_ok(target) -> bool:
    """target — Page или Frame: реальный клик по кнопке в форме BAP (обходит перекрытия)."""
    try:
        ok = target.evaluate(
            """() => {
            const form = document.querySelector('form.customfilter');
            if (!form) return false;
            const btn = form.querySelector('button[data-webdriver="ok"]');
            if (!btn || btn.offsetParent === null) return false;
            btn.scrollIntoView({ block: 'center', inline: 'center' });
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            if (typeof btn.click === 'function') btn.click();
            return true;
          }"""
        )
        return bool(ok)
    except Exception:
        return False


def _js_click_bap_save_ok_all_frames(page: Page) -> bool:
    for tgt in [page] + list(page.frames):
        try:
            if _js_click_customfilter_save_ok(tgt):
                flog("сохранение правила", "JS: form.customfilter button[data-webdriver=ok]")
                return True
        except Exception:
            continue
    return False


def _iter_mail_settings_targets(page: Page):
    """Корень вкладки + все frame (модал Smarte Funktionen часто в iframe)."""
    yield page
    try:
        for fr in page.frames:
            yield fr
    except Exception:
        pass


def _try_dismiss_smarte_modal_in_target(target) -> bool:
    """
    Один контекст (Page/Frame): если виден «Smarte Funktionen» — чекбоксы в диалоге, затем жёлтая кнопка.
    """
    try:
        hint = target.get_by_text(re.compile(r"Smarte\s+Funktionen", re.I))
        if hint.count() == 0:
            return False
        if not hint.first.is_visible(timeout=1500):
            return False
    except Exception:
        return False
    flog(
        "модал Smarte Funktionen",
        "чекбоксы → «Beiden zustimmen und weiter» (или Auswahl übernehmen)",
    )
    root = target
    try:
        dlg = target.locator('[role="dialog"]').filter(
            has_text=re.compile(r"Smarte", re.I)
        )
        if dlg.count() > 0:
            root = dlg.first
        else:
            dlg2 = target.locator('[aria-modal="true"]').filter(
                has_text=re.compile(r"Smarte|WEB\.DE\s+Paket", re.I)
            )
            if dlg2.count() > 0:
                root = dlg2.first
    except Exception:
        root = target
    try:
        cbs = root.locator('input[type="checkbox"]')
        n = min(cbs.count(), 14)
        for i in range(n):
            cb = cbs.nth(i)
            try:
                if not cb.is_visible(timeout=500):
                    continue
                if cb.is_checked():
                    continue
                cb.click(timeout=4000)
                time.sleep(0.15)
            except Exception:
                continue
    except Exception:
        pass
    for pat in (
        re.compile(r"Beiden\s+zustimmen\s+und\s+weiter", re.I),
        re.compile(r"Beide\s+zustimmen\s+und\s+weiter", re.I),
        re.compile(r"Beiden\s+zustimmen", re.I),
        re.compile(r"zustimmen\s+und\s+weiter", re.I),
    ):
        try:
            btn = target.get_by_role("button", name=pat)
            if btn.count() > 0 and _safe_click(btn, timeout=14000):
                time.sleep(1.5)
                return True
        except Exception:
            continue
    try:
        btn2 = target.locator("button").filter(
            has_text=re.compile(r"Beiden\s+zustimmen|zustimmen\s+und\s+weiter", re.I)
        )
        if btn2.count() > 0 and _safe_click(btn2, timeout=14000):
            time.sleep(1.5)
            return True
    except Exception:
        pass
    try:
        link = target.get_by_role("link", name=re.compile(r"Auswahl\s+übernehmen", re.I))
        if link.count() > 0 and _safe_click(link, timeout=8000):
            time.sleep(1.0)
            return True
    except Exception:
        pass
    return False


def _dismiss_smart_features_modal_once(page: Page) -> bool:
    """Один проход по root + frame — для лёгкого опроса внутри цикла ожидания кнопки."""
    for target in _iter_mail_settings_targets(page):
        try:
            if _try_dismiss_smarte_modal_in_target(target):
                return True
        except Exception:
            continue
    return False


def _dismiss_smart_features_modal(page: Page, timeout_ms: int = 25000) -> bool:
    """
    Модал «Smarte Funktionen – schon gesehen?» — опрос root + frame, чекбоксы, затем основная кнопка.
    Возвращает True, если модалку закрыли.
    """
    deadline = time.monotonic() + max(1.0, timeout_ms / 1000.0)
    while time.monotonic() < deadline:
        if _dismiss_smart_features_modal_once(page):
            return True
        time.sleep(0.35)
    flog("модал Smarte Funktionen не найдена за timeout (пропуск)", f"{timeout_ms}ms")
    return False


RE_AUSWAHL_UEBERNOMMEN = re.compile(r"Auswahl\s+wurde\s+übernommen", re.I)


def _js_dismiss_auswahl_uebernommen_in_document() -> str:
    """Выполнять через target.evaluate: закрыть toast «Auswahl wurde übernommen». Возврат clicked|none."""
    return """(() => {
      const body = document.body;
      if (!body) return 'none';
      const t = (body.innerText || '');
      if (t.indexOf('Auswahl wurde') < 0 && t.indexOf('Auswahl wurde \u00fcbernommen') < 0) return 'none';
      const markers = ['Auswahl wurde übernommen', 'Auswahl wurde ubernommen'];
      let anchor = null;
      for (const m of markers) {
        const it = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span,p')).find(
          el => (el.innerText || '').trim().indexOf(m) === 0 || (el.textContent || '').includes(m)
        );
        if (it) { anchor = it; break; }
      }
      let dlg = anchor && (anchor.closest('[role="dialog"]') || anchor.closest('.layer-dialog')
        || anchor.closest('.layer-root') || anchor.closest('[class*="Modal"]') || anchor.closest('[class*="modal"]'));
      if (!dlg) {
        dlg = document.querySelector('[role="dialog"]') || document.querySelector('.layer-dialog') || document.body;
      }
      const tryClick = (el) => {
        if (!el || el.offsetParent === null) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof el.click === 'function') el.click();
        return true;
      };
      const pick = (sel) => Array.from(dlg.querySelectorAll(sel)).find((b) => b.offsetParent !== null);
      if (tryClick(pick('button[aria-label*="Schlie" i]'))) return 'clicked';
      if (tryClick(pick('button[title*="Schlie" i]'))) return 'clicked';
      if (tryClick(pick('[data-webdriver="close"]'))) return 'clicked';
      if (tryClick(pick('button.m-close-button, .m-dialog-close, [class*="dialog-close"] button'))) return 'clicked';
      const buttons = Array.from(dlg.querySelectorAll('button'));
      for (const b of buttons) {
        const ar = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).toLowerCase();
        if ((ar.includes('schlie') || ar.includes('close')) && b.offsetParent) {
          if (tryClick(b)) return 'clicked';
        }
      }
      for (const b of buttons) {
        const tx = (b.innerText || '').trim();
        if ((tx === '×' || tx === '\u00d7' || tx === '\u2715') && b.offsetParent) {
          if (tryClick(b)) return 'clicked';
        }
      }
      const hdr = dlg.querySelector('.layer-dialog-header, [class*="LayerHeader"], [class*="dialog-header"], header');
      if (hdr) {
        const small = Array.from(hdr.querySelectorAll('button')).filter(
          (b) => b.offsetParent && b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().width < 52
        );
        const corner = small.length ? small[small.length - 1] : null;
        if (corner && tryClick(corner)) return 'clicked';
      }
      return 'none';
    })()"""


def _try_dismiss_auswahl_uebernommen_in_target(target) -> bool:
    """Один document (page или frame): модал успеха после Speichern в Einstellungen."""
    try:
        has_marker = target.evaluate(
            """() => {
              const t = (document.body && document.body.innerText) || '';
              return t.indexOf('Auswahl wurde') >= 0 && t.indexOf('bernommen') >= 0;
            }"""
        )
    except Exception:
        return False
    if not has_marker:
        return False
    flog("модал успеха", "«Auswahl wurde übernommen» — закрываю (X / Schließen)")
    try:
        r = target.evaluate(_js_dismiss_auswahl_uebernommen_in_document())
        if r == "clicked":
            time.sleep(0.45)
            return True
    except Exception:
        pass
    root = target
    try:
        dlg = target.locator('[role="dialog"]').filter(has_text=RE_AUSWAHL_UEBERNOMMEN)
        if dlg.count() > 0 and dlg.first.is_visible(timeout=800):
            root = dlg.first
    except Exception:
        pass
    for loc in (
        root.get_by_role("button", name=re.compile(r"Schließen|Close", re.I)),
        root.locator('button[aria-label*="Schließen" i], button[aria-label*="Close" i]'),
    ):
        try:
            if loc.count() > 0 and _safe_click(loc.first, timeout=6000):
                time.sleep(0.4)
                return True
        except Exception:
            continue
    try:
        pg = getattr(target, "page", None) or target
        pg.keyboard.press("Escape")
        time.sleep(0.35)
        gone = not target.evaluate(
            """() => {
              const t = (document.body && document.body.innerText) || '';
              return t.indexOf('Auswahl wurde') >= 0 && t.indexOf('bernommen') >= 0;
            }"""
        )
        if gone:
            return True
    except Exception:
        pass
    return False


_AUSWAHL_MARKER_JS = """() => {
  const t = (document.body && document.body.innerText) || '';
  return t.indexOf('Auswahl wurde') >= 0 && t.indexOf('bernommen') >= 0;
}"""


def _any_mail_settings_scope_has_auswahl_marker(page: Page) -> bool:
    """Быстрая проверка без ожидания — иначе _dismiss ждал бы весь timeout_ms даже при пустой странице."""
    for tgt in _iter_mail_settings_targets(page):
        try:
            if tgt.evaluate(_AUSWAHL_MARKER_JS):
                return True
        except Exception:
            continue
    return False


def _dismiss_auswahl_uebernommen_modal(page: Page, timeout_ms: int = 18000) -> bool:
    """Подтверждение «Auswahl wurde übernommen» — мешает кликам по сайдбару; закрыть X или Schließen."""
    if not _any_mail_settings_scope_has_auswahl_marker(page):
        return False
    deadline = time.monotonic() + max(0.8, timeout_ms / 1000.0)
    while time.monotonic() < deadline:
        for tgt in _iter_mail_settings_targets(page):
            try:
                if _try_dismiss_auswahl_uebernommen_in_target(tgt):
                    return True
            except Exception:
                continue
        time.sleep(0.28)
    return False


def _click_profile_avatar_webde_header(page: Page) -> bool:
    """
    Круг с инициалами (SO) справа в шапке — у WEB.DE часто нет aria-label «Account»,
    только 2–3 буквы внутри кнопки. Ищем в правой части header и кликаем через DOM.
    """
    try:
        result = page.evaluate(
            """() => {
            const appa = document.querySelector('account-avatar.webde[role="button"]')
              || document.querySelector('account-avatar.webde.hydrated')
              || document.querySelector('account-avatar.webde');
            if (appa) {
              const b = appa.getBoundingClientRect();
              if (b.width >= 6 && b.height >= 6) {
                appa.click();
                return { ok: true, mode: 'account-avatar', text: (appa.innerText || '').trim().slice(0, 8), label: (appa.getAttribute('aria-label') || '') };
              }
            }
            const hdr = document.querySelector('header');
            if (!hdr) return { ok: false, reason: 'no header' };
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const rightMin = vw * 0.62;
            const topMax = vh * 0.22;
            const nodes = hdr.querySelectorAll('button, [role="button"], a[href*="account" i], a[href*="konto" i]');
            const candidates = [];
            for (const el of nodes) {
              const b = el.getBoundingClientRect();
              if (b.width < 8 || b.height < 8) continue;
              if (b.right < rightMin) continue;
              if (b.top > topMax) continue;
              const t = (el.innerText || '').replace(/\\s+/g, '').trim();
              const al = (el.getAttribute('aria-label') || '').trim();
              candidates.push({ el, t, al, b, right: b.right });
            }
            candidates.sort((a, b) => b.right - a.right);
            const skipText = /premium|suchen|search|entdecken|login|anmelden|^☰$/i;
            const skipLabel = /premium|suchen|search|menu|menü|navigation/i;
            for (const c of candidates) {
              if (skipLabel.test(c.al)) continue;
              if (c.t.length >= 1 && c.t.length <= 4 && /^[A-ZÄÖÜa-zäöüß\\.\\-]+$/.test(c.t)) {
                c.el.click();
                return { ok: true, mode: 'initials', text: c.t, label: c.al };
              }
            }
            for (const c of candidates) {
              if (!c.t || c.t.length < 1) continue;
              if (skipText.test(c.t) && c.t.length > 3) continue;
              if (skipLabel.test(c.al)) continue;
              if (c.t.length > 24) continue;
              c.el.click();
              return { ok: true, mode: 'right-header', text: c.t, label: c.al };
            }
            return { ok: false, reason: 'no candidate', n: candidates.length };
          }"""
        )
        if isinstance(result, dict) and result.get("ok"):
            flog(
                "клик по кругу профиля (header справа)",
                f"{result.get('mode')} text={result.get('text')!r} label={result.get('label')!r}",
            )
            return True
        flog("аватар по координатам header не найден", str(result)[:120])
    except Exception as e:
        flog("ошибка JS-клика по аватару", str(e)[:100])
    return False


def _click_appa_account_avatar_webde(page: Page) -> bool:
    """
    Портал WEB.DE (Lux): <account-avatar class="webde hydrated" role="button" aria-controls="appa-account-flyout">.
    """
    try:
        tmo = 12000 if not _filters_fast_mode() else 8000
        try:
            page.wait_for_selector(
                "account-avatar.webde, account-avatar[role='button'][aria-controls='appa-account-flyout']",
                state="visible",
                timeout=tmo,
            )
        except Exception:
            pass
        root = page.locator("account-avatar.webde")
        if root.count() == 0:
            root = page.locator('account-avatar[role="button"][aria-controls="appa-account-flyout"]')
        if root.count() == 0:
            root = page.locator("account-avatar[role='button']")
        if root.count() == 0:
            return False
        av = root.first
        vis_tmo = 10000 if not _filters_fast_mode() else 6500
        av.wait_for(state="visible", timeout=vis_tmo)
        av.scroll_into_view_if_needed(timeout=5000)
        av.click(timeout=10000, force=True)
        flog("appa", "клик account-avatar.webde")
        _fsleep(0.45, 0.2)
        if not _appa_flyout_visible(page):
            inner = av.locator(".appa-user-icon, section.appa-user-icon__initials, .appa-user-icon__initials")
            if inner.count() > 0:
                inner.first.click(timeout=8000, force=True)
                flog("appa", "доп. клик по блоку инициалов внутри avatar")
                _fsleep(0.35, 0.15)
        return True
    except Exception as ex:
        flog("appa avatar", str(ex)[:95])
        return False


def _appa_flyout_visible(page: Page) -> bool:
    try:
        fo = page.locator("#appa-account-flyout")
        if fo.count() > 0 and fo.first.is_visible(timeout=600):
            return True
    except Exception:
        pass
    try:
        exp = page.locator('account-avatar[aria-expanded="true"]')
        if exp.count() > 0:
            return True
    except Exception:
        pass
    return False


def _profile_account_menu_seems_open(page: Page) -> bool:
    """
    Меню «открыто» только если есть пункты залогиненного аккаунта.
    Гостевой flyout тоже рисует #appa-account-flyout — без showMailSettings / Abmelden это не успех.
    """
    def _vis(loc) -> bool:
        try:
            return loc.count() > 0 and loc.first.is_visible(timeout=900)
        except Exception:
            return False

    mail_sel = (
        '#appa-account-flyout a[href*="showMailSettings" i], '
        '#appa-account-flyout a.appa-navigation-row[href*="showMailSettings" i], '
        'account-avatar a[href*="showMailSettings" i], '
        'a.appa-navigation-row[href*="showMailSettings" i]'
    )
    if _vis(page.locator(mail_sel)):
        return True
    href_broad = 'a[href*="showMailSettings" i], a[href*="link.web.de" i][href*="settings" i]'
    if _vis(page.locator(href_broad)):
        return True
    try:
        fo = page.locator("#appa-account-flyout")
        if fo.count() > 0 and fo.first.is_visible(timeout=500):
            fin = fo.first.locator("a, [role='link'], [role='menuitem']")
            if _vis(fin.filter(has_text=re.compile(r"E-Mail\s*[-]?\s*Einstellungen", re.I))):
                return True
            if _vis(fo.first.get_by_text(re.compile(r"Abmelden|Ausloggen", re.I))):
                return True
    except Exception:
        pass
    for fr in page.frames:
        if fr is page.main_frame:
            continue
        try:
            l2 = fr.locator(mail_sel)
            if l2.count() > 0 and l2.first.is_visible(timeout=400):
                return True
            l3 = fr.locator(href_broad)
            if l3.count() > 0 and l3.first.is_visible(timeout=400):
                return True
        except Exception:
            continue
    return False


def _assert_webde_session_not_logged_out_portal(page: Page) -> None:
    """Перед профилем проверяем, что не гостевой портал с кнопкой Login (не для вкладки почты)."""
    try:
        u = (_page_url_live(page) or "").lower()
    except Exception:
        u = ""
    if any(x in u for x in ("navigator.web.de", "bap.navigator", "mail_settings", "filterrules")):
        return
    if "web.de" not in u:
        return
    # Главная и Lux/appa подгружаются волнами: сначала гостевой скелет, потом профиль.
    raw_sec = (os.environ.get("WEBDE_PORTAL_LOGIN_POLL_SEC") or "").strip()
    try:
        poll_sec = float(raw_sec) if raw_sec else 45.0
    except ValueError:
        poll_sec = 45.0
    poll_sec = max(8.0, min(120.0, poll_sec))
    deadline = time.monotonic() + poll_sec
    last_log = 0.0
    while time.monotonic() < deadline:
        if _webde_portal_logged_in_ui(page):
            return
        try:
            blob = (page.inner_text("body", timeout=8000) or "").lower()
            if "sie sind eingeloggt" in blob or "zum postfach" in blob:
                return
        except Exception:
            pass
        now = time.monotonic()
        if now - last_log >= 5.0:
            last_log = now
            left = max(0, int(deadline - now))
            flog(
                "портал web.de: жду гидратацию входа (профиль / «Sie sind eingeloggt»)…",
                f"опрос каждую 1s, осталось ~{left}s (WEBDE_PORTAL_LOGIN_POLL_SEC)",
            )
        time.sleep(1.0)
    if _webde_portal_logged_in_ui(page):
        return
    if _sso_navigator_then_webde_portal(page):
        return
    if _webde_portal_logged_in_ui(page):
        return
    try:
        login_hit = page.get_by_role("button", name=re.compile(r"^(Login|Anmelden)$", re.I))
        if login_hit.count() > 0 and login_hit.first.is_visible(timeout=600):
            filters_capture_debug(page, "webde_portal_logged_out")
            raise RuntimeError(
                "WEB.DE: похоже, вы не вошли в аккаунт (на странице видна кнопка Login/Anmelden, "
                "нет признаков «Sie sind eingeloggt»). Войдите снова и запустите сценарий."
            )
    except RuntimeError:
        raise
    except Exception:
        pass


def _navigate_to_webde_portal_for_filters(page: Page) -> None:
    """
    Полный reload https://web.de/ с wait_until=load часто рвёт почтовую сессию (отдельные куки/SSO).
    Если уже в почте/настройках — не уходим на портал. Иначе — мягкий goto (domcontentloaded).
    Принудительно всегда открыть портал: WEBDE_FILTERS_FORCE_WEBDE_GOTO=1
    """
    if os.environ.get("WEBDE_FILTERS_FORCE_WEBDE_GOTO", "0").strip().lower() in (
        "1",
        "true",
        "yes",
    ):
        flog("STEP-01", "WEBDE_FILTERS_FORCE_WEBDE_GOTO — переход на https://web.de/")
        page.goto("https://web.de/", wait_until="domcontentloaded", timeout=120000)
        return
    try:
        u = (_page_url_live(page) or "").lower()
    except Exception:
        u = ""
    if any(
        x in u
        for x in (
            "navigator.web.de",
            "bap.navigator",
            "/mail_settings",
            "filterrules",
            "mail/client",
        )
    ):
        flog(
            "STEP-01",
            "без перехода на портал — уже почта/настройки (лишний web.de сбрасывал сессию)",
        )
        return
    if ("web.de" in u or "www.web.de" in u) and "hilfe." not in u and "auth." not in u:
        if "navigator" not in u and "bap." not in u:
            try:
                blob = (page.inner_text("body", timeout=9000) or "").lower()
                if "sie sind eingeloggt" in blob or "zum postfach" in blob:
                    flog("STEP-01", "без reload — уже на web.de с маркером входа")
                    return
            except Exception:
                pass
    flog("STEP-01", "goto https://web.de/ (domcontentloaded — не полный load)")
    page.goto("https://web.de/", wait_until="domcontentloaded", timeout=120000)


def _open_profile_menu(page: Page, *, _sso_retry: bool = True) -> None:
    flog(
        "открываю меню профиля",
        "STEP: сначала быстрый JS-клик по account-avatar/инициалам в header, затем Playwright appa.",
    )
    try:
        page.bring_to_front()
    except Exception:
        pass

    # 0a) Без длинных wait_for_selector: сразу клик по тому же account-avatar, что видит пользователь (LJ и т.д.)
    if _click_profile_avatar_webde_header(page):
        for _ in range(8):
            if _profile_account_menu_seems_open(page):
                flog("меню профиля открыто", "быстрый JS: account-avatar / инициалы в header")
                return
            time.sleep(0.3)

    # 0b) Lux / Appa: <account-avatar class="webde hydrated" role="button" aria-controls="appa-account-flyout">
    if _click_appa_account_avatar_webde(page):
        for _ in range(10):
            if _profile_account_menu_seems_open(page):
                flog("меню профиля открыто", "appa-account-flyout (E-Mail Einstellungen в DOM)")
                return
            time.sleep(0.35)
        flog("appa", "flyout не подтвердился после клика — запасные пути")

    # 0c) Повтор быстрого JS (после hydration appa мог только что появиться)
    if _click_profile_avatar_webde_header(page):
        for _ in range(6):
            if _profile_account_menu_seems_open(page):
                flog("меню профиля открыто", "повтор JS-клика по аватару")
                return
            time.sleep(0.3)

    # 1) Инициалы в accessible name (редко)
    try:
        vpw = (page.viewport_size or {}).get("width") or 1280
        ini = page.get_by_role("button", name=re.compile(r"^[A-ZÄÖÜa-zäöüß]{1,3}$"))
        if ini.count() > 0:
            for i in range(min(ini.count(), 6)):
                el = ini.nth(i)
                try:
                    if el.is_visible(timeout=1500):
                        box = el.bounding_box()
                        if box and box.get("x", 0) > vpw * 0.42:
                            el.click(timeout=8000)
                            time.sleep(0.9)
                            if _profile_account_menu_seems_open(page):
                                flog("меню профиля открыто (role=button по инициалам в имени)")
                                return
                except Exception:
                    continue
    except Exception:
        pass

    # 2) Запас: только явные метки аккаунта (без «Menü» / последней кнопки header — открывали не то и рвали сессию)
    candidates = [
        page.locator('[aria-label*="Konto" i]'),
        page.locator('[aria-label*="Benutzer" i]'),
        page.locator('[aria-label*="Account" i]'),
        page.locator('[aria-label*="Profil" i]'),
        page.get_by_role("button", name=re.compile(r"Account|Profil|Mein WEB", re.I)),
        page.locator('[data-testid*="user" i]'),
    ]
    for loc in candidates:
        if loc.count() > 0 and _safe_click(loc, timeout=10000):
            time.sleep(0.9)
            if _profile_account_menu_seems_open(page):
                flog("меню профиля открыто (запасной селектор)")
                return
    if _sso_retry and _sso_navigator_then_webde_portal(page):
        flog("меню профиля", "после SSO navigator — повтор открытия меню (один раз)")
        return _open_profile_menu(page, _sso_retry=False)
    raise RuntimeError(
        "Не удалось открыть меню профиля на web.de (нет инициалов в шапке и не сработали aria Account/Konto). "
        "Проверьте, что вы залогинены на web.de."
    )


def _locator_email_settings_link(page: Page):
    """
    Пункт меню профиля: link.web.de / showMailSettings или role=link/menuitem с текстом про E-Mail.
    """
    ap = page.locator(
        '#appa-account-flyout a.appa-navigation-row[href*="showMailSettings" i], '
        '#appa-account-flyout a[href*="showMailSettings" i], '
        'account-avatar a.appa-navigation-row[href*="showMailSettings" i], '
        'a.appa-navigation-row[href*="showMailSettings" i]'
    )
    try:
        if ap.count() > 0 and ap.first.is_visible(timeout=800):
            return ap
    except Exception:
        pass
    href_sel = (
        'a[href*="showMailSettings" i], '
        'a[href*="showmailsettings" i], '
        'a[href*="link.web.de" i][href*="settings" i], '
        'a[href*="link.web.de/settings" i], '
        'a[href*="navigator.web.de" i][href*="mail" i], '
        'a[href*="mail_settings" i]'
    )
    text_rx = re.compile(r"E-Mail\s*[-]?\s*Einstellungen", re.I)
    loc = page.locator(href_sel).filter(has_text=text_rx)
    if loc.count() == 0:
        loc = page.locator(href_sel).filter(has_text=re.compile(r"E-Mail", re.I))
    if loc.count() == 0:
        loc = page.get_by_role("link", name=re.compile(r"E-Mail.*Einstellungen|Einstellungen.*E-Mail", re.I))
    if loc.count() == 0:
        loc = page.get_by_role("menuitem", name=re.compile(r"E-Mail.*Einstellungen", re.I))
    if loc.count() == 0:
        loc = page.locator('[role="menu"], [role="listbox"], [class*="popover" i], [class*="dropdown" i]').locator(
            "a, [role='link'], [role='menuitem']"
        ).filter(has_text=text_rx)
    if loc.count() == 0:
        loc = page.locator(href_sel)
    if loc.count() > 0:
        return loc
    for fr in page.frames:
        if fr is page.main_frame:
            continue
        try:
            apf = fr.locator(
                '#appa-account-flyout a[href*="showMailSettings" i], '
                'a.appa-navigation-row[href*="showMailSettings" i], '
                'a[href*="showMailSettings" i]'
            )
            if apf.count() > 0:
                return apf
            hf = fr.locator(href_sel)
            lf = hf.filter(has_text=text_rx)
            if lf.count() == 0:
                lf = hf.filter(has_text=re.compile(r"E-Mail", re.I))
            if lf.count() > 0:
                return lf
            if hf.count() > 0:
                return hf
        except Exception:
            continue
    return loc


def _wait_email_settings_link_visible(page: Page, total_sec: float = 22.0):
    """После открытия меню пункт может дорисоваться — поллим несколько секунд."""
    deadline = time.monotonic() + total_sec
    last_n = -1
    while time.monotonic() < deadline:
        link = _locator_email_settings_link(page)
        try:
            n = link.count()
        except Exception:
            n = 0
        if n != last_n:
            last_n = n
            flog("поиск «E-Mail Einstellungen»", f"совпадений: {n}")
        if n > 0:
            try:
                link.first.wait_for(state="visible", timeout=2500)
                return link
            except Exception:
                pass
        time.sleep(0.35)
    return _locator_email_settings_link(page)


def _click_email_settings(page: Page, context: BrowserContext) -> Page:
    flog("клик «E-Mail Einstellungen» (один клик — без повтора при той же вкладке)")
    link = _wait_email_settings_link_visible(page, total_sec=18.0)
    if link.count() == 0:
        flog("меню", "пункт не найден — повторно открываю меню профиля")
        _open_profile_menu(page)
        time.sleep(1.0)
        link = _wait_email_settings_link_visible(page, total_sec=15.0)
    if link.count() == 0:
        filters_capture_debug(page, "no_E-Mail_Einstellungen_in_menu")
        raise RuntimeError("Не найдена ссылка «E-Mail Einstellungen» в меню профиля")
    target = link.first
    try:
        target.scroll_into_view_if_needed(timeout=8000)
    except Exception:
        pass

    n_pages = len(context.pages)
    url_before = ""
    try:
        url_before = page.url or ""
    except Exception:
        pass

    try:
        target.click(timeout=25000, force=True)
    except PlaywrightTimeout:
        flog("клик E-Mail Einstellungen", "таймаут — пробую JS click")
        try:
            target.evaluate("el => el.click()")
        except Exception as e:
            filters_capture_debug(page, "click_E-Mail_Einstellungen_failed")
            raise RuntimeError(f"Клик «E-Mail Einstellungen»: {e!s}"[:200]) from e

    # Один клик: ждём либо новую вкладку, либо навигацию в текущей (без второго click() — он давал Logout/сброс сессии).
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        if len(context.pages) > n_pages:
            for p in context.pages:
                if p is page:
                    continue
                u = _page_url_live(p)
                ul = u.lower()
                if _navigator_url_ready_for_sidebar(u) or "link.web.de" in ul:
                    try:
                        p.wait_for_load_state("domcontentloaded", timeout=60000)
                    except Exception:
                        pass
                    p.bring_to_front()
                    flog("открыта вкладка настроек", _page_url_live(p)[:120])
                    return p
        try:
            cur = _page_url_live(page)
            u = cur.lower()
            if u != url_before.lower() and (
                _navigator_url_ready_for_sidebar(cur) or "link.web.de" in u
            ):
                try:
                    page.wait_for_load_state("domcontentloaded", timeout=60000)
                except Exception:
                    pass
                flog("настройки в этой вкладке", _page_url_live(page)[:120])
                return page
        except Exception:
            pass
        time.sleep(0.35)

    picked = _pick_settings_page(context, page)
    flog("ожидание навигации: взята вкладка по URL", _page_url_live(picked)[:120])
    return picked


def _find_mail_settings_page(context: BrowserContext):
    """Вкладка с настройками почты — редирект bap часто в другой tab, а ссылка page остаётся на alligator."""
    for p in context.pages:
        u = _page_url_live(p)
        if _navigator_url_ready_for_sidebar(u):
            return p
    return None


def _wait_mail_settings_ready(page: Page, context: BrowserContext, timeout_sec: float = 120.0) -> Page:
    """
    После «E-Mail Einstellungen» часто две вкладки: одна залипает на alligator…/start/, вторая уже bap…/mail_settings.
    Смотрим context.pages, а не только page.url.
    """
    hit = _find_mail_settings_page(context)
    if hit is not None:
        try:
            hit.bring_to_front()
        except Exception:
            pass
        flog("mail_settings найден среди вкладок", _page_url_live(hit)[:115])
        try:
            hit.wait_for_load_state("load", timeout=60000)
        except Exception:
            pass
        return hit

    flog("жду …/mail_settings/… (опрос всех вкладок контекста)")
    deadline = time.monotonic() + timeout_sec
    last_tabs_log = 0.0
    prev_main = ""

    while time.monotonic() < deadline:
        hit = _find_mail_settings_page(context)
        if hit is not None:
            try:
                hit.bring_to_front()
            except Exception:
                pass
            flog("интерфейс настроек почты готов", _page_url_live(hit)[:115])
            try:
                hit.wait_for_load_state("load", timeout=60000)
            except Exception:
                pass
            return hit

        u_main = _page_url_live(page)
        if u_main != prev_main:
            prev_main = u_main
            flog("вкладка page (может быть не та, где mail_settings)…", u_main[:115])

        if time.monotonic() - last_tabs_log > 2.5:
            last_tabs_log = time.monotonic()
            parts = []
            for i, p in enumerate(context.pages):
                try:
                    live = _page_url_live(p)
                    parts.append(f"[{i}] {live[:90]}")
                except Exception:
                    parts.append(f"[{i}] ?")
            flog("все вкладки контекста", " · ".join(parts)[:220])

        time.sleep(0.12)

    tail = _page_url_live(page)[:200]
    raise RuntimeError(
        f"Таймаут {timeout_sec:.0f}с: нет вкладки с mail_settings. page URL (live)={tail!r}"
    )


def _page_url_has_mail_settings(page: Page) -> bool:
    try:
        return "mail_settings" in ((_page_url_live(page) or "").lower())
    except Exception:
        return False


def _page_url_has_filterrules(page: Page) -> bool:
    try:
        return "filterrules" in ((_page_url_live(page) or "").lower())
    except Exception:
        return False


def _find_filterrules_page(context: BrowserContext):
    """Вкладка с уже открытым редактором правил (после клика или при ручной навигации)."""
    for p in context.pages:
        if _page_url_has_filterrules(p):
            return p
    return None


def _try_fast_click_filterregeln_nav_item(scope) -> bool:
    """
    На уже открытом mail_settings пункт «Filterregeln» обычно — link/menuitem в левой колонке.
    Короткие таймауты, без 30+ с ожидания innerText всего body.
    """
    for role in ("link", "menuitem", "button", "tab"):
        try:
            loc = scope.get_by_role(role, name=re.compile(r"Filterregeln", re.I))
            if loc.count() == 0:
                continue
            el = loc.first
            el.scroll_into_view_if_needed(timeout=4000)
            el.click(timeout=5000, force=True)
            flog("Filterregeln: быстрый клик", f"role={role}")
            return True
        except Exception:
            continue
    return False


def _wait_sidebar_filterregeln_in_dom(page: Page, timeout_ms: int = 30000) -> None:
    """SPA: пункт появляется в DOM не сразу — ждём текст, без фиксированной паузы."""
    try:
        page.wait_for_function(
            """() => {
            const b = document.body;
            if (!b || !b.innerText) return false;
            return b.innerText.indexOf('Filterregeln') >= 0;
          }""",
            timeout=timeout_ms,
        )
        flog("в DOM есть «Filterregeln» (сайдбар отрисован)")
    except PlaywrightTimeout:
        flog("предупреждение: «Filterregeln» в DOM не дождались за timeout — пробую клик")


def _js_click_filterregeln_left_sidebar(page: Page) -> bool:
    """WEB.DE navigator: пункт часто div/li без role=link; клик по левой колонке."""
    try:
        ok = page.evaluate(
            """() => {
            const vw = window.innerWidth;
            const maxLeft = vw * 0.40;
            const nodes = document.querySelectorAll(
              'a, button, div, span, li, p, [role="button"], [role="link"], [role="menuitem"], [role="tab"]'
            );
            const hits = [];
            for (const el of nodes) {
              const raw = (el.textContent || '').replace(/\\s+/g, ' ').trim();
              if (raw.indexOf('Filterregeln') < 0) continue;
              if (raw.length > 40) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              if (r.left > maxLeft) continue;
              hits.push({ el, area: r.width * r.height, top: r.top });
            }
            hits.sort((a, b) => a.top - b.top);
            for (const h of hits) {
              try {
                h.el.scrollIntoView({ block: 'center', inline: 'nearest' });
                h.el.click();
                return true;
              } catch (e) {}
            }
            return false;
          }"""
        )
        if ok:
            flog("Filterregeln: JS-клик по элементу в левой колонке")
        return bool(ok)
    except Exception as e:
        flog("JS-клик Filterregeln ошибка", str(e)[:80])
        return False


def _click_filterregeln_under_sidebar_heading(scope, heading_re: re.Pattern, log_detail: str) -> bool:
    """Пункт меню «Filterregeln» рядом с заголовком секции (Ordner или E-Mail)."""
    side = scope.locator(
        "aside, nav, [class*='sidebar' i], [class*='SideNav' i], "
        "[class*='navigation' i], [class*='settings-nav' i], [data-testid*='nav' i]"
    )
    try:
        for si in range(min(side.count(), 6)):
            s = side.nth(si)
            if s.get_by_text(heading_re).count() == 0:
                continue
            hit = s.get_by_text(re.compile(r"^\s*Filterregeln\s*$", re.I))
            if hit.count() == 0:
                continue
            el = hit.first
            el.scroll_into_view_if_needed(timeout=6000)
            el.wait_for(state="visible", timeout=8000)
            el.click(timeout=8000, force=True)
            flog("Filterregeln: клик в сайдбаре", log_detail)
            return True
    except Exception:
        pass
    return False


def _click_filterregeln_ordner_sidebar(scope) -> bool:
    """Сначала секция «Ordner», иначе «E-Mail» — на части макетов Filterregeln только там."""
    if _click_filterregeln_under_sidebar_heading(scope, re.compile(r"\bOrdner\b", re.I), "под «Ordner»"):
        return True
    if _click_filterregeln_under_sidebar_heading(
        scope, re.compile(r"\bE-?Mail\b", re.I), "под «E-Mail» (альт. раскладка)"
    ):
        return True
    return False


def _click_filterregeln_in_scope(scope) -> bool:
    """scope: Page или Frame — сначала Ordner→Filterregeln, затем общий сайдбар."""
    if _click_filterregeln_ordner_sidebar(scope):
        return True

    side = scope.locator(
        "aside, nav, [class*='sidebar' i], [class*='SideNav' i], "
        "[class*='navigation' i], [class*='settings-nav' i], [data-testid*='nav' i]"
    )
    try:
        if side.count() > 0:
            loc_fb = side.get_by_text(re.compile(r"^\s*Filterregeln\s*$", re.I))
            if loc_fb.count() > 0:
                el = loc_fb.first
                el.scroll_into_view_if_needed(timeout=6000)
                el.wait_for(state="visible", timeout=8000)
                el.click(timeout=8000, force=True)
                flog("Filterregeln: клик внутри сайдбар-контейнера")
                return True
    except Exception:
        pass

    locs = [
        scope.get_by_role("link", name=re.compile(r"Filterregeln", re.I)),
        scope.get_by_role("menuitem", name=re.compile(r"Filterregeln", re.I)),
        scope.get_by_role("button", name=re.compile(r"Filterregeln", re.I)),
        scope.get_by_role("tab", name=re.compile(r"Filterregeln", re.I)),
        scope.locator("a, button, [role='button'], [role='menuitem'], div[role='link']").filter(
            has_text=re.compile(r"^\s*Filterregeln\s*$", re.I)
        ),
        scope.get_by_text(re.compile(r"^\s*Filterregeln\s*$", re.I)),
        scope.get_by_text("Filterregeln", exact=True),
    ]
    for loc in locs:
        try:
            if loc.count() == 0:
                continue
            el = loc.first
            el.scroll_into_view_if_needed(timeout=6000)
            el.wait_for(state="visible", timeout=8000)
            el.click(timeout=8000, force=True)
            return True
        except Exception:
            continue
    return False


def _ensure_filter_rules_page(page: Page, context: BrowserContext | None = None):
    """
    Клик «Filterregeln» в сайдбаре mail_settings, затем ждём кнопку «Filterregeln erstellen».
    Если URL уже содержит filterrules (BAP-клиент) — клик пропускается.
    Возвращает scope (Page/Frame), где кнопка видна, или None.
    """
    # Долгие таймауты не нужны: «Smarte Funktionen» дальше ловится в _wait_filterregeln_erstellen (каждые 3 с).
    _dismiss_smart_features_modal(page, timeout_ms=3500)
    _dismiss_auswahl_uebernommen_modal(page, timeout_ms=10000)

    if _page_url_has_filterrules(page):
        flog(
            "переход к «Filterregeln»",
            "уже на странице filterrules — сайдбар не кликаю",
        )
        flog("ожидание кнопки «Filterregeln erstellen» (после раздела Filterregeln)")
        btn_scope = _wait_filterregeln_erstellen_button_ready(page, timeout_sec=55.0)
        if btn_scope is None:
            flog(
                "предупреждение",
                "кнопка «Filterregeln erstellen» не появилась за 55с — пробую клик по всем frame",
            )
            filters_capture_debug(page, "warn_no_Filterregeln_erstellen_button")
        return btn_scope

    flog("переход к «Filterregeln» (сайдбар Einstellungen)")

    clicked = False
    # Уже на mail_settings — сначала короткий клик по роли (не ждать 35 с wait_for_function по body).
    if _page_url_has_mail_settings(page):
        if _try_fast_click_filterregeln_nav_item(page):
            clicked = True
        else:
            for fr in page.frames:
                try:
                    if _try_fast_click_filterregeln_nav_item(fr):
                        clicked = True
                        flog("Filterregeln: быстрый клик (iframe)")
                        break
                except Exception:
                    continue

    if not clicked:
        dom_ms = 16000 if _filters_fast_mode() else 35000
        if _page_url_has_mail_settings(page):
            dom_ms = min(dom_ms, 7000)
        _wait_sidebar_filterregeln_in_dom(page, timeout_ms=dom_ms)

    if not clicked:
        if _click_filterregeln_in_scope(page):
            clicked = True
            flog("Filterregeln: клик (основной документ)")
        else:
            for fr in page.frames:
                try:
                    if _click_filterregeln_in_scope(fr):
                        clicked = True
                        flog("Filterregeln: клик (iframe)")
                        break
                except Exception:
                    continue

    if not clicked:
        if _js_click_filterregeln_left_sidebar(page):
            clicked = True

    if not clicked:
        _filters_raise(
            page,
            "ensure_filterregeln_click",
            "Не найден пункт «Filterregeln» (сайдбар Ordner/E-Mail). URL=" + _page_url_live(page)[:160],
        )

    time.sleep(0.45 if _filters_fast_mode() else 0.72)
    try:
        page.wait_for_load_state("domcontentloaded", timeout=20000)
    except Exception:
        pass
    _dismiss_smart_features_modal(page, timeout_ms=4000)
    _dismiss_auswahl_uebernommen_modal(page, timeout_ms=8000)

    flog("ожидание кнопки «Filterregeln erstellen» (после раздела Filterregeln)")
    btn_scope = _wait_filterregeln_erstellen_button_ready(page, timeout_sec=55.0)
    if btn_scope is None and context is not None:
        alt = _find_filterrules_page(context)
        if alt is not None and alt != page:
            flog(
                "Filterregeln",
                "кнопка не на текущей вкладке — переключаюсь на вкладку filterrules",
            )
            try:
                alt.bring_to_front()
            except Exception:
                pass
            btn_scope = _wait_filterregeln_erstellen_button_ready(alt, timeout_sec=35.0)
            if btn_scope is None:
                filters_capture_debug(alt, "warn_no_Filterregeln_erstellen_on_filterrules_tab")
    if btn_scope is None:
        flog(
            "предупреждение",
            "кнопка «Filterregeln erstellen» нет — закрываю Smarte Funktionen и повторяю клик «Filterregeln»",
        )
        if _dismiss_smart_features_modal(page, timeout_ms=7000):
            time.sleep(0.45)
        for tgt in _iter_mail_settings_targets(page):
            try:
                if _click_filterregeln_in_scope(tgt):
                    flog("Filterregeln", "повторный клик после модалки / ожидание панели")
                    break
            except Exception:
                continue
        time.sleep(0.55 if _filters_fast_mode() else 0.9)
        _dismiss_smart_features_modal(page, timeout_ms=4000)
        _dismiss_auswahl_uebernommen_modal(page, timeout_ms=8000)
        btn_scope = _wait_filterregeln_erstellen_button_ready(page, timeout_sec=48.0)
    if btn_scope is None:
        flog(
            "предупреждение",
            "кнопка «Filterregeln erstellen» не появилась — пробую клик по всем frame",
        )
        filters_capture_debug(page, "warn_no_Filterregeln_erstellen_button")
    return btn_scope


def _mail_settings_ui_scopes(page: Page):
    """Сначала дочерние frame (часто там navigator настроек), затем основной документ."""
    out = []
    for fr in page.frames:
        if fr != page.main_frame:
            out.append(fr)
    out.append(page)
    return out


def _all_page_scopes(page: Page, preferred_first=None):
    """
    Все контексты DOM вкладки: предпочтительный (iframe после клика), каждый frame, затем page.
    Модалка может быть во вложенном frame или на корне — раньше смотрели только iframe+page.
    """
    scopes: list = []
    seen: set[int] = set()

    def add(sc):
        if sc is None:
            return
        k = id(sc)
        if k in seen:
            return
        seen.add(k)
        scopes.append(sc)

    add(preferred_first)
    for fr in page.frames:
        add(fr)
    add(page)
    return scopes


def _erstellen_button_locators_in_scope(sc):
    """
    Скрин 2: тёмная кнопка «Filterregel(n) erstellen» в основной области (не сайдбар).
    Сначала main / article, затем весь frame.
    """
    pairs: list[tuple[str, object]] = []
    for sel, lab in (("main", "main"), ('[role="main"]', "role=main"), ("article", "article")):
        try:
            m = sc.locator(sel).first
            if m.count() == 0:
                continue
            btn = m.get_by_role("button", name=RE_BTN_OPEN_FILTER_MODAL)
            if btn.count() > 0:
                pairs.append((lab, btn))
        except Exception:
            pass
    pairs.append(("весь frame", sc.get_by_role("button", name=RE_BTN_OPEN_FILTER_MODAL)))
    return pairs


def _wait_filterregeln_erstellen_button_ready(page: Page, timeout_sec: float = 55.0):
    """
    После клика «Filterregeln» в сайдбаре кнопка «Filterregeln erstellen» появляется не сразу —
    ждём видимость во всех frame (предпочтительно в main/article).
    Пока ждём — периодически закрываем «Smarte Funktionen», если она перекрыла центральную панель.
    """
    deadline = time.monotonic() + timeout_sec
    last_smarte = time.monotonic()
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now - last_smarte >= 3.0:
            last_smarte = now
            _dismiss_smart_features_modal_once(page)
        for i, sc in enumerate(_all_page_scopes(page, None)):
            for where, btn in _erstellen_button_locators_in_scope(sc):
                try:
                    if btn.count() == 0:
                        continue
                    b0 = btn.first
                    b0.wait_for(state="visible", timeout=420)
                    flog(
                        "кнопка «Filterregeln erstellen» готова",
                        f"scope[{i}] · {where}",
                    )
                    return sc
                except Exception:
                    continue
        time.sleep(0.28)
    return None


def _click_filterregeln_erstellen_in_best_scope(page: Page, hint_scope=None):
    """
    Клик по «Filterregeln erstellen» (скрин 2→3): сначала main/article в каждом scope.
    Возвращает (scope_где_кликнули, clicked_ok).
    """
    for sc in _all_page_scopes(page, hint_scope):
        for where, btn in _erstellen_button_locators_in_scope(sc):
            if _safe_click(btn, timeout=5000):
                flog("клик «Filterregel(n) erstellen»", f"{where} — основная колонка")
                return sc, True
    return hint_scope or page, False


def _select_option_by_substring(select_locator, substring: str) -> bool:
    """Выбор <option> по подстроке; force=True — селект часто скрыт под кастомным combobox."""
    sub_l = substring.lower()
    try:
        for opt in select_locator.locator("option").all():
            try:
                lab = (opt.inner_text() or "").strip()
            except Exception:
                continue
            if sub_l in lab.lower():
                val = opt.get_attribute("value")
                try:
                    if val is not None and val != "":
                        select_locator.select_option(value=val, force=True)
                    else:
                        select_locator.select_option(label=lab, force=True)
                except TypeError:
                    if val is not None and val != "":
                        select_locator.select_option(value=val)
                    else:
                        select_locator.select_option(label=lab)
                return True
    except Exception:
        pass
    # Запас: смена value через JS (скрытый select)
    try:
        sub_js = json.dumps(substring)
        ok = select_locator.evaluate(
            f"""(sel) => {{
            const sub = ({sub_js}).toLowerCase();
            const opts = sel.options || [];
            for (let i = 0; i < opts.length; i++) {{
              const t = (opts[i].textContent || '').toLowerCase();
              if (t.indexOf(sub) >= 0) {{
                sel.selectedIndex = i;
                sel.dispatchEvent(new Event('input', {{ bubbles: true }}));
                sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return true;
              }}
            }}
            return false;
          }}"""
        )
        return bool(ok)
    except Exception:
        return False


def _native_selected_option_text(select_locator) -> str:
    try:
        return (
            select_locator.evaluate(
                """s => {
          const o = s.options[s.selectedIndex];
          return o ? (o.textContent || '').trim() : '';
        }"""
            )
            or ""
        )
    except Exception:
        return ""


def _native_select_option_labels(select_locator) -> list[str]:
    try:
        raw = select_locator.evaluate(
            """s => [...s.options].map(o => (o.textContent || '').trim())"""
        )
        return list(raw) if raw else []
    except Exception:
        return []


def _native_set_select_index(select_locator, index: int) -> bool:
    """Смена selectedIndex + события (React/свои виджеты слушают change)."""
    try:
        ok = select_locator.evaluate(
            """(sel, j) => {
            if (j < 0 || j >= sel.options.length) return false;
            sel.selectedIndex = j;
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }""",
            index,
        )
        return bool(ok)
    except Exception:
        return False


def _native_folder_select_set_papierkorb(dlg) -> bool:
    """
    Ищем <select>, в опциях которого есть и Posteingang, и Papierkorb (типичный выбор папки).
    Не полагаемся на фиксированный индекс — у WEB.DE порядок select в DOM может плавать.
    """
    selects = dlg.locator("select")
    n = selects.count()
    for i in range(min(n, 12)):
        si = selects.nth(i)
        try:
            labels = _native_select_option_labels(si)
        except Exception:
            continue
        lows = [x.lower() for x in labels if x]
        if not any("papierkorb" in x for x in lows):
            continue
        joined = " ".join(lows)
        if not any(
            k in joined
            for k in (
                "posteingang",
                "inbox",
                "spam",
                "gesendet",
                "entwurf",
                "draft",
            )
        ):
            continue
        for j, lab in enumerate(labels):
            if "papierkorb" in lab.lower():
                if _native_set_select_index(si, j):
                    flog("native folder → Papierkorb", f"select[{i}] option[{j}] «{lab[:40]}»")
                    return True
        if _select_option_by_substring(si, "Papierkorb"):
            flog("native folder → Papierkorb", f"select[{i}] (substring)")
            return True
    return False


def _native_action_select_set_verschiebe(dlg) -> bool:
    """Селект действия: опция с «Verschiebe» и «Ordner»."""
    selects = dlg.locator("select")
    n = selects.count()
    for i in range(min(n, 12)):
        si = selects.nth(i)
        labels = _native_select_option_labels(si)
        if not labels:
            continue
        blob = " | ".join(labels).lower()
        if "verschiebe" not in blob and "verschieb" not in blob:
            continue
        if "ordner" not in blob:
            continue
        cur = _native_selected_option_text(si).lower()
        if "verschiebe" in cur and "ordner" in cur:
            flog("native action Verschiebe", f"select[{i}] уже выбрано")
            return True
        for j, lab in enumerate(labels):
            low = lab.lower()
            if "verschiebe" in low and "ordner" in low:
                if _native_set_select_index(si, j):
                    flog("native action Verschiebe", f"select[{i}] option[{j}]")
                    return True
        if _select_option_by_substring(si, "Verschiebe"):
            flog("native action Verschiebe", f"select[{i}] (substring)")
            return True
    return False


def _dlg_native_any_selected_contains(dlg, needle: str) -> bool:
    needle = needle.lower()
    selects = dlg.locator("select")
    for i in range(min(selects.count(), 14)):
        try:
            if needle in _native_selected_option_text(selects.nth(i)).lower():
                return True
        except Exception:
            continue
    return False


def _bap_condition_select_locator(dlg):
    """Expert filter (navigator): условие — отдельный <select>, value ALL_MAILS."""
    for loc in (
        dlg.locator('select[name*="conditionType"]'),
        dlg.locator("select.form-composite-switchable-content_condition"),
    ):
        try:
            if loc.count() > 0:
                return loc.first
        except Exception:
            continue
    return None


def _bap_condition_is_all_mails(dlg) -> bool:
    sel = _bap_condition_select_locator(dlg)
    if sel is None:
        return False
    try:
        v = sel.evaluate("s => (s.options[s.selectedIndex] || {}).value || ''")
        return (v or "").strip() == "ALL_MAILS"
    except Exception:
        return False


def _bap_select_condition_all_mails(dlg) -> bool:
    sel = _bap_condition_select_locator(dlg)
    if sel is None:
        return False
    try:
        try:
            sel.select_option(value="ALL_MAILS", force=True)
        except TypeError:
            sel.select_option(value="ALL_MAILS")
        flog("BAP условие", "ALL_MAILS (Alle neuen E-Mails)")
        _fsleep(0.25, 0.1)
        return True
    except Exception as ex:
        flog("BAP условие", f"не выставлено ALL_MAILS: {ex!s}"[:90])
        return False


def _wait_bap_move_button_papierkorb(dlg, total_sec: float = 3.0) -> bool:
    """После клика по flyout Wicket иногда обновляет подпись кнопки с задержкой."""
    deadline = time.monotonic() + total_sec
    while time.monotonic() < deadline:
        if _bap_move_button_shows_papierkorb(dlg):
            return True
        time.sleep(0.22)
    return False


def _bap_move_button_shows_papierkorb(dlg) -> bool:
    try:
        b = dlg.locator('[data-webdriver="moveToButton"]')
        if b.count() == 0:
            return False
        # Подпись папки — в .button-dropdown_text / .button_text, не во всём inner_text кнопки
        for sub in (
            ".button-dropdown_text",
            ".button_text",
            "span.button_text",
        ):
            try:
                inner = b.first.locator(sub)
                if inner.count() > 0:
                    t = (inner.first.inner_text(timeout=3500) or "").lower()
                    if "papierkorb" in t:
                        return True
            except Exception:
                continue
        t = (b.first.inner_text(timeout=4000) or "").lower()
        return "papierkorb" in t
    except Exception:
        return False


def _bap_click_papierkorb_in_folder_flyout(dlg, page: Page) -> bool:
    """
    Папка — не <select>: кнопка moveToButton + flyout с input.menu-item[value=…] (Wicket/BAP).
    """
    btn = dlg.locator('[data-webdriver="moveToButton"]')
    if btn.count() == 0:
        try:
            btn = dlg.get_by_role("button", name=re.compile(r"Posteingang", re.I))
        except Exception:
            btn = dlg.locator('[data-webdriver="moveToButton"]')
    if btn.count() == 0:
        return False
    try:
        btn.first.click(timeout=8000, force=True)
    except Exception:
        try:
            btn.first.dispatch_event("click", timeout=4000)
        except Exception:
            return False
    _fsleep(0.55, 0.22)
    selectors = (
        'input.menu-item[value="Papierkorb"]',
        'input[type="submit"][value="Papierkorb"]',
    )
    for sel in selectors:
        try:
            loc = dlg.locator(sel)
            if loc.count() > 0:
                loc.first.click(timeout=10000, force=True)
                flog("BAP папка", "Papierkorb (flyout input)")
                _fsleep(0.35, 0.12)
                return True
        except Exception:
            continue
    for fr in page.frames:
        for sel in selectors:
            try:
                loc = fr.locator(sel)
                if loc.count() > 0:
                    try:
                        if not loc.first.is_visible(timeout=2500):
                            continue
                    except Exception:
                        pass
                    loc.first.click(timeout=10000, force=True)
                    flog("BAP папка", f"Papierkorb ({sel}) во frame")
                    _fsleep(0.35, 0.12)
                    return True
            except Exception:
                continue
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return False


def _webde_bap_customfilter_fill_all_mails_trash(page: Page, dlg) -> bool:
    """
    Разметка WEB.DE BAP: customfilter + moveToButton + submit-элементы меню (см. HTML пользователя).
    """
    if dlg.locator('[data-webdriver="moveToButton"]').count() == 0:
        return False
    flog("форма фильтра", "BAP customfilter (moveToButton)")
    _bap_select_condition_all_mails(dlg)
    if _bap_move_button_shows_papierkorb(dlg):
        flog("BAP папка", "уже Papierkorb на кнопке")
        return True
    return _bap_click_papierkorb_in_folder_flyout(dlg, page)


def _select_native_if_present(dlg) -> None:
    """Нативные <select> в модалке. Не проверяем is_visible — у WEB.DE они часто display:none."""
    selects = dlg.locator("select")
    cnt = selects.count()
    if cnt == 0:
        return
    # Как на скрине WEB.DE: [0]=«eine/alle», [1]=Alle neuen E-Mails, [2]=Verschiebe…, [3]=Papierkorb
    try:
        if cnt >= 4:
            pairs = (
                (1, "Alle neuen", "select[1]: Alle neuen E-Mails"),
                (2, "Verschiebe", "select[2]: Verschiebe in Ordner"),
                (3, "Papierkorb", "select[3]: Papierkorb"),
            )
            for idx, needle, logline in pairs:
                try:
                    sx = selects.nth(idx)
                    if sx.count() == 0:
                        continue
                    cur = _native_selected_option_text(sx).lower()
                    if needle.lower() in cur:
                        flog("native select уже OK", logline)
                        continue
                    if _select_option_by_substring(sx, needle):
                        flog("native select OK", logline)
                    else:
                        flog("native select пропуск", f"[{idx}] не выставлен «{needle}»")
                except Exception as ex:
                    flog("native select ошибка", f"[{idx}] {ex!s}"[:80])
            # Запас: селект папки не всегда [3], подписи option могут отличаться от видимого текста
            _native_action_select_set_verschiebe(dlg)
            _native_folder_select_set_papierkorb(dlg)
            return
    except Exception:
        pass
    try:
        s0 = selects.nth(0)
        if s0.is_visible(timeout=2000):
            if _select_option_by_substring(s0, "Alle neuen"):
                flog("select[0]: Alle neuen E-Mails")
    except Exception:
        pass
    if cnt >= 2:
        try:
            s1 = selects.nth(1)
            if _select_option_by_substring(s1, "Verschiebe"):
                flog("select[1]: Verschiebe in Ordner")
        except Exception:
            pass
    if cnt >= 3:
        try:
            s2 = selects.nth(2)
            if _select_option_by_substring(s2, "Papierkorb"):
                flog("select[2]: Papierkorb")
        except Exception:
            pass
    elif cnt == 2:
        try:
            if _select_option_by_substring(selects.nth(1), "Papierkorb"):
                flog("select[1]: Papierkorb (fallback)")
        except Exception:
            pass
    # Для cnt < 4 или если фиксированные индексы не сработали
    _native_action_select_set_verschiebe(dlg)
    _native_folder_select_set_papierkorb(dlg)


def _verify_trash_filter_modal_ready(page: Page, dlg) -> tuple[bool, str]:
    """
    Перед «Filterregel einrichten»: убедиться, что в модалке видны условие, действие и Papierkorb.
    Иначе WEB.DE часто не создаёт правило, а скрипт всё равно доходил до клика сохранения.
    """
    blob = ""
    try:
        blob = (dlg.inner_text(timeout=12000) or "").lower()
    except Exception:
        pass
    checks = (
        ("alle neuen", "в модалке нет условия «Alle neuen E-Mails» (текст и нативный select)"),
        ("verschiebe", "в модалке нет действия «Verschiebe in Ordner»"),
        ("papierkorb", "в модалке не выбрана папка «Papierkorb»"),
    )
    ok_alle = (
        "alle neuen" in blob
        or _dlg_native_any_selected_contains(dlg, "alle neuen")
        or _bap_condition_is_all_mails(dlg)
    )
    ok_move = "verschiebe" in blob or _dlg_native_any_selected_contains(dlg, "verschiebe")
    ok_bin = (
        "papierkorb" in blob
        or _dlg_native_any_selected_contains(dlg, "papierkorb")
        or _bap_move_button_shows_papierkorb(dlg)
    )
    if ok_alle and ok_move and ok_bin:
        flog(
            "проверка модалки перед сохранением",
            "OK (текст модалки и/или выбранные option в <select>)",
        )
        return True, ""

    # Запас: реально выбранные option у скрытых <select> по фиксированным индексам
    try:
        selects = dlg.locator("select")
        n = selects.count()
        if n >= 4:

            def _sel_blob(i: int) -> str:
                try:
                    return (
                        selects.nth(i).evaluate(
                            """s => {
              const o = s.options[s.selectedIndex];
              return o ? (o.textContent || '').trim() + ' ' + (o.value || '') : '';
            }"""
                        )
                        or ""
                    ).lower()
                except Exception:
                    return ""

            t1, t2, t3 = _sel_blob(1), _sel_blob(2), _sel_blob(3)
            if "alle neuen" in t1 and "verschiebe" in t2 and "papierkorb" in t3:
                flog("проверка модалки перед сохранением", "OK (нативные select[1..3])")
                return True, ""
    except Exception:
        pass

    missing = []
    if not ok_alle:
        missing.append(checks[0][1])
    if not ok_move:
        missing.append(checks[1][1])
    if not ok_bin:
        missing.append(checks[2][1])
    detail = "; ".join(missing) if missing else "состояние модалки не подтверждено"
    flog("проверка модалки перед сохранением", f"FAIL: {detail}")
    try:
        filters_capture_debug(page, "verify_modal_before_save_fail")
    except Exception:
        pass
    return False, detail


def _option_click_in_root_or_page(root, page: Page, option_re: re.Pattern) -> bool:
    """Список опций иногда в портеале основного документа, не в iframe."""
    for sc in (root, page):
        try:
            opt = sc.get_by_role("option", name=option_re)
            if opt.count() > 0:
                opt.first.click(timeout=10000)
                return True
        except Exception:
            pass
    return False


def _click_option_matching_in_all_frames(page: Page, option_re: re.Pattern) -> bool:
    """Выпадающий список WEB.DE часто в iframe / portal; ищем [role=option] по тексту."""
    try:
        frame_list = list(page.frames)
    except Exception:
        frame_list = []
    for fr in frame_list:
        try:
            opts = fr.locator('[role="listbox"] [role="option"], [role="option"]')
            n = min(opts.count(), 100)
            for i in range(n):
                el = opts.nth(i)
                try:
                    txt = (el.inner_text(timeout=1200) or "").strip()
                    if txt and option_re.search(txt):
                        try:
                            el.scroll_into_view_if_needed(timeout=3000)
                        except Exception:
                            pass
                        el.click(timeout=10000, force=True)
                        return True
                except Exception:
                    continue
            # BAP flyout: input.menu-item / submit с value="Papierkorb" и т.п.
            subs = fr.locator('input.menu-item[type="submit"], input[type="submit"].menu-item')
            ns = min(subs.count(), 80)
            for i in range(ns):
                el = subs.nth(i)
                try:
                    val = (el.get_attribute("value") or "").strip()
                    if val and option_re.search(val):
                        el.click(timeout=10000, force=True)
                        return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def _combobox_select_option(root, page: Page, dlg, combo_index: int, option_re: re.Pattern, ok_msg: str) -> bool:
    combos = dlg.get_by_role("combobox")
    try:
        cb = combos.nth(combo_index)
        try:
            cb.scroll_into_view_if_needed(timeout=2500)
        except Exception:
            pass
        try:
            cb.click(timeout=8000, force=True)
        except Exception as e:
            # Не используем locator.evaluate(click): у WEB.DE зависает до default timeout (~120 с).
            try:
                cb.dispatch_event("click", timeout=4000)
            except Exception as e2:
                flog(f"{ok_msg} — открытие combobox[{combo_index}]", str(e2)[:70])
                return False
    except Exception as e:
        flog(f"{ok_msg} — открытие combobox[{combo_index}]", str(e)[:70])
        return False
    _fsleep(0.45, 0.15)
    if _option_click_in_root_or_page(root, page, option_re):
        flog(ok_msg)
        return True
    if _click_option_matching_in_all_frames(page, option_re):
        flog(ok_msg)
        return True
    flog(ok_msg, "опция не найдена")
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return False


def _ui_open_folder_dropdown_pick_papierkorb(page: Page, dlg) -> bool:
    """
    Кастомный UI: список папок часто открывается кликом по текущему значению (Posteingang),
    а не через стабильный combobox-индекс. Без 120-секундных evaluate.
    """
    re_bin = re.compile(r"Papierkorb", re.I)

    def _try_click_then_pick(trigger_loc, label: str) -> bool:
        try:
            if trigger_loc.count() == 0:
                return False
            last = min(trigger_loc.count(), 10)
            for i in range(last - 1, -1, -1):
                el = trigger_loc.nth(i)
                try:
                    if not el.is_visible(timeout=2000):
                        continue
                    el.click(timeout=6000, force=True)
                    time.sleep(0.5)
                    if _click_option_matching_in_all_frames(page, re_bin):
                        flog("папка (UI)", f"{label} → Papierkorb")
                        return True
                except Exception:
                    continue
        except Exception:
            pass
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass
        return False

    # 0) Кнопка папки BAP — не цепляем «Posteingang» из сайдбара / чужих блоков
    try:
        btn = dlg.locator('[data-webdriver="moveToButton"]')
        if _try_click_then_pick(btn, "moveToButton"):
            return True
    except Exception:
        pass

    # 1) Видимый текст «Posteingang» в модалке (стартовое значение папки)
    try:
        post = dlg.get_by_text(re.compile(r"Posteingang", re.I))
        if _try_click_then_pick(post, "клик «Posteingang»"):
            return True
    except Exception:
        pass

    # 2) Combobox, в подписи которого уже Posteingang / Inbox (поле папки)
    try:
        combos = dlg.get_by_role("combobox")
        nc = min(combos.count(), 8)
        for idx in range(nc - 1, -1, -1):
            cb = combos.nth(idx)
            try:
                raw = (cb.inner_text(timeout=2500) or "") + " " + (cb.get_attribute("value") or "")
            except Exception:
                raw = ""
            low = raw.lower()
            if "posteingang" in low or "inbox" in low:
                try:
                    cb.click(timeout=6000, force=True)
                    time.sleep(0.5)
                    if _click_option_matching_in_all_frames(page, re_bin):
                        flog("папка (UI)", f"combobox[{idx}] (Posteingang) → Papierkorb")
                        return True
                except Exception:
                    pass
                try:
                    page.keyboard.press("Escape")
                except Exception:
                    pass
    except Exception:
        pass

    # 3) Запас: последние combobox в форме (часто папка = последний или предпоследний)
    for idx in (3, 2):
        try:
            combos = dlg.get_by_role("combobox")
            if idx >= combos.count():
                continue
            cb = combos.nth(idx)
            try:
                cb.click(timeout=6000, force=True)
            except Exception:
                try:
                    cb.dispatch_event("click", timeout=4000)
                except Exception:
                    continue
            time.sleep(0.5)
            if _click_option_matching_in_all_frames(page, re_bin):
                flog("папка (UI)", f"combobox[{idx}] (запас) → Papierkorb")
                return True
        except Exception:
            pass
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass

    return False


def _wait_filter_create_modal(page: Page, iframe_scope, timeout_sec: float = 55.0):
    """
    Диалог «Filterregel(n) erstellen» часто без [class*='Modal']: ищем во всех frame,
    по role=dialog, aria-modal, Wenn/Dann, якорю кнопки сохранения (einrichten или erstellen).
    """
    title_rx = RE_MODAL_FILTER_TITLE
    deadline = time.monotonic() + timeout_sec

    def _try_scope(sc, label: str):
        if sc is None:
            return None
        try:
            g = sc.get_by_role("dialog", name=title_rx)
            if g.count() > 0:
                g.first.wait_for(state="visible", timeout=4000)
                flog("модалка: найдена", f"{label} · role=dialog + имя")
                return g.first
        except Exception:
            pass
        try:
            loc = sc.locator('[role="dialog"]').filter(has_text=title_rx)
            if loc.count() > 0:
                loc.first.wait_for(state="visible", timeout=4000)
                flog("модалка: найдена", f"{label} · [role=dialog] + текст заголовка")
                return loc.first
        except Exception:
            pass
        try:
            loc = sc.locator('[aria-modal="true"]')
            for i in range(min(loc.count(), 6)):
                el = loc.nth(i)
                try:
                    if not el.is_visible(timeout=1200):
                        continue
                    if el.get_by_text(title_rx).count() > 0 or el.get_by_text(
                        re.compile(r"Wenn", re.I)
                    ).count() > 0:
                        flog("модалка: найдена", f"{label} · aria-modal [#{i}]")
                        return el
                except Exception:
                    continue
        except Exception:
            pass
        try:
            loc = sc.locator('[role="dialog"]')
            for i in range(min(loc.count(), 10)):
                el = loc.nth(i)
                try:
                    if not el.is_visible(timeout=1200):
                        continue
                    if el.get_by_text(re.compile(r"Wenn", re.I)).count() > 0 and el.get_by_role(
                        "combobox"
                    ).count() > 0:
                        flog("модалка: найдена", f"{label} · dialog + Wenn + combobox [#{i}]")
                        return el
                except Exception:
                    continue
        except Exception:
            pass
        return None

    def _try_flat_wenn_container(sc, label: str):
        """WEB.DE иногда рисует форму без role=dialog — Wenn + кнопка сохранения + combobox."""
        wenn_rx = re.compile(r"Wenn", re.I)
        for save_tag, save_rx in (
            ("einrichten", RE_BTN_SAVE_EINRICHTEN),
            ("erstellen", RE_BTN_SAVE_ERSTELLEN),
        ):
            try:
                cand = sc.locator("div,section,form,main").filter(has_text=wenn_rx).filter(
                    has=sc.get_by_role("button", name=save_rx)
                )
                for i in range(min(cand.count(), 10)):
                    el = cand.nth(i)
                    try:
                        if not el.is_visible(timeout=700):
                            continue
                        if el.get_by_role("combobox").count() == 0:
                            continue
                        flog(
                            "модалка: найдена",
                            f"{label} · Wenn + «{save_tag}» + combobox [#{i}]",
                        )
                        return el
                    except Exception:
                        continue
            except Exception:
                pass
        return None

    stall_log = time.monotonic()
    stall_shot = time.monotonic()
    while time.monotonic() < deadline:
        for i, sc in enumerate(_all_page_scopes(page, iframe_scope)):
            label = f"scope[{i}]"
            hit = _try_scope(sc, label)
            if hit is not None:
                return hit
            hit = _try_flat_wenn_container(sc, label)
            if hit is not None:
                return hit

        for i, sc in enumerate(_all_page_scopes(page, iframe_scope)):
            label = f"scope[{i}]"
            for save_rx in (RE_BTN_SAVE_EINRICHTEN, RE_BTN_SAVE_ERSTELLEN):
                try:
                    btn = sc.get_by_role("button", name=save_rx)
                    if btn.count() == 0:
                        continue
                    btn.first.wait_for(state="visible", timeout=3500)
                    for xp in (
                        "xpath=ancestor::*[@role='dialog' or @aria-modal='true'][1]",
                        "xpath=ancestor::*[contains(@class,'modal') or contains(@class,'Modal') or contains(@class,'layer') or contains(@class,'Layer') or contains(@class,'Drawer') or contains(@class,'flyout') or contains(@class,'Flyout')][1]",
                    ):
                        anc = btn.first.locator(xp)
                        if anc.count() > 0:
                            try:
                                anc.first.wait_for(state="visible", timeout=2500)
                                flog(
                                    "модалка: найдена",
                                    f"{label} · предок от кнопки сохранения ({xp[:36]}…)",
                                )
                                return anc.first
                            except Exception:
                                continue
                except Exception:
                    pass

        now = time.monotonic()
        if now - stall_log >= 12.0:
            stall_log = now
            left = max(0.0, deadline - now)
            flog(
                "модалка: всё ещё жду…",
                f"осталось ~{left:.0f}s · опрос всех frame + page",
            )
            filters_log_state(page, "wait_modal_stall")
        if now - stall_shot >= 25.0:
            stall_shot = now
            filters_screenshot(page, "stall_wait_Filterregeln_erstellen_modal")

        time.sleep(0.35)

    _filters_raise(
        page,
        "wait_filter_create_modal",
        "Модалка «Filterregel(n) erstellen» не найдена (все frame + page: dialog / Wenn+combobox / предок кнопки)",
    )


def _click_modal_save_filter_rule(dlg, root, page: Page) -> bool:
    """
    Футер: «Filterregel einrichten» (data-webdriver=ok) / «Filterregel erstellen».
    BAP: спиннер .layer-dialog.spinner перекрывает UI; кнопка может быть вне узла dlg — ищем везде + force click.
    Не ждём спиннер на всём page первым — в DOM часто висит глобальный #idd1 .spinner (ложное зависание).
    """
    for sc in (dlg, root):
        if sc is not None:
            try:
                _wait_wicket_modal_spinner_hidden(sc, timeout_ms=32000 if not _filters_fast_mode() else 14000)
            except Exception:
                pass
    try:
        _wait_spinner_only_near_customfilter(
            page, timeout_ms=18000 if not _filters_fast_mode() else 10000
        )
    except Exception:
        pass

    def _attempt_save(scope, label: str) -> bool:
        if scope is None:
            return False
        pairs = (
            ('form.customfilter [data-webdriver="ok"]', True),
            ('form.customfilter .m-button-container [data-webdriver="ok"]', True),
            ('.layer-root:has(form.customfilter) [data-webdriver="ok"]', True),
            ('[data-webdriver="Dialog:Root:Container"] [data-webdriver="ok"]', True),
            ('.m-button-container [data-webdriver="ok"]', True),
            ('[data-webdriver="ok"]', True),
            ('button[name*="bottomButtons_body:ok"]', True),
            ('button[name*="bottomButtons"][name*="ok"]', True),
        )
        for sel, last in pairs:
            try:
                loc = scope.locator(sel)
                if _try_click_first_or_last_force(loc, timeout=18000, prefer_last=last):
                    flog("сохранение правила", f"«Filterregel einrichten» ({label} · {sel[:40]}…)")
                    return True
            except Exception:
                continue
        for role_loc in (
            lambda s: s.get_by_role("button", name=RE_BTN_SAVE_EINRICHTEN),
            lambda s: s.get_by_role("button", name=RE_BTN_SAVE_ERSTELLEN),
        ):
            try:
                loc = role_loc(scope)
                if _try_click_first_or_last_force(loc, timeout=18000, prefer_last=True):
                    flog("сохранение правила", f"role=button ({label})")
                    return True
            except Exception:
                continue
        return False

    for sc, lab in (
        (dlg, "модалка"),
        (root, "root/iframe"),
        (page, "page"),
    ):
        if _attempt_save(sc, lab):
            return True

    for fr in page.frames:
        try:
            if _attempt_save(fr, f"frame:{(fr.url or '')[:48]}"):
                return True
        except Exception:
            continue

    if _js_click_bap_save_ok_all_frames(page):
        return True

    # Нативная мышь по кнопке в форме (Wicket иногда «глотает» только Playwright-click)
    try:
        save_sel = 'form.customfilter [data-webdriver="ok"]'
        for tgt in (page, *list(page.frames)):
            try:
                loc = tgt.locator(save_sel)
                if loc.count() == 0:
                    continue
                for attempt in range(3):
                    if _mouse_click_locator_center(loc, timeout=12000):
                        flog(
                            "сохранение правила",
                            f"mouse.click центр [ok] (попытка {attempt + 1})",
                        )
                        time.sleep(0.4)
                        return True
                    time.sleep(0.35)
            except Exception:
                continue
    except Exception:
        pass

    # Запас: точный текст кнопки в layer-root (Wicket)
    try:
        ok_txt = page.locator(".layer-root:has(form.customfilter) button.m-button.button-primary").filter(
            has_text=re.compile(r"Filterregel\s+einrichten", re.I),
        )
        if ok_txt.count() == 0:
            ok_txt = page.locator(".layer-root button.m-button.button-primary").filter(
                has_text=re.compile(r"Filterregel\s+einrichten", re.I),
            )
        if _try_click_first_or_last_force(ok_txt, timeout=15000, prefer_last=True):
            flog("сохранение правила", "layer-root .m-button-primary + текст")
            return True
    except Exception:
        pass

    if _safe_click(page.get_by_role("button", name=re.compile(r"einrichten", re.I)), timeout=9000):
        return True
    if _safe_click(page.get_by_role("button", name=RE_BTN_SAVE_ERSTELLEN), timeout=8000):
        return True
    return False


def _create_trash_rule_for_all_new_mail(page: Page, filterregeln_erstellen_hint_scope=None) -> None:
    # Сначала «Filterregeln», потом эта кнопка; клик коротким проходом по всем frame.
    flog("кнопка открытия модалки", "«Filterregel(n) erstellen» в основной колонке")
    root, ok = _click_filterregeln_erstellen_in_best_scope(page, filterregeln_erstellen_hint_scope)
    if not ok:
        for sc in _mail_settings_ui_scopes(page):
            btn = sc.get_by_role("button", name=RE_BTN_OPEN_FILTER_MODAL)
            if _safe_click(btn, timeout=8500):
                root = sc
                ok = True
                break
    if not ok:
        _filters_raise(
            page,
            "create_click_Filterregeln_erstellen",
            "Не найдена кнопка «Filterregel(n) erstellen»",
        )
    if root != page:
        flog("клик открытия модалки", "iframe (navigator)")

    _fsleep(0.6, 0.22)
    _filters_milestone(page, "after_click_Filterregeln_erstellen_before_modal")
    # Модалка после клика — любой frame вкладки или page; не обязательно role=dialog
    dlg = _wait_filter_create_modal(
        page,
        root,
        timeout_sec=38.0 if _filters_fast_mode() else 60.0,
    )
    flog("модалка создания правила", "«Filterregel(n) erstellen»")
    _filters_milestone(page, "modal_Filterregeln_erstellen_open")

    # Реальная разметка BAP: ALL_MAILS + кнопка moveToButton + input.menu-item (не role=option)
    _webde_bap_customfilter_fill_all_mails_trash(page, dlg)
    _select_native_if_present(dlg)

    re_alle = re.compile(r"Alle\s+neuen\s+E-Mails", re.I)
    re_move = re.compile(r"Verschiebe\s+in\s+Ordner", re.I)
    re_bin = re.compile(r"Papierkorb", re.I)

    combos = dlg.get_by_role("combobox")
    n = combos.count()
    flog("модалка: combobox в диалоге", str(n))
    if n == 0:
        flog("предупреждение", "в модалке нет role=combobox — возможно другой UI")
        filters_capture_debug(page, "modal_zero_combobox")

    # Скрин WEB.DE: «Wenn [eine] …» — первый combobox не тип письма; условие — второй.
    if n >= 4:
        idx_alle, idx_move, idx_bin = 1, 2, 3
    elif n >= 3:
        idx_alle, idx_move, idx_bin = 0, 1, 2
    else:
        idx_alle, idx_move, idx_bin = 0, 1, 2

    skip_alle_combo = _dlg_native_any_selected_contains(dlg, "alle neuen") or _bap_condition_is_all_mails(dlg)
    skip_move_combo = _dlg_native_any_selected_contains(dlg, "verschiebe")
    skip_bin_combo = _dlg_native_any_selected_contains(dlg, "papierkorb") or _bap_move_button_shows_papierkorb(dlg)
    if skip_alle_combo:
        flog("combobox", "пропуск условия — уже в <select>")
    if skip_move_combo:
        flog("combobox", "пропуск действия — уже в <select>")
    if skip_bin_combo:
        flog("combobox", "пропуск папки — уже Papierkorb в <select>")

    if n > 0:
        if not skip_alle_combo and not _combobox_select_option(
            root, page, dlg, idx_alle, re_alle, "условие: Alle neuen E-Mails"
        ):
            for i in range(min(n, 4)):
                if _combobox_select_option(
                    root, page, dlg, i, re_alle, "условие: Alle neuen E-Mails (перебор)"
                ):
                    break
        _fsleep(0.35, 0.12)
        if (
            n >= 2
            and not skip_move_combo
            and not _combobox_select_option(
                root, page, dlg, idx_move, re_move, "действие: Verschiebe in Ordner"
            )
        ):
            for i in range(min(n, 4)):
                if _combobox_select_option(
                    root, page, dlg, i, re_move, "действие: Verschiebe in Ordner (перебор)"
                ):
                    break
        _fsleep(0.35, 0.12)
        if n >= 3 and not skip_bin_combo and not _combobox_select_option(
            root, page, dlg, idx_bin, re_bin, "папка: Papierkorb"
        ):
            for i in range(min(n, 4)):
                if _combobox_select_option(root, page, dlg, i, re_bin, "папка: Papierkorb (перебор)"):
                    break

    # Клик по «Posteingang» / полю папки → список → Papierkorb (без зависаний evaluate)
    if not _dlg_native_any_selected_contains(dlg, "papierkorb") and not _bap_move_button_shows_papierkorb(dlg):
        _ui_open_folder_dropdown_pick_papierkorb(page, dlg)
    _fsleep(0.55, 0.18)

    # После combobox / UI: снова нативные <select>
    _native_action_select_set_verschiebe(dlg)
    _native_folder_select_set_papierkorb(dlg)

    if dlg.locator('[data-webdriver="moveToButton"]').count() > 0:
        tw = 3.2 if not _filters_fast_mode() else 2.0
        if not _wait_bap_move_button_papierkorb(dlg, total_sec=tw):
            _bap_click_papierkorb_in_folder_flyout(dlg, page)
            _fsleep(0.45, 0.15)
            _wait_bap_move_button_papierkorb(dlg, total_sec=2.0 if _filters_fast_mode() else 2.8)

    ok_fill, why_fill = _verify_trash_filter_modal_ready(page, dlg)
    if not ok_fill:
        _filters_raise(page, "verify_modal_before_save", why_fill)

    if not _click_modal_save_filter_rule(dlg, root, page):
        _filters_raise(
            page,
            "create_click_save_filter",
            "Не найдена кнопка сохранения («Filterregel einrichten» или «Filterregel erstellen»)",
        )
    _fsleep(2.0, 0.75)
    if _dismiss_auswahl_uebernommen_modal(page, timeout_ms=14000):
        flog("после сохранения правила", "закрыта модалка «Auswahl wurde übernommen»")
    _dismiss_auswahl_uebernommen_modal(page, timeout_ms=4000)


def _run_trash_all_new_mail_filter_body(page: Page, context: BrowserContext) -> None:
    """
    Полный сценарий после авторизованной сессии.
    Важно: тот же Page / вкладка, где завершился вход — не открываем новое окно.
    """
    flog("=== настройка фильтра: все новые письма → Papierkorb ===")
    if _filters_fast_mode():
        flog("режим", "WEBDE_FILTERS_FAST — укороченные ожидания")
    try:
        page.bring_to_front()
    except Exception:
        pass
    try:
        flog("STEP-00 вкладка до портала", (page.url or "")[:120])
    except Exception:
        pass
    _navigate_to_webde_portal_for_filters(page)
    if _filters_fast_mode():
        flog("STEP-01b", "WEBDE_FILTERS_FAST: без networkidle")
    else:
        # Главная web.de с новостями/рекламой почти никогда не даёт networkidle за разумное время.
        try:
            page.wait_for_load_state("networkidle", timeout=9000)
        except Exception:
            flog("networkidle пропущен (ожидание ≤9s) — продолжаю по domcontentloaded")
    flog("STEP-02", "ожидание портала web.de (профиль / CMP)")
    _wait_webde_portal_after_goto(page, timeout_sec=48.0 if _filters_fast_mode() else 95.0)
    flog("STEP-02 OK", f"url={page.url[:100]!r}")

    flog("STEP-03", "меню профиля → только этот путь (без goto navigator/mail_settings)")
    _assert_webde_session_not_logged_out_portal(page)
    _open_profile_menu(page)
    flog("STEP-04", "E-Mail Einstellungen → вкладка настроек почты")
    settings_page = _click_email_settings(page, context)
    settings_page = _pick_settings_page(context, settings_page)
    settings_page.wait_for_load_state(
        "domcontentloaded",
        timeout=45000 if _filters_fast_mode() else 90000,
    )
    settings_page = _wait_mail_settings_ready(
        settings_page,
        context,
        timeout_sec=72.0 if _filters_fast_mode() else 120.0,
    )
    _fsleep(0.6, 0.2)
    flog(
        "STEP-05 mail_settings готова",
        _page_url_live(settings_page)[:120],
    )
    _filters_milestone(settings_page, "05_mail_settings_ready")

    _dismiss_smart_features_modal(settings_page, timeout_ms=4000)
    _dismiss_auswahl_uebernommen_modal(settings_page, timeout_ms=10000)
    flog("STEP-06", "сайдбар: Ordner → Filterregeln, ждём «Filterregeln erstellen»")
    erstellen_scope = _ensure_filter_rules_page(settings_page, context)
    _filters_milestone(settings_page, "06_after_Filterregeln_sidebar")
    _dismiss_smart_features_modal(settings_page, timeout_ms=4000)
    _dismiss_auswahl_uebernommen_modal(settings_page, timeout_ms=8000)
    flog("STEP-07", "кнопка «Filterregel(n) erstellen» → модалка → сохранение")
    _create_trash_rule_for_all_new_mail(
        settings_page, filterregeln_erstellen_hint_scope=erstellen_scope
    )
    flog("=== фильтр: готово ===")
    _save_cookies_after_filter_success(context)
    # Явная строка для логов/парсеров (как просили)
    print("[WEB.DE][FILTERS] фильтр «всё в корзину» — готово", flush=True)


def run_trash_all_new_mail_filter(page: Page, context: BrowserContext) -> None:
    try:
        _run_trash_all_new_mail_filter_body(page, context)
    except Exception as e:
        flog(
            "▶▶▶ СБОЙ СЦЕНАРИЯ ФИЛЬТРОВ ◀◀◀",
            f"{type(e).__name__}: {e!s}"[:500],
        )
        try:
            filters_capture_debug(page, f"uncaught_{type(e).__name__}")
        except Exception:
            pass
        raise


def run_compose_mail_quick_touch(page: Page, context: BrowserContext, to_email: str) -> bool:
    """
    После входа в WEB.DE: портал → меню профиля → ссылка в Postfach (не Einstellungen) →
    попытка «Neue E-Mail» / Verfassen, письмо себе. Лучшее усилие; при сбое — только лог, не raise.
    """
    em = (to_email or "").strip()
    if not em:
        flog("compose", "нет to_email — пропуск")
        return False
    flog("compose", "E-Mail → Postfach → neue E-Mail (touch)")
    try:
        page.bring_to_front()
    except Exception:
        pass
    try:
        _navigate_to_webde_portal_for_filters(page)
        _wait_webde_portal_after_goto(page, timeout_sec=42.0 if _filters_fast_mode() else 75.0)
        _open_profile_menu(page)
        time.sleep(0.45)
        # Постфах: navigator / mail, без showMailSettings
        rows = page.locator(
            "#appa-account-flyout a.appa-navigation-row, "
            "a.appa-navigation-row[href*='navigator.web.de' i], "
            "a[href*='navigator.web.de' i][href*='mail' i]"
        )
        n = rows.count()
        clicked = False
        for i in range(min(n, 12)):
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
                    flog("compose", f"клик постфах: {href[:80]!r}")
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
                        flog("compose", "клик по role=link " + name_rx.pattern[:40])
                        break
                except Exception:
                    continue
        if not clicked:
            flog("compose", "не найдена ссылка Postfach — пропуск compose")
            return False
        _fsleep(2.2, 0.8)
        # Ждём клиент почты в любой вкладке
        deadline = time.monotonic() + 55.0
        mail_page = page
        while time.monotonic() < deadline:
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
            time.sleep(0.5)
        try:
            mail_page.bring_to_front()
        except Exception:
            pass
        compose_hit = False
        for role, pat in (
            ("button", re.compile(r"E-Mail|Verfassen|Neue\s+E-Mail|Schreiben", re.I)),
            ("link", re.compile(r"Neue\s+E-Mail|Verfassen|E-Mail\s+schreiben", re.I)),
        ):
            try:
                loc = mail_page.get_by_role(role, name=pat).first
                if loc.count() and loc.is_visible(timeout=2500):
                    loc.click(timeout=12000)
                    compose_hit = True
                    flog("compose", f"открыта форма ({role})")
                    break
            except Exception:
                continue
        if not compose_hit:
            flog("compose", "кнопка compose не найдена — пропуск отправки")
            return False
        _fsleep(1.2, 0.45)
        filled = False
        for sel in (
            'input[type="email"]',
            'input[name*="to" i]',
            'textarea[name*="to" i]',
            '[data-testid*="recipient" i]',
        ):
            try:
                loc = mail_page.locator(sel).first
                if loc.count() and loc.is_visible(timeout=2000):
                    loc.fill(em)
                    filled = True
                    break
            except Exception:
                continue
        if not filled:
            try:
                mail_page.get_by_placeholder(re.compile(r"Empfänger|An|To", re.I)).first.fill(em)
                filled = True
            except Exception:
                pass
        if not filled:
            flog("compose", "поле To не найдено")
            return False
        try:
            subj = mail_page.locator(
                'input[name*="subject" i], input[placeholder*="Betreff" i]'
            ).first
            if subj.count() and subj.is_visible(timeout=1500):
                subj.fill("WEB.DE")
        except Exception:
            pass
        try:
            body = mail_page.locator(
                'textarea[name*="body" i], div[contenteditable="true"]'
            ).first
            if body.count() and body.is_visible(timeout=1500):
                body.click(timeout=3000)
                body.fill("OK")
        except Exception:
            pass
        for btn_txt in (
            re.compile(r"Senden", re.I),
            re.compile(r"Absenden", re.I),
            re.compile(r"Send", re.I),
        ):
            try:
                b = mail_page.get_by_role("button", name=btn_txt).first
                if b.count() and b.is_visible(timeout=2000):
                    b.click(timeout=12000)
                    flog("compose", "отправка (кнопка)")
                    _fsleep(1.5, 0.5)
                    return True
            except Exception:
                continue
        flog("compose", "кнопка Senden не найдена")
        return False
    except Exception as e:
        flog("compose", f"ошибка (игнор): {e!s}"[:200])
        try:
            filters_capture_debug(page, "compose_touch_failed")
        except Exception:
            pass
        return False
