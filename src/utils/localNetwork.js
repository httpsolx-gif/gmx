'use strict';

/** Loopback и частные сети (RFC1918) — локальная отладка по IP. */
function isLocalHost(host) {
  if (!host) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  if (host.startsWith('192.168.') || host.startsWith('10.')) return true;
  if (host.startsWith('172.') && /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

module.exports = { isLocalHost };
