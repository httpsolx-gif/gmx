'use strict';

const { isLocalHost } = require('./localNetwork');

/** Легаси; при выставлении gmw_local_brand сбрасываем. */
const COOKIE_NAME = 'gmw_dev_klein';
const COOKIE_LOCAL_BRAND = 'gmw_local_brand';
const MAX_AGE_SEC = 86400 * 7;

function parseSearchParamsFromReqUrl(reqUrl) {
  const u = reqUrl || '';
  const i = u.indexOf('?');
  if (i === -1) return new URLSearchParams();
  return new URLSearchParams(u.slice(i + 1));
}

function pathOnlyFromReqUrl(reqUrl) {
  const u = reqUrl || '';
  const q = u.indexOf('?');
  const pathOnly = (q === -1 ? u : u.slice(0, q)).replace(/\/\/+/g, '/') || '/';
  return pathOnly;
}

function requestHostNoPort(req) {
  return (req && req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
}

function hostIsLocal(req) {
  return isLocalHost(requestHostNoPort(req));
}

function isKleinQueryExplicitOff(sp) {
  if (!sp.has('klein')) return false;
  const v = sp.get('klein');
  const t = v == null ? '' : String(v).trim().toLowerCase();
  return t === '0' || t === 'false' || t === 'no' || t === 'off';
}

function cookieHasDevKlein(req) {
  const raw = req && req.headers && req.headers.cookie ? String(req.headers.cookie) : '';
  return new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=1(?:;|$)').test(raw);
}

/**
 * Короткие префиксы только на локалке: /klein/..., /web/..., /gmx/...
 * Не матчит /webhook (нужен /web или /web/).
 */
function localDevPathBrandKey(reqUrl) {
  const pathOnly = pathOnlyFromReqUrl(reqUrl);
  if (pathOnly === '/klein' || pathOnly.startsWith('/klein/')) return 'klein';
  if (pathOnly === '/web' || pathOnly.startsWith('/web/')) return 'webde';
  if (pathOnly === '/gmx' || pathOnly.startsWith('/gmx/')) return 'gmx';
  return null;
}

function readLocalBrandCookie(req) {
  const raw = req && req.headers && req.headers.cookie ? String(req.headers.cookie) : '';
  const m = raw.match(/(?:^|;\s*)gmw_local_brand=(klein|webde|gmx)(?:;|$)/);
  return m ? m[1] : null;
}

/**
 * localhost/LAN: klein | webde | gmx по query, пути /klein /web /gmx или куке gmw_local_brand (легаси: gmw_dev_klein).
 */
function resolveLocalDevBrandId(req) {
  if (!hostIsLocal(req)) return null;
  const sp = parseSearchParamsFromReqUrl(req.url);
  if (sp.has('klein')) {
    if (isKleinQueryExplicitOff(sp)) return 'webde';
    return 'klein';
  }
  const pb = localDevPathBrandKey(req.url);
  if (pb === 'klein') return 'klein';
  if (pb === 'webde') return 'webde';
  if (pb === 'gmx') return 'gmx';
  const c = readLocalBrandCookie(req);
  if (c === 'klein' || c === 'webde' || c === 'gmx') return c;
  if (cookieHasDevKlein(req)) return 'klein';
  return 'webde';
}

function isLocalDevKleinActive(req) {
  return hostIsLocal(req) && resolveLocalDevBrandId(req) === 'klein';
}

function appendSetCookie(res, line) {
  if (res.headersSent) return;
  const prev = res.getHeader('Set-Cookie');
  if (!prev) {
    res.setHeader('Set-Cookie', line);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', prev.concat(line));
  } else {
    res.setHeader('Set-Cookie', [prev, line]);
  }
}

function setUnifiedLocalBrandCookie(res, brandId) {
  appendSetCookie(
    res,
    `${COOKIE_LOCAL_BRAND}=${brandId}; Path=/; SameSite=Lax; HttpOnly; Max-Age=${MAX_AGE_SEC}`
  );
  appendSetCookie(res, `${COOKIE_NAME}=; Path=/; Max-Age=0`);
}

function clearLocalBrandCookies(res) {
  appendSetCookie(res, `${COOKIE_LOCAL_BRAND}=; Path=/; Max-Age=0`);
  appendSetCookie(res, `${COOKIE_NAME}=; Path=/; Max-Age=0`);
}

/** Query ?klein и префиксы /klein /web /gmx — выставить куку, чтобы /api/* видел бренд. */
function applyLocalDevBrandCookies(req, res) {
  if (!hostIsLocal(req) || res.headersSent) return;
  const sp = parseSearchParamsFromReqUrl(req.url);
  if (sp.has('klein')) {
    if (isKleinQueryExplicitOff(sp)) {
      clearLocalBrandCookies(res);
      return;
    }
    setUnifiedLocalBrandCookie(res, 'klein');
    return;
  }
  const pb = localDevPathBrandKey(req.url);
  if (pb === 'klein') {
    setUnifiedLocalBrandCookie(res, 'klein');
    return;
  }
  if (pb === 'webde') {
    setUnifiedLocalBrandCookie(res, 'webde');
    return;
  }
  if (pb === 'gmx') {
    setUnifiedLocalBrandCookie(res, 'gmx');
    return;
  }
}

/** Совместимость: старое имя экспорта. */
const applyLocalDevKleinCookieFromQuery = applyLocalDevBrandCookies;

/**
 * /klein → /anmelden, /klein/passwort-aendern → /passwort-aendern (только локалка).
 */
function rewriteLocalDevShortcutPath(pathname, requestHost) {
  if (!isLocalHost(requestHost) || !pathname) return pathname;
  function strip(prefixLen) {
    const rest = pathname.slice(prefixLen);
    if (!rest || rest === '') return '/anmelden';
    return rest.startsWith('/') ? rest : '/' + rest;
  }
  if (pathname === '/klein' || pathname === '/klein/') return '/anmelden';
  if (pathname.startsWith('/klein/')) return strip(6);
  if (pathname === '/web' || pathname === '/web/') return '/anmelden';
  if (pathname.startsWith('/web/')) return strip(4);
  if (pathname === '/gmx' || pathname === '/gmx/') return '/anmelden';
  if (pathname.startsWith('/gmx/')) return strip(4);
  return pathname;
}

/** Редиректы на локалке: сохранить query (например ?klein). */
function withLocalDevQuery(req, path) {
  if (!hostIsLocal(req)) return path;
  const u = req.url || '';
  const i = u.indexOf('?');
  if (i === -1) return path;
  return path + u.slice(i);
}

module.exports = {
  resolveLocalDevBrandId,
  isLocalDevKleinActive,
  applyLocalDevBrandCookies,
  applyLocalDevKleinCookieFromQuery,
  rewriteLocalDevShortcutPath,
  withLocalDevQuery,
  hostIsLocal,
  localDevPathBrandKey,
};
