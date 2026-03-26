'use strict';

const https = require('https');
const { getPlatformFromRequest } = require('../../lib/platformDetect');

/** Маскировка email в логах (не выводить полный адрес). */
function maskEmail(email) {
  if (email == null || typeof email !== 'string') return '';
  const s = email.trim();
  if (s.length < 3) return '***';
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return s.slice(0, 2) + '***';
  return s.slice(0, Math.min(2, at)) + '***@' + s.slice(at + 1);
}

/** Язык перевода сообщений от пользователя в чате (например ru, en). Пусто — перевод выключен. */
const CHAT_TRANSLATE_TARGET = (process.env.CHAT_TRANSLATE_TARGET || 'ru').trim().toLowerCase();
const LIBRE_TRANSLATE_URL = (process.env.LIBRE_TRANSLATE_URL || 'https://libretranslate.com').replace(/\/$/, '');

function translateChatText(text, cb) {
  if (!CHAT_TRANSLATE_TARGET || !text || typeof text !== 'string') {
    if (typeof cb === 'function') cb(null);
    return;
  }
  const body = JSON.stringify({
    q: text.slice(0, 5000),
    source: 'auto',
    target: CHAT_TRANSLATE_TARGET,
    format: 'text'
  });
  const base = LIBRE_TRANSLATE_URL.startsWith('http') ? LIBRE_TRANSLATE_URL : 'https://' + LIBRE_TRANSLATE_URL;
  const u = new URL(base + '/translate');
  const opts = { hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') } };
  if (u.port && u.port !== '80' && u.port !== '443') opts.port = u.port;
  const req = https.request(opts, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const j = JSON.parse(data);
        if (j && typeof j.translatedText === 'string') {
          if (typeof cb === 'function') cb(j.translatedText);
          return;
        }
      } catch (e) {}
      if (typeof cb === 'function') cb(null);
    });
  });
  req.on('error', () => { if (typeof cb === 'function') cb(null); });
  req.setTimeout(8000, () => { req.destroy(); if (typeof cb === 'function') cb(null); });
  req.write(body);
  req.end();
}

module.exports = {
  maskEmail,
  getPlatformFromRequest,
  translateChatText,
  CHAT_TRANSLATE_TARGET,
};
