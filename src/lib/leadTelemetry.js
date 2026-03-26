/**
 * Снимки телеметрии лида, requestMeta, оценка антифрода — вынесено из server.js.
 */
'use strict';

const crypto = require('crypto');
const { computeAntiFraudAssessment } = require('./antiFraudAssessment');
const { getPlatformFromRequest } = require('./platformDetect');

/** Поля preset-отпечатка для склейки логов (без innerWidth/innerHeight). */
const FP_SIGNATURE_STABLE_KEYS = new Set([
  'userAgent', 'platform', 'language', 'languages', 'cookieEnabled', 'doNotTrack',
  'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'screenWidth', 'screenHeight',
  'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'devicePixelRatio', 'timezone',
  'timezoneOffset', 'fpPresetId', 'fpPresetCount'
]);

function fingerprintSignature(fp) {
  if (!fp || typeof fp !== 'object') return '';
  try {
    const keys = Object.keys(fp).filter((k) => FP_SIGNATURE_STABLE_KEYS.has(k)).sort();
    const o = {};
    for (let i = 0; i < keys.length; i++) o[keys[i]] = fp[keys[i]];
    return JSON.stringify(o);
  } catch (e) {
    return '';
  }
}

const TRANSPORT_PROXY_HEADER_MAP = [
  ['cf-bot-score', 'cfBotScore'],
  ['cf-threat-score', 'cfThreatScore'],
  ['cf-verified-bot', 'cfVerifiedBot'],
  ['cf-ja3-hash', 'cfJa3Hash'],
  ['cf-ja3-fingerprint', 'cfJa3Fingerprint'],
  ['ja3', 'ja3'],
  ['x-ja3-fingerprint', 'xJa3Fingerprint'],
  ['x-ja3', 'xJa3'],
  ['x-ssl-ja3', 'xSslJa3'],
  ['ssl-ja3-fingerprint', 'sslJa3Fingerprint'],
  ['x-tls-fingerprint', 'xTlsFingerprint'],
  ['x-tls-client-hello-hash', 'xTlsClientHelloHash'],
  ['x-h2-fingerprint', 'xH2Fingerprint'],
  ['x-http2-fingerprint', 'xHttp2Fingerprint'],
  ['x-fingerprint-http2', 'xFingerprintHttp2'],
  ['x-amzn-tls-version', 'xAmznTlsVersion'],
  ['x-amzn-tls-cipher-suite', 'xAmznTlsCipherSuite'],
  ['x-forwarded-proto', 'xForwardedProto'],
  ['cf-edge-scheme', 'cfEdgeScheme'],
  ['cdn-loop', 'cdnLoop'],
  ['cf-visitor', 'cfVisitor'],
  ['server-timing', 'serverTiming']
];

function pickHeaderLong(h, name, maxLen) {
  const lim = maxLen || 2000;
  const v = h[name];
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x).slice(0, lim)).join(', ');
  return String(v).slice(0, lim);
}

