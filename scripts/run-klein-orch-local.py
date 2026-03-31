#!/usr/bin/env python3
"""
Загружает корневой .env построчно (значения с & и т.п. — без shell source)
и запускает login/lead_simulation_api.py --klein-orchestration.

Переменные реального Chrome задаются в .env (WEBDE_CHROME_USER_DATA_DIR,
KLEIN_ISOLATED_CHROME_USER_DATA_DIR, WEBDE_BROWSER_EXECUTABLE, HEADLESS=0, …).

Использование:
  python3 scripts/run-klein-orch-local.py [LEAD_ID]
По умолчанию LEAD_ID из env LEAD_ID_ORCH или тестовый лид из SQLite под WEBDE_EMAIL.
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
SIM = ROOT / "login" / "lead_simulation_api.py"


def load_dotenv_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if k:
            os.environ[k] = v


def default_lead_id_from_db() -> str:
    email = (os.environ.get("WEBDE_EMAIL") or "").strip()
    db = ROOT / "data" / "database.sqlite"
    if email and db.is_file():
        try:
            con = sqlite3.connect(str(db))
            try:
                row = con.execute(
                    "SELECT id FROM leads WHERE lower(email) = lower(?) LIMIT 1",
                    (email,),
                ).fetchone()
                if row and row[0]:
                    return str(row[0])
            finally:
                con.close()
        except Exception:
            pass
    return "mn9g6yrqbd0476puxc9"


def main() -> int:
    load_dotenv_file(ENV_FILE)
    port = (os.environ.get("PORT") or "3002").strip()
    secret = (os.environ.get("WORKER_SECRET") or "").strip()
    if not secret:
        print("WORKER_SECRET пуст — задайте в .env", file=sys.stderr)
        return 2
    lead = (sys.argv[1] if len(sys.argv) > 1 else "").strip() or (
        os.environ.get("LEAD_ID_ORCH") or ""
    ).strip() or default_lead_id_from_db()
    os.environ.setdefault("WEBDE_PROXY_FROM_ADMIN", "1")
    cmd = [
        sys.executable,
        str(SIM),
        "--server-url",
        f"http://127.0.0.1:{port}",
        "--lead-id",
        lead,
        "--worker-secret",
        secret,
        "--klein-orchestration",
    ]
    print(f"[run-klein-orch-local] lead={lead} url=http://127.0.0.1:{port}", flush=True)
    return subprocess.call(cmd, cwd=str(ROOT), env=os.environ)


if __name__ == "__main__":
    raise SystemExit(main())
