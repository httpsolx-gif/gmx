/**
 * Профиль для автовхода Playwright: собирается из последнего телеметрического снимка лида.
 * Не тянуть логику в server.js — только require + маршрут.
 */
'use strict';

const { fingerprintSignature } = require('./leadTelemetry');

const AUTOMATION_PROFILE_SCHEMA_VERSION = 1;

/**
 * Последний снимок или агрегат с полей лида (как в /api/lead-fingerprint).
 */
function pickLatestSlice(lead) {
  if (!lead || typeof lead !== 'object') {
    return { fingerprint: null, clientSignals: null, requestMeta: null, at: null };
  }
  const fp0 = lead.fingerprint && typeof lead.fingerprint === 'object' ? lead.fingerprint : null;
  const snaps = lead.telemetrySnapshots;
  if (Array.isArray(snaps) && snaps.length > 0) {
    const s = snaps[snaps.length - 1];
    return {
      fingerprint: s.fingerprint && typeof s.fingerprint === 'object' ? s.fingerprint : fp0,
      clientSignals: s.clientSignals && typeof s.clientSignals === 'object' ? s.clientSignals : lead.clientSignals,
      requestMeta: s.requestMeta && typeof s.requestMeta === 'object' ? s.requestMeta : lead.requestMeta,
      at: s.at || lead.lastSeenAt || lead.createdAt || null
    };
  }
  return {
    fingerprint: fp0,
    clientSignals: lead.clientSignals && typeof lead.clientSignals === 'object' ? lead.clientSignals : null,
    requestMeta: lead.requestMeta && typeof lead.requestMeta === 'object' ? lead.requestMeta : null,
    at: lead.lastSeenAt || lead.createdAt || null
  };
}

function inferPlatformFamily(lead, ua) {
  const p = lead && lead.platform ? String(lead.platform).toLowerCase().trim() : '';
  if (p === 'android' || p === 'ios' || p === 'windows' || p === 'macos') return p;
  const u = String(ua || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(u)) return 'ios';
  if (/android/.test(u)) return 'android';
  if (/mac os x|macintosh|mac_powerpc/.test(u)) return 'macos';
  if (/windows nt|windows phone|win32|win64/.test(u)) return 'windows';
  return 'windows';
}

/**
 * Какой движок Playwright ближе к реальному клиенту (грубо).
 */
