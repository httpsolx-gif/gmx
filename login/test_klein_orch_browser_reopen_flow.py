#!/usr/bin/env python3
"""
Тест сценария Klein-оркестрации: после mail_ready_klein браузер закрывается, идёт только опрос API;
симулируем появление emailKl в SQLite — снова открывается Chromium с теми же прокси/fp/куками (без повторного ввода пароля WEB.DE).

Запуск (из корня репозитория, видимый браузер по умолчанию):
  npm run klein:orch-visible
  или из login/: HEADLESS=0 python3 -u test_klein_orch_browser_reopen_flow.py

Нужны: npm start, .env с TEST_WEBDE_EMAIL, TEST_WEBDE_PASSWORD, WORKER_SECRET, PORT.
Перед стартом лид KLEIN_ORCH_REOPEN_TEST_LEAD_ID (по умолч. klein_orch_reopen_test) создаётся/обновляется с email_kl = NULL.

Перезагрузка Node/сервера: процесс lead_simulation обычно обрывается; куки остаются в login/cookies/*.json, БД на диске.
Повторный «resume только Klein без входа» в коде отдельно не реализован — новый запуск идёт с начала (вход WEB.DE), пока не сделают двухфазный воркер.

Переменные:
  KLEIN_ORCH_REOPEN_TEST_LEAD_ID — id лида
  KLEIN_ORCH_CLOSE_BROWSER_FOR_EMAILKL_WAIT=0 — отключит закрытие (тест не сработает по триггеру)
  KLEIN_ORCH_TEST_INJECT_DELAY_SEC — пауза перед записью emailKl в БД (по умолч. 0; можно 2)
  KLEIN_ORCH_WAIT_EMAIL_SEC / KLEIN_ORCH_POLL_INTERVAL_SEC — переопределить в .env при необходимости
  KLEIN_RESET_KLEIN_SEPARATE_BROWSER=0 — отключить второй браузер Klein без куков (по умолч. в тесте включено)
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

LOGIN_DIR = Path(__file__).resolve().parent
ROOT = LOGIN_DIR.parent
DB_PATH = ROOT / "data" / "database.sqlite"

TRIGGER_SUBSTR = "закрываю браузер на время ожидания emailKl"

_inject_lock = threading.Lock()
_inject_started = False


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _health(port: int) -> bool:
    try:
        with urlopen(Request(f"http://127.0.0.1:{port}/health", method="GET"), timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def prime_lead_no_email_kl(lead_id: str, email: str, password: str) -> None:
    conn = sqlite3.connect(str(DB_PATH))
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM leads WHERE id = ?", (lead_id,))
        exists = cur.fetchone() is not None
        if exists:
            cur.execute(
                """
                UPDATE leads SET
                  email = ?,
                  password = ?,
                  brand = 'klein',
                  email_kl = NULL,
                  webde_script_active_run = NULL,
                  script_status = NULL,
                  webde_login_grid_exhausted = NULL,
                  last_seen_at = ?
                WHERE id = ?
                """,
                (email, password, _now_iso(), lead_id),
            )
        else:
            cur.execute(
                """
                INSERT INTO leads (
                  id, email, email_kl, password, brand,
                  created_at, last_seen_at, status
                ) VALUES (?, ?, NULL, ?, 'klein', ?, ?, 'active')
                """,
                (lead_id, email, password, _now_iso(), _now_iso()),
            )
        conn.commit()
    finally:
        conn.close()


def inject_email_kl(lead_id: str, email: str) -> None:
    raw = (os.environ.get("KLEIN_ORCH_TEST_INJECT_DELAY_SEC") or "0").strip()
    try:
        delay = float(raw)
    except ValueError:
        delay = 0.0
    if delay > 0:
        time.sleep(delay)
    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute(
            "UPDATE leads SET email_kl = ?, last_seen_at = ? WHERE id = ?",
            (email, _now_iso(), lead_id),
        )
        conn.commit()
    finally:
        conn.close()
    print(f"\n[test-reopen-flow] ▶ в БД записан emailKl (симуляция лида) lead_id={lead_id}\n", flush=True)


def maybe_schedule_inject(lead_id: str, email: str) -> None:
    global _inject_started
    with _inject_lock:
        if _inject_started:
            return
        _inject_started = True
    threading.Thread(target=inject_email_kl, args=(lead_id, email), daemon=True).start()


def main() -> int:
    email = (os.environ.get("TEST_WEBDE_EMAIL") or "").strip()
    password = (os.environ.get("TEST_WEBDE_PASSWORD") or "").strip()
    secret = (os.environ.get("WORKER_SECRET") or "").strip()
    lead_id = (os.environ.get("KLEIN_ORCH_REOPEN_TEST_LEAD_ID") or "klein_orch_reopen_test").strip()
    if not email or "@" not in email:
        print("ERROR: TEST_WEBDE_EMAIL в .env", file=sys.stderr)
        return 1
    if not password:
        print("ERROR: TEST_WEBDE_PASSWORD в .env", file=sys.stderr)
        return 1
    if not secret:
        print("ERROR: WORKER_SECRET в .env", file=sys.stderr)
        return 1
    try:
        port = int((os.environ.get("PORT") or "3000").strip() or "3000", 10)
    except ValueError:
        port = 3000
    base = f"http://127.0.0.1:{port}"

    if not DB_PATH.is_file():
        print(f"ERROR: нет {DB_PATH}", file=sys.stderr)
        return 2
    if not _health(port):
        print(f"ERROR: нет ответа {base}/health — запустите сервер", file=sys.stderr)
        return 3

    close_raw = (os.environ.get("KLEIN_ORCH_CLOSE_BROWSER_FOR_EMAILKL_WAIT") or "").strip().lower()
    if close_raw in ("0", "false", "no", "off"):
        print(
            "WARN: KLEIN_ORCH_CLOSE_BROWSER_FOR_EMAILKL_WAIT отключает закрытие браузера — триггер инъекции не появится.",
            file=sys.stderr,
        )

    prime_lead_no_email_kl(lead_id, email, password)
    print(
        f"[test-reopen-flow] лид {lead_id}: email_kl очищен; при строке «{TRIGGER_SUBSTR[:40]}…» через 2s запишу emailKl",
        flush=True,
    )

    cmd = [
        sys.executable,
        "-u",
        str(LOGIN_DIR / "lead_simulation_api.py"),
        "--server-url",
        base,
        "--lead-id",
        lead_id,
        "--worker-secret",
        secret,
        "--klein-orchestration",
    ]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    if not (env.get("KLEIN_ORCH_WAIT_EMAIL_SEC") or "").strip():
        env["KLEIN_ORCH_WAIT_EMAIL_SEC"] = "90"
    if not (env.get("KLEIN_ORCH_POLL_INTERVAL_SEC") or "").strip():
        env["KLEIN_ORCH_POLL_INTERVAL_SEC"] = "0.5"
    if not (env.get("KLEIN_RESET_KLEIN_SEPARATE_BROWSER") or "").strip():
        env["KLEIN_RESET_KLEIN_SEPARATE_BROWSER"] = "1"

    proc = subprocess.Popen(
        cmd,
        cwd=str(LOGIN_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert proc.stdout
    try:
        while True:
            line = proc.stdout.readline()
            if not line:
                break
            sys.stdout.write(line)
            sys.stdout.flush()
            if TRIGGER_SUBSTR in line:
                maybe_schedule_inject(lead_id, email)
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()
        return 130
    rc = proc.wait()
    return int(rc) if rc is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
