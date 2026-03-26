#!/usr/bin/env python3
"""
Полный перебор сетки прокси × индексы отпечатков (webde_fingerprints.json).
Проверка: auth.web.de → email → Weiter → появление пароля или CaptchaFox (без ввода пароля и без 2Captcha).

Запуск на сервере (из каталога login или с PYTHONPATH):
  python3 webde_grid_test.py --email user@web.de --apply
  python3 webde_grid_test.py --credentials user@web.de:secret --apply --headless 1

Пароль из учётки не используется в браузере — только email (как тест «живости» пары).

С --apply перезаписывает:
  - login/proxy.txt — только строки прокси, у которых есть хотя бы одна успешная пара с каким-либо отпечатком;
  - login/webde_fingerprint_indices.txt — только индексы, у которых есть хотя бы один успех с каким-либо прокси.

Без --apply только печать в stdout.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

from webde_login import (  # noqa: E402
    PROXY_FILE,
    probe_webde_proxy_fingerprint,
    _load_webde_fingerprints_playwright,
    _parse_proxy_line_with_optional_geo,
)

FP_INDICES_FILE = Path(
    os.getenv("WEBDE_FP_INDICES_FILE", "").strip() or (LOGIN_DIR / "webde_fingerprint_indices.txt")
)


def load_proxy_entries() -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    if not PROXY_FILE.is_file():
        return out
    with open(PROXY_FILE, "r", encoding="utf-8") as f:
        for line in f:
            raw = line.rstrip("\n")
            st = raw.strip()
            if not st or st.startswith("#"):
                continue
            cfg, _geo = _parse_proxy_line_with_optional_geo(raw)
            if cfg:
                out.append((raw, cfg))
    return out


def load_fp_indices(pool_len: int) -> list[int]:
    if pool_len <= 0:
        return []
    if not FP_INDICES_FILE.is_file():
        return list(range(pool_len))
    seen: set[int] = set()
    with open(FP_INDICES_FILE, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            try:
                i = int(s.split()[0], 10)
            except ValueError:
                continue
            if 0 <= i < pool_len:
                seen.add(i)
    return sorted(seen) if seen else list(range(pool_len))


def parse_credentials(s: str) -> tuple[str, str]:
    s = (s or "").strip()
    if ":" not in s:
        return "", ""
    email, _, pw = s.partition(":")
    return email.strip(), pw.strip()


def main() -> None:
    p = argparse.ArgumentParser(description="Тест сетки прокси × отпечатки WEB.DE")
    p.add_argument("--email", default=os.getenv("WEBDE_GRID_TEST_EMAIL", "").strip())
    p.add_argument("--password", default=os.getenv("WEBDE_GRID_TEST_PASSWORD", "").strip())
    p.add_argument("--credentials", default="", help="email:password (пароль игнорируется проверкой)")
    p.add_argument("--apply", action="store_true", help="Удалить мёртвые прокси/индексы из файлов")
    p.add_argument("--headless", default="1", help="1/true — без окна (по умолчанию 1)")
    args = p.parse_args()

    email = (args.email or "").strip()
    _pw = (args.password or "").strip()
    if args.credentials.strip():
        e2, p2 = parse_credentials(args.credentials)
        if e2:
            email = e2
        if p2:
            _pw = p2
    if not email:
        print("Укажите --email или --credentials user@web.de:pass", file=sys.stderr)
        sys.exit(2)

    headless = str(args.headless).strip().lower() in ("1", "true", "yes", "y")

    pool = _load_webde_fingerprints_playwright()
    pool_len = len(pool)
    if pool_len == 0:
        print("Пул webde_fingerprints.json пуст", file=sys.stderr)
        sys.exit(1)

    proxies = load_proxy_entries()
    if not proxies:
        print("Нет прокси в proxy.txt — добавьте строки или проверьте путь", file=sys.stderr)
        sys.exit(1)

    fp_indices = load_fp_indices(pool_len)
    n_pairs = len(proxies) * len(fp_indices)
    print(f"[GRID] email={email!r} прокси={len(proxies)} отпечатков={len(fp_indices)} ячеек={n_pairs}", flush=True)

    ok_for_proxy: set[int] = set()
    ok_for_fp: set[int] = set()

    pi = 0
    for pidx, (line_raw, pcfg) in enumerate(proxies):
        for fi in fp_indices:
            pi += 1
            short = line_raw[:70] + ("…" if len(line_raw) > 70 else "")
            print(f"[{pi}/{n_pairs}] proxy#{pidx} fp#{fi} … {short!r}", flush=True)
            res = probe_webde_proxy_fingerprint(email, pcfg, fi, headless=headless)
            print(f"    → {res}", flush=True)
            if res == "ok":
                ok_for_proxy.add(pidx)
                ok_for_fp.add(fi)

    dead_proxies = [i for i in range(len(proxies)) if i not in ok_for_proxy]
    dead_fp = [i for i in fp_indices if i not in ok_for_fp]

    print(
        f"[SUMMARY] ok_proxy={len(ok_for_proxy)}/{len(proxies)} ok_fp={len(ok_for_fp)}/{len(fp_indices)} "
        f"dead_proxy_idx={dead_proxies} dead_fp={dead_fp}",
        flush=True,
    )

    if not args.apply:
        print("[GRID] без --apply файлы не менялись", flush=True)
        return

    new_proxy_lines = [proxies[i][0] for i in range(len(proxies)) if i in ok_for_proxy]
    try:
        PROXY_FILE.write_text("\n".join(new_proxy_lines) + ("\n" if new_proxy_lines else ""), encoding="utf-8")
    except OSError as e:
        print(f"Не удалось записать proxy.txt: {e}", file=sys.stderr)
        sys.exit(1)

    new_fp_lines = [str(i) for i in sorted(ok_for_fp)]
    try:
        FP_INDICES_FILE.write_text(
            "\n".join(new_fp_lines) + ("\n" if new_fp_lines else ""),
            encoding="utf-8",
        )
    except OSError as e:
        print(f"Не удалось записать webde_fingerprint_indices.txt: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[APPLY] записано proxy.txt строк: {len(new_proxy_lines)}, индексов отпечатков: {len(new_fp_lines)}", flush=True)


if __name__ == "__main__":
    main()
