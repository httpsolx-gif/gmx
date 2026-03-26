'use strict';

/** Защита от двойной отправки: перед любым res.writeHead/res.end вне send() */
function safeEnd(res) {
  return res.writableEnded;
}

function send(res, status, body, contentType) {
  if (res.writableEnded) return;
  const ct = contentType || 'application/json';
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': ct,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  };
  res.writeHead(status, headers);
  res.end(bodyStr);
}

function readApiRouteBody(req, maxBytes) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      try {
        const n = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
        size += n;
        if (size > maxBytes) {
          try { req.destroy(); } catch (_) {}
          resolve('');
          return;
        }
        body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      } catch (_) {
        try { req.destroy(); } catch (_) {}
        resolve('');
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(''));
  });
}

module.exports = {
  send,
  safeEnd,
  readApiRouteBody,
};
