import os
import sys
import time
from dataclasses import dataclass


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), ".")))


from gmx_login import login_gmx  # noqa: E402
from webde_login import login_webde  # noqa: E402


@dataclass(frozen=True)
class Account:
    email: str
    password: str


@dataclass(frozen=True)
class Proxy:
    host: str
    port: int
    username: str
    password: str

    def as_playwright_proxy(self) -> dict:
        return {
            "server": f"http://{self.host}:{self.port}",
            "username": self.username,
            "password": self.password,
        }


def parse_account(line: str) -> Account:
    line = (line or "").strip()
    if not line or ":" not in line:
        raise ValueError(f"bad account line: {line!r}")
    email, password = line.split(":", 1)
    return Account(email=email.strip(), password=password.strip())


def parse_proxy(line: str) -> Proxy:
    line = (line or "").strip()
    # Supported:
    # - user:pass@host:port
    # - host:port:user:pass
    # - user:pass:host:port
    if "@" in line:
        creds, hostport = line.split("@", 1)
        if ":" not in creds or ":" not in hostport:
            raise ValueError(f"bad proxy line: {line!r}")
        user, pw = creds.split(":", 1)
        host, port_s = hostport.rsplit(":", 1)
        return Proxy(host=host.strip(), port=int(port_s.strip()), username=user.strip(), password=pw.strip())
    parts = [p.strip() for p in line.split(":")]
    if len(parts) != 4:
        raise ValueError(f"bad proxy line: {line!r}")
    a, b, c, d = parts
    if b.isdigit():
        return Proxy(host=a, port=int(b), username=c, password=d)
    if d.isdigit():
        return Proxy(host=c, port=int(d), username=a, password=b)
    raise ValueError(f"bad proxy line: {line!r}")


def provider(email: str) -> str:
    e = (email or "").lower()
    if e.endswith("@gmx.de") or e.endswith("@gmx.net") or e.endswith("@gmx.com"):
        return "gmx"
    if e.endswith("@web.de") or e.endswith("@email.de") or e.endswith("@gmx.de"):
        # gmx.de handled above, rest here
        return "webde"
    # default: try provider by domain keyword
    if "web.de" in e:
        return "webde"
    return "gmx"


def build_new_fingerprints() -> None:
    """Regenerates login/webde_fingerprints.json + public pool (DE)."""
    import subprocess

    subprocess.run(
        ["node", "scripts/build-webde-fingerprints-de-win11.mjs"],
        cwd=os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
        check=True,
    )


def _with_env(overrides: dict[str, str | None]):
    class _EnvCtx:
        def __enter__(self):
            self._prev = {}
            for k, v in overrides.items():
                self._prev[k] = os.environ.get(k)
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            return self

        def __exit__(self, exc_type, exc, tb):
            for k, prev in self._prev.items():
                if prev is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = prev
            return False

    return _EnvCtx()


def _read_lines(path: str) -> list[str]:
    out: list[str] = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            out.append(s)
    return out


def _usage() -> str:
    return (
        "Usage:\n"
        "  ACCOUNTS_FILE=./tmp/accounts.txt PROXIES_FILE=./tmp/proxies.txt \\\n"
        "  AUTOLOGIN_PROFILE=1 AUTOLOGIN_BLOCK_HEAVY=1 HEADLESS=1 \\\n"
        "  MAX_FP_PER_PROXY=3 MAX_PROXY_ROUNDS=4 \\\n"
        "  python3 login/run_four_autologins.py\n\n"
        "accounts.txt format (one per line):\n"
        "  email:password\n\n"
        "proxies.txt format (one per line):\n"
        "  user:pass@host:port\n"
        "  # or legacy:\n"
        "  host:port:user:pass\n"
        "  user:pass:host:port\n"
    )


