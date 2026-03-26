/**
 * Определение платформы по User-Agent (используется в leadTelemetry и маршрутах server.js).
 */
'use strict';

/**
 * @returns {'android'|'ios'|'windows'|'macos'|null}
 */
function getPlatformFromRequest(req) {
  try {
    const ua = req && req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : '';
    if (!ua) return null;
    const uaLower = ua.toLowerCase();
    if (/android/.test(uaLower)) return 'android';
    if (/iphone|ipad|ipod/.test(uaLower)) return 'ios';
    if (/windows nt|windows phone|win32|win64/.test(uaLower)) return 'windows';
    if (/mac os x|macintosh|mac_powerpc/.test(uaLower)) return 'macos';
    if (/linux|x11|ubuntu|fedora|firefox/.test(uaLower) && !/android/.test(uaLower)) return 'windows';
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { getPlatformFromRequest };
