#!/usr/bin/env python3
"""Патч webde_login.py: post_login_callback, save_cookies_for_account, _plc_save_*."""
from __future__ import annotations

import sys
from pathlib import Path

ANCHOR = '''        log("Куки", "Не удалось сохранить куки для скачивания: " + str(e))


# «Вход временно недоступен» — нужна смена IP и отпечатков, затем повтор'''

NEW_BLOCK = '''        log("Куки", "Не удалось сохранить куки для скачивания: " + str(e))


def save_cookies_for_account(context, email: str) -> str:
    """
    Сохранить куки в login/cookies/<email>.json (то же имя, что после входа).
    После сценария фильтров (webde_mail_filters) — актуальный файл.
    """
    em = (email or "").strip()
    if not em:
        raise ValueError("save_cookies_for_account: пустой email")
    path = _cookies_path_for_email(em)
    save_cookies(context, str(path))
    return str(path)


def _invoke_post_login_callback(post_login_callback, page, context) -> None:
    if not post_login_callback:
        return
    log("Фильтры", "post_login_callback: старт")
    try:
        post_login_callback(page, context)
    finally:
        log("Фильтры", "post_login_callback: завершён")


def _plc_save_lead(context, email, page, post_login_callback):
    _invoke_post_login_callback(post_login_callback, page, context)
    try:
        save_cookies(context, str(_cookies_path_for_email(email)))
    except Exception as e:
        log("Куки", "Не удалось сохранить куки для скачивания: " + str(e))


def _plc_save_exit(context, email, page, post_login_callback):
    _invoke_post_login_callback(post_login_callback, page, context)
    _wait_then_save_cookies_and_exit(context, email)


# «Вход временно недоступен» — нужна смена IP и отпечатков, затем повтор'''

SIG_OLD = """    automation_profile: dict | None = None,
):"""

SIG_NEW = """    automation_profile: dict | None = None,
    post_login_callback=None,
):"""

DOC_INSERT_AFTER = """    on_wrong_two_fa: lead_mode — после неверного кода на WEB.DE (опционально уведомить сервер).
    """
DOC_NEW = """    on_wrong_two_fa: lead_mode — после неверного кода на WEB.DE (опционально уведомить сервер).
    post_login_callback: после успешного входа, до сохранения куков: callback(page, context) — напр. фильтр «все письма в корзину» (webde_mail_filters).
    """


def main() -> int:
    path = Path(__file__).resolve().parent.parent / "login" / "webde_login.py"
    if not path.exists():
        print("Нет файла:", path, file=sys.stderr)
        return 1
    s = path.read_text(encoding="utf-8")
    if "def save_cookies_for_account(" in s:
        print("Патч уже применён:", path)
        return 0
    if ANCHOR not in s:
        print("Якорь не найден (_save_cookies_for_lead_mode / комментарий)", file=sys.stderr)
        return 1
    s = s.replace(ANCHOR, NEW_BLOCK, 1)

    s = s.replace(
        "_save_cookies_for_lead_mode(context, email)",
        "_plc_save_lead(context, email, page, post_login_callback)",
    )
    s = s.replace(
        "_wait_then_save_cookies_and_exit(context, email)",
        "_plc_save_exit(context, email, page, post_login_callback)",
    )

    if SIG_OLD not in s:
        print("Сигнатура login_webde не найдена", file=sys.stderr)
        return 1
    s = s.replace(SIG_OLD, SIG_NEW, 1)

    if DOC_INSERT_AFTER in s and "post_login_callback: после успешного входа" not in s:
        s = s.replace(DOC_INSERT_AFTER, DOC_NEW, 1)

    path.write_text(s, encoding="utf-8")
    print("OK:", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
