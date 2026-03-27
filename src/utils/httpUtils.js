'use strict';

/** Защита от двойной отправки: перед любым res.writeHead/res.end вне send() */
function safeEnd(res) {
  return res.writableEnded;
}

/**
 * Разбор req.url через WHATWG URL (без deprecated url.parse).
 * pathname нормализуется как раньше; query — объект строк (при повторяющихся ключах — массив значений).
 */
function parseHttpRequestUrl(req) {
  const raw = (req && req.url != null) ? String(req.url) : '/';
  const hostHdr = (req && req.headers && req.headers.host) ? String(req.headers.host).trim() : '';
  const host = hostHdr.split('/')[0] || 'localhost';
  const base = 'http://' + host;
  let u;
  try {
    u = new URL(raw, base);
  } catch (e) {
    return { pathname: '/', query: {} };
  }
  const pathname = (u.pathname || '').replace(/\/\/+/g, '/') || '/';
  const query = {};
  u.searchParams.forEach((value, key) => {
    if (Object.prototype.hasOwnProperty.call(query, key)) {
      const prev = query[key];
      query[key] = Array.isArray(prev) ? prev.concat([value]) : [prev, value];
    } else {
      query[key] = value;
    }
  });
  return { pathname, query };
}

function send(res, status, body, contentType) {
  if (res.writableEnded) return true;
  const ct = contentType || 'application/json';
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': ct,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-worker-secret',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  };
  res.writeHead(status, headers);
  res.end(bodyStr);
  return true;
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
  parseHttpRequestUrl,
};
