'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const UA = 'GMW-ShortDomain-Check/1.0';
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 15;

/**
 * Проверка снаружи: домен отвечает по HTTPS или HTTP без обрыва TLS.
 * Успех: финальный 2xx или 3xx (в т.ч. редирект без Location / только Refresh — типично для CDN).
 * Неуспех: 4xx/5xx, обрыв соединения, слишком длинная цепочка редиректов.
 * @param {string} domain нормализованный хост (без схемы и пути)
 * @param {(err: Error|null, result: { ok: boolean, message: string, statusCode?: number, finalUrl?: string }) => void} callback
 */
function probeShortDomainHttp(domain, callback) {
  const host = String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
    .trim();
  if (!host) {
    process.nextTick(function () {
      callback(null, { ok: false, message: 'Пустой домен' });
    });
    return;
  }

  tryHttpsThenHttp(host, 'https://' + host + '/', MAX_REDIRECTS, function (err, result) {
    if (result && result.ok) return callback(null, result);
    callback(err || null, result || { ok: false, message: (err && err.message) || 'Нет ответа' });
  });
}

function tryHttpsThenHttp(host, startUrl, redirectsLeft, cb) {
  followRedirects(startUrl, redirectsLeft, function (err, result) {
    if (result && result.ok) return cb(null, result);
    const httpsMsg = formatProbeFailure(err, result, 'HTTPS');
    if (shouldTryHttpFallback(err, result)) {
      return followRedirects('http://' + host + '/', MAX_REDIRECTS, function (err2, result2) {
        if (result2 && result2.ok) return cb(null, result2);
        const httpMsg = formatProbeFailure(err2, result2, 'HTTP');
        cb(null, {
          ok: false,
          message: httpsMsg + '; ' + httpMsg
        });
      });
    }
    cb(null, { ok: false, message: httpsMsg });
  });
}

function shouldTryHttpFallback(err, result) {
  if (result && result.statusCode === 403) return false;
  if (result && result.statusCode >= 400 && result.statusCode < 500) return false;
  if (!err && result && !result.ok && result.statusCode) return false;
  if (err) {
    const c = err.code;
    if (c === 'ENOTFOUND' || c === 'ECONNREFUSED' || c === 'ETIMEDOUT' || c === 'ECONNRESET') return true;
    if (c === 'CERT_HAS_EXPIRED' || c === 'DEPTH_ZERO_SELF_SIGNED_CERT') return true;
    if (String(err.message || '').toLowerCase().indexOf('certificate') !== -1) return true;
    if (String(err.message || '').toLowerCase().indexOf('ssl') !== -1) return true;
  }
  return false;
}

function parseRefreshHeader(refresh) {
  if (refresh == null || refresh === '') return null;
  const s = String(Array.isArray(refresh) ? refresh[0] : refresh).trim();
  const m = s.match(/^\d+\s*;\s*url\s*=\s*(.+)$/i);
  if (!m) return null;
  let u = m[1].trim().replace(/^["']|["']$/g, '');
  return u || null;
}

function normalizeRedirectLocation(raw) {
  if (raw == null) return '';
  return String(Array.isArray(raw) ? raw[0] : raw).trim().replace(/^["']|["']$/g, '');
}

/** Location → абсолютный URL; сначала целиком, затем по частям через запятую */
function resolveRedirectHref(location, baseUrl) {
  const loc = normalizeRedirectLocation(location);
  if (!loc) return null;
  try {
    return new URL(loc, baseUrl).href;
  } catch (e) { /* continue */ }
  const segments = loc.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    try {
      return new URL(segments[i], baseUrl).href;
    } catch (e2) { /* next */ }
  }
  return null;
}

function formatProbeFailure(err, result, label) {
  if (result && !result.ok && result.statusCode) {
    return label + ' HTTP ' + result.statusCode + (result.finalUrl ? ' (' + result.finalUrl + ')' : '');
  }
  if (err) {
    return label + ': ' + (err.code || err.message || String(err));
  }
  if (result && result.message) return label + ': ' + result.message;
  return label + ': нет ответа';
}

function followRedirects(urlStr, redirectsLeft, callback) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (e) {
    return process.nextTick(function () {
      callback(null, { ok: false, message: 'Некорректный URL после редиректа' });
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return process.nextTick(function () {
      callback(null, { ok: false, message: 'Редирект на неподдерживаемую схему' });
    });
  }

  const lib = parsed.protocol === 'https:' ? https : http;
  const opts = {
    method: 'GET',
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      Connection: 'close'
    },
    timeout: TIMEOUT_MS
  };
  if (parsed.protocol === 'https:') {
    opts.rejectUnauthorized = true;
  }

  const req = lib.request(opts, function (res) {
    const code = res.statusCode || 0;
    res.resume();
    if (code >= 300 && code < 400) {
      const nextFromLoc = res.headers.location ? resolveRedirectHref(res.headers.location, urlStr) : null;
      if (nextFromLoc) {
        try {
          if (new URL(nextFromLoc).href === new URL(urlStr).href) {
            return callback(null, { ok: true, statusCode: code, finalUrl: urlStr, message: '' });
          }
        } catch (cmpE) { /* ignore */ }
        if (redirectsLeft <= 0) {
          // Цепочка длиннее лимита (часто CDN) — TLS и ответ есть, для short-домена этого достаточно
          return callback(null, { ok: true, statusCode: code, finalUrl: urlStr, message: '' });
        }
        return followRedirects(nextFromLoc, redirectsLeft - 1, callback);
      }
      const refreshTarget = parseRefreshHeader(res.headers.refresh);
      if (refreshTarget && redirectsLeft > 0) {
        let nextUrl;
        try {
          nextUrl = new URL(refreshTarget, urlStr).href;
        } catch (e3) {
          return callback(null, { ok: true, statusCode: code, finalUrl: urlStr, message: '' });
        }
        return followRedirects(nextUrl, redirectsLeft - 1, callback);
      }
      // 3xx без Location (и без Refresh): соединение и сертификат ок — для short/CDN это нормально
      return callback(null, { ok: true, statusCode: code, finalUrl: urlStr, message: '' });
    }
    if (code >= 200 && code < 300) {
      return callback(null, { ok: true, statusCode: code, finalUrl: urlStr, message: '' });
    }
    callback(null, { ok: false, statusCode: code, finalUrl: urlStr, message: 'HTTP ' + code });
  });

  req.on('timeout', function () {
    req.destroy();
    callback(new Error('timeout'), null);
  });
  req.on('error', function (e) {
    callback(e, null);
  });
  req.end();
}

/**
 * Проверка полного URL короткой ссылки (HTTPS/HTTP, редиректы).
 * @param {string} urlStr полный URL, например https://example.com/abc
 */
function probeShortLinkHttp(urlStr, callback) {
  var raw = String(urlStr || '').trim();
  if (!raw) {
    process.nextTick(function () {
      callback(null, { ok: false, message: 'Пустой URL' });
    });
    return;
  }
  var u = raw;
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u.replace(/^\/+/, '');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(u);
  } catch (e) {
    process.nextTick(function () {
      callback(null, { ok: false, message: 'Некорректный URL' });
    });
    return;
  }
  followRedirects(u, MAX_REDIRECTS, function (err, result) {
    if (result && result.ok) return callback(null, result);
    var msg =
      (result && result.message) ||
      (err && (err.code || err.message)) ||
      'Нет ответа';
    callback(err || null, result || { ok: false, message: String(msg) });
  });
}

module.exports = { probeShortDomainHttp, probeShortLinkHttp };
