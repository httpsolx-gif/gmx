#!/usr/bin/env python3
"""Пишет src/core/httpServerApp.js как тонкий алиас на src/server.js (без дублирования кода).

Раньше скрипт собирал урезанную копию server.js по номерам строк — после рефакторинга
это ломалось. Теперь httpServerApp.js только подключает server.js.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
out_path = ROOT / "src" / "core" / "httpServerApp.js"

BODY = """/**
 * Совместимость: раньше был в корне src/ (см. scripts/assemble-http-server-app.py).
 * Не подключён в npm start (точка входа — server.js → ./server.js).
 * Поведение идентично src/server.js: один процесс, один listen.
 */
require('../server.js');
"""

out_path.write_text(BODY, encoding="utf-8")
print("wrote", out_path, "lines", len(BODY.splitlines()))
