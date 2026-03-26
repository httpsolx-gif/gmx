#!/usr/bin/env python3
"""
Одна порция пробы: до 3 индексов отпечатка параллельно, один прокси (первая строка proxy.txt).

stdin: JSON { "email", "indices", "headless", "requirePasswordField"?, "password" — игнорируется }
Параллелизм: WEBDE_PROBE_MAX_WORKERS=1..3 (по умолчанию 3). На 2 ГБ RAM лучше 1.
stdout: одна строка JSON { "ok": true, "results": [{ "index", "status" }] } или { "ok": false, "error" }
"""
from __future__ import annotations

import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))


def _first_proxy_config():
    from webde_login import PROXY_FILE, _parse_proxy_line_with_optional_geo

    if not PROXY_FILE.is_file():
        return None
    with open(PROXY_FILE, "r", encoding="utf-8") as f:
        for line in f:
            st = line.strip()
            if not st or st.startswith("#"):
                continue
            cfg, _ = _parse_proxy_line_with_optional_geo(line.rstrip("\n"))
            if cfg:
                return cfg
    return None


def _run_batch(email: str, indices: list[int], headless: bool, require_password_field: bool) -> dict:
    from webde_probe_worker import run_probe

    if not indices:
        return {"ok": True, "results": []}
    proxy = _first_proxy_config()
    proxy_json = json.dumps(proxy) if proxy else ""
    # На VPS 1–2 ГБ ОЗУ три параллельных Chromium легко съедают >1.5 ГБ (RAM растёт, CPU почти 0 — ждут I/O).
    try:
        cap = int(os.environ.get("WEBDE_PROBE_MAX_WORKERS", "3") or "3")
    except ValueError:
        cap = 3
    cap = max(1, min(3, cap))
    workers = min(cap, len(indices))
    tasks = [(email, proxy_json, int(i), headless, require_password_field) for i in indices]
    results: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as ex:
        future_map = {ex.submit(run_probe, *t): t[2] for t in tasks}
        for fut in as_completed(future_map):
            idx = future_map[fut]
            try:
                results.append(fut.result())
            except Exception:
                results.append({"index": idx, "status": "error"})
    results.sort(key=lambda r: int(r.get("index", 0)))
    return {"ok": True, "results": results}


def main() -> None:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        print(json.dumps({"ok": False, "error": "invalid json"}))
        sys.exit(1)

    email = (data.get("email") or "").strip()
    indices_raw = data.get("indices") or []
    headless = bool(data.get("headless", True))
    require_pf = bool(data.get("requirePasswordField") or data.get("require_password_field"))

    if not email:
        print(json.dumps({"ok": False, "error": "missing email"}))
        sys.exit(1)
    if not isinstance(indices_raw, list):
        print(json.dumps({"ok": False, "error": "indices must be array"}))
        sys.exit(1)

    clean_idx: list[int] = []
    for x in indices_raw:
        try:
            clean_idx.append(int(x))
        except (TypeError, ValueError):
            continue

    out = _run_batch(email, clean_idx, headless, require_pf)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
