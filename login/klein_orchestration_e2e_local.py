#!/usr/bin/env python3
"""
Локальный полный прогон Klein-оркестрации (как lead_simulation_api --klein-orchestration):
WEB.DE → Config E-Mail → фильтры → mail_ready_klein → сброс пароля Klein → Papierkorb → ссылка → новый пароль → ULP.

Без ожидания «жертвы» на форме: в БД заранее выставляются поля лида.
По умолчанию email_kl = TEST_WEBDE_EMAIL (тот же ящик для письма сброса).
Иначе: KLEIN_E2E_EMAIL_KL=klein@… — только Klein (forgot), почта WEB.DE остаётся TEST_WEBDE_EMAIL.

Требования: запущенный Node (npm start), .env в корне проекта:
  TEST_WEBDE_EMAIL, TEST_WEBDE_PASSWORD, WORKER_SECRET, PORT (опц.)

  KLEIN_E2E_LEAD_ID=… — идентификатор лида (по умолчанию klein_e2e_local)
  KLEIN_E2E_EMAIL_KL=… — опционально, отдельный emailKl для Klein
  HEADLESS=1 — без окна (рекомендуется на сервере)

Запуск из каталога login/:
  python3 klein_orchestration_e2e_local.py
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

LOGIN_DIR = Path(__file__).resolve().parent
ROOT = LOGIN_DIR.parent
DB_PATH = ROOT / "data" / "database.sqlite"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _health_ok(port: int) -> bool:
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/health", method="GET")
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def upsert_klein_lead(lead_id: str, email: str, password: str, email_kl: str | None = None) -> None:
    """email/password — WEB.DE; email_kl — Klein (forgot); если email_kl не задан — как email."""
    em_kl = (email_kl or "").strip() or email
    if not DB_PATH.is_file():
        print(f"ERROR: нет БД {DB_PATH}", file=sys.stderr)
        sys.exit(2)
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
                  email_kl = ?,
                  password = ?,
                  brand = 'klein',
                  webde_script_active_run = NULL,
                  script_status = NULL,
                  webde_login_grid_exhausted = NULL,
                  last_seen_at = ?
                WHERE id = ?
                """,
                (email, em_kl, password, _now_iso(), lead_id),
            )
        else:
            cur.execute(
                """
                INSERT INTO leads (
                  id, email, email_kl, password, brand,
                  created_at, last_seen_at, status
                ) VALUES (?, ?, ?, ?, 'klein', ?, ?, 'active')
                """,
                (lead_id, email, em_kl, password, _now_iso(), _now_iso()),
            )
        conn.commit()
    finally:
        conn.close()


def main() -> int:
    email = (os.environ.get("TEST_WEBDE_EMAIL") or "").strip()
    password = (os.environ.get("TEST_WEBDE_PASSWORD") or "").strip()
    secret = (os.environ.get("WORKER_SECRET") or "").strip()
    if not email or "@" not in email:
        print("ERROR: задайте TEST_WEBDE_EMAIL в .env", file=sys.stderr)
        return 1
    if not password:
        print("ERROR: задайте TEST_WEBDE_PASSWORD в .env", file=sys.stderr)
        return 1
    if not secret:
        print("ERROR: задайте WORKER_SECRET в .env", file=sys.stderr)
        return 1
    try:
        port = int((os.environ.get("PORT") or "3000").strip() or "3000", 10)
    except ValueError:
        port = 3000
    base = f"http://127.0.0.1:{port}"
    lead_id = (os.environ.get("KLEIN_E2E_LEAD_ID") or "klein_e2e_local").strip()

    if not _health_ok(port):
        print(f"ERROR: сервер не отвечает на {base}/health — запустите npm start", file=sys.stderr)
        return 3

    email_kl_env = (os.environ.get("KLEIN_E2E_EMAIL_KL") or "").strip()
    upsert_klein_lead(lead_id, email, password, email_kl_env or None)
    ek_note = f" email_kl={email_kl_env[:6]}…" if email_kl_env else " email_kl=TEST_WEBDE_EMAIL"
    print(f"[klein-e2e] lead_id={lead_id} web.de={email[:4]}… brand=klein{ek_note}", flush=True)

    cmd = [
        sys.executable,
        str(LOGIN_DIR / "lead_simulation_api.py"),
        "--server-url",
        base,
        "--lead-id",
        lead_id,
        "--worker-secret",
        secret,
        "--klein-orchestration",
    ]
    return subprocess.call(cmd, cwd=str(LOGIN_DIR), env=os.environ.copy())


if __name__ == "__main__":
    raise SystemExit(main())