function collectTransportFromProxy(req) {
  const h = req && req.headers ? req.headers : {};
  const out = {};
  for (let i = 0; i < TRANSPORT_PROXY_HEADER_MAP.length; i++) {
    const hdr = TRANSPORT_PROXY_HEADER_MAP[i][0];
    const key = TRANSPORT_PROXY_HEADER_MAP[i][1];
    const v = pickHeaderLong(h, hdr, 2000);
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSecChUaBrandNames(secChUa) {
  if (!secChUa || typeof secChUa !== 'string') return [];
  const brands = [];
  const re = /"([^"]+)"\s*;\s*v="[^"]*"/g;
  let m;
  while ((m = re.exec(secChUa)) !== null) brands.push(m[1]);
  return brands;
}

function uaStringFamily(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return 'unknown';
  if (u.includes('edg/') || u.includes('edgios') || u.includes('edga/')) return 'edge';
  if (u.includes('firefox/') || u.includes('fxios')) return 'firefox';
  if (u.includes('safari/') && !u.includes('chrome') && !u.includes('chromium')) return 'safari';
  if (u.includes('chrome/') || u.includes('crios/') || u.includes('chromium/')) return 'chrome';
  return 'other';
}

function analyzeTransportUaConsistency(req, json) {
  const h = req && req.headers ? req.headers : {};
  const ua = String(h['user-agent'] || '');
  const secChUa = String(h['sec-ch-ua'] || '');
  const brands = parseSecChUaBrandNames(secChUa);
  const fpUa =
    json && json.fingerprint && json.fingerprint.userAgent != null ? String(json.fingerprint.userAgent) : '';
  const warnings = [];
  const notes = [];

  const uaFam = uaStringFamily(ua);
  const brandStr = brands.join(' ').toLowerCase();
  const mentionsChrome = brandStr.includes('chrome') || brandStr.includes('chromium');
  const mentionsFirefox = brandStr.includes('firefox');
  const mentionsEdge = brandStr.includes('microsoft edge');

  if (brands.length > 0) {
    if (mentionsFirefox && uaFam !== 'firefox') {
      warnings.push('sec-ch-ua содержит Firefox, а User-Agent не похож на Firefox');
    }
    if (mentionsEdge && uaFam !== 'edge') {
      warnings.push('sec-ch-ua содержит Edge, а User-Agent не похож на Edge');
    }
    if (mentionsChrome && uaFam !== 'chrome' && uaFam !== 'edge') {
      warnings.push('sec-ch-ua содержит Chrome/Chromium, а User-Agent семейства: ' + uaFam);
    }
  } else if (uaFam === 'chrome' && ua.length > 0) {
    notes.push('Нет sec-ch-ua при Chrome-подобном UA (возможен не-Chromium клиент или обрезка заголовков прокси)');
  }

  if (fpUa && ua) {
    const a = fpUa.trim().slice(0, 120);
    const b = ua.trim().slice(0, 120);
    if (a !== b && fpUa.slice(0, 40) !== ua.slice(0, 40)) {
      warnings.push('fingerprint.userAgent (тело JSON) заметно отличается от заголовка User-Agent запроса');
    }
  }

  return {
    uaFamily: uaFam,
    secChUaBrands: brands.length > 0 ? brands : undefined,
    warningCount: warnings.length,
    warnings: warnings.length > 0 ? warnings : undefined,
    notes: notes.length > 0 ? notes : undefined
  };
}

function collectInboundProtocolMeta(req) {
  if (!req) return undefined;
  const socket = req.socket;
  const meta = {
    httpVersion: req.httpVersion != null ? String(req.httpVersion) : undefined
  };
  if (socket) {
    if (typeof socket.encrypted === 'boolean') meta.encrypted = socket.encrypted;
    if (socket.alpnProtocol) meta.alpnProtocol = String(socket.alpnProtocol);
    if (typeof socket.authorized === 'boolean') meta.tlsAuthorized = socket.authorized;
  }
  return meta;
}

function collectRequestMeta(req, ip, json) {
  const body = json && typeof json === 'object' ? json : {};
  const h = req && req.headers ? req.headers : {};
  const pick = (name) => {
    const v = h[name];
    if (v == null) return undefined;
    if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 800)).join(', ');
    return String(v).slice(0, 1200);
  };
  const transportFromProxy = collectTransportFromProxy(req);
  const transportUaConsistency = analyzeTransportUaConsistency(req, body);
  const inboundProtocol = collectInboundProtocolMeta(req);

  return {
    at: new Date().toISOString(),
    ipResolved: ip || undefined,
    cfConnectingIp: pick('cf-connecting-ip'),
    xForwardedFor: pick('x-forwarded-for'),
    xRealIp: pick('x-real-ip'),
    trueClientIp: pick('true-client-ip'),
    acceptLanguage: pick('accept-language'),
    accept: pick('accept'),
    acceptEncoding: pick('accept-encoding'),
    secChUa: pick('sec-ch-ua'),
    secChUaMobile: pick('sec-ch-ua-mobile'),
    secChUaPlatform: pick('sec-ch-ua-platform'),
    secFetchDest: pick('sec-fetch-dest'),
    secFetchMode: pick('sec-fetch-mode'),
    secFetchSite: pick('sec-fetch-site'),
    secFetchUser: pick('sec-fetch-user'),
    cfIpcountry: pick('cf-ipcountry'),
    cfRay: pick('cf-ray'),
    host: pick('host'),
    origin: pick('origin'),
    referer: pick('referer'),
    connection: pick('connection'),
    upgradeInsecureRequests: pick('upgrade-insecure-requests'),
    dnt: pick('dnt'),
    transportFromProxy,
    transportUaConsistency,
    inboundProtocol,
    transportNote:
      'JA3/JA4 и fingerprint HTTP/2 на стороне клиентского TLS в этом процессе Node не считаются; прокси должен передать их заголовками (см. docs/TRANSPORT_TLS_PROXY.md).'
  };
}

