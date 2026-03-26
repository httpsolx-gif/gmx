#!/usr/bin/env python3
"""
Симуляция входа лида для админки (тест перед API).
Читает email (и опционально пароль) из lead_data.json, выполняет вход на web.de,
отдаёт результат в lead_result.json: wrong_credentials | push | success | error.
Пароль может прийти позже — пока решаем капчу, админка может дописать пароль в файл.
"""
import json
import time
from pathlib import Path

from webde_login import (
    login_webde,
    load_all_proxies_from_file,
    log,
    LoginTemporarilyUnavailable,
)

LEAD_DATA_FILE = Path(__file__).parent / "lead_data.json"
LEAD_RESULT_FILE = Path(__file__).parent / "lead_result.json"


def load_lead_data():
    """Читает lead_data.json: {"email": "...", "password": "..."} (password опционально)."""
    if not LEAD_DATA_FILE.is_file():
        return None, None
    try:
        with open(LEAD_DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return (data.get("email") or "").strip(), (data.get("password") or "").strip()
    except Exception:
        return None, None


def get_password_from_file():
    """Для login_webde(..., get_password=...): перечитывает файл и возвращает пароль."""
    _, pw = load_lead_data()
    return pw or None


def write_result(email: str, result: str):
    """Пишет результат в lead_result.json."""
    out = {"email": email, "result": result}
    with open(LEAD_RESULT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    log("Симуляция", f"Результат записан в {LEAD_RESULT_FILE}: {result}")


def run_simulation():
    """Читает данные лида, запускает вход в lead_mode, записывает результат."""
    email, password = load_lead_data()
    if not email:
        log("Симуляция", f"В {LEAD_DATA_FILE} нет email. Формат: {{\"email\": \"...\", \"password\": \"...\"}}")
        write_result("", "error")
        return

    log("Симуляция", f"Email: {email}, пароль: {'есть' if password else 'буду ждать из файла'}")

    get_password = None if password else get_password_from_file
    proxy_list = load_all_proxies_from_file()
    proxy_config = proxy_list[0] if proxy_list else None

    try:
        result = login_webde(
            email=email,
            password=password or None,
            headless=False,
            lead_mode=True,
            get_password=get_password,
            proxy_config=proxy_config,
        )
        if isinstance(result, str):
            write_result(email, result)
        else:
            write_result(email, "error")
    except LoginTemporarilyUnavailable:
        log("Симуляция", "Вход временно недоступен (блок по IP)")
        write_result(email, "error")
    except Exception as e:
        log("Симуляция", f"Ошибка: {e}")
        write_result(email, "error")


if __name__ == "__main__":
    run_simulation()
