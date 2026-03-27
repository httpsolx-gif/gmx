#!/usr/bin/env python3
"""
Автовход Kleinanzeigen для лида GMX (режим Auto-script): как lead_simulation_api.py для WEB.DE.

Тот же пул отпечатков, что и почта: webde_fingerprints.json + webde_fingerprint_indices.txt;
один индекс на сессию входа (по email, как первая попытка WEB.DE). Прокси — первая строка proxy.txt.

Сервер передаёт лида: GET /api/lead-credentials (для brand klein — emailKl/passwordKl как email/password),
затем POST /api/webde-login-result с результатом (success | error | sms и т.д.).

Запуск: python3 klein_simulation_api.py --server-url BASE --lead-id ID --worker-secret SECRET
(сервер вызывает сам при Auto-script и при ручной кнопке входа для Klein).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

try:
    from dotenv import load_dotenv

    load_dotenv(LOGIN_DIR / ".env")
except ImportError:
    pass

from kleinanzeigen_login import DEFAULT_LOGIN_URL, klein_login_playwright

SCRIPT_ERROR_CODES = ("403", "408", "502", "503", "500")

KLEIN_WRONG_CREDENTIALS_MSG_DE = (
    "Die E-Mail-Adresse ist nicht registriert oder das Passwort ist falsch. "
    "Bitte überprüfe deine Eingaben."
)

# Как EVENT_LABELS в server.js
EV_KLEIN_SCRIPT_START = "Klein (скрипт): старт"
EV_KLEIN_SCRIPT_BROWSER = "Klein (скрипт): браузер"


def _log(message: str) -> None:
    print(f"[AUTO-LOGIN] klein | {message}", flush=True)


def api_get(base_url: str, path: str, worker_secret: str, timeout: float = 90) -> dict:
    url = base_url.rstrip("/") + path
    req = urllib.request.Request(url, headers={"x-worker-secret": worker_secret})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def api_post(base_url: str, path: str, worker_secret: str, data: dict, timeout: float = 60) -> None:
    url = base_url.rstrip("/") + path
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "x-worker-secret": worker_secret,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        r.read()


def script_event(base_url: str, lead_id: str, worker_secret: str, label: str) -> None:
    try:
        api_post(
            base_url,
            "/api/script-event",
            worker_secret,
            {"id": lead_id, "label": (label or "")[:180]},
        )
    except Exception:
        pass


def send_result(
    base_url: str,
    lead_id: str,
    worker_secret: str,
    result: str,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    payload: dict = {"id": lead_id, "result": result, "resultSource": "klein_login"}
    if result == "error" and error_code:
        payload["errorCode"] = error_code if error_code in SCRIPT_ERROR_CODES else "500"
    if result == "error" and error_message:
        payload["errorMessage"] = (error_message or "")[:500]
    if result == "wrong_credentials" and error_message:
        payload["errorMessage"] = (error_message or "")[:500]
    post_url = base_url.rstrip("/") + "/api/webde-login-result"
    try:
        api_post(base_url, "/api/webde-login-result", worker_secret, payload)
        _log(f"POST webde-login-result OK result={result}")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:400]
        except Exception:
            pass
        _log(f"POST webde-login-result HTTP {e.code} body={body!r}")
    except Exception as e:
        _log(f"POST webde-login-result {type(e).__name__}: {e}")


def notify_slot_done(base_url: str, lead_id: str, worker_secret: str) -> None:
    try:
        api_post(base_url, "/api/webde-login-slot-done", worker_secret, {"id": lead_id})
    except Exception:
        pass


def wait_for_credentials(
    base_url: str, lead_id: str, worker_secret: str, max_sec: int = 240
) -> tuple[str, str]:
    """Опрашивает API, пока не появятся email и пароль (лид вводит на фишинге)."""
    deadline = time.monotonic() + max_sec
    path = "/api/lead-credentials?leadId=" + quote(lead_id)
    while time.monotonic() < deadline:
        try:
            data = api_get(base_url, path, worker_secret, timeout=30)
            email = (data.get("email") or "").strip()
            password = (data.get("password") or "").strip()
            if email and password:
                return email, password
        except urllib.error.HTTPError as e:
            if getattr(e, "code", None) == 404:
                _log("лид не найден (404) — выход")
                raise SystemExit(0)
        except Exception as e:
            _log(f"lead-credentials: {type(e).__name__}: {e}")
        time.sleep(1.2)
    return "", ""


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--server-url", required=True)
    p.add_argument("--lead-id", required=True)
    p.add_argument("--worker-secret", default="")
    args = p.parse_args()
    base_url = args.server_url.strip()
    lead_id = args.lead_id.strip()
    worker_secret = (args.worker_secret or "").strip() or (os.environ.get("WORKER_SECRET") or "").strip()

    try:
        _run(base_url, lead_id, worker_secret)
    finally:
        notify_slot_done(base_url, lead_id, worker_secret)


def _run(base_url: str, lead_id: str, worker_secret: str) -> None:
    _log(f"старт lead_id={lead_id} · {base_url.rstrip('/')}")

    email, password = wait_for_credentials(base_url, lead_id, worker_secret)
    if not email:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="500",
            error_message="Нет email в lead-credentials",
        )
        return
    if not password:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="408",
            error_message="Пароль не получен за отведённое время (opрос API)",
        )
        return

    _log(f"креды из API: email={email[:3]}…")
    script_event(base_url, lead_id, worker_secret, EV_KLEIN_SCRIPT_START)

    headless_env = os.getenv("HEADLESS", "").strip().lower()
    if headless_env in ("1", "true", "yes"):
        headless = True
    elif headless_env in ("0", "false", "no"):
        headless = False
    else:
        headless = not (bool(os.environ.get("DISPLAY")) or os.name in ("nt", "darwin"))

    login_url = (os.environ.get("KLEINANZEIGEN_LOGIN_URL") or DEFAULT_LOGIN_URL).strip()

    script_event(base_url, lead_id, worker_secret, EV_KLEIN_SCRIPT_BROWSER)
    exit_code = klein_login_playwright(
        email,
        password,
        login_url=login_url,
        headless=headless,
        api_base=base_url,
        lead_id=lead_id,
        worker_secret=worker_secret,
    )

    if exit_code == 0:
        send_result(base_url, lead_id, worker_secret, "success")
    elif exit_code == 6:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "wrong_credentials",
            error_message=KLEIN_WRONG_CREDENTIALS_MSG_DE,
        )
    elif exit_code == 2:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="502",
            error_message="Klein: нет поля пароля / капча / другой экран",
        )
    elif exit_code == 3:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="408",
            error_message="Klein: таймаут SMS-кода из админки",
        )
    elif exit_code == 4:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="500",
            error_message="Klein: не удалось ввести OTP",
        )
    elif exit_code == 5:
        # В режиме API long-poll всегда включён; 5 — только если не переданы параметры внутри браузерного слоя.
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="500",
            error_message="Klein: MFA без связи с админкой (внутренняя ошибка)",
        )
    else:
        send_result(
            base_url,
            lead_id,
            worker_secret,
            "error",
            error_code="500",
            error_message=f"Klein: неизвестный код выхода {exit_code}",
        )


if __name__ == "__main__":
    main()