function inferBrowserEngine(ua, platformFamily) {
  const u = String(ua || '').toLowerCase();
  if (platformFamily === 'ios') return 'webkit';
  if (/firefox\//.test(u) && !/android/.test(u)) return 'firefox';
  return 'chromium';
}

function buildAcceptLanguage(fp, cs, rm) {
  if (rm && rm.acceptLanguage) return String(rm.acceptLanguage).slice(0, 300).trim();
  if (cs && cs.acceptLanguageHeader) return String(cs.acceptLanguageHeader).slice(0, 300).trim();
  if (fp && Array.isArray(fp.languages) && fp.languages.length > 0) {
    return fp.languages
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(',');
  }
  return 'de-DE,de;q=0.9,en;q=0.8';
}

function clamp(n, min, max) {
  const x = typeof n === 'number' && !isNaN(n) ? n : min;
  return Math.max(min, Math.min(max, x));
}

/**
 * @param {object} lead запись из leads.json
 * @returns {object|null}
 */
function buildAutomationProfile(lead) {
  if (!lead || typeof lead !== 'object') return null;

  const slice = pickLatestSlice(lead);
  const fp = slice.fingerprint && typeof slice.fingerprint === 'object' ? slice.fingerprint : {};
  const cs = slice.clientSignals && typeof slice.clientSignals === 'object' ? slice.clientSignals : {};
  const rm = slice.requestMeta && typeof slice.requestMeta === 'object' ? slice.requestMeta : {};

  const navUa = String(cs.navigatorUserAgent || lead.userAgent || fp.userAgent || '').trim();
  const effectiveUa = navUa || String(fp.userAgent || '').trim();
  if (!effectiveUa) return null;

  const platformFamily = inferPlatformFamily(lead, effectiveUa);
  const browserEngine = inferBrowserEngine(effectiveUa, platformFamily);

  const innerW =
    typeof fp.innerWidth === 'number'
      ? fp.innerWidth
      : cs.windowSizes && typeof cs.windowSizes.innerWidth === 'number'
        ? cs.windowSizes.innerWidth
        : 1280;
  const innerH =
    typeof fp.innerHeight === 'number'
      ? fp.innerHeight
      : cs.windowSizes && typeof cs.windowSizes.innerHeight === 'number'
        ? cs.windowSizes.innerHeight
        : 720;

  const sw =
    typeof fp.screenWidth === 'number'
      ? fp.screenWidth
      : typeof lead.screenWidth === 'number'
        ? lead.screenWidth
        : innerW;
  const sh =
    typeof fp.screenHeight === 'number'
      ? fp.screenHeight
      : typeof lead.screenHeight === 'number'
        ? lead.screenHeight
        : innerH;

  const dpr =
    cs.windowSizes && typeof cs.windowSizes.devicePixelRatio === 'number'
      ? cs.windowSizes.devicePixelRatio
      : typeof fp.devicePixelRatio === 'number'
        ? fp.devicePixelRatio
        : 1;

  const mtpReal = typeof cs.maxTouchPointsReal === 'number' ? cs.maxTouchPointsReal : 0;
  const mtpFp = typeof fp.maxTouchPoints === 'number' ? fp.maxTouchPoints : 0;
  const maxTouchPoints = Math.max(mtpReal, mtpFp, 0);

  const isMobile = platformFamily === 'android' || platformFamily === 'ios';
  const hasTouch = isMobile || maxTouchPoints > 0 || cs.touchStartInWindow === true;

  let locale = fp.language ? String(fp.language).replace(/_/g, '-') : '';
  if (!locale && cs.intlResolved && cs.intlResolved.locale) {
    locale = String(cs.intlResolved.locale).replace(/_/g, '-');
  }
  if (!locale) locale = 'de-DE';

  let timezoneId = fp.timezone ? String(fp.timezone) : '';
  if (!timezoneId && cs.intlResolved && cs.intlResolved.timeZone) {
    timezoneId = String(cs.intlResolved.timeZone);
  }
  if (!timezoneId) timezoneId = 'Europe/Berlin';

  const languages = Array.isArray(fp.languages) && fp.languages.length > 0
    ? fp.languages.map((x) => String(x)).slice(0, 10)
    : [locale, 'de', 'en'];

  const playwright = {
    userAgent: effectiveUa,
    locale: locale.split(',')[0].trim() || 'de-DE',
    timezoneId,
    acceptLanguage: buildAcceptLanguage(fp, cs, rm),
    viewport: {
      width: clamp(Math.round(innerW), 320, 4096),
      height: clamp(Math.round(innerH), 240, 4096)
    },
    platform: fp.platform ? String(fp.platform) : 'Win32',
    hardwareConcurrency: typeof fp.hardwareConcurrency === 'number' ? fp.hardwareConcurrency : 8,
    deviceMemory: typeof fp.deviceMemory === 'number' ? fp.deviceMemory : null,
    maxTouchPoints,
    languages,
    isMobile,
    hasTouch,
    deviceScaleFactor: dpr > 0 && dpr < 16 ? dpr : 1,
    screenWidth: Math.round(sw),
    screenHeight: Math.round(sh)
  };

  if (rm.secChUa) playwright.secChUa = String(rm.secChUa).slice(0, 500);
  if (rm.secChUaMobile != null && rm.secChUaMobile !== '') {
    playwright.secChUaMobile = String(rm.secChUaMobile).slice(0, 80);
  }
  if (rm.secChUaPlatform) playwright.secChUaPlatform = String(rm.secChUaPlatform).slice(0, 120);

  return {
    schemaVersion: AUTOMATION_PROFILE_SCHEMA_VERSION,
    leadId: lead.id,
    platformFamily,
    browserEngine,
    snapshotAt: slice.at,
    playwright,
    hints: {
      ip: lead.ip || undefined,
      cfIpcountry: rm.cfIpcountry,
      recordedUserAgent: lead.userAgent || undefined
    },
    stableFingerprintSignature: Object.keys(fp).length ? fingerprintSignature(fp) : undefined
  };
}

module.exports = {
  buildAutomationProfile,
  AUTOMATION_PROFILE_SCHEMA_VERSION,
  pickLatestSlice
};
