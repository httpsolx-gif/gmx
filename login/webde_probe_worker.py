"""Воркер для подпроцессов webde_probe_batch (функция импортируема для pickle/spawn)."""

from __future__ import annotations

import json


def run_probe(email: str, proxy_json: str, idx: int, headless: bool, require_password_field: bool = False) -> dict:
    from webde_login import probe_webde_proxy_fingerprint

    proxy_config = json.loads(proxy_json) if proxy_json else None
    try:
        status = probe_webde_proxy_fingerprint(
            email,
            proxy_config,
            int(idx),
            headless=bool(headless),
            require_password_field=bool(require_password_field),
        )
    except Exception:
        status = "error"
    return {"index": int(idx), "status": status}
