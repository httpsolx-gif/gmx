'use strict';

/**
 * WS только для оповещения админки об обновлении лидов (не чат — чат по HTTP).
 * broadcast совпадает с automationService / persist, вызывается через global.__gmwWssBroadcast.
 */
function attachAdminLeadsWebSocket(WebSocketServer, server) {
  if (!WebSocketServer) return null;
  const wss = new WebSocketServer({ server: server, path: '/ws' });
  global.__gmwWssBroadcast = function () {
    const msg = JSON.stringify({ type: 'leads-update' });
    wss.clients.forEach(function (client) {
      if (client.readyState === 1) try { client.send(msg); } catch (e) {}
    });
  };
  wss.on('connection', function () {
    console.log('[SERVER] WebSocket: админ подключён');
  });
  return wss;
}

module.exports = { attachAdminLeadsWebSocket };
