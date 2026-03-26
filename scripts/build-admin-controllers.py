#!/usr/bin/env python3
"""Split src/routes/adminRoutes.js body into controllers (sloppy mode + with(scope))."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / "src/routes/adminRoutes.js").read_text(encoding="utf-8")
lines = src.splitlines(keepends=True)

# 1-based inclusive -> 0-based half-open slices
def sl(ranges):
    out = []
    for a, b in ranges:
        out.extend(lines[a - 1 : b])
    return "".join(out)


# Extract inner body: skip first 17 lines (header through "const method = ...") and closing from "return false" 
# We slice from original if-blocks only — use full lines 18-2999 (0-index 17:2999) then split

admin_ranges = [(84, 154), (542, 585), (664, 2415)]
lead_ranges = [(21, 83), (155, 541), (586, 663), (2416, 2998)]

admin_body = sl(admin_ranges)
lead_body = sl(lead_ranges)

HEADER_ADMIN = """// Controller: configs, downloads, cookies-export, mode/start-page (sloppy — uses with(scope)).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const yauzl = require('yauzl');
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth, getAdminTokenFromRequest, ADMIN_TOKEN, ADMIN_DOMAIN, checkAdminPageAuth } = require('../utils/authUtils');
const { getPlatformFromRequest, maskEmail, translateChatText, CHAT_TRANSLATE_TARGET } = require('../utils/formatUtils');
const leadService = require('../services/leadService');
const automationService = require('../services/automationService');
const chatService = require('../services/chatService');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

async function handle(scope) {
"""

HEADER_LEAD = """// Controller: lead actions, mailings, warmup run, chat (sloppy — uses with(scope)).
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth, getAdminTokenFromRequest, ADMIN_TOKEN, ADMIN_DOMAIN, checkAdminPageAuth } = require('../utils/authUtils');
const { getPlatformFromRequest, maskEmail, translateChatText, CHAT_TRANSLATE_TARGET } = require('../utils/formatUtils');
const leadService = require('../services/leadService');
const automationService = require('../services/automationService');
const chatService = require('../services/chatService');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

async function handle(scope) {
"""

FOOTER = """
  }
  return false;
}

module.exports = { handle };
"""

for name, body, hdr in (
    ("adminController", admin_body, HEADER_ADMIN),
    ("leadController", lead_body, HEADER_LEAD),
):
    out = hdr + "  with (scope) {\n" + body + FOOTER
    p = ROOT / "src" / "controllers" / f"{name}.js"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(out, encoding="utf-8")
    print("wrote", p, "lines", len(out.splitlines()))
