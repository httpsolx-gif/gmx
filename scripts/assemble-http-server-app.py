#!/usr/bin/env python3
"""Build src/httpServerApp.js from src/server.js: drop monolithic API block, add route dispatch + ROUTE_HTTP_DEPS."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
server_path = ROOT / "src" / "server.js"
names_path = ROOT / "scripts" / "_route_dep_names.txt"
out_path = ROOT / "src" / "httpServerApp.js"

lines = server_path.read_text(encoding="utf-8").splitlines(keepends=True)

# Exclude: not a runtime value for victim/admin handlers (optional)
SKIP = frozenset({"API_ROUTE_DEPS"})
names = [n.strip() for n in names_path.read_text(encoding="utf-8").splitlines() if n.strip() and n.strip() not in SKIP]

deps_body = ",\n  ".join(f"{n}: {n}" for n in names)
route_requires = """const clientRoutes = require('./routes/clientRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
"""

dispatch = """
    const ROUTE_HTTP_MERGED = Object.assign({}, ROUTE_HTTP_DEPS, { ip });
    let routeHandled = false;
    try {
      routeHandled = await clientRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED);
      if (!routeHandled) routeHandled = await authRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED);
      if (!routeHandled) routeHandled = await adminRoutes.handleRoute(req, res, parsed, body, ROUTE_HTTP_MERGED);
    } catch (err) {
      console.error('[routes]', err);
      if (!safeEnd(res)) send(res, 500, { ok: false, error: 'server error' });
      return;
    }
    if (routeHandled) return;

"""

preamble = "".join(lines[5:2580])  # lines 6-2580 (1-based), ends at }; before createServer
handler_open = "const server = http.createServer(async (req, res) => {\n"
handler_start = "".join(lines[2581:2737])  # inside callback, CORS through end of /api/ early block
tail = "".join(lines[7800:8096])  # from blank/comment after chat-read through outer `});` of createServer
rest = "".join(lines[8096:])

deps_block = f"const ROUTE_HTTP_DEPS = {{\n  {deps_body}\n}};\n\n"

# Remove admin-klein-logo.js from static allowlist in tail
tail = tail.replace("'/admin-klein-logo.js', ", "")

# Remove from preamble (ADMIN_DOMAIN admin assets)
preamble = preamble.replace(
    "pathname === '/admin-klein-logo.js' || ",
    "",
)

out = (
    preamble
    + route_requires
    + deps_block
    + handler_open
    + handler_start
    + dispatch
    + tail
    + rest
)

out_path.write_text(out, encoding="utf-8")
print("wrote", out_path, "lines", len(out.splitlines()))
