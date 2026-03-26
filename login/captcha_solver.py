"""
Решение капчи через API 2Captcha.
Поддержка: обычная картинка (ImageToTextTask) и CaptchaFox (токен).
"""
import base64
import time
import requests

API_BASE = "https://api.2captcha.com"


def _create_task(api_key: str, task: dict, **kwargs) -> int:
    """Создать задачу, вернуть taskId."""
    r = requests.post(
        f"{API_BASE}/createTask",
        json={"clientKey": api_key, "task": task, **kwargs},
        timeout=30,
    )
    data = r.json()
    if data.get("errorId") != 0:
        raise RuntimeError(
            f"2Captcha createTask error: {data.get('errorCode', data.get('errorDescription', data))}"
        )
    return data["taskId"]


def _get_task_result(api_key: str, task_id: int, poll_interval: int = 5, max_wait: int = 120):
    """Ждать результат задачи (polling)."""
    start = time.monotonic()
    while (time.monotonic() - start) < max_wait:
        r = requests.post(
            f"{API_BASE}/getTaskResult",
            json={"clientKey": api_key, "taskId": task_id},
            timeout=30,
        )
        data = r.json()
        if data.get("errorId") != 0:
            raise RuntimeError(
                f"2Captcha getTaskResult error: {data.get('errorCode', data.get('errorDescription', data))}"
            )
        if data.get("status") == "ready":
            return data.get("solution", {})
        time.sleep(poll_interval)
    raise TimeoutError("2Captcha: решение не получено за отведённое время")


def solve_image_captcha(api_key: str, image_base64: str, **options) -> str:
    """
    Решить обычную капчу по изображению (Base64).
    options: phrase, case, numeric, math, minLength, maxLength, comment.
    """
    # убираем data URI префикс если есть
    if "," in image_base64:
        image_base64 = image_base64.split(",", 1)[1]
    task = {
        "type": "ImageToTextTask",
        "body": image_base64,
        **{k: v for k, v in options.items() if k in ("phrase", "case", "numeric", "math", "minLength", "maxLength", "comment")},
    }
    task_id = _create_task(api_key, task)
    solution = _get_task_result(api_key, task_id)
    return solution.get("text", "").strip()


def parse_proxy(proxy_str: str) -> dict:
    """
    Парсит строку прокси в параметры для API.
    Форматы: http://user:pass@host:port, socks5://host:port, host:port (по умолчанию http).
    """
    if not proxy_str or not proxy_str.strip():
        return {}
    s = proxy_str.strip()
    login = password = None
    if "@" in s:
        auth, rest = s.rsplit("@", 1)
        if "://" in auth:
            proto_part = auth.split("://", 1)[1]
            if ":" in proto_part:
                login, password = proto_part.split(":", 1)
        else:
            login, password = auth.split(":", 1)
        s = rest
    if "://" in s:
        proxy_type, addr = s.split("://", 1)
        proxy_type = proxy_type.lower()
        if proxy_type == "socks4":
            proxy_type = "socks4"
        elif proxy_type == "socks5":
            proxy_type = "socks5"
        else:
            proxy_type = "http"
    else:
        proxy_type = "http"
        addr = s
    if ":" in addr:
        proxy_address, proxy_port = addr.rsplit(":", 1)
        proxy_port = int(proxy_port)
    else:
        proxy_address = addr
        proxy_port = 8080
    out = {
        "proxyType": proxy_type,
        "proxyAddress": proxy_address,
        "proxyPort": proxy_port,
    }
    if login is not None:
        out["proxyLogin"] = login
    if password is not None:
        out["proxyPassword"] = password
    return out


def solve_captchafox(
    api_key: str,
    website_url: str,
    website_key: str,
    user_agent: str,
    proxy_type: str = "http",
    proxy_address: str = "",
    proxy_port: int = 0,
    proxy_login: str | None = None,
    proxy_password: str | None = None,
) -> str:
    """
    Решить CaptchaFox. Требуются прокси и User-Agent.
    Возвращает токен для подстановки в форму.
    """
    task = {
        "type": "CaptchaFoxTask",
        "websiteURL": website_url,
        "websiteKey": website_key,
        "userAgent": user_agent,
        "proxyType": proxy_type,
        "proxyAddress": proxy_address,
        "proxyPort": proxy_port,
    }
    if proxy_login is not None:
        task["proxyLogin"] = proxy_login
    if proxy_password is not None:
        task["proxyPassword"] = proxy_password
    task_id = _create_task(api_key, task)
    solution = _get_task_result(api_key, task_id)
    return (solution.get("token") or "").strip()


def solve_captchafox_with_proxy_string(api_key: str, website_url: str, website_key: str, user_agent: str, proxy_str: str) -> str:
    """Решить CaptchaFox, передав прокси одной строкой (как в .env)."""
    proxy = parse_proxy(proxy_str)
    if not proxy:
        raise ValueError("Для CaptchaFox нужен прокси (PROXY в .env). Формат: http://user:pass@host:port или host:port")
    return solve_captchafox(
        api_key,
        website_url=website_url,
        website_key=website_key,
        user_agent=user_agent,
        proxy_type=proxy["proxyType"],
        proxy_address=proxy["proxyAddress"],
        proxy_port=proxy["proxyPort"],
        proxy_login=proxy.get("proxyLogin"),
        proxy_password=proxy.get("proxyPassword"),
    )