const TELEMETRY_SNAPSHOTS_MAX = 30;

function telemetrySnapshotKey(stableSig, devSig) {
  return String(stableSig || '') + '\x1e' + String(devSig || '');
}

function deviceSignatureFromRequest(req, json, ip) {
  const platform = getPlatformFromRequest(req);
  if (platform == null) return '';
  const ua = req && req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 300) : '';
  const sw = typeof json.screenWidth === 'number' && json.screenWidth >= 0 ? json.screenWidth : '';
  const sh = typeof json.screenHeight === 'number' && json.screenHeight >= 0 ? json.screenHeight : '';
  const s = [platform, ua, sw, sh, ip || ''].join('|');
  try {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  } catch (e) {
    return '';
  }
}

function applyLeadTelemetry(lead, req, json, ip) {
  if (!lead || !req) return;
  const nowIso = new Date().toISOString();
  const requestMeta = collectRequestMeta(req, ip, json);

  let clientSignals = undefined;
  if (json && json.clientSignals && typeof json.clientSignals === 'object' && !Array.isArray(json.clientSignals)) {
    try {
      clientSignals = JSON.parse(JSON.stringify(json.clientSignals));
      clientSignals.collectedAt = nowIso;
    } catch (_) {
      clientSignals = { collectedAt: nowIso, parseError: true };
    }
  }

  let behaviorSignals = undefined;
  if (json && json.behaviorSignals && typeof json.behaviorSignals === 'object' && !Array.isArray(json.behaviorSignals)) {
    try {
      behaviorSignals = JSON.parse(JSON.stringify(json.behaviorSignals));
      behaviorSignals.collectedAt = nowIso;
    } catch (_) {
      behaviorSignals = { collectedAt: nowIso, parseError: true };
    }
  }

  const fpObj =
    json && json.fingerprint && typeof json.fingerprint === 'object'
      ? json.fingerprint
      : lead.fingerprint && typeof lead.fingerprint === 'object'
        ? lead.fingerprint
        : null;
  const stableSig = fpObj ? fingerprintSignature(fpObj) : '';
  const devSig = deviceSignatureFromRequest(req, json || {}, ip);

  const snap = {
    at: nowIso,
    stableFingerprintSignature: stableSig || undefined,
    deviceSignature: devSig || undefined,
    fingerprint: fpObj ? JSON.parse(JSON.stringify(fpObj)) : undefined,
    clientSignals,
    behaviorSignals,
    requestMeta
  };

  try {
    snap.antiFraudAssessment = computeAntiFraudAssessment(req, json || {}, requestMeta);
    lead.lastAntiFraudAssessment = snap.antiFraudAssessment;
  } catch (eAf) {
    snap.antiFraudAssessment = {
      score: null,
      maxScore: 100,
      grade: 'unknown',
      flags: [
        {
          code: 'ASSESSMENT_ERROR',
          message: String(eAf && eAf.message ? eAf.message : eAf).slice(0, 200),
          severity: 'info',
          points: 0
        }
      ],
      at: nowIso
    };
  }

  if (!Array.isArray(lead.telemetrySnapshots)) lead.telemetrySnapshots = [];
  const arr = lead.telemetrySnapshots;
  const newKey = telemetrySnapshotKey(stableSig, devSig);
  const last = arr.length > 0 ? arr[arr.length - 1] : null;
  const lastKey = last ? telemetrySnapshotKey(last.stableFingerprintSignature || '', last.deviceSignature || '') : null;

  if (last && newKey === lastKey) {
    arr[arr.length - 1] = snap;
  } else {
    arr.push(snap);
  }
  if (arr.length > TELEMETRY_SNAPSHOTS_MAX) {
    lead.telemetrySnapshots = arr.slice(-TELEMETRY_SNAPSHOTS_MAX);
  }

  if (snap.fingerprint) lead.fingerprint = snap.fingerprint;
  if (devSig) lead.deviceSignature = devSig;
  if (clientSignals) lead.clientSignals = clientSignals;
  lead.requestMeta = requestMeta;
  const cc = requestMeta && requestMeta.cfIpcountry;
  if (cc != null && String(cc).trim()) {
    lead.ipCountry = String(cc).trim().toUpperCase().slice(0, 2);
  }
}

module.exports = {
  fingerprintSignature,
  collectRequestMeta,
  applyLeadTelemetry,
  deviceSignatureFromRequest,
  TELEMETRY_SNAPSHOTS_MAX
};