def main() -> int:
    accounts_file = (os.environ.get("ACCOUNTS_FILE") or "").strip()
    proxies_file = (os.environ.get("PROXIES_FILE") or "").strip()
    if not accounts_file or not proxies_file:
        print(_usage(), flush=True)
        raise SystemExit("Set ACCOUNTS_FILE and PROXIES_FILE env vars")

    accounts_raw = _read_lines(accounts_file)
    proxies_raw = _read_lines(proxies_file)

    accounts = [parse_account(x) for x in accounts_raw]
    proxies = [parse_proxy(x) for x in proxies_raw]

    os.environ.setdefault("AUTOLOGIN_PROFILE", "1")
    os.environ.setdefault("AUTOLOGIN_BLOCK_HEAVY", "1")

    if (os.environ.get("REBUILD_FINGERPRINTS") or "").strip().lower() in ("1", "true", "yes"):
        print("=== generating new fingerprints (DE) ===", flush=True)
        build_new_fingerprints()
    # Invalidate caches inside imported modules (if present)
    try:
        from gmx_login import invalidate_webde_fingerprints_cache as _inv_gmx  # noqa: E402

        _inv_gmx()
    except Exception:
        pass
    try:
        from webde_login import invalidate_webde_fingerprints_cache as _inv_webde  # noqa: E402

        _inv_webde()
    except Exception:
        pass

    results: list[tuple[str, str]] = []
    fp_base = int(os.environ.get("FP_START", "0") or "0")
    max_fp_per_proxy = int(os.environ.get("MAX_FP_PER_PROXY", "4") or "4")
    max_proxy_rounds = int(os.environ.get("MAX_PROXY_ROUNDS", str(len(proxies))) or str(len(proxies)))

    for i, acc in enumerate(accounts, 1):
        prov = provider(acc.email)
        print(f"\n=== ACCOUNT [{i}/4] {prov} {acc.email} ===", flush=True)
        success = False
        attempt_no = 0
        for proxy_round, prx in enumerate(proxies[:max_proxy_rounds], 1):
            for fp_off in range(max_fp_per_proxy):
                fp_idx = fp_base + (proxy_round - 1) * max_fp_per_proxy + fp_off
                attempt_no += 1
                print(
                    f"\n--- attempt {attempt_no}: proxy {prx.host}:{prx.port} fp_index={fp_idx} ---",
                    flush=True,
                )
                t0 = time.monotonic()
                try:
                    if prov == "webde":
                        # Только автовход: отключаем persistent user-data-dir,
                        # иначе WEBDE_CHROME_USER_DATA_DIR склеивает сессии/куки и "отпечаток" не меняется честно.
                        with _with_env({"WEBDE_CHROME_USER_DATA_DIR": ""}):
                            res = login_webde(
                                email=acc.email,
                                password=acc.password,
                                proxy_config=prx.as_playwright_proxy(),
                                proxy_str=prx.as_playwright_proxy()["server"],
                                fingerprint_index=fp_idx,
                                force_pool_fingerprint=True,
                                headless=True,
                                lead_mode=False,
                            )
                    else:
                        res = login_gmx(
                            email=acc.email,
                            password=acc.password,
                            proxy_config=prx.as_playwright_proxy(),
                            proxy_str=prx.as_playwright_proxy()["server"],
                            fingerprint_index=fp_idx,
                            force_pool_fingerprint=True,
                            headless=True,
                            lead_mode=False,
                        )
                    dt = time.monotonic() - t0
                    print(f"RESULT {acc.email}: {res} ({dt:.1f}s)", flush=True)
                    if res is True or str(res).lower() in ("success", "hilfe_success"):
                        results.append((acc.email, "success"))
                        success = True
                        break
                    if str(res) in ("wrong_credentials", "wrong_password", "wrong", "bad_credentials"):
                        results.append((acc.email, "wrong_credentials"))
                        success = False
                        proxy_round = max_proxy_rounds
                        break
                except Exception as e:
                    dt = time.monotonic() - t0
                    print(f"RESULT {acc.email}: EXC {type(e).__name__}: {e} ({dt:.1f}s)", flush=True)
                    continue
            if success:
                break
        if not success and not any(r[0] == acc.email for r in results):
            results.append((acc.email, "failed"))

    print("\n=== SUMMARY ===", flush=True)
    for email, res in results:
        print(f"{email}: {res}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

