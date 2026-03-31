#!/usr/bin/env python3
"""
Локальный тест: вход WEB.DE + фильтр «все новые письма в корзину».
Браузер видимый, подробный лог, окно не закрывается, пока не нажмёте Enter в терминале.

Учётные данные ТОЛЬКО из окружения (не коммитьте пароль в репозиторий):

  export WEBDE_TEST_EMAIL='you@web.de'
  export WEBDE_TEST_PASSWORD='***'
  export WEBDE_VERBOSE_LOG=1
  export KEEP_BROWSER_OPEN=1
  cd login && python3 test_mail_filters_local.py

Повтор без нового входа (тот же процесс и то же окно браузера):

  WEBDE_FILTERS_DEV_LOOP=1   # по умолчанию для этого скрипта

После каждого прогона сценария фильтров:
  Enter      — снова запустить только фильтры (сессия уже залогинена)
  r / reload — перезагрузить модуль webde_mail_filters.py с диска (правки кода без выхода из браузера)
  q          — выйти из цикла; дальше сработает KEEP_BROWSER_OPEN (Enter закроет браузер)

Отключить цикл (один прогон, как раньше): WEBDE_FILTERS_DEV_LOOP=0

Автоповтор до успеха (тот же браузер, без ввода в терминале; подробный лог — WEBDE_VERBOSE_LOG=1):

  WEBDE_FILTERS_RETRY_UNTIL_SUCCESS=1 WEBDE_FILTERS_DEV_LOOP=0 HEADLESS=1 python3 test_mail_filters_local.py

  WEBDE_FILTERS_MAX_ATTEMPTS=0  — без лимита попыток (осторожно: при вечной ошибке цикл не остановится).
  WEBDE_FILTERS_MAX_ATTEMPTS=30 — не более 30 прогонов фильтров.

Опционально: HEADLESS=0 (по умолчанию скрипт форсирует окно на macOS/Linux с DISPLAY).

Ускорить сценарий фильтров (рекомендуется с открытым браузером):

  HEADLESS=0 WEBDE_FILTERS_FAST=1 python3 test_mail_filters_local.py

"""
from __future__ import annotations

import importlib
import os
import sys
import time
import traceback
import warnings
from pathlib import Path

# Шум в терминале: urllib3/requests несовместимые версии (не ошибка скрипта)
warnings.filterwarnings("ignore", category=UserWarning, module="requests")

LOGIN_DIR = Path(__file__).resolve().parent
if str(LOGIN_DIR) not in sys.path:
    sys.path.insert(0, str(LOGIN_DIR))

os.environ.setdefault("WEBDE_VERBOSE_LOG", "1")
os.environ.setdefault("KEEP_BROWSER_OPEN", "1")
os.environ.setdefault("HEADLESS", "0")
os.environ.setdefault("WEBDE_FILTERS_DEV_LOOP", "1")
# В headless нет окна «закрой вручную» — иначе скрипт зависнет на input() в webde_login.
if os.environ.get("HEADLESS", "0").strip().lower() in ("1", "true", "yes"):
    os.environ["KEEP_BROWSER_OPEN"] = "0"

# Перезагрузить dotenv после установки переменных — webde_login вызывает load_dotenv при импорте
try:
    from dotenv import load_dotenv

    load_dotenv(LOGIN_DIR / ".env", override=False)
    # Локальные тестовые креды без пароля в argv (см. .env.example); файл в .gitignore
    load_dotenv(LOGIN_DIR / ".env.local", override=True)
except ImportError:
    pass

from webde_login import login_webde, take_lead_held_browser_session  # noqa: E402
import webde_mail_filters as _webde_mail_filters  # noqa: E402


def _env_flag(name: str, default: str = "0") -> bool:
    v = (os.environ.get(name) or default).strip().lower()
    return v not in ("0", "false", "no", "off", "")


def _max_filter_retry_attempts() -> int | None:
    """None = без лимита; иначе максимум прогонов run_trash_all_new_mail_filter."""
    v = (os.environ.get("WEBDE_FILTERS_MAX_ATTEMPTS") or "").strip()
    if v == "0":
        return None
    if v == "":
        return 200
    try:
        n = int(v)
        return n if n > 0 else 200
    except ValueError:
        return 200


