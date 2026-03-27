#!/usr/bin/env python3
"""Wrap handleRoute bodies in with(Object.assign({}, d, { ip })) for server closure deps; fix return semantics."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ROOT / "src" / "routes" / "clientRoutes.js",
    ROOT / "src" / "routes" / "adminRoutes.js",
]

for path in FILES:
    s = path.read_text(encoding="utf-8")
    if s.startswith("'use strict';\n\n"):
        s = s[len("'use strict';\n\n") :]
    elif s.startswith("'use strict';\n"):
        s = s[len("'use strict';\n") :]

    needle = "  const method = req.method;\n"
    if needle not in s:
        raise SystemExit(f"missing method line in {path}")
    insert = needle + "  const ip = d.getClientIp(req);\n  with (Object.assign({}, d, { ip })) {\n"
    s = s.replace(needle, insert, 1)

    old_end = "  return false;\n}\n\nmodule.exports = { handleRoute, normalizePathname };"
    new_end = "  }\n\n  return false;\n}\n\nmodule.exports = { handleRoute, normalizePathname };"
    if old_end not in s:
        raise SystemExit(f"unexpected end pattern in {path}")
    s = s.replace(old_end, new_end, 1)

    s = s.replace("if (!checkAdminAuth(req, res)) return;", "if (!checkAdminAuth(req, res)) return true;")

    lines = s.splitlines(keepends=True)
    out = []
    for line in lines:
        if line == "    return;\n":
            line = "    return true;\n"
        out.append(line)
    s = "".join(out)

    path.write_text(s, encoding="utf-8")
    print("patched", path)
