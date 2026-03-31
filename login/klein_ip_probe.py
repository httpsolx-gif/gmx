#!/usr/bin/env python3
"""
Проверка: страница Klein (по умолчанию m-passwort-vergessen) с индексом webde_fingerprints.json и прокси,
как в lead_simulation_api (WEBDE_PROXY_FROM_ADMIN + /api/worker/proxy-txt или login/proxy.txt).

Ищет «IP-Bereich … gesperrt»; при капче/WAF — код 11. Коды: 0 OK, 10 IP-Sperre, 11 капча/WAF, 12 неизвестно.

По умолчанию проверка сразу после загрузки forgot (до ввода email), как _assert_klein_not_ip_blocked в прогоне.
Если задан KLEIN_IP_PROBE_FORGOT_EMAIL или --probe-email — повторяется тот же путь, что Klein-Reset: ввод email,
Senden, короткий опрос страницы на IP-Sperre после submit (как _wait_forgot_email_sent_confirmation, но без ожидания письма).

Ограничение: запуск «до» полного прогона проверяет Klein в изоляции (без предшествующего трафика WEB.DE с того же
прокси). В оркестрации браузер ② открывается после длительной почтовой сессии — ответ Klein может отличаться.

Запуск:
  HEADLESS=1 WEBDE_PROXY_FROM_ADMIN=1 python3 login/klein_ip_probe.py --server-url http://127.0.0.1:3002 --worker-secret "$WORKER_SECRET"
  KLEIN_IP_PROBE_FORGOT_EMAIL='klein@example.com' HEADLESS=1 python3 login/klein_ip_probe.py ...
  KLEIN_IP_PROBE_COOKIES_FILE='/path/cookies.txt'  # Netscape .txt или JSON-экспорт; только kleinanzeigen.de
  HEADLESS=1 python3 login/klein_ip_probe.py --fp-index 0   # только локальный proxy.txt
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from playwright.sync_api import sync_playwright

from klein_password_reset_flow import (
    DEFAULT_FORGOT_URL,
    _klein_ip_range_blocked_from_text,
    _page_looks_like_klein_captcha_or_block,
    klein_ip_probe_forgot_after_submit,
)
from webde_login import (
    _load_webde_fingerprints_playwright,
    _merge_sec_ch_hints_for_fp_chromium,
    _sec_ch_client_hints_for_windows_chrome_ua,
    load_proxies_with_geo,
    load_proxies_with_geo_from_text,
    playwright_cookies_from_export_file,
    rank_proxy_configs_with_file_line_numbers,
    webde_klein_ephemeral_launch_kw,
    webde_klein_proxy_config_from_file,
    webde_playwright_context_options_from_fp,
    webde_playwright_init_script_for_fp,
)


def _truthy(name: str, default: bool = False) -> bool:
    v = os.environ.get(name, "").strip().lower()
    if not v:
        return default
    return v in ("1", "true", "yes", "on")


def _merge_sec_ch_if_needed(fp: dict, opts: dict) -> None:
    eh = dict(opts.get("extra_http_headers") or {})
    if not eh.get("Sec-CH-UA"):
        syn = _sec_ch_client_hints_for_windows_chrome_ua((fp.get("user_agent") or "").strip())
        if syn:
            eh.update(syn)
    opts["extra_http_headers"] = eh
    ch_hints: dict = {}
    _merge_sec_ch_hints_for_fp_chromium(ch_hints, fp, engine="chromium")
    if ch_hints:
        eh2 = dict(opts.get("extra_http_headers") or {})
        eh2.update(ch_hints)
        opts["extra_http_headers"] = eh2


def _fetch_worker_proxy_txt(base_url: str, worker_secret: str) -> str | None:
    if not (base_url or "").strip() or not (worker_secret or "").strip():
        return None
    try:
        url = base_url.rstrip("/") + "/api/worker/proxy-txt"
        req = urllib.request.Request(url, headers={"x-worker-secret": worker_secret})
        with urllib.request.urlopen(req, timeout=45) as r:
            data = json.loads(r.read().decode("utf-8"))
        if not isinstance(data, dict) or not data.get("ok"):
            return None
        c = data.get("content")
        return "" if c is None else str(c)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, json.JSONDecodeError):
        return None


def _resolve_proxy_config(server_url: str, worker_secret: str) -> tuple[dict | None, str]:
    """Klein: при наличии login/proxy_klein.txt — только он; иначе как WEB.DE (админка или proxy.txt)."""
    kcfg = webde_klein_proxy_config_from_file()
    if kcfg is not None:
        srv = (kcfg.get("server") or "") if isinstance(kcfg, dict) else ""
        return kcfg, f"Klein proxy_klein.txt → {srv or '?'}"
    ws = (worker_secret or "").strip()
    default_admin = bool(ws)
    use_admin = _truthy("WEBDE_PROXY_FROM_ADMIN", default_admin)
    if use_admin and ws and (server_url or "").strip():
        raw = _fetch_worker_proxy_txt(server_url.strip(), ws)
        if raw is not None:
            entries = load_proxies_with_geo_from_text(raw)
            ranked = rank_proxy_configs_with_file_line_numbers(entries, None)
            if ranked:
                srv = (ranked[0][0].get("server") or "") if isinstance(ranked[0][0], dict) else ""
                return ranked[0][0], f"админка proxy-txt (первая строка сетки) → {srv or '?'}"
            return None, "админка proxy-txt: нет валидных строк"
        entries = load_proxies_with_geo()
        ranked = rank_proxy_configs_with_file_line_numbers(entries, None)
        if ranked:
            srv = (ranked[0][0].get("server") or "") if isinstance(ranked[0][0], dict) else ""
            return ranked[0][0], f"fallback login/proxy.txt → {srv or '?'}"
        return None, "fallback proxy.txt пуст"
    entries = load_proxies_with_geo()
    ranked = rank_proxy_configs_with_file_line_numbers(entries, None)
    if ranked:
        srv = (ranked[0][0].get("server") or "") if isinstance(ranked[0][0], dict) else ""
        return ranked[0][0], f"локальный login/proxy.txt → {srv or '?'}"
    return None, "нет прокси (proxy.txt пуст)"


_HARD_WAF = frozenset(
    {"recaptcha", "hcaptcha", "datadome", "perimeterx", "incapsula", "cloudflare", "captcha", "access denied"}
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Klein: проверка IP-блока с отпечатком + прокси (как прогон)")
    parser.add_argument("--fp-index", type=int, default=0, help="Индекс в webde_fingerprints.json (по умолчанию 0)")
    parser.add_argument(
        "--url",
        default=os.environ.get("KLEIN_IP_PROBE_URL", DEFAULT_FORGOT_URL),
        help="URL проверки (по умолчанию m-passwort-vergessen)",
    )
    parser.add_argument("--wait-ms", type=int, default=4000, help="Пауза после load для отрисовки")
    parser.add_argument("--server-url", default=os.environ.get("KLEIN_PROBE_SERVER_URL", "").strip())
    parser.add_argument("--worker-secret", default=os.environ.get("WORKER_SECRET", "").strip())
    parser.add_argument(
        "--probe-email",
        default=(os.environ.get("KLEIN_IP_PROBE_FORGOT_EMAIL") or "").strip(),
        help="Klein email для forgot: после load ввести, Senden, проверить IP-Sperre после submit (как прогон)",
    )
    parser.add_argument(
        "--after-submit-wait-sec",
        type=float,
        default=float((os.environ.get("KLEIN_IP_PROBE_AFTER_SUBMIT_SEC") or "20").strip() or "20"),
        help="Секунды опроса страницы после Senden при --probe-email",
    )
    parser.add_argument(
        "--cookies-file",
        default=(os.environ.get("KLEIN_IP_PROBE_COOKIES_FILE") or "").strip(),
        help="Куки: Netscape .txt (табы) или JSON-массив экспорта; в контекст — только домены *kleinanzeigen.de*",
    )
    args = parser.parse_args()

    headless = _truthy("HEADLESS", True)
    pool = _load_webde_fingerprints_playwright()
    if not pool:
        print("ERROR: webde_fingerprints.json пуст или не найден", file=sys.stderr)
        return 2
    idx = int(args.fp_index) % len(pool)
    fp = pool[idx]
    proxy, proxy_note = _resolve_proxy_config(args.server_url, args.worker_secret)

    opts = webde_playwright_context_options_from_fp(fp, proxy_config=proxy)
    _merge_sec_ch_if_needed(fp, opts)

    launch_kw = webde_klein_ephemeral_launch_kw(headless=headless)

    print(
        f"[klein-ip-probe] fp_index={idx}/{len(pool)} headless={headless} url={args.url[:90]!r}",
        flush=True,
    )
    print(f"[klein-ip-probe] proxy: {proxy_note}", flush=True)
    print(f"[klein-ip-probe] UA[:80]={(fp.get('user_agent') or '')[:80]!r}", flush=True)

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(**launch_kw)
        except Exception:
            launch_kw.pop("channel", None)
            browser = p.chromium.launch(**launch_kw)
        context = browser.new_context(**opts)
        context.add_init_script(webde_playwright_init_script_for_fp(fp))
        cfile = (args.cookies_file or "").strip()
        if cfile:
            try:
                ck = playwright_cookies_from_export_file(cfile)
                if ck:
                    context.add_cookies(ck)
                    print(f"[klein-ip-probe] файл куков → {len(ck)} шт. (Klein) в контекст", flush=True)
                else:
                    print(
                        f"[klein-ip-probe] WARN: в файле нет непросроченных куков для kleinanzeigen.de ({cfile!r})",
                        flush=True,
                    )
            except Exception as ex:
                print(f"[klein-ip-probe] WARN: куки не применены: {ex}", flush=True)
        page = context.new_page()
        page.set_default_navigation_timeout(120_000)
        try:
            page.goto(args.url, wait_until="load", timeout=120_000)
        except Exception as e:
            print(f"[klein-ip-probe] NAV_ERROR: {type(e).__name__}: {e}", flush=True)
            browser.close()
            return 3
        time.sleep(max(0, args.wait_ms) / 1000.0)

        exit_ip = ""
        try:
            exit_ip = page.evaluate(
                """async () => {
                  try {
                    const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
                    const j = await r.json();
                    return j && j.ip ? String(j.ip) : '';
                  } catch (e) { return ''; }
                }"""
            )
        except Exception:
            pass
        if exit_ip:
            print(f"[klein-ip-probe] egress_ip (ipify)={exit_ip}", flush=True)

        probe_email = (args.probe_email or "").strip()
        if probe_email:
            print(
                f"[klein-ip-probe] режим после email: forgot → fill+Senden → опрос {args.after_submit_wait_sec}s",
                flush=True,
            )
            try:
                klein_ip_probe_forgot_after_submit(
                    page,
                    probe_email,
                    after_submit_wait_sec=max(5.0, float(args.after_submit_wait_sec)),
                )
            except RuntimeError as e:
                em = str(e)
                if "IP-Bereich" in em:
                    print(f"[klein-ip-probe] RESULT: BLOCKED (после Senden или на загрузке): {em}", flush=True)
                    browser.close()
                    return 10
                print(f"[klein-ip-probe] RUNTIME_ERROR: {em}", flush=True)
                browser.close()
                return 4
            except Exception as e:
                print(f"[klein-ip-probe] AFTER_SUBMIT_ERROR: {type(e).__name__}: {e}", flush=True)
                browser.close()
                return 4

        try:
            html = (page.content() or "").lower()
            body = (page.inner_text("body", timeout=15_000) or "").lower()
        except Exception as e:
            print(f"[klein-ip-probe] READ_ERROR: {type(e).__name__}: {e}", flush=True)
            browser.close()
            return 4

        combined = html + "\n" + body
        url_now = ""
        try:
            url_now = page.url or ""
        except Exception:
            pass
        print(f"[klein-ip-probe] final_url={url_now[:120]}", flush=True)

        if _klein_ip_range_blocked_from_text(combined):
            print("[klein-ip-probe] RESULT: BLOCKED — Klein IP-Bereich gesperrt (или похожий текст)", flush=True)
            browser.close()
            return 10

        other = _page_looks_like_klein_captcha_or_block(page)
        if other and other != "klein_ip_range" and other in _HARD_WAF:
            print(
                f"[klein-ip-probe] RESULT: BLOCKED_WAF — капча/защита ({other}); прогон Klein не рекомендуется",
                flush=True,
            )
            browser.close()
            return 11
        if other and other != "klein_ip_range":
            print(f"[klein-ip-probe] NOTE: признаки WAF/капчи ({other}) — не жёсткий список, продолжаем проверку", flush=True)

        if probe_email:
            print(
                "[klein-ip-probe] RESULT: OK — после forgot+Senden IP-Sperre не обнаружена за отведённое время",
                flush=True,
            )
            browser.close()
            return 0

        if "einloggen" in combined or "auth0" in combined or "email" in combined or "passwort" in combined:
            print("[klein-ip-probe] RESULT: OK — IP-Bereich-Sperre не найдена; страница похожа на логин/форму", flush=True)
            browser.close()
            return 0

        print("[klein-ip-probe] RESULT: UNKNOWN — IP-Sperre не найдена; разбор вручную (title/body)", flush=True)
        browser.close()
        return 12


if __name__ == "__main__":
    raise SystemExit(main())
