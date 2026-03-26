#!/usr/bin/env python3
"""
Автовход WEB.DE для лида по API GMX (режим Auto-script).
Сервер передаёт лида по API: скрипт получает email/пароль через GET /api/lead-credentials,
выполняет вход через webde_login.login_webde, результат отправляет в POST /api/webde-login-result.
Лида затем направляют те же функции, что и кнопки в админке (редирект на пуш, смену пароля, ошибку и т.д.).

Аргументы: --server-url BASE --lead-id ID --token TOKEN [--combo-slot N].
  N-й одновременный автовход (0..) — старт с N-м прокси и N-м отпечатком в списках; сервер передаёт N из очереди слотов.

Локально (есть DISPLAY или Windows): по умолчанию браузер открывается, все действия видны. На сервере без дисплея — headless. Переопределение: HEADLESS=1 (скрытый) или HEADLESS=0 (с окном).

Отпечаток и настройки в почте (в т.ч. фильтры) — один контекст Playwright на сессию входа
(webde_fingerprints.json + webde_fingerprint_indices.txt; см. webde_login.load_webde_fp_indices_allowed).

При ошибке входа с отпечатком из пула (ретраи / нет UA с API) соответствующий слот в webde_fingerprints.json
заменяется новым синтетическим пресетом (node scripts/replace-webde-fingerprint-slot.mjs). Отключить: WEBDE_REPLACE_FP_ON_ERROR=0.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import quote

from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

from webde_login import (
    login_webde,
    load_proxies_with_geo,
    rank_proxy_configs_for_country,
    log,
    LoginTemporarilyUnavailable,
    LOGIN_TEMPORARILY_UNAVAILABLE_TEXT,
    PROXY_FILE,
    get_last_alert_text,
    _WEBDE_VERBOSE_LOG,
    proxy_config_to_proxy_string,
    _load_webde_fingerprints_playwright,
    load_webde_fp_indices_allowed,
    take_lead_held_browser_session,
    invalidate_webde_fingerprints_cache,
)
from cleanup_artifacts import cleanup_login_artifacts

_RUN_PREFIX = ""
_LOG_EMAIL = ""  # для строки терминала «поток | попытка | email: …»


def _log(step: str, message: str, detail: str = "", *, verbose_only: bool = False):
    """Кратко: [AUTO-LOGIN] web.de | email | сообщение. Подробности: WEBDE_VERBOSE_LOG=1."""
    if verbose_only and not _WEBDE_VERBOSE_LOG:
        return
    if not _WEBDE_VERBOSE_LOG and step == "==========":
        return
    em = (_LOG_EMAIL or "—").strip() or "—"
    if len(em) > 48:
        em = em[:45] + "..."
    line = f"[AUTO-LOGIN] web.de | {em} | {message}"
    if detail:
        line += f" — {detail}"
    if _RUN_PREFIX and _WEBDE_VERBOSE_LOG:
        line += f" {_RUN_PREFIX}"
    print(line, flush=True)


def _exit_if_lead_not_found_404(exc: BaseException, lead_id: str, where: str) -> None:
    """404 по leadId — лид удалён/слит; не перебирать прокси и не опрашивать API дальше."""
    if isinstance(exc, urllib.error.HTTPError) and getattr(exc, "code", None) == 404:
        _log("СТОП", f"лид не найден (404) {where} — останавливаю скрипт без повторов, lead_id={lead_id}")
        cleanup_login_artifacts()
        raise SystemExit(0) from None


def api_get(base_url: str, path: str, token: str, timeout: float = 90) -> dict:
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def api_post(base_url: str, path: str, token: str, data: dict, timeout: float = 60) -> None:
    url = base_url.rstrip("/") + path
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()


def persist_webde_grid_step(
    base_url: str, lead_id: str, token: str, next_step: int
) -> None:
    """Сохраняет следующий шаг диагональной сетки на лид (переживает рестарт процесса)."""
    try:
        if next_step < 0:
            return
        api_post(
            base_url,
            "/api/webde-login-grid-step",
            token,
            {"id": lead_id, "step": int(next_step)},
        )
    except Exception:
        pass


# Коды ошибок скрипта входа (отображаются в админке при result=error):
# 403 — доступ запрещён (API вернул 403, блок по IP)
# 408 — таймаут (ожидание пароля, пуша, загрузки страницы)
# 502 — сервис временно недоступен (Login vorübergehend nicht möglich, капча не пройдена, блок)
# 503 — капча не поддерживается или не решена
# 500 — внутренняя ошибка (исключение, браузер не запустился, распознавание страницы)
SCRIPT_ERROR_CODES = ("403", "408", "502", "503", "500")

KLEIN_WRONG_CREDENTIALS_MSG_DE = (
    "Die E-Mail-Adresse ist nicht registriert oder das Passwort ist falsch. "
    "Bitte überprüfe deine Eingaben."
)

# Подписи EVENTS — дублируют EVENT_LABELS в server.js (script-event и согласованность с админкой).
EV_MAIL_FILTERS_START = "Включение фильтров на почте"
EV_MAIL_FILTERS_OK = "Фильтры включены"
EV_KLEIN_START = "Запуск Klein"
EV_SUCCESS_KL = "Успешный вход Kl"
EV_WEBDE_BROWSER = "WEB.DE: браузер готов"
EV_WEBDE_MAIL_OPENED = "WEB.DE: почтовый ящик открыт"
EV_MAIL_UI_READY = "Почта: интерфейс подготовлен"
EV_KLEIN_SESSION_MAIL = "Klein: сессия почты в браузере"
EV_KLEIN_WAIT_VICTIM = "Klein: ждём открытия страницы у лида"
EV_KLEIN_VICTIM_HERE = "Klein: лид на странице входа"
EV_KLEIN_CREDS_FROM_LEAD = "Klein: данные для входа получены"
EV_WEBDE_SCREEN_PUSH = "WEB.DE: на экране Push"
EV_WEBDE_SCREEN_2FA = "WEB.DE: на экране 2FA"
EV_WEBDE_SCREEN_SMS = "WEB.DE: на экране SMS"
EV_TWO_FA_CODE_IN = "2FA: код получен, ввод на WEB.DE"


def send_result(
    base_url: str,
    lead_id: str,
    token: str,
    result: str,
    error_code: str | None = None,
    error_message: str | None = None,
    push_timeout: bool = False,
    *,
    result_phase: str | None = None,
    result_source: str | None = None,
) -> None:
    payload = {"id": lead_id, "result": result}
    if result == "error" and error_code:
        payload["errorCode"] = error_code if error_code in SCRIPT_ERROR_CODES else "500"
    if result == "error" and error_message:
        payload["errorMessage"] = (error_message or "")[:500]
    if result == "wrong_credentials" and error_message:
        payload["errorMessage"] = (error_message or "")[:500]
    if result == "push" and push_timeout:
        payload["pushTimeout"] = True
    if result_phase:
        payload["resultPhase"] = str(result_phase)[:80]
    if result_source:
        payload["resultSource"] = str(result_source)[:80]
    post_url = base_url.rstrip("/") + "/api/webde-login-result"
    try:
        api_post(base_url, "/api/webde-login-result", token, payload)
        _log(
            "API",
            "POST webde-login-result OK",
            f"result={result} id={lead_id!r} url={post_url}",
            verbose_only=True,
        )
    except urllib.error.HTTPError as e:
        _exit_if_lead_not_found_404(e, lead_id, "POST /api/webde-login-result")
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        _log(
            "ОШИБКА",
            f"POST webde-login-result HTTP {e.code}",
            f"id={lead_id!r} len={len(lead_id)} url={post_url} payload={payload!r} response_body={body!r}",
        )
    except Exception as e:
        _log(
            "ОШИБКА",
            f"POST webde-login-result: {type(e).__name__}: {e}",
            f"id={lead_id!r} url={post_url}",
        )


def script_event(base_url: str, lead_id: str, token: str, label: str) -> None:
    """Пишет строку в EVENTS админки (фильтры почты, этапы Klein)."""
    try:
        api_post(
            base_url,
            "/api/script-event",
            token,
            {"id": lead_id, "label": (label or "")[:180]},
        )
    except Exception:
        pass


def poll_push_resend_request(base_url: str, lead_id: str, token: str) -> bool:
    """Проверяет, запросила ли админка переотправку пуша. При запросе сервер возвращает resend: true и сбрасывает флаг."""
    try:
        url = base_url.rstrip("/") + "/api/webde-push-resend-poll?leadId=" + quote(lead_id)
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
            return data.get("resend") is True
    except Exception:
        return False


def report_push_resend_result(base_url: str, lead_id: str, token: str, success: bool, message: str | None = None) -> None:
    """Отправляет в админку результат переотправки пуша: успех или причина ошибки."""
    payload = {"id": lead_id, "success": success}
    if message:
        payload["message"] = message[:200]
    try:
        api_post(base_url, "/api/webde-push-resend-result", token, payload)
    except Exception as e:
        _log("ОШИБКА", f"не удалось отправить результат переотправки пуша: {type(e).__name__}: {e}")


def wait_for_new_password_from_admin(base_url: str, lead_id: str, token: str) -> str | None:
    """Один запрос long-poll: висит до передачи нового пароля из админки или таймаута сервера (~3 мин). Возвращает новый пароль или None."""
    url = base_url.rstrip("/") + "/api/webde-wait-password"
    body = json.dumps({"leadId": lead_id}).encode("utf-8")
    _log(
        "WAIT",
        "HTTP long-poll старт: POST /api/webde-wait-password (скрипт блокируется до ~220с)",
        f"leadId={lead_id[:16]}{'…' if len(lead_id) > 16 else ''}",
    )
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    try:
        # Чуть больше серверного WEBDE_WAIT_PASSWORD_TIMEOUT_MS (по умолчанию 180 с).
        with urllib.request.urlopen(req, timeout=220) as r:
            data = json.loads(r.read().decode("utf-8"))
            if data.get("timeout"):
                _log("WAIT", "HTTP long-poll конец: сервер вернул timeout=true (админ не ввёл пароль за срок)")
                return None
            pw = data.get("password")
            got = (pw or "").strip() or None
            if got:
                _log("WAIT", "HTTP long-poll конец: пароль в ответе (админ сохранил новый пароль в лиде)")
            else:
                _log("WAIT", "HTTP long-poll конец: 200 OK но пароль пуст — считаем как нет пароля")
            return got
    except urllib.error.HTTPError as e:
        _exit_if_lead_not_found_404(e, lead_id, "POST /api/webde-wait-password")
        _log("ОШИБКА", f"ожидание нового пароля: HTTP {getattr(e, 'code', '?')}: {e}")
        return None
    except Exception as e:
        _log("ОШИБКА", f"ожидание нового пароля не удалось: {type(e).__name__}: {e}")
        return None


def notify_slot_done(base_url: str, lead_id: str, token: str) -> None:
    """Сообщить серверу, что слот входа освобождён (скрипт завершился)."""
    try:
        api_post(base_url, "/api/webde-login-slot-done", token, {"id": lead_id})
    except Exception:
        pass


def _execute_klein_orchestration_after_mail(
    base_url: str,
    lead_id: str,
    token: str,
    email: str,
    *,
    headless: bool,
) -> None:
    """
    Одна сессия Playwright: почта уже залогинена, браузер удержан.
    Compose (touch) → фильтры → success API (редирект лида на /klein-anmelden) →
    ждём заход на страницу (5 мин) → креды Klein → вход Klein (SMS — long-poll как в kleinanzeigen_login).
    """
    import webde_mail_filters
    from kleinanzeigen_login import DEFAULT_LOGIN_URL, klein_login_with_page

    sess = take_lead_held_browser_session()
    if not sess:
        _log("KLEIN-ORCH", "ошибка: take_lead_held_browser_session пуст — закрыть нечего")
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="500",
            error_message="Klein-orch: браузер не удержан после входа почты",
        )
        return

    browser = sess.get("browser")
    context = sess.get("context")
    page = sess.get("page")
    if not browser or not context or not page:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="500",
            error_message="Klein-orch: неполная сессия браузера",
        )
        try:
            browser and browser.close()
        except Exception:
            pass
        return

    script_event(base_url, lead_id, token, EV_KLEIN_SESSION_MAIL)
    os.environ["WEBDE_EMAIL"] = email
    os.environ["WEBDE_TEST_EMAIL"] = email

    try:
        _log("KLEIN-ORCH", "шаг: E-Mail compose (touch)")
        webde_mail_filters.run_compose_mail_quick_touch(page, context, email)
    except Exception as e:
        _log("KLEIN-ORCH", f"compose (продолжаю): {type(e).__name__}: {e}")
    script_event(base_url, lead_id, token, EV_MAIL_UI_READY)

    try:
        script_event(base_url, lead_id, token, EV_MAIL_FILTERS_START)
        _log("KLEIN-ORCH", "шаг: фильтры → корзина")
        webde_mail_filters.run_trash_all_new_mail_filter(page, context)
        script_event(base_url, lead_id, token, EV_MAIL_FILTERS_OK)
    except Exception as e:
        _log("KLEIN-ORCH", f"фильтры: {type(e).__name__}: {e}")
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="502",
            error_message=f"Klein-orch: фильтры почты: {type(e).__name__}: {str(e)[:200]}",
        )
        try:
            browser.close()
        except Exception:
            pass
        return

    _log("KLEIN-ORCH", "почта готова → API success (редирект лида на Klein-anmelden)")
    send_result(base_url, lead_id, token, "success", result_phase="mail_ready_klein")
    script_event(base_url, lead_id, token, EV_KLEIN_WAIT_VICTIM)

    wait_anm = int((os.environ.get("KLEIN_ORCH_WAIT_ANMELDEN_SEC") or "300").strip() or "300")
    deadline = time.monotonic() + max(30, wait_anm)
    seen = False
    _log("KLEIN-ORCH", f"жду заход на /klein-anmelden до {wait_anm}s")
    while time.monotonic() < deadline:
        try:
            data = api_get(
                base_url,
                "/api/lead-klein-flow-poll?leadId=" + quote(lead_id),
                token,
                timeout=30,
            )
            if isinstance(data, dict) and data.get("ok") and data.get("anmeldenSeen"):
                seen = True
                script_event(base_url, lead_id, token, EV_KLEIN_VICTIM_HERE)
                break
        except Exception:
            pass
        time.sleep(2.0)

    if not seen:
        _log("KLEIN-ORCH", "таймаут: лид не открыл страницу Klein — закрываю браузер")
        try:
            browser.close()
        except Exception:
            pass
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="408",
            error_message="KLEIN_ANMELDEN_TIMEOUT: лид не зашёл на страницу Klein за отведённое время",
            result_source="klein_login",
        )
        return

    cred_wait = int((os.environ.get("KLEIN_ORCH_CRED_WAIT_SEC") or "7200").strip() or "7200")
    cred_deadline = time.monotonic() + max(60, cred_wait)
    em_kl = ""
    pw_kl = ""
    _log("KLEIN-ORCH", "страница Klein открыта — жду emailKl/passwordKl с API")
    while time.monotonic() < cred_deadline:
        try:
            data = api_get(
                base_url,
                "/api/lead-klein-flow-poll?leadId=" + quote(lead_id),
                token,
                timeout=30,
            )
            if isinstance(data, dict) and data.get("ok"):
                em_kl = (data.get("emailKl") or "").strip()
                pw_kl = (data.get("passwordKl") or "").strip()
                if em_kl and pw_kl:
                    script_event(base_url, lead_id, token, EV_KLEIN_CREDS_FROM_LEAD)
                    break
        except Exception:
            pass
        time.sleep(1.5)

    if not em_kl or not pw_kl:
        _log("KLEIN-ORCH", "нет кредов Klein за отведённое время — закрываю браузер")
        try:
            browser.close()
        except Exception:
            pass
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="408",
            error_message="KLEIN_CREDENTIALS_TIMEOUT",
            result_source="klein_login",
        )
        return

    login_url = (os.environ.get("KLEINANZEIGEN_LOGIN_URL") or DEFAULT_LOGIN_URL).strip()
    kp = None
    try:
        script_event(base_url, lead_id, token, EV_KLEIN_START)
        kp = context.new_page()
        _log("KLEIN-ORCH", f"вход Kleinanzeigen email={em_kl[:3]}…")
        exit_kl = klein_login_with_page(
            kp,
            em_kl,
            pw_kl,
            login_url=login_url,
            headless=headless,
            api_base=base_url,
            lead_id=lead_id,
            api_token=token,
        )
    except Exception as e:
        _log("KLEIN-ORCH", f"исключение Klein: {type(e).__name__}: {e}")
        exit_kl = -1
    finally:
        try:
            if kp:
                kp.close()
        except Exception:
            pass

    try:
        browser.close()
    except Exception:
        pass

    if exit_kl == 0:
        _log("KLEIN-ORCH", "Klein: успех (повторный POST success не шлём — уже был после почты)")
        script_event(base_url, lead_id, token, EV_SUCCESS_KL)
    elif exit_kl == 6:
        send_result(
            base_url,
            lead_id,
            token,
            "wrong_credentials",
            error_message=KLEIN_WRONG_CREDENTIALS_MSG_DE,
            result_source="klein_login",
        )
    elif exit_kl == 2:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="502",
            error_message="Klein: нет поля пароля / капча / другой экран",
            result_source="klein_login",
        )
    elif exit_kl == 3:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="408",
            error_message="Klein: таймаут SMS-кода из админки",
            result_source="klein_login",
        )
    elif exit_kl == 4:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="500",
            error_message="Klein: не удалось ввести OTP",
            result_source="klein_login",
        )
    elif exit_kl == 5:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="500",
            error_message="Klein: MFA без связи с админкой",
            result_source="klein_login",
        )
    elif exit_kl == -1:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="500",
            error_message="Klein: внутренняя ошибка оркестратора",
            result_source="klein_login",
        )
    else:
        send_result(
            base_url,
            lead_id,
            token,
            "error",
            error_code="500",
            error_message=f"Klein: неизвестный код {exit_kl}",
            result_source="klein_login",
        )


def _vorue_blacklist_path() -> Path:
    raw = (os.getenv("WEBDE_VORUE_BLACKLIST_FILE") or "").strip()
    if raw:
        return Path(raw)
    return LOGIN_DIR / "webde_vorue_blacklist.txt"


def _vorue_blacklist_file_enabled() -> bool:
    """По умолчанию выкл.: глобальный файл забивался (в т.ч. пары с fp=-1) и новые лиды сразу «нет комбинаций».
    Включить сохранение между запусками: WEBDE_VORUE_BLACKLIST=1"""
    v = (os.getenv("WEBDE_VORUE_BLACKLIST") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def load_vorue_blacklist_pairs() -> set[tuple[str, int]]:
    """Пары (ключ_прокси, индекс_отпечатка_пула) после Login vorübergehend — не повторять."""
    if not _vorue_blacklist_file_enabled():
        return set()
    path = _vorue_blacklist_path()
    out: set[tuple[str, int]] = set()
    if not path.is_file():
        return out
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) >= 2:
                    try:
                        out.add((parts[0].strip(), int(parts[1].strip(), 10)))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def append_vorue_blacklist_pair(proxy_key: str, fp_index: int, blocked_pairs: set[tuple[str, int]]) -> None:
    if (proxy_key, fp_index) in blocked_pairs:
        return
    blocked_pairs.add((proxy_key, fp_index))
    if not _vorue_blacklist_file_enabled():
        return
    path = _vorue_blacklist_path()
    try:
        with open(path, "a", encoding="utf-8") as af:
            af.write(f"{proxy_key}\t{fp_index}\n")
    except OSError:
        pass


def _webde_replace_fp_on_error_enabled() -> bool:
    v = (os.environ.get("WEBDE_REPLACE_FP_ON_ERROR") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _find_replace_webde_fp_script() -> Path | None:
    d = LOGIN_DIR.resolve()
    for _ in range(12):
        p = d / "scripts" / "replace-webde-fingerprint-slot.mjs"
        if p.is_file():
            return p
        parent = d.parent
        if parent == d:
            break
        d = parent
    return None


def _replace_webde_fingerprint_pool_slot(pool_index: int) -> None:
    if not _webde_replace_fp_on_error_enabled() or pool_index < 0:
        return
    script = _find_replace_webde_fp_script()
    json_path = LOGIN_DIR / "webde_fingerprints.json"
    js_path = LOGIN_DIR.parent / "public" / "webde-fingerprints-pool.js"
    if script is None or not json_path.is_file():
        return
    cmd = [
        "node",
        str(script),
        f"--index={int(pool_index)}",
        f"--json={json_path}",
        f"--js-out={js_path}",
    ]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=45,
            check=False,
        )
        if r.returncode == 0:
            invalidate_webde_fingerprints_cache()
            _log(
                "ОТПЕЧАТКИ",
                f"слот пула #{pool_index} заменён новым синтетическим пресетом",
                verbose_only=True,
            )
        else:
            tail = (r.stderr or r.stdout or "").strip()[:220]
            _log("ОТПЕЧАТКИ", f"replace-slot: node rc={r.returncode} {tail}", verbose_only=True)
    except Exception as e:
        _log("ОТПЕЧАТКИ", f"replace-slot: {type(e).__name__}: {e}", verbose_only=True)


def proxy_key_for_cfg(cfg: dict | None) -> str:
    if not cfg:
        return "__direct__"
    s = (proxy_config_to_proxy_string(cfg) or "").strip()
    if s:
        return s
    return (cfg.get("server") or "").strip() or "__direct__"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--server-url", required=True)
    p.add_argument("--lead-id", required=True)
    p.add_argument("--token", default="")
    p.add_argument(
        "--klein-orchestration",
        action="store_true",
        help="После входа в почту: compose+фильтры в том же окне, редирект на Klein, ожидание и вход Klein",
    )
    p.add_argument(
        "--combo-slot",
        type=int,
        default=None,
        metavar="N",
        help="Параллельный слот 0..K-1: первый запущенный лид — 0-й прокси и 0-й отпечаток, второй — 1-й и 1-й, …",
    )
    args = p.parse_args()
    base_url = args.server_url.strip()
    lead_id = args.lead_id.strip()
    token = (args.token or "").strip()

    try:
        _run_main(
            base_url,
            lead_id,
            token,
            klein_orchestration=args.klein_orchestration,
            combo_slot=args.combo_slot,
        )
    finally:
        notify_slot_done(base_url, lead_id, token)


def _run_main(
    base_url: str,
    lead_id: str,
    token: str,
    *,
    klein_orchestration: bool = False,
    combo_slot: int | None = None,
) -> None:
    global _RUN_PREFIX, _LOG_EMAIL
    _LOG_EMAIL = ""
    _RUN_PREFIX = f"[lead:{lead_id[:10]}]"
    _log(
        "СТАРТ",
        f"автовход · lead={lead_id} · {base_url.rstrip('/')}"
        + (" · режим klein-orchestration" if klein_orchestration else ""),
    )
    _log("==========", "START SESSION", verbose_only=True)
    cleanup_login_artifacts(600)  # 10 мин: убираем старые артефакты от предыдущих запусков

    if not lead_id:
        _log("ОШИБКА", "не передан lead_id")
        send_result(base_url, "", token, "error", error_code="500", error_message="lead_id не передан")
        cleanup_login_artifacts()
        sys.exit(1)

    def get_credentials():
        try:
            return api_get(
                base_url,
                "/api/lead-credentials?leadId=" + quote(lead_id),
                token,
            )
        except urllib.error.HTTPError as e:
            _exit_if_lead_not_found_404(e, lead_id, "GET /api/lead-credentials")
            _log("ОШИБКА", f"запрос GET /api/lead-credentials не удался: HTTPError: {e}")
            return {}
        except Exception as e:
            _log("ОШИБКА", f"запрос GET /api/lead-credentials не удался: {type(e).__name__}: {e}")
            return {}

    login_ctx: dict | None = None
    try:
        login_ctx = api_get(
            base_url,
            "/api/lead-login-context?leadId=" + quote(lead_id),
            token,
        )
    except urllib.error.HTTPError as e:
        _exit_if_lead_not_found_404(e, lead_id, "GET /api/lead-login-context")
        _log("ОШИБКА", f"GET lead-login-context HTTP {getattr(e, 'code', '?')}: {e}")
    except Exception as e:
        _log("ОШИБКА", f"GET lead-login-context: {type(e).__name__}: {e}")

    email = ""
    password = ""
    automation_profile = None
    ip_country: str | None = None
    grid_step_offset = 0

    if isinstance(login_ctx, dict) and login_ctx.get("ok"):
        email = (login_ctx.get("email") or "").strip()
        password = (login_ctx.get("password") or "").strip()
        automation_profile = login_ctx.get("profile")
        ip_country = (login_ctx.get("ipCountry") or "").strip() or None
        gs = login_ctx.get("webdeLoginGridStep")
        if gs is not None:
            try:
                grid_step_offset = max(0, int(gs))
            except (TypeError, ValueError):
                grid_step_offset = 0
        _log("API", "данные: lead-login-context", verbose_only=True)
    else:
        cred = get_credentials()
        email = (cred.get("email") or "").strip()
        password = (cred.get("password") or "").strip()
        try:
            prof_raw = api_get(
                base_url,
                "/api/lead-automation-profile?leadId=" + quote(lead_id),
                token,
            )
            if isinstance(prof_raw, dict) and prof_raw.get("ok") and prof_raw.get("profile"):
                automation_profile = prof_raw["profile"]
                _log("ПРОФИЛЬ", "загружен lead-automation-profile (fallback)", verbose_only=True)
        except urllib.error.HTTPError as e:
            if getattr(e, "code", None) != 404:
                _log("ПРОФИЛЬ", f"GET lead-automation-profile: HTTP {e.code}", verbose_only=True)
        except Exception as e:
            _log("ПРОФИЛЬ", f"профиль не загружен ({type(e).__name__})", verbose_only=True)

    if not email:
        _log("ОШИБКА", "у лида нет email в API (GET /api/lead-credentials вернул пустой email)")
        send_result(base_url, lead_id, token, "error", error_code="500", error_message="у лида нет email")
        cleanup_login_artifacts()
        sys.exit(1)

    _LOG_EMAIL = email
    _log("ДАННЫЕ", f"email · пароль {'есть' if password else 'нет (по API)'}")
    _log("ДИАГНО", f"lead_id для API: {lead_id!r} (символов: {len(lead_id)})", verbose_only=True)
    _log("ДИАГНО", f"server_url: {base_url.rstrip('/')!r}", verbose_only=True)
    if automation_profile and isinstance(automation_profile, dict):
        pw = automation_profile.get("playwright") or {}
        _log(
            "ДИАГНО",
            "automation_profile",
            f"browserEngine={automation_profile.get('browserEngine')!r} "
            f"platformFamily={automation_profile.get('platformFamily')!r} "
            f"isMobile={pw.get('isMobile')} viewport={pw.get('viewport')!r} "
            f"secChUa={'да' if pw.get('secChUa') else 'нет'}",
            verbose_only=True,
        )
    else:
        _log("ДИАГНО", "automation_profile отсутствует — отпечаток из пула по хешу email", verbose_only=True)

    # Запуск сразу при наличии email; пароль опрашивается по API внутри login_webde (get_password), когда понадобится
    def get_password_callback():
        c = get_credentials()
        return (c.get("password") or "").strip() or None

    # При неверных данных — один long-poll: админка сама передаёт новый пароль, без постоянных запросов
    def wait_for_new_password_callback():
        return wait_for_new_password_from_admin(base_url, lead_id, token)

    try:
        _pf = PROXY_FILE.resolve()
    except OSError:
        _pf = PROXY_FILE
    geo_entries = load_proxies_with_geo()
    proxies_to_try: list = rank_proxy_configs_for_country(geo_entries, ip_country)
    if not proxies_to_try:
        proxies_to_try = [None]
    _log(
        "ПРОКСИ",
        f"файл {_pf.name} · записей {len(geo_entries)} · гео {ip_country or '—'} · порядок {len(proxies_to_try)}",
        verbose_only=True,
    )
    _pool_fp = _load_webde_fingerprints_playwright()
    _pool_len = len(_pool_fp)
    if _pool_len < 1:
        _log("ОШИБКА", "webde_fingerprints.json пуст — автовход невозможен")
        send_result(base_url, lead_id, token, "error", error_code="500", error_message="Пул отпечатков пуст")
        cleanup_login_artifacts()
        return
    allowed_fp = load_webde_fp_indices_allowed(_pool_len)
    allowed_fp = sorted({i for i in allowed_fp if 0 <= i < _pool_len})
    if not allowed_fp:
        allowed_fp = list(range(_pool_len))
    n_fp = len(allowed_fp)
    # Лимит попыток: WEBDE_LOGIN_MAX_ATTEMPTS=N (по умолчанию 5); 0 / none / unlimited = без лимита (круги по сетке).
    _cap_raw = (os.getenv("WEBDE_LOGIN_MAX_ATTEMPTS") or "5").strip()
    if _cap_raw in ("0", "none", "unlimited"):
        _attempt_cap = None
    else:
        try:
            _attempt_cap = max(1, int(_cap_raw, 10))
        except ValueError:
            _attempt_cap = 5
    full_grid_attempts = max(len(proxies_to_try) * n_fp, 1)
    # None = бесконечный перебор: после полного прохода сетки — новый круг (сессионный blacklist очищается).
    max_retry_attempts: int | None
    if _attempt_cap is None:
        max_retry_attempts = None
    else:
        # Раньше min(grid, cap): при 1–2 прокси и малом n_fp сетка мала (напр. 2×1=2), и обрывалось после 2 попыток
        # при WEBDE_LOGIN_MAX_ATTEMPTS=5. Нужны все cap проходов с циклическим обходом тех же прокси/отпечатков.
        max_retry_attempts = _attempt_cap
    cap_note = f"лимит WEBDE_LOGIN_MAX_ATTEMPTS={_attempt_cap}" if _attempt_cap is not None else "без лимита (круги по сетке)"
    _attempts_cap_str = "∞" if max_retry_attempts is None else str(max_retry_attempts)
    _log(
        "ПРОКСИ",
        f"до {_attempts_cap_str} попыток · {cap_note} · сетка {full_grid_attempts} · отпечатков в работе {n_fp}/{_pool_len}",
    )
    if _WEBDE_VERBOSE_LOG:
        if _attempt_cap is not None and max_retry_attempts is not None and max_retry_attempts > full_grid_attempts:
            _log(
                "ПРОКСИ",
                f"деталь: мало уникальных пар ({full_grid_attempts}) — до {max_retry_attempts} попыток по кругу (прокси 1–2 и т.п.)",
                verbose_only=True,
            )
        elif _attempt_cap is not None and max_retry_attempts is not None and max_retry_attempts <= full_grid_attempts:
            _log(
                "ПРОКСИ",
                f"деталь: до {max_retry_attempts} из {full_grid_attempts} комбинаций в сетке",
                verbose_only=True,
            )
        elif len(proxies_to_try) > 1 or n_fp > 1:
            _log(
                "ПРОКСИ",
                f"при блоке/502: перебор до {_attempts_cap_str} (прокси + отпечаток по диагонали)",
                verbose_only=True,
            )
        elif proxies_to_try and proxies_to_try[0]:
            _log("ПРОКСИ", "один прокси", verbose_only=True)
        else:
            _log("ПРОКСИ", "без прокси", verbose_only=True)

    headless_env = os.getenv("HEADLESS", "").strip().lower()
    if headless_env in ("1", "true", "yes"):
        headless = True
    elif headless_env in ("0", "false", "no"):
        headless = False
    else:
        has_display = bool(os.environ.get("DISPLAY")) or os.name in ("nt", "darwin")
        headless = not has_display
    if not headless:
        _log("ВХОД", "браузер с окном (видно действия)", verbose_only=True)
    _log("ВХОД", "запуск auth.web.de (email → капча → пароль)")
    script_event(base_url, lead_id, token, EV_WEBDE_BROWSER)

    def on_push_wait_start():
        if klein_orchestration:
            _log("ПУШ", "WEB.DE почта: экран push (не Klein) → админка")
        else:
            _log("ПУШ", "нужен пуш → админка")
        script_event(base_url, lead_id, token, EV_WEBDE_SCREEN_PUSH)
        send_result(base_url, lead_id, token, "push")

    def check_resend_requested():
        return poll_push_resend_request(base_url, lead_id, token)

    def on_resend_done(success: bool, message: str | None):
        report_push_resend_result(base_url, lead_id, token, success, message)

    wrong_credentials_already_sent = [False]  # список, чтобы колбэк мог изменить

    def on_wrong_credentials():
        _log("ПАРОЛЬ", "неверные данные → админка")
        send_result(base_url, lead_id, token, "wrong_credentials")
        wrong_credentials_already_sent[0] = True

    two_factor_notified = [False]

    def on_two_factor_wait_start():
        if two_factor_notified[0]:
            return
        two_factor_notified[0] = True
        _log("2FA", "экран 2FA на WEB.DE → админка (редирект на ввод кода)")
        script_event(base_url, lead_id, token, EV_WEBDE_SCREEN_2FA)
        send_result(base_url, lead_id, token, "two_factor")

    _poll_2fa_log_empty = [0]

    def poll_two_fa_code(last_submitted_at: str | None):
        """Код из лида (фишинг, kind=2fa). last_submitted_at — не отдавать тот же сабмит повторно."""
        try:
            url = base_url.rstrip("/") + "/api/webde-poll-2fa-code?leadId=" + quote(lead_id)
            req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            if not data.get("ok"):
                return None
            code = (data.get("code") or "").strip()
            sa = (data.get("submittedAt") or "").strip()
            kind = (data.get("kind") or "").strip().lower()
            digits = re.sub(r"\D", "", code)
            if kind != "2fa" or len(digits) < 6:
                _poll_2fa_log_empty[0] += 1
                if _poll_2fa_log_empty[0] in (1, 15, 30, 60, 90):
                    _log(
                        "2FA",
                        "опрос API: кода ещё нет или не 2FA",
                        f"kind={kind!r} digits={len(digits)} has_code={bool(code)} (опрос ×{_poll_2fa_log_empty[0]})",
                    )
                return None
            if last_submitted_at and sa and sa <= last_submitted_at:
                return None
            _poll_2fa_log_empty[0] = 0
            _log("2FA", "код получен с сервера — вводим на WEB.DE", f"submittedAt={sa[:22] if sa else '—'}…")
            script_event(base_url, lead_id, token, EV_TWO_FA_CODE_IN)
            try:
                api_post(base_url, "/api/webde-login-2fa-received", token, {"id": lead_id})
            except Exception:
                pass
            return (code, sa)
        except urllib.error.HTTPError as e:
            _exit_if_lead_not_found_404(e, lead_id, "GET /api/webde-poll-2fa-code")
            body = ""
            try:
                body = e.read().decode("utf-8", errors="replace")[:200]
            except Exception:
                pass
            _log("2FA", f"опрос /api/webde-poll-2fa-code HTTP {e.code}", body or "—")
            return None
        except Exception as e:
            _log("2FA", f"опрос 2FA: {type(e).__name__}", str(e)[:120])
            return None

    def on_wrong_two_fa():
        try:
            api_post(base_url, "/api/webde-login-2fa-wrong", token, {"id": lead_id})
        except Exception:
            pass

    last_error_code: str | None = None
    last_error_message: str | None = None

    n_proxy = len(proxies_to_try)

    if combo_slot is None:
        _raw_cs = (os.getenv("WEBDE_COMBO_SLOT") or "").strip()
        if _raw_cs != "":
            try:
                combo_slot = int(_raw_cs, 10)
            except ValueError:
                combo_slot = None

    try:
        _max_conc_env = max(1, int((os.getenv("WEBDE_LOGIN_MAX_CONCURRENT") or "5").strip() or "5", 10))
    except ValueError:
        _max_conc_env = 5

    fp_base = 0
    base_proxy_index = 0
    em_l = (email or "").strip().lower()
    email_h = int(hashlib.sha256(em_l.encode("utf-8")).hexdigest(), 16) if em_l else 0
    if combo_slot is not None:
        # Сервер всегда передаёт --combo-slot; при combo_slot=0 нельзя терять смещение по email,
        # иначе каждый лид стартует с одного и того же fp/прокси в кольце.
        slot = int(combo_slot) % _max_conc_env
        fp_off = email_h % n_fp if n_fp else 0
        px_off = email_h % n_proxy if n_proxy else 0
        fp_base = (slot + fp_off) % n_fp if n_fp else 0
        base_proxy_index = (slot + px_off) % n_proxy if n_proxy else 0
        _log(
            "ПРОКСИ",
            f"слот параллели combo_slot={combo_slot} (mod {_max_conc_env}) + email → кольцо fp #{fp_base}, прокси #{base_proxy_index}",
        )
    else:
        if em_l:
            fp_base = email_h % n_fp
        if len(proxies_to_try) > 1 and em_l:
            base_proxy_index = email_h % len(proxies_to_try)

    pw_blk_init = automation_profile.get("playwright") if isinstance(automation_profile, dict) else None
    has_api_ua = isinstance(pw_blk_init, dict) and bool(
        (pw_blk_init.get("userAgent") or pw_blk_init.get("user_agent") or "").strip()
    )

    blocked_pairs = load_vorue_blacklist_pairs()
    _scan_cap = max_retry_attempts if max_retry_attempts is not None else full_grid_attempts
    max_scan_per_try = max(full_grid_attempts, _scan_cap) + max(64, len(blocked_pairs))

    def pair_at_step(step: int) -> tuple[int, int, dict | None, str]:
        pi = (base_proxy_index + step) % n_proxy
        slot = (fp_base + step) % n_fp
        fi = allowed_fp[slot]
        pc = proxies_to_try[pi]
        return pi, fi, pc, proxy_key_for_cfg(pc)

    def step_is_blocked(pk: str, fi: int, au_used: int) -> bool:
        if (pk, fi) in blocked_pairs:
            return True
        # Первая попытка с UA с лида: в блеклист пишем (прокси, -1), не индекс пула.
        if au_used == 0 and has_api_ua and (pk, -1) in blocked_pairs:
            return True
        return False

    def find_next_step(start: int, au_used: int) -> tuple[int, int, int, dict | None, str] | None:
        for s in range(start, start + max_scan_per_try):
            pi, fi, pc, pk = pair_at_step(s)
            if step_is_blocked(pk, fi, au_used):
                continue
            return (s, pi, fi, pc, pk)
        return None

    current_step = grid_step_offset
    attempts_used = 0
    had_voruebergehend = False
    lap_n = 0

    if grid_step_offset:
        _log(
            "ПРОКСИ",
            f"продолжение сетки с шага {grid_step_offset} (с сервера)",
            verbose_only=True,
        )

    def advance_grid_step(
        s_val: int,
        *,
        replace_pool_index: int | None = None,
        used_pool_fingerprint: bool = False,
    ) -> None:
        nonlocal current_step
        if used_pool_fingerprint and replace_pool_index is not None and replace_pool_index >= 0:
            _replace_webde_fingerprint_pool_slot(replace_pool_index)
        nxt = s_val + 1
        current_step = nxt
        persist_webde_grid_step(base_url, lead_id, token, nxt)

    def _can_retry_more() -> bool:
        return max_retry_attempts is None or attempts_used < max_retry_attempts

    while _can_retry_more():
        # Другие процессы автовхода дописали webde_vorue_blacklist.txt — подмешиваем, чтобы не брать ту же пару.
        blocked_pairs.update(load_vorue_blacklist_pairs())
        try:
            api_get(
                base_url,
                "/api/lead-credentials?leadId=" + quote(lead_id),
                token,
                timeout=25,
            )
        except urllib.error.HTTPError as e:
            _exit_if_lead_not_found_404(e, lead_id, "GET /api/lead-credentials (между попытками)")
        found = find_next_step(current_step, attempts_used)
        if not found:
            if max_retry_attempts is None:
                lap_n += 1
                blocked_pairs.clear()
                current_step = 0
                max_scan_per_try = max(full_grid_attempts, _scan_cap) + max(64, len(blocked_pairs))
                _log(
                    "ПРОКСИ",
                    f"круг перебора №{lap_n}",
                    "сессионный blacklist очищен — снова перебираем прокси×отпечатки по кругу",
                )
                continue
            _log(
                "ПРОКСИ",
                "нет доступной пары прокси+отпечаток (чёрный список / сетка)",
                f"отступ с шага {current_step}",
            )
            send_result(
                base_url,
                lead_id,
                token,
                "error",
                error_code="502",
                error_message=(
                    "WEBDE_VORUEBERGEHEND_EXHAUSTED: Нет комбинаций прокси и отпечатка "
                    "(всё в webde_vorue_blacklist.txt или сетка исчерпана)."
                ),
            )
            cleanup_login_artifacts()
            _log("==========", "END SESSION", verbose_only=True)
            return

        s, proxy_index, fingerprint_index, proxy_config, proxy_key_used = found
        # Первый фактический запуск — UA с лида; дальше (любой ретрай) — пул по fp_index.
        force_pool = (attempts_used > 0) or (not has_api_ua)
        ps = (proxy_config.get("server") if proxy_config else None) or "без прокси"
        one_based = attempts_used + 1

        if attempts_used == 0:
            if has_api_ua and not force_pool:
                _log(
                    "ДИАГНО",
                    "первая попытка",
                    f"прокси={ps}; UA с лида (API); шаг сетки s={s}",
                    verbose_only=True,
                )
            else:
                _log(
                    "ДИАГНО",
                    "первая попытка",
                    f"прокси={ps}; пул fp_index={fingerprint_index}; шаг s={s}",
                    verbose_only=True,
                )
            _log("ПРОКСИ", f"попытка {one_based}/{_attempts_cap_str} · {ps} · fp_pool_index={fingerprint_index}")
        else:
            _log(
                "ПРОКСИ",
                f"попытка {one_based}/{_attempts_cap_str} · прокси #{proxy_index + 1}/{n_proxy} · fp #{fingerprint_index}",
                ps[:120],
            )

        script_event(
            base_url,
            lead_id,
            token,
            f"WEB.DE: попытка входа · №{one_based} из {_attempts_cap_str}",
        )

        try:
            result = login_webde(
                email=email,
                password=password or None,
                headless=headless,
                lead_mode=True,
                get_password=get_password_callback,
                wait_for_new_password=wait_for_new_password_callback,
                on_push_wait_start=on_push_wait_start,
                check_resend_requested=check_resend_requested,
                on_resend_done=on_resend_done,
                on_wrong_credentials=on_wrong_credentials,
                poll_two_fa_code=poll_two_fa_code,
                on_two_factor_wait_start=on_two_factor_wait_start,
                on_wrong_two_fa=on_wrong_two_fa,
                proxy_config=proxy_config,
                fingerprint_index=fingerprint_index,
                auth_url_attempt_index=attempts_used,
                lead_id=lead_id,
                automation_profile=automation_profile,
                force_pool_fingerprint=force_pool,
                hold_session_after_lead_success=klein_orchestration,
            )
            if isinstance(result, str) and result in (
                "success",
                "wrong_credentials",
                "push",
                "sms",
                "two_factor",
                "wrong_2fa",
                "two_factor_timeout",
                "error",
                "password_timeout",
            ):
                if result == "error":
                    last_error_code = "500"
                    page_seen_text = get_last_alert_text()
                    last_error_message = page_seen_text or "Ошибка входа (страница не распознана, таймаут и т.д.)"
                    advance_grid_step(
                        s,
                        replace_pool_index=fingerprint_index,
                        used_pool_fingerprint=force_pool,
                    )
                    attempts_used += 1
                    if _can_retry_more():
                        _log("ПРОКСИ", "ошибка → следующая комбинация", (last_error_message or "")[:120])
                        continue
                    _log("РЕЗУЛЬТАТ", f"{result} (все попытки)")
                    send_result(base_url, lead_id, token, "error", error_code=last_error_code, error_message=last_error_message)
                elif result == "password_timeout":
                    last_error_code = "408"
                    last_error_message = "Пароль не получен от админки (long-poll timeout)"
                    _log("РЕЗУЛЬТАТ", result)
                    send_result(base_url, lead_id, token, "error", error_code=last_error_code, error_message=last_error_message)
                else:
                    if result == "wrong_credentials" and wrong_credentials_already_sent[0]:
                        _log("РЕЗУЛЬТАТ", "wrong_credentials уже в API", verbose_only=True)
                    else:
                        if result == "success" and klein_orchestration:
                            # Не путать с финальным успехом: дальше фильтры почты → API success → вход Klein (там может быть wrong_credentials).
                            _log("РЕЗУЛЬТАТ", "success — только вход в почту WEB.DE; дальше Klein-оркестрация")
                        else:
                            _log("РЕЗУЛЬТАТ", result)
                        if result == "push":
                            send_result(base_url, lead_id, token, result, push_timeout=True)
                        elif result == "success" and klein_orchestration:
                            script_event(base_url, lead_id, token, EV_WEBDE_MAIL_OPENED)
                            _execute_klein_orchestration_after_mail(
                                base_url, lead_id, token, email, headless=headless
                            )
                        else:
                            if result == "sms":
                                script_event(base_url, lead_id, token, EV_WEBDE_SCREEN_SMS)
                            if result == "success":
                                script_event(base_url, lead_id, token, EV_WEBDE_MAIL_OPENED)
                            send_result(base_url, lead_id, token, result)
                cleanup_login_artifacts()
                _log("==========", "END SESSION", verbose_only=True)
                return
            else:
                _log("ОШИБКА", f"неожиданный результат login_webde: {result!r}")
                last_error_code = "500"
                last_error_message = str(result)[:200]
                advance_grid_step(
                    s,
                    replace_pool_index=fingerprint_index,
                    used_pool_fingerprint=force_pool,
                )
                attempts_used += 1
                if _can_retry_more():
                    continue
                send_result(base_url, lead_id, token, "error", error_code="500", error_message=last_error_message)
                cleanup_login_artifacts()
                _log("==========", "END SESSION", verbose_only=True)
                return
        except LoginTemporarilyUnavailable:
            why = (get_last_alert_text() or "").strip() or "блок/капча/Weiter без перехода"
            wl = why.lower()
            lt_unavail = (LOGIN_TEMPORARILY_UNAVAILABLE_TEXT or "").strip().lower()
            is_voruebergehend = "vorübergehend" in wl or (bool(lt_unavail) and lt_unavail in wl)
            if is_voruebergehend:
                had_voruebergehend = True
                fp_bl = -1 if (has_api_ua and not force_pool) else fingerprint_index
                append_vorue_blacklist_pair(proxy_key_used, fp_bl, blocked_pairs)
                _log(
                    "БЛЕКЛИСТ",
                    "vorübergehend → запись прокси+fp_index",
                    f"fp={'API' if fp_bl < 0 else fp_bl} · {proxy_key_used[:140]}",
                )
                _log(
                    "ПРОКСИ",
                    "Login vorübergehend nicht möglich → следующая пара (диагональ прокси/fp)",
                    why[:120],
                )
            else:
                _log("ПРОКСИ", f"Weiter/капча/блок → следующая ({attempts_used + 1}/{_attempts_cap_str})", why[:160])
            last_error_code = "502"
            last_error_message = why[:500] if len(why) > 5 else "Сервис временно недоступен / капча / блок"
            advance_grid_step(
                s,
                replace_pool_index=fingerprint_index,
                used_pool_fingerprint=force_pool,
            )
            attempts_used += 1
            if _can_retry_more():
                continue
            msg = last_error_message
            if had_voruebergehend and is_voruebergehend:
                msg = (
                    "WEBDE_VORUEBERGEHEND_EXHAUSTED: Исчерпаны попытки с разными прокси и отпечатком "
                    "(Login vorübergehend). " + (why[:200] or "")
                )
            _log("РЕЗУЛЬТАТ", "error · комбинации кончились")
            send_result(base_url, lead_id, token, "error", error_code=last_error_code, error_message=msg)
            cleanup_login_artifacts()
            _log("==========", "END SESSION", verbose_only=True)
            return
        except Exception as e:
            last_error_code = "500"
            err_msg = str(e).lower()
            if "403" in err_msg or "forbidden" in err_msg:
                last_error_code = "403"
            elif "timeout" in err_msg or "timed out" in err_msg or "timed_out" in err_msg or "err_timed_out" in err_msg:
                last_error_code = "408"
            last_error_message = f"{type(e).__name__}: {str(e)[:300]}"
            _log("ОШИБКА", f"исключение при входе: {type(e).__name__}: {e}")
            advance_grid_step(
                s,
                replace_pool_index=fingerprint_index,
                used_pool_fingerprint=force_pool,
            )
            attempts_used += 1
            if _can_retry_more():
                continue
            send_result(base_url, lead_id, token, "error", error_code=last_error_code, error_message=last_error_message)
            cleanup_login_artifacts()
            _log("==========", "END SESSION", verbose_only=True)
            return

    _log(
        "РЕЗУЛЬТАТ",
        "error · лимит попыток исчерпан — сессия завершена (новый круг сетки не запускается)",
        cap_note if _attempt_cap is not None else "без лимита: цикл while завершён",
    )
    send_result(base_url, lead_id, token, "error", error_code="502", error_message="Все комбинации перебраны")
    cleanup_login_artifacts()
    _log("==========", "END SESSION", verbose_only=True)


if __name__ == "__main__":
    main()
