const { safeEnd, send } = require('../utils/httpUtils');
const adminSessionService = require('../services/adminSessionService');

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const PASSWORD_AUTH_ENABLED = !!(ADMIN_USERNAME && ADMIN_PASSWORD);

const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_MAX = 5;
const loginFailBuckets = Object.create(null);

function pruneLoginFailBuckets(now) {
  const keys = Object.keys(loginFailBuckets);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (loginFailBuckets[k].resetAt < now) delete loginFailBuckets[k];
  }
}

function loginFailKey(ip) {
  const ipKey = (ip && String(ip).trim()) ? String(ip).trim() : 'unknown';
  return 'admLogin:' + ipKey;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  if (Math.random() < 0.02) pruneLoginFailBuckets(now);
  const key = loginFailKey(ip);
  if (!loginFailBuckets[key] || now > loginFailBuckets[key].resetAt) {
    loginFailBuckets[key] = { count: 0, resetAt: now + LOGIN_FAIL_WINDOW_MS };
  }
  loginFailBuckets[key].count++;
  return loginFailBuckets[key].count > LOGIN_FAIL_MAX;
}

function resetLoginFailures(ip) {
  delete loginFailBuckets[loginFailKey(ip)];
}

function buildSessionCookie(token) {
  const parts = [
    'admin_session=' + encodeURIComponent(token),
    'HttpOnly',
    'Path=/',
    'Max-Age=86400',
    'SameSite=Strict',
  ];
  if (process.env.ADMIN_COOKIE_SECURE === '1') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function buildClearSessionCookie() {
  const parts = [
    'admin_session=',
    'HttpOnly',
    'Path=/',
    'Max-Age=0',
    'SameSite=Strict',
  ];
  if (process.env.ADMIN_COOKIE_SECURE === '1') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

async function handle(scope) {
  with (scope) {
    if (pathname === '/api/admin/login' && method === 'POST') {
      if (safeEnd(res)) return true;
      if (!PASSWORD_AUTH_ENABLED) {
        res.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: false, error: 'auth_not_configured' }));
        return true;
      }
      let data = {};
      try {
        data = body && typeof body === 'string' && body.length ? JSON.parse(body) : {};
      } catch (e) {
        data = {};
      }
      const username = data && data.username != null ? String(data.username).trim() : '';
      const password = data && data.password != null ? String(data.password) : '';

      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        const blocked = recordLoginFailure(ip);
        if (blocked) {
          res.writeHead(429, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: 'too_many_requests' }));
          return true;
        }
        res.writeHead(401, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ ok: false, error: 'invalid_credentials' }));
        return true;
      }

      resetLoginFailures(ip);
      const sessionToken = adminSessionService.createSession();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': buildSessionCookie(sessionToken),
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    if (pathname === '/api/admin/logout' && method === 'POST') {
      if (safeEnd(res)) return true;
      if (!PASSWORD_AUTH_ENABLED) {
        send(res, 503, { ok: false, error: 'auth_not_configured' });
        return true;
      }
      const t = adminSessionService.getAdminSessionTokenFromCookie(req);
      if (!adminSessionService.isValid(t)) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return true;
      }
      adminSessionService.revoke(t);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': buildClearSessionCookie(),
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
  }
  return false;
}

module.exports = { handle, PASSWORD_AUTH_ENABLED };
