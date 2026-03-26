#!/usr/bin/env python3
"""
Проверка, что сервер отдаёт «полный контекст лида» для автовхода WEB.DE
(парсинг → /api/lead-login-context) и что в снимке есть телеметрия.

Использование:
  python3 login/verify_lead_automation.py --server-url https://ADMIN_HOST --token YOUR_TOKEN --lead-id LEAD_ID

Опционально сравнить с сырым снимком (clientSignals vs profile.playwright.userAgent):
  добавьте --deep

Код выхода: 0 — критичные поля есть; 1 — профиля нет или нет email; 2 — ошибка HTTP/сети.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import quote


def api_get(url: str, token: str, timeout: float = 60) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    p = argparse.ArgumentParser(description="Проверка lead-login-context и телеметрии лида")
    p.add_argument("--server-url", required=True, help="База админки, напр. https://grzl.org")
    p.add_argument("--token", required=True, help="Bearer токен админки")
    p.add_argument("--lead-id", required=True, dest="lead_id", help="ID лида")
    p.add_argument("--deep", action="store_true", help="Запросить /api/lead-fingerprint и сверить UA")
    args = p.parse_args()

    base = args.server_url.rstrip("/")
    lid = quote(args.lead_id.strip(), safe="")
    token = args.token.strip()

    print("=== Проверка цепочки: лид → API → профиль автовхода ===\n")

    try:
        ctx = api_get(f"{base}/api/lead-login-context?leadId={lid}", token)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")[:400]
        except Exception:
            body = ""
        print(f"FAIL: GET lead-login-context HTTP {e.code}\n{body}")
        return 2
    except Exception as e:
        print(f"FAIL: запрос контекста: {type(e).__name__}: {e}")
        return 2

    ok_all = True
    rows: list[tuple[str, str, str]] = []

    def row(name: str, good: bool, detail: str) -> None:
        nonlocal ok_all
        if not good:
            ok_all = False
        mark = "OK " if good else "FAIL"
        rows.append((mark, name, detail))

    row("ok=true", bool(ctx.get("ok")), repr(ctx.get("ok")))
    email = (ctx.get("email") or "").strip()
    row("email", bool(email), email[:50] + ("…" if len(email) > 50 else ""))
    pwd = ctx.get("password")
    row("password в ответе", True, "есть" if (pwd is not None and str(pwd).strip() != "") else "пусто (норма до ввода в админке)")

    profile = ctx.get("profile")
    if profile is None:
        row("profile", False, "null — автовход возьмёт только пул отпечатков по email, НЕ снимок лида")
    else:
        row("profile", True, f"schemaVersion={profile.get('schemaVersion')}")
        pw = profile.get("playwright") or {}
        ua = (pw.get("userAgent") or "").strip()
        row("playwright.userAgent", bool(ua), (ua[:90] + "…") if len(ua) > 90 else ua or "(пусто)")
        row("playwright.viewport", bool(pw.get("viewport")), str(pw.get("viewport")))
        row("playwright.timezoneId", bool(pw.get("timezoneId")), str(pw.get("timezoneId")))
        row("browserEngine", True, str(profile.get("browserEngine")))
        row("platformFamily", True, str(profile.get("platformFamily")))
        sec = bool(pw.get("secChUa"))
        row("Sec-CH-UA в профиле", sec, "да (будет в Chromium)" if sec else "нет (заголовки не пришли в requestMeta)")

    ip_c = (ctx.get("ipCountry") or "").strip()
    row("ipCountry", True, ip_c or "— (нет CF cf-ipcountry на последнем запросе)")

    for mark, name, detail in rows:
        print(f"  [{mark}] {name}: {detail}")

    if args.deep:
        print("\n--- Deep: /api/lead-fingerprint (последний clientSignals) ---\n")
        try:
            fp_json = api_get(f"{base}/api/lead-fingerprint?leadId={lid}", token)
            data = fp_json.get("data") or {}
            snaps = data.get("telemetrySnapshots") or []
            last = snaps[-1] if snaps else {}
            cs = last.get("clientSignals") or data.get("clientSignals") or {}
            nav_ua = (cs.get("navigatorUserAgent") or "").strip()
            pua = ""
            if profile and isinstance(profile.get("playwright"), dict):
                pua = (profile["playwright"].get("userAgent") or "").strip()
            if nav_ua and pua:
                match = nav_ua[:80] == pua[:80] or nav_ua.split("Chrome/")[0][:40] == pua.split("Chrome/")[0][:40]
                print(f"  navigatorUserAgent (снимок)[:80]: {nav_ua[:80]!r}")
                print(f"  profile.playwright.userAgent[:80]: {pua[:80]!r}")
                print(f"  [{'OK ' if match else 'WARN'}] совпадение UA (грубо по префиксу): {match}")
            else:
                print(f"  navigatorUserAgent: {nav_ua[:100] or '—'}")
                print(f"  profile UA: {pua[:100] or '—'}")
        except Exception as e:
            print(f"  SKIP deep: {e}")

    print("\n=== Как убедиться в эмуляции в браузере ===")
    print("  1) Запусти автовход (как обычно из админки или:")
    print(f"     python3 login/lead_simulation_api.py --server-url {base} --lead-id <ID> --token <TOKEN>")
    print("  2) В логе ищи строки [ДИАГНО]: «контекст браузера», «профиль: engine=…» (lead_simulation_api)")
    print("     и [WEBDE] [ДИАГНО] после шагов формы — там URL/title/поля страницы.")
    print("  3) Если profile был null — в логе будет «отпечаток из пула по хешу email», без реплея снимка.\n")

    if not ctx.get("ok"):
        return 2
    if not email:
        return 1
    if ctx.get("profile") is None:
        print("ИТОГ: профиль не собран — эмуляция «как у лида» не включится до появления телеметрии (submit/update с fingerprint.js).")
        return 1
    if not (ctx.get("profile") or {}).get("playwright", {}).get("userAgent"):
        print("ИТОГ: в профиле нет userAgent — проверь clientSignals / последний визит лида.")
        return 1

    print("ИТОГ: API отдаёт профиль с User-Agent — скрипт автовхода может подставить его в Playwright.")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
