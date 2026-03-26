"""
Автоочистка артефактов после входа: скриншоты, временные файлы.
Оставляем только куки (cookies/*.json) и данные лида на сервере (почта, пароли, история).
"""
from pathlib import Path

LOGIN_DIR = Path(__file__).resolve().parent

# Файлы/маски в login/, которые можно удалять (скриншоты и временные данные сессии)
ARTIFACT_NAMES = [
    "webde_screenshot.png",
    "webde_page_info.txt",
    "debug_screenshot.png",
    "debug_consent.png",
    "lead_data.json",
    "lead_result.json",
]


def cleanup_login_artifacts(max_age_seconds: int | None = None) -> int:
    """
    Удаляет скриншоты и временные файлы из login/.
    Не трогает: cookies/, *.py, .env, proxy.txt, accounts.txt и т.д.
    Если max_age_seconds задан — удаляем только файлы старше этого возраста (для таймерной очистки).
    Если None — удаляем все перечисленные артефакты (после успешного входа).
    Возвращает количество удалённых файлов.
    """
    import time
    deleted = 0
    now = time.time()
    for name in ARTIFACT_NAMES:
        p = LOGIN_DIR / name
        if not p.is_file():
            continue
        if max_age_seconds is not None:
            try:
                mtime = p.stat().st_mtime
                if (now - mtime) < max_age_seconds:
                    continue
            except OSError:
                continue
        try:
            p.unlink()
            deleted += 1
        except OSError:
            pass
    # Удаляем любые другие .png в login/ (скриншоты с нефиксированными именами)
    try:
        for f in LOGIN_DIR.glob("*.png"):
            if max_age_seconds is not None:
                try:
                    if (now - f.stat().st_mtime) < max_age_seconds:
                        continue
                except OSError:
                    continue
            try:
                f.unlink()
                deleted += 1
            except OSError:
                pass
    except OSError:
        pass
    return deleted
