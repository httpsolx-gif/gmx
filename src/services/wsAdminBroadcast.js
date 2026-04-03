'use strict';
const { getLeadById } = require('../db/database');

/**
 * WS только для оповещения админки об обновлении лидов (не чат — чат по HTTP).
 * broadcast совпадает с automationService / persist, вызывается через global.__gmwWssBroadcast.
 */
function attachAdminLeadsWebSocket(WebSocketServer, server) {
  if (!WebSocketServer) return null;
  const wss = new WebSocketServer({ server: server, path: '/ws' });
  function sendToClients(payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach(function (client) {
      if (client.readyState === 1) {
        try { client.send(msg); } catch (e) {}
      }
    });
  }
  global.__gmwWssBroadcast = function () {
    sendToClients({ type: 'leads-update' });
  };
  global.__gmwWssBroadcastLeadUpdate = function (leadId, patch) {
    const id = leadId != null ? String(leadId).trim() : '';
    if (!id) {
      sendToClients({ type: 'leads-update' });
      return;
    }
    if (patch && typeof patch === 'object' && Object.keys(patch).length > 0) {
      try {
        sendToClients({ type: 'lead-patch', leadId: id, patch });
      } catch (_) {
        sendToClients({ type: 'leads-update' });
      }
      return;
    }
    let lead = null;
    try { lead = getLeadById(id); } catch (e) { lead = null; }
    if (!lead) {
      sendToClients({ type: 'leads-update' });
      return;
    }
    try {
      const hb = global.__gmwStatusHeartbeatsForAdmin && global.__gmwStatusHeartbeatsForAdmin[id]
        ? global.__gmwStatusHeartbeatsForAdmin[id]
        : null;
      if (hb && hb.lastSeenAt) {
        lead.sessionPulseAt = hb.lastSeenAt;
        if (hb.currentPage) lead.currentPage = hb.currentPage;
      }
    } catch (_) {}
    sendToClients({ type: 'lead-update', lead: lead });
  };
  global.__gmwWssBroadcastLogAppended = function (leadId, line) {
    const id = leadId != null ? String(leadId).trim() : '';
    const logLine = line != null ? String(line) : '';
    if (!id || !logLine) return;
    sendToClients({ type: 'log_appended', leadId: id, line: logLine });
  };
  wss.on('connection', function () {
    console.log('[SERVER] WebSocket: админ подключён');
  });
  return wss;
}

module.exports = { attachAdminLeadsWebSocket };