def _post_login_retry_filters_until_success(page, context) -> None:
    """
    Повторяет сценарий фильтров в том же браузере, пока не завершится без исключения
    (в логе [FILTERS] должна быть строка «=== фильтр: готово ===»).
    """
    os.environ["WEBDE_VERBOSE_LOG"] = "1"
    wmf = _webde_mail_filters
    cap = _max_filter_retry_attempts()
    attempt = 0
    print(
        "[test] WEBDE_FILTERS_RETRY_UNTIL_SUCCESS: повтор в том же окне до успеха. "
        f"Лимит попыток: {'∞' if cap is None else cap}. Подробный лог: WEBDE_VERBOSE_LOG=1",
        flush=True,
    )
    while True:
        attempt += 1
        if cap is not None and attempt > cap:
            raise RuntimeError(
                f"WEBDE_FILTERS_MAX_ATTEMPTS: исчерпано {cap} попыток настройки фильтра без успеха"
            )
        print(
            f"\n[test] ─── Попытка настройки фильтра #{attempt} "
            f"({time.strftime('%H:%M:%S')}) ───",
            flush=True,
        )
        try:
            wmf.run_trash_all_new_mail_filter(page, context)
            print(
                "[test] УСПЕХ: сценарий фильтров завершён; в stdout должны быть строки "
                "«[FILTERS] === фильтр: готово ===» и «Фильтр - корзина включен»; "
                "куки — в login/cookies/<email>.json",
                flush=True,
            )
            return
        except Exception as e:
            print(f"[test] Попытка #{attempt} — ошибка: {e}", flush=True)
            traceback.print_exc()
            # После правки кода на диске следующая попытка подхватит её без перезапуска процесса
            if _env_flag("WEBDE_FILTERS_RELOAD_ON_RETRY", "1"):
                try:
                    wmf = importlib.reload(_webde_mail_filters)
                    print(
                        "[test] importlib.reload(webde_mail_filters) — правки в .py учтены.",
                        flush=True,
                    )
                except Exception as rex:
                    print(f"[test] reload не удался: {rex}", flush=True)
            # Пауза с нарастанием, макс 45 с (время поправить код)
            delay = min(45, 8 + attempt * 3)
            print(
                f"[test] Пауза {delay} с, затем повтор (тот же браузер). "
                "Отключить reload: WEBDE_FILTERS_RELOAD_ON_RETRY=0",
                flush=True,
            )
            time.sleep(delay)
            try:
                page.bring_to_front()
            except Exception:
                pass


def _post_login_with_optional_dev_loop(page, context) -> None:
    """Один прогон или цикл «фильтры снова» в том же context без повторного логина."""
    if _env_flag("WEBDE_FILTERS_RETRY_UNTIL_SUCCESS", "0"):
        _post_login_retry_filters_until_success(page, context)
        return

    if not _env_flag("WEBDE_FILTERS_DEV_LOOP", "1"):
        _webde_mail_filters.run_trash_all_new_mail_filter(page, context)
        return

    wmf = _webde_mail_filters
    print(
        "[test] WEBDE_FILTERS_DEV_LOOP: тот же браузер. После каждого прогона:\n"
        "       Enter — повторить только фильтры  |  r/reload — подхватить правки в webde_mail_filters.py\n"
        "       q — выход из цикла (потом Enter — закрытие браузера, как обычно)",
        flush=True,
    )
    while True:
        try:
            wmf.run_trash_all_new_mail_filter(page, context)
            print("[test] Сценарий фильтров завершился без исключения.", flush=True)
        except Exception as e:
            print(f"[test] Ошибка фильтров: {e}", flush=True)
            traceback.print_exc()

        try:
            line = input("[test] Enter | r=reload модуль | q=выход > ").strip().lower()
        except EOFError:
            print("[test] EOF — выход из цикла.", flush=True)
            break

        if line in ("r", "reload"):
            wmf = importlib.reload(wmf)
            print("[test] Модуль webde_mail_filters перезагружен с диска.", flush=True)
            try:
                page.bring_to_front()
            except Exception:
                pass
            continue

        if line == "q":
            print("[test] Выход из цикла повторов фильтров.", flush=True)
            break

        try:
            page.bring_to_front()
        except Exception:
            pass


def main() -> None:
    email = (
        os.environ.get("WEBDE_TEST_EMAIL") or os.environ.get("WEBDE_EMAIL") or ""
    ).strip()
    password = (
        os.environ.get("WEBDE_TEST_PASSWORD") or os.environ.get("WEBDE_PASSWORD") or ""
    ).strip()
    if not email or not password:
        print(
            "Задайте учётку: WEBDE_TEST_EMAIL / WEBDE_TEST_PASSWORD\n"
            "или те же значения в .env как WEBDE_EMAIL / WEBDE_PASSWORD.\n"
            "Пример: WEBDE_TEST_EMAIL=user@web.de WEBDE_TEST_PASSWORD='…' python3 test_mail_filters_local.py",
            file=sys.stderr,
        )
        sys.exit(1)

    has_display = bool(os.environ.get("DISPLAY")) or sys.platform == "darwin"
    headless = os.environ.get("HEADLESS", "0").strip().lower() in ("1", "true", "yes")
    if not has_display:
        headless = True
        print("[test] Нет DISPLAY — принудительно headless", file=sys.stderr)

    print("[test] Старт: вход + фильтры, headless=", headless, flush=True)

    def _after_mail_success() -> None:
        """Совместимо с login_webde: сессия держится до вызова take_lead_held_browser_session()."""
        sess = take_lead_held_browser_session()
        if not sess:
            print("[test] нет удержанной сессии — фильтры пропущены", flush=True)
            return
        browser = sess.get("browser")
        context = sess.get("context")
        page = sess.get("page")
        if not browser or not context or not page:
            print("[test] неполная сессия браузера", flush=True)
            return
        try:
            _post_login_with_optional_dev_loop(page, context)
        finally:
            if not headless and _env_flag("KEEP_BROWSER_OPEN", "0"):
                try:
                    input("[test] Enter чтобы закрыть браузер > ")
                except (EOFError, KeyboardInterrupt):
                    pass
            try:
                browser.close()
            except Exception:
                pass

    result = login_webde(
        email=email,
        password=password,
        headless=headless,
        lead_mode=True,
        hold_session_after_lead_success=True,
        after_mail_success_fn=_after_mail_success,
    )
    print("[test] Результат login_webde:", result, flush=True)
    if result != "success":
        sys.exit(1)


if __name__ == "__main__":
    main()
